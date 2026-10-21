import { send, bodyError } from './http.js';
import { StreamMeter } from './stream.js';
import { buildReport } from './report.js';

export function transportOptions(options, signal, agent = false) {
  return {
    connectTimeout: options.connectTimeout,
    idleTimeout: options.idleTimeout,
    maxTime: options.maxTime,
    insecure: options.insecure,
    agent,
    signal,
  };
}

// Sends the request, feeds the body to the meter and the output as it
// arrives, and returns the report. Errors end up in the report, not thrown.
export async function runOnce(request, options, output, { signal = null, agent = false } = {}) {
  let exchange = null;
  let meter = null;
  let error = null;
  output.begin?.(request);
  try {
    exchange = await send(request, transportOptions(options, signal, agent));
    meter = new StreamMeter({
      contentType: exchange.headers['content-type'],
      timeline: options.timeline,
      onText: output.text ? (text) => output.text(text) : null,
    });
    output.head?.(exchange, meter);
    await consume(exchange, meter, output);
  } catch (err) {
    error = err;
  }
  const report = buildReport({ request, exchange, error, meter, timeline: options.timeline });
  output.end(report, meter);
  return report;
}

function consume(exchange, meter, output) {
  const { body } = exchange;
  return new Promise((resolve, reject) => {
    body.on('data', (chunk) => {
      meter.push(chunk, exchange.elapsed());
      if (output.write(chunk) === false) {
        body.pause();
        // A failed drain means the output is gone; the caller aborts the request.
        output.drain().then(() => body.resume(), () => {});
      }
    });
    body.once('end', () => {
      meter.finish(exchange.elapsed());
      resolve();
    });
    body.once('error', (err) => {
      meter.finish(exchange.elapsed());
      reject(bodyError(err, exchange.timing));
    });
  });
}
