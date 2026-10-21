// Incremental parser for text/event-stream, following the WHATWG rules:
// https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
// Input must already be decoded; the caller's TextDecoder drops the BOM.
// `retry` only matters to a client that reconnects, so it is ignored.

const LINE_END = /\r\n?|\n/g;

export class SseParser {
  #line = '';
  #skipLF = false;
  #overflow = false;
  #discard = false;
  #data = '';
  #type = '';
  #id = '';
  #limit;

  oversized = 0;

  constructor({ limit = 16 * 1024 * 1024 } = {}) {
    this.#limit = limit;
  }

  push(text, t) {
    const events = [];
    let start = 0;
    if (this.#skipLF && text.charCodeAt(0) === 10) start = 1;
    if (text.length > 0) this.#skipLF = false;

    LINE_END.lastIndex = start;
    let match;
    while ((match = LINE_END.exec(text)) !== null) {
      const line = this.#line + text.slice(start, match.index);
      this.#line = '';
      if (this.#overflow) {
        this.#overflow = false;
      } else {
        this.#field(line, t, events);
      }
      start = LINE_END.lastIndex;
      if (match[0] === '\r' && start === text.length) this.#skipLF = true;
    }

    if (!this.#overflow) {
      this.#line += text.slice(start);
      if (this.#line.length > this.#limit) {
        this.#line = '';
        this.#overflow = true;
        this.#drop();
      }
    }
    return events;
  }

  // True when the stream stopped inside an event, which the spec discards.
  finish() {
    const pending = this.#data !== '' || this.#line !== '';
    this.#data = '';
    this.#line = '';
    return { pending };
  }

  // An oversized line or data buffer spoils the whole event, so everything up
  // to the next blank line is ignored.
  #drop() {
    this.#data = '';
    this.#discard = true;
    this.oversized++;
  }

  #field(line, t, events) {
    if (line === '') {
      if (this.#discard) {
        this.#discard = false;
        this.#data = '';
        this.#type = '';
      } else {
        this.#dispatch(t, events);
      }
      return;
    }
    if (this.#discard || line.charCodeAt(0) === 58) return;

    const colon = line.indexOf(':');
    let name = line;
    let value = '';
    if (colon !== -1) {
      name = line.slice(0, colon);
      value = line.slice(line.charCodeAt(colon + 1) === 32 ? colon + 2 : colon + 1);
    }

    switch (name) {
      case 'event':
        this.#type = value;
        break;
      case 'data':
        this.#data += value + '\n';
        if (this.#data.length > this.#limit) this.#drop();
        break;
      case 'id':
        if (!value.includes('\0')) this.#id = value;
        break;
    }
  }

  #dispatch(t, events) {
    if (this.#data !== '') {
      events.push({ type: this.#type || 'message', data: this.#data.slice(0, -1), id: this.#id, t });
    }
    this.#data = '';
    this.#type = '';
  }
}
