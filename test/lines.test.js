import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineSplitter } from '../lib/lines.js';

function split(...chunks) {
  const splitter = new LineSplitter();
  const lines = chunks.flatMap((chunk, i) => splitter.push(chunk, i));
  const last = splitter.finish(chunks.length);
  return { lines: last ? [...lines, last] : lines, splitter };
}

test('splits LF and CRLF lines', () => {
  assert.deepEqual(split('{"a":1}\r\n{"b":2}\n').lines.map((l) => l.line), ['{"a":1}', '{"b":2}']);
});

test('returns a last line that has no newline', () => {
  assert.deepEqual(split('one\ntwo').lines.map((l) => l.line), ['one', 'two']);
  assert.equal(new LineSplitter().finish(0), null);
});

test('keeps empty lines for the caller to skip', () => {
  assert.deepEqual(split('a\n\nb\n').lines.map((l) => l.line), ['a', '', 'b']);
});

test('stamps a line with the time of the chunk that ended it', () => {
  assert.deepEqual(split('{"a"', ':1}\n{"b":2}\n').lines.map((l) => l.t), [1, 1]);
});

test('gives the same lines however the text is split', () => {
  const text = '{"x":"é"}\r\n{"y":[1,2]}\n\n{"z":null}';
  const whole = split(text).lines.map((l) => l.line);
  for (let i = 0; i <= text.length; i++) {
    assert.deepEqual(split(text.slice(0, i), text.slice(i)).lines.map((l) => l.line), whole, `split at ${i}`);
  }
});

test('drops a line longer than the limit', () => {
  const splitter = new LineSplitter({ limit: 8 });
  const lines = [...splitter.push('0123456789', 0), ...splitter.push('abc\nok\n', 1)];
  assert.deepEqual(lines.map((l) => l.line), ['ok']);
  assert.equal(splitter.oversized, 1);
});
