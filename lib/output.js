import { once } from 'node:events';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { phaseDurations } from './http.js';
import { redactUrl } from './redact.js';
import { LiveView } from './term/live.js';
import { aggregateRuns } from './report.js';
import { renderPanel, renderRuns } from './term/panel.js';
import { colorEnabled, createStyle } from './term/style.js';

const BINARY_NOTE = 'binary body not shown, redirect stdout to keep it';
const TEXT_TYPE = /^(text\/|application\/([\w.-]+\+)?(json|xml|yaml|x-yaml|javascript|x-www-form-urlencoded|x-ndjson|ndjson|jsonl|graphql))/i;

// A terminal can report 0 columns (a pty nobody sized); then width is unknown.
function width(stream) {
  return stream.isTTY && stream.columns > 0 ? stream.columns : Infinity;
}

function formatHead(exchange) {
  const lines = [`HTTP/${exchange.httpVersion} ${exchange.status} ${exchange.statusMessage}`];
  const raw = exchange.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1]}`);
  return `${lines.join('\n')}\n\n`;
}

// Body bytes go to stdout untouched; the summary goes to stderr, so
// `req url | jq` and `req url > file` keep working.
export class PlainOutput {
  #lastByte = 0x0a;
  #wrote = false;
  #binary = false;

  constructor({ stdout, stderr, options, muted = () => false }) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.options = options;
    this.muted = muted;
    this.style = createStyle(colorEnabled(stderr, options.color));
  }

  head(exchange) {
    if (this.options.include && !this.options.quiet) this.stdout.write(formatHead(exchange));
  }

  // Like curl, a body that starts with binary data is not written to a
  // terminal; redirected or piped, every byte goes through.
  write(chunk) {
    if (this.options.quiet || this.#binary || chunk.length === 0) return true;
    if (!this.#wrote && this.stdout.isTTY && chunk.includes(0)) {
      this.#binary = true;
      return true;
    }
    this.#wrote = true;
    this.#lastByte = chunk[chunk.length - 1];
    return this.stdout.write(chunk);
  }

  drain() {
    return once(this.stdout, 'drain');
  }

  end(report, meter) {
    if (this.muted()) return;
    // Keep the summary off the last body line when both share a terminal.
    if (this.#wrote && this.#lastByte !== 0x0a && this.stdout.isTTY && this.stderr.isTTY) this.stderr.write('\n');
    if (this.#binary) report = { ...report, warnings: [...report.warnings, BINARY_NOTE] };
    const lines = renderPanel(report, {
      cols: width(this.stderr),
      style: this.style,
      gaps: meter?.gaps,
    });
    this.stderr.write(`${lines.join('\n')}\n`);
  }

  progress(reports, planned) {
    if (this.stderr.isTTY) this.stderr.write(`\r\x1b[Krun ${reports.length}/${planned}`);
  }

  summary(summary) {
    if (this.muted()) return;
    if (this.stderr.isTTY) this.stderr.write('\r\x1b[K');
    this.stderr.write(`${renderRuns(summary, { cols: width(this.stderr), style: this.style }).join('\n')}\n`);
  }
}

export class JsonOutput {
  constructor({ stdout }) {
    this.stdout = stdout;
  }

  write() {
    return true;
  }

  end(report) {
    this.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }

  summary(summary) {
    this.end(summary);
  }
}

// Live table for --runs. Aggregating sorts every sample, so it happens when
// a frame is drawn (a few times a second), not after every run.
export class LiveRunsOutput {
  #view;
  #start = 0;
  #reports = [];
  #planned = 0;
  #summary = null;
  #stale = false;

  constructor({ stdout, stdin = null, options, onInterrupt }) {
    this.style = createStyle(colorEnabled(stdout, options.color));
    this.#view = new LiveView(stdout, {
      input: stdin,
      onInterrupt,
      render: (cols, final) => renderRuns(this.#current(), {
        cols,
        style: this.style,
        live: final ? null : { frame: this.#view.frame, elapsed: performance.now() - this.#start },
      }),
    });
  }

  beginRuns(request, planned) {
    this.#planned = planned;
    this.#summary = { runs: 0, planned, statuses: {}, failed: {}, timing: {}, request: { method: request.method, url: redactUrl(request.url) } };
    this.#start = performance.now();
    this.#view.start();
  }

  progress(reports) {
    this.#reports = reports;
    this.#stale = true;
  }

  summary(summary) {
    this.#summary = summary;
    this.#stale = false;
    this.#view.stop();
  }

  #current() {
    if (this.#stale) {
      this.#summary = aggregateRuns(this.#reports, this.#planned);
      this.#stale = false;
    }
    return this.#summary;
  }
}

// The live view used when stdout is a terminal. Text streams into the
// scrollback; the timing panel stays pinned under it and becomes the
// final summary when the request ends.
export class LiveOutput {
  #view;
  #request = null;
  #secure = false;
  #literal = false;
  #start = 0;
  #marks = null;
  #exchange = null;
  #meter = null;
  #stats = null;
  #statsAt = -Infinity;
  #mode = 'pending';
  #held = '';
  #decoder = new TextDecoder();
  #final = null;
  #finalGaps = null;

  constructor({ stdout, stdin = null, options, onInterrupt }) {
    this.options = options;
    this.style = createStyle(colorEnabled(stdout, options.color));
    this.#view = new LiveView(stdout, {
      input: stdin,
      onInterrupt,
      render: (cols, final) => this.#lines(cols, final),
    });
  }

  begin(request) {
    this.#request = { method: request.method, url: redactUrl(request.url) };
    this.#secure = request.url.protocol === 'https:';
    this.#literal = net.isIP(request.url.hostname.replace(/^\[(.*)\]$/, '$1')) !== 0;
    this.#start = performance.now();
    this.#view.start();
  }

  mark(name, timing) {
    this.#marks = timing;
  }

  head(exchange, meter) {
    this.#exchange = exchange;
    this.#meter = meter;
    if (this.options.include) this.#view.text(formatHead(exchange));
    const type = exchange.headers['content-type'];
    if (this.options.quiet) this.#mode = 'quiet';
    else if (meter.kind !== 'raw' && !this.options.raw) this.#mode = 'pending';
    else if (!type) this.#mode = 'sniff';
    else this.#mode = TEXT_TYPE.test(type) ? 'text' : 'binary';
  }

  // Generated text of an LLM stream, already pulled out of the events.
  text(chunk) {
    if (this.options.quiet || this.options.raw) return;
    this.#mode = 'llm';
    this.#held = '';
    this.#view.text(chunk);
  }

  // Called after the meter has seen the chunk, so for SSE and NDJSON the
  // first event decides between showing extracted text and raw text.
  write(chunk) {
    if (this.#mode === 'sniff') this.#mode = chunk.includes(0) ? 'binary' : 'text';
    if (this.#mode === 'text') {
      this.#view.text(this.#decoder.decode(chunk, { stream: true }));
    } else if (this.#mode === 'pending') {
      this.#held += this.#decoder.decode(chunk, { stream: true });
      // An LLM stream often opens with events that carry no text yet
      // (Anthropic's message_start, OpenAI's role-only chunk).
      if (this.#meter.provider) {
        this.#mode = 'llm';
        this.#held = '';
      } else if (this.#meter.events > 0 || this.#held.length > 64 * 1024) {
        this.#mode = 'text';
        this.#view.text(this.#held);
        this.#held = '';
      }
    }
    return true;
  }

  end(report, meter) {
    if (this.#mode === 'pending' || this.#mode === 'text') {
      const rest = this.#held + this.#decoder.decode();
      if (rest) this.#view.text(rest);
    }
    this.#final = this.#mode === 'binary' ? { ...report, warnings: [...report.warnings, BINARY_NOTE] } : report;
    this.#finalGaps = meter?.gaps ?? null;
    this.#view.stop();
  }

  #lines(cols, final) {
    if (final) return renderPanel(this.#final, { cols, style: this.style, gaps: this.#finalGaps });
    const elapsed = performance.now() - this.#start;
    const ex = this.#exchange;
    const report = {
      request: this.#request,
      response: ex && { status: ex.status, statusText: ex.statusMessage, reused: ex.reused },
      timing: this.#marks && phaseDurations(this.#marks),
      body: this.#meter && this.#liveStats(elapsed),
      warnings: [],
      error: null,
    };
    const live = { phase: this.#phase(), elapsed, frame: this.#view.frame };
    return renderPanel(report, { cols, style: this.style, live, gaps: this.#meter?.gaps });
  }

  // Percentiles sort every gap, so they are refreshed a few times a second.
  #liveStats(now) {
    if (now - this.#statsAt > 200) {
      this.#stats = this.#meter.stats();
      this.#statsAt = now;
    }
    return { ...this.#stats, bytes: this.#meter.bytes, events: this.#meter.events };
  }

  #phase() {
    const m = this.#marks ?? {};
    if (this.#exchange) return 'receiving';
    if ((this.#secure ? m.tls : m.connect) != null) return 'waiting';
    if (m.connect != null) return 'handshake';
    if (m.dns != null || this.#literal) return 'connecting';
    return 'resolving';
  }
}
