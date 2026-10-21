// In-process throughput of the stream pipeline on a 50 MB OpenAI-style SSE
// stream and a 50 MB Ollama-style NDJSON stream, fed in 16 KB chunks.
import { performance } from 'node:perf_hooks';
import { SseParser } from '../lib/sse.js';
import { StreamMeter } from '../lib/stream.js';
import { summarize } from '../lib/stats.js';
import { round, save } from './common.js';

const TARGET = 50 * 1024 * 1024;
const CHUNK = 16 * 1024;
const ITERATIONS = 7;

function build(line) {
  const parts = [];
  let size = 0;
  for (let i = 0; size < TARGET; i++) {
    const s = line(i);
    parts.push(s);
    size += s.length;
  }
  const buf = Buffer.from(parts.join(''));
  const chunks = [];
  for (let i = 0; i < buf.length; i += CHUNK) chunks.push(buf.subarray(i, i + CHUNK));
  return { chunks, bytes: buf.length, events: parts.length };
}

function time(fn) {
  const runs = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    fn();
    runs.push(performance.now() - start);
  }
  return summarize(runs).p50;
}

function report(name, input, ms) {
  const row = {
    name,
    mbPerSecond: round(input.bytes / 2 ** 20 / (ms / 1000), 1),
    eventsPerSecond: Math.round(input.events / (ms / 1000)),
    medianMs: round(ms, 1),
  };
  console.log(`${name}: ${row.mbPerSecond} MB/s, ${row.eventsPerSecond.toLocaleString('en')} events/s`);
  return row;
}

const sse = build((i) => `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"tok${i} "},"finish_reason":null}]}\n\n`);
const ndjson = build((i) => `{"model":"llama3.2","created_at":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"tok${i} "},"done":false}\n`);
const text = sse.chunks.map((c) => c.toString());

const results = [
  report('SSE parser only', sse, time(() => {
    const parser = new SseParser();
    for (const t of text) parser.push(t, 0);
  })),
  report('SSE + JSON + LLM metrics', sse, time(() => {
    const meter = new StreamMeter({ contentType: 'text/event-stream' });
    for (const c of sse.chunks) meter.push(c, 0);
    meter.finish(0);
  })),
  report('NDJSON + JSON + LLM metrics', ndjson, time(() => {
    const meter = new StreamMeter({ contentType: 'application/x-ndjson' });
    for (const c of ndjson.chunks) meter.push(c, 0);
    meter.finish(0);
  })),
];

// Memory a meter keeps per event once garbage is collected: the gap samples.
let retainedBytesPerEvent = null;
if (globalThis.gc) {
  gc();
  const before = process.memoryUsage().heapUsed;
  const meter = new StreamMeter({ contentType: 'text/event-stream' });
  for (const c of sse.chunks) meter.push(c, 0);
  meter.finish(0);
  gc();
  retainedBytesPerEvent = round((process.memoryUsage().heapUsed - before) / sse.events, 1);
  console.log(`retained after GC: ${retainedBytesPerEvent} bytes per event (${meter.events.toLocaleString('en')} events kept alive)`);
}

save('parser', {
  method: `median of ${ITERATIONS} passes over ${TARGET / 2 ** 20} MB in ${CHUNK / 1024} KB chunks, in one process`,
  results,
  retainedBytesPerEvent,
});
