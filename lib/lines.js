// Splits decoded text into lines for NDJSON. Accepts LF and CRLF, and a last
// line without a newline. A line longer than the limit is dropped and counted.

export class LineSplitter {
  #rest = '';
  #overflow = false;
  #limit;

  oversized = 0;

  constructor({ limit = 16 * 1024 * 1024 } = {}) {
    this.#limit = limit;
  }

  push(text, t) {
    const lines = [];
    let start = 0;
    let nl;
    while ((nl = text.indexOf('\n', start)) !== -1) {
      if (this.#overflow) {
        this.#overflow = false;
      } else {
        lines.push({ line: trimCR(this.#rest + text.slice(start, nl)), t });
      }
      this.#rest = '';
      start = nl + 1;
    }
    if (!this.#overflow) {
      this.#rest += text.slice(start);
      if (this.#rest.length > this.#limit) {
        this.#rest = '';
        this.#overflow = true;
        this.oversized++;
      }
    }
    return lines;
  }

  finish(t) {
    const line = trimCR(this.#rest);
    this.#rest = '';
    return line === '' ? null : { line, t };
  }
}

function trimCR(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
