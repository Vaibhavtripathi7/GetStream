import { once } from 'node:events';
import { renderPanel } from './term/panel.js';
import { colorEnabled, createStyle } from './term/style.js';

export function formatHead(exchange) {
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

  write(chunk) {
    if (this.options.quiet || chunk.length === 0) return true;
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
    const lines = renderPanel(report, {
      cols: this.stderr.isTTY ? this.stderr.columns : Infinity,
      style: this.style,
      gaps: meter?.gaps,
    });
    this.stderr.write(`${lines.join('\n')}\n`);
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
}
