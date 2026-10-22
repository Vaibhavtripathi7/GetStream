import { SseParser } from './sse.js';
import { LineSplitter } from './lines.js';
import { extract } from './llm.js';
import { summarize } from './stats.js';

const NDJSON_TYPES = new Set([
  'application/x-ndjson',
  'application/ndjson',
  'application/jsonl',
  'application/jsonlines',
  'application/x-jsonlines',
]);

export function streamKind(contentType = '') {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'text/event-stream') return 'sse';
  if (NDJSON_TYPES.has(type)) return 'ndjson';
  return 'raw';
}

// Measures a response body as it arrives. `t` is the arrival time of each
// chunk in ms since the request started. For LLM streams the timing follows
// chunks that carry generated text; for other streams it follows events.
export class StreamMeter {
  #decoder = new TextDecoder();
  #parser;
  #onText;
  #lastEvent = null;

  constructor({ contentType = '', onText = null, timeline = false } = {}) {
    this.kind = streamKind(contentType);
    this.#parser = this.kind === 'sse' ? new SseParser() : this.kind === 'ndjson' ? new LineSplitter() : null;
    this.#onText = onText;

    this.bytes = 0;
    this.chunks = 0;
    this.events = 0;
    this.provider = null;
    this.firstToken = null;
    this.lastToken = null;
    this.deltas = 0;
    this.inputTokens = null;
    this.outputTokens = null;
    this.reasoningTokens = null;
    this.streamedReasoning = false;
    this.gaps = [];
    this.timeline = timeline ? [] : null;
    this.done = false;
    this.pending = false;
    this.parseErrors = 0;
    this.errors = [];
  }

  push(chunk, t) {
    this.bytes += chunk.length;
    this.chunks++;
    if (this.#parser) this.#handle(this.#parser.push(this.#decoder.decode(chunk, { stream: true }), t));
  }

  finish(t) {
    if (!this.#parser) return;
    const items = this.#parser.push(this.#decoder.decode(), t);
    if (this.kind === 'sse') {
      this.pending = this.#parser.finish().pending;
    } else {
      const last = this.#parser.finish(t);
      if (last) items.push(last);
    }
    this.#handle(items);
  }

  get oversized() {
    return this.#parser?.oversized ?? 0;
  }

  // The token rate covers what was streamed between the first and the last
  // text chunk: reasoning a provider keeps hidden happens before the first
  // token and is left out; reasoning that was streamed is counted.
  stats() {
    const span = this.lastToken - this.firstToken;
    const rate = (count) => (count > 1 && span > 0 ? ((count - 1) * 1000) / span : null);
    const streamed = this.outputTokens === null
      ? null
      : this.outputTokens + (this.streamedReasoning ? this.reasoningTokens ?? 0 : 0);
    return {
      kind: this.kind,
      bytes: this.bytes,
      chunks: this.chunks,
      events: this.events,
      provider: this.provider,
      firstToken: this.firstToken,
      lastToken: this.lastToken,
      deltas: this.deltas,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      tokensPerSecond: streamed === null ? null : rate(streamed),
      deltasPerSecond: rate(this.deltas),
      gaps: summarize(this.gaps),
      done: this.done,
      pending: this.pending,
      parseErrors: this.parseErrors,
      oversized: this.oversized,
      errors: this.errors,
      timeline: this.timeline,
    };
  }

  #handle(items) {
    for (const item of items) {
      if (this.kind === 'sse') {
        this.events++;
        if (item.data === '[DONE]') {
          this.done = true;
          continue;
        }
        this.#record(item.data.trimStart().startsWith('{') ? parseJson(item.data) : undefined, item.t);
      } else {
        if (item.line.trim() === '') continue;
        this.events++;
        const value = parseJson(item.line);
        if (value === undefined) this.parseErrors++;
        this.#record(value, item.t);
      }
    }
  }

  #record(payload, t) {
    let delta = payload === undefined ? null : extract(payload);
    if (delta?.provider && !this.provider) {
      this.provider = delta.provider;
      this.gaps = [];
      this.timeline &&= [];
    }
    if (delta?.provider && delta.provider !== this.provider) delta = null;
    if (delta?.error) this.errors.push(delta.error);

    if (!this.provider) {
      this.#mark(this.#lastEvent, t);
      this.#lastEvent = t;
      return;
    }
    if (!delta) return;
    if (delta.inputTokens !== undefined) this.inputTokens = delta.inputTokens;
    if (delta.outputTokens !== undefined) this.outputTokens = delta.outputTokens;
    if (delta.reasoningTokens !== undefined) this.reasoningTokens = delta.reasoningTokens;
    if (delta.reasoning && delta.text) this.streamedReasoning = true;
    if (delta.done) this.done = true;
    if (delta.text) {
      this.#mark(this.lastToken, t);
      this.firstToken ??= t;
      this.lastToken = t;
      this.deltas++;
      this.#onText?.(delta.text);
    }
  }

  #mark(previous, t) {
    if (previous !== null) this.gaps.push(t - previous);
    this.timeline?.push(t);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
