import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StreamMeter, streamKind } from '../lib/stream.js';
import { extract } from '../lib/llm.js';
import { summarize, percentile } from '../lib/stats.js';

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

// Feeds one event (or line) per chunk, 10 ms apart, starting at t = 10.
function meter(contentType, pieces) {
  let text = '';
  const m = new StreamMeter({ contentType, onText: (s) => (text += s), timeline: true });
  pieces.forEach((piece, i) => m.push(Buffer.from(piece), (i + 1) * 10));
  m.finish((pieces.length + 1) * 10);
  return { m, stats: m.stats(), text };
}

const sseEvents = (name) => fixture(name).split(/(?<=\n\n)/);
const ndjsonLines = (name) => fixture(name).split(/(?<=\n)/);

test('summarize uses linear interpolation between ranks', () => {
  const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(s.p50, 50.5);
  assert.equal(s.p95, 95.05);
  assert.equal(s.min, 1);
  assert.equal(s.max, 100);
  assert.equal(s.mean, 50.5);
  assert.equal(summarize([]), null);
  assert.equal(summarize([null, 4]).p99, 4);
  assert.equal(percentile(Float64Array.of(1, 3), 50), 2);
});

test('maps content types to stream kinds', () => {
  assert.equal(streamKind('text/event-stream; charset=utf-8'), 'sse');
  assert.equal(streamKind('application/x-ndjson'), 'ndjson');
  assert.equal(streamKind('application/json'), 'raw');
  assert.equal(streamKind(undefined), 'raw');
});

test('openai chat: first token skips the empty role chunk', () => {
  const { stats, text } = meter('text/event-stream', sseEvents('openai-chat.sse'));
  assert.equal(stats.provider, 'openai');
  assert.equal(text, 'Hello there');
  assert.equal(stats.firstToken, 20);
  assert.equal(stats.lastToken, 30);
  assert.equal(stats.deltas, 2);
  assert.equal(stats.inputTokens, 9);
  assert.equal(stats.outputTokens, 2);
  assert.equal(stats.tokensPerSecond, 100);
  assert.equal(stats.done, true);
  assert.deepEqual(stats.timeline, [20, 30]);
});

test('openai responses api', () => {
  const { stats, text } = meter('text/event-stream', sseEvents('openai-responses.sse'));
  assert.equal(stats.provider, 'openai-responses');
  assert.equal(text, 'Hello there');
  assert.equal(stats.firstToken, 20);
  assert.equal(stats.outputTokens, 2);
  assert.equal(stats.inputTokens, 10);
  assert.equal(stats.done, true);
});

test('anthropic messages: output tokens come from message_delta', () => {
  const { stats, text } = meter('text/event-stream', sseEvents('anthropic.sse'));
  assert.equal(stats.provider, 'anthropic');
  assert.equal(text, 'Hello there');
  assert.equal(stats.firstToken, 40);
  assert.equal(stats.inputTokens, 12);
  assert.equal(stats.outputTokens, 2);
  assert.equal(stats.gaps.count, 1);
  assert.equal(stats.done, true);
});

test('gemini', () => {
  const { stats, text } = meter('text/event-stream', sseEvents('gemini.sse'));
  assert.equal(stats.provider, 'gemini');
  assert.equal(text, 'Hello there');
  assert.equal(stats.firstToken, 10);
  assert.equal(stats.outputTokens, 2);
});

test('ollama ndjson', () => {
  const { stats, text } = meter('application/x-ndjson', ndjsonLines('ollama.ndjson'));
  assert.equal(stats.provider, 'ollama');
  assert.equal(text, 'Hello there');
  assert.equal(stats.outputTokens, 2);
  assert.equal(stats.inputTokens, 8);
  assert.equal(stats.done, true);
  assert.equal(stats.parseErrors, 0);
});

test('without usage the rate is reported per chunk, not per token', () => {
  const chunk = (s) => `data: {"choices":[{"delta":{"content":"${s}"}}]}\n\n`;
  const { stats } = meter('text/event-stream', [chunk('a'), chunk('b'), chunk('c')]);
  assert.equal(stats.outputTokens, null);
  assert.equal(stats.tokensPerSecond, null);
  assert.equal(stats.deltasPerSecond, 100);
});

test('decodes text split anywhere inside a multi-byte character', () => {
  const body = Buffer.from('data: {"choices":[{"delta":{"content":"héllo 👋 世界"}}]}\n\n');
  for (let i = 1; i < body.length; i++) {
    let text = '';
    const m = new StreamMeter({ contentType: 'text/event-stream', onText: (s) => (text += s) });
    m.push(body.subarray(0, i), 1);
    m.push(body.subarray(i), 2);
    m.finish(3);
    assert.equal(text, 'héllo 👋 世界', `split at byte ${i}`);
  }
});

