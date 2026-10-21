import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser } from '../lib/sse.js';

function parse(...chunks) {
  const parser = new SseParser();
  const events = chunks.flatMap((chunk, i) => parser.push(chunk, i));
  return { events, parser, end: parser.finish() };
}

const shape = (events) => events.map(({ type, data, id }) => ({ type, data, id }));

test('parses a single event', () => {
  assert.deepEqual(shape(parse('data: hello\n\n').events), [{ type: 'message', data: 'hello', id: '' }]);
});

test('joins data lines and keeps the event type', () => {
  const { events } = parse('event: add\ndata: a\ndata: b\n\n');
  assert.deepEqual(shape(events), [{ type: 'add', data: 'a\nb', id: '' }]);
});

test('accepts CR, LF and CRLF line endings', () => {
  const { events } = parse('data: a\r\rdata: b\r\n\r\ndata: c\n\n');
  assert.deepEqual(events.map((e) => e.data), ['a', 'b', 'c']);
});

test('treats a CRLF split across chunks as one line ending', () => {
  const { events } = parse('data: a\r', '\ndata: b\n\n');
  assert.deepEqual(events.map((e) => e.data), ['a\nb']);
});

test('a lone CR at the end of a chunk still ends the line', () => {
  const { events } = parse('data: a\r', 'data: b\r', '\r');
  assert.deepEqual(events.map((e) => e.data), ['a\nb']);
});

test('matches the example from the spec', () => {
  const { events, end } = parse('data\n\ndata\ndata\n\ndata:');
  assert.deepEqual(events.map((e) => e.data), ['', '\n']);
  assert.equal(end.pending, true);
});

test('strips exactly one leading space from a value', () => {
  const { events } = parse('data:  two\n\ndata:none\n\n');
  assert.deepEqual(events.map((e) => e.data), [' two', 'none']);
});

test('ignores comments, unknown fields and events without data', () => {
  const { events } = parse(': ping\n\nfoo: bar\nevent: x\n\ndata: 2\n\n');
  assert.deepEqual(shape(events), [{ type: 'message', data: '2', id: '' }]);
});

test('resets the event type after each dispatch', () => {
  const { events } = parse('event: x\ndata: 1\n\ndata: 2\n\n');
  assert.deepEqual(events.map((e) => e.type), ['x', 'message']);
});

test('keeps the last event id and ignores ids containing NUL', () => {
  const { events } = parse('id: 7\ndata: a\n\ndata: b\n\nid: x\0y\ndata: c\n\nid\ndata: d\n\n');
  assert.deepEqual(events.map((e) => e.id), ['7', '7', '7', '']);
});

test('accepts only digits for retry', () => {
  assert.equal(parse('retry: 1500\n\n').parser.retry, 1500);
  assert.equal(parse('retry: 15x\n\n').parser.retry, null);
});

test('reports an event left open at the end of the stream', () => {
  const { events, end } = parse('data: one\n\ndata: two\n');
  assert.deepEqual(events.map((e) => e.data), ['one']);
  assert.equal(end.pending, true);
  assert.equal(parse('data: one\n\n').end.pending, false);
});

test('stamps each event with the time of the chunk that completed it', () => {
  const { events } = parse('data: a', '\n\ndata: b\n', '\n');
  assert.deepEqual(events.map((e) => e.t), [1, 2]);
});

test('gives the same events however the stream is split', () => {
  const stream = 'event: delta\r\ndata: {"t":"héllo 👋"}\r\n\r\n: keep-alive\n\nid: 42\ndata: line one\ndata: line two\r\rdata: [DONE]\n\n';
  const whole = shape(parse(stream).events);
  assert.equal(whole.length, 3);
  for (let i = 0; i <= stream.length; i++) {
    for (const j of [i, Math.min(stream.length, i + 1), Math.min(stream.length, i + 7)]) {
      const pieces = [stream.slice(0, i), stream.slice(i, j), stream.slice(j)];
      assert.deepEqual(shape(parse(...pieces).events), whole, `split at ${i},${j}`);
    }
  }
  assert.deepEqual(shape(parse(...stream).events), whole, 'one character at a time');
});

test('drops an oversized event and carries on', () => {
  const parser = new SseParser({ limit: 16 });
  const events = [
    ...parser.push('data: ' + 'x'.repeat(40), 0),
    ...parser.push('\ndata: tail\n\ndata: ok\n\n', 1),
  ];
  assert.deepEqual(events.map((e) => e.data), ['ok']);
  assert.equal(parser.oversized, 1);
});

test('drops an event whose data grows past the limit', () => {
  const parser = new SseParser({ limit: 16 });
  const events = parser.push('data: 0123456789\ndata: 0123456789\n\ndata: ok\n\n', 0);
  assert.deepEqual(events.map((e) => e.data), ['ok']);
  assert.equal(parser.oversized, 1);
});
