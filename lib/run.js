import { finished } from 'node:stream';
import { sendFollowing, bodyError, warmUp, RequestError } from './http.js';
import { StreamMeter } from './stream.js';
import { buildReport, aggregateRuns } from './report.js';

function transportOptions(options, signal, agent = false, output = null) {
  return {
    connectTimeout: options.connectTimeout,
    idleTimeout: options.idleTimeout,
    maxTime: options.maxTime,
    insecure: options.insecure,
    maxRedirects: options.location ? 10 : 0,
    agent,
    signal,
    onMark: output?.mark ? (timing, phase) => output.mark(timing, phase) : null,
  };
}

// Sends the request, feeds the body to the meter and the output as it
// arrives, and returns the report. Errors end up in the report, not thrown.
export async function runOnce(request, options, output, { signal = null, agent = false } = {}) {
  let exchange = null;
  let meter = null;
  let error = null;
  await warmUp({ tls: request.url.protocol === 'https:' });
  output.begin?.(request);
  try {
    exchange = await sendFollowing(request, transportOptions(options, signal, agent, output));
    meter = new StreamMeter({
      contentType: exchange.headers['content-type'],
      timeline: options.timeline,
      onText: output.text ? (text) => output.text(text) : null,
    });
    output.head?.(exchange, meter);
    await consume(exchange, meter, output);
  } catch (err) {
    // Anything that is not a request failure is a bug and should crash loudly.
    if (!(err instanceof RequestError)) throw err;
    error = err;
  }
  const report = buildReport({ request, exchange, error, meter, timeline: options.timeline });
  output.end(report, meter);
  return report;
}

// Sends the request `runs` times in a row. Each run opens a new connection
// unless keepAlive is set, in which case later runs report no dns/tcp/tls.
export async function runMany(request, options, output, { signal = null } = {}) {
  // One pooled agent per protocol, since a redirect can switch http to https.
  const agents = new Map();
  const agent = options.keepAlive
    ? (url) => {
        if (!agents.has(url.protocol)) {
          const transport = process.getBuiltinModule(url.protocol === 'https:' ? 'node:https' : 'node:http');
          agents.set(url.protocol, new transport.Agent({ keepAlive: true, maxSockets: 1 }));
        }
        return agents.get(url.protocol);
      }
    : false;
  await warmUp({ tls: request.url.protocol === 'https:' });
  const discard = { write: () => true, end() {} };
  const reports = [];
  output.beginRuns?.(request, options.runs);
  try {
    while (reports.length < options.runs && !signal?.aborted) {
      const report = await runOnce(request, options, discard, { signal, agent });
      if (report.error?.kind === 'aborted') break;
      reports.push(report);
      output.progress?.(reports, options.runs);
    }
  } finally {
    for (const a of agents.values()) a.destroy();
  }
  const summary = aggregateRuns(reports, options.runs);
  summary.aborted = Boolean(signal?.aborted);
  output.summary(summary);
  return summary;
}

// finished() also reports a body that failed before anyone listened, as
// when a malformed chunk arrives in the same packet as the headers.
function consume(exchange, meter, output) {
  const { body } = exchange;
  return new Promise((resolve, reject) => {
    body.on('data', (chunk) => {
      meter.push(chunk, exchange.arrivedAt());
      if (output.write(chunk) === false) {
        body.pause();
        // A failed drain means the output is gone; the caller aborts the request.
        output.drain().then(() => body.resume(), () => {});
      }
    });
    finished(body, (err) => {
      if (err) exchange.timing.failed ??= exchange.elapsed();
      meter.finish(exchange.elapsed());
      if (err) reject(bodyError(err, exchange.timing));
      else resolve();
    });
  });
}