test('drops a UTF-8 BOM before parsing', () => {
  const { stats } = meter('text/event-stream', [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('data: x\n\n')])]);
  assert.equal(stats.events, 1);
});

test('plain SSE is timed per event', () => {
  const { stats } = meter('text/event-stream', ['data: a\n\n', 'data: b\n\n', ': ping\n\n', 'data: c\n\n']);
  assert.equal(stats.provider, null);
  assert.equal(stats.events, 3);
  assert.deepEqual(stats.timeline, [10, 20, 40]);
  assert.equal(stats.gaps.max, 20);
});

test('counts NDJSON lines that are not JSON', () => {
  const { stats } = meter('application/x-ndjson', ['not json\n', '\n', '{"a":1}']);
  assert.equal(stats.events, 2);
  assert.equal(stats.parseErrors, 1);
});

test('records an error sent inside the stream', () => {
  const { stats } = meter('text/event-stream', ['data: {"error":{"message":"rate limited","type":"requests"}}\n\n']);
  assert.deepEqual(stats.errors, ['rate limited']);
});

test('flags a stream that ends inside an event', () => {
  assert.equal(meter('text/event-stream', ['data: x\n']).stats.pending, true);
});

test('raw bodies are only counted', () => {
  const { stats } = meter('application/octet-stream', ['abc', 'def']);
  assert.equal(stats.kind, 'raw');
  assert.equal(stats.bytes, 6);
  assert.equal(stats.chunks, 2);
  assert.equal(stats.events, 0);
  assert.equal(stats.gaps, null);
});

test('extract ignores ordinary JSON and pings', () => {
  assert.equal(extract({ type: 'ping' }), null);
  assert.equal(extract({ hello: 'world' }), null);
  assert.equal(extract([1, 2]), null);
  assert.equal(extract('text'), null);
});

test('gemini and OpenAI-compatible streams finish on a finish reason', () => {
  assert.equal(meter('text/event-stream', sseEvents('gemini.sse')).stats.done, true);
  const noMarker = ['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'];
  assert.equal(meter('text/event-stream', noMarker).stats.done, true);
  assert.equal(meter('text/event-stream', noMarker.slice(0, 1)).stats.done, false);
});

test('records provider errors from anthropic and the responses api', () => {
  const anthropic = meter('text/event-stream', [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
  ]);
  assert.deepEqual(anthropic.stats.errors, ['Overloaded']);
  const responses = meter('text/event-stream', ['data: {"type":"response.failed","response":{"error":{"message":"quota"}}}\n\n']);
  assert.deepEqual(responses.stats.errors, ['quota']);
});

test('a real Gemini stream: answer and thinking tokens apart, rate over what was streamed', () => {
  // gemini-3.7-flash, captured 2026-10-22; only the opaque thoughtSignature is shortened
  const raw = readFileSync(new URL('fixtures/gemini-live.sse', import.meta.url), 'utf8');
  const events = raw.split(/(?<=\r\n\r\n)/);
  const { stats, text } = meter('text/event-stream', events);
  let expected = '';
  for (const e of events) for (const p of JSON.parse(e.slice(6)).candidates[0].content.parts) expected += p.text ?? '';
  assert.equal(text, expected);
  assert.equal(stats.provider, 'gemini');
  assert.equal(stats.events, 16);
  assert.equal(stats.deltas, 15);
  assert.equal(stats.done, true);
  assert.equal(stats.inputTokens, 18);
  assert.equal(stats.outputTokens, 374);
  assert.equal(stats.reasoningTokens, 863);
  assert.equal(stats.tokensPerSecond, (373 * 1000) / (stats.lastToken - stats.firstToken));
});

test('hidden reasoning is left out of the rate, streamed reasoning is counted', () => {
  const chunk = (delta, usage) => `data: ${JSON.stringify({ choices: [{ delta }], ...(usage ? { usage } : {}) })}\n\n`;
  const usage = { prompt_tokens: 5, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 80 } };

  const hidden = meter('text/event-stream', [chunk({ content: 'a' }), chunk({ content: 'b' }, usage)]).stats;
  assert.equal(hidden.outputTokens, 20);
  assert.equal(hidden.reasoningTokens, 80);
  assert.equal(hidden.tokensPerSecond, 1900);

  const streamed = meter('text/event-stream', [chunk({ reasoning_content: 'think' }), chunk({ content: 'b' }, usage)]).stats;
  assert.equal(streamed.outputTokens, 20);
  assert.equal(streamed.tokensPerSecond, 9900);

  const responses = meter('text/event-stream', [
    'data: {"type":"response.output_text.delta","delta":"a"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"b"}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":50,"output_tokens_details":{"reasoning_tokens":40}}}}\n\n',
  ]).stats;
  assert.equal(responses.outputTokens, 10);
  assert.equal(responses.reasoningTokens, 40);
});
