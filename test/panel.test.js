import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringWidth, truncate, splitRows, sanitize } from '../lib/term/text.js';
import { renderPanel, renderRuns } from '../lib/term/panel.js';
import { createStyle } from '../lib/term/style.js';
import { formatMs, formatBytes } from '../lib/format.js';

test('measures display width', () => {
  assert.equal(stringWidth('hello'), 5);
  assert.equal(stringWidth('世界'), 4);
  assert.equal(stringWidth('👋 hi'), 5);
  assert.equal(stringWidth('é'), 1);
  assert.equal(stringWidth('\x1b[32mok\x1b[39m'), 2);
  assert.equal(stringWidth('\u{F0000}'), 1);
});

test('truncates by width and keeps colours closed', () => {
  assert.equal(truncate('hello world', 6), 'hello…');
  assert.equal(truncate('世界世界', 5), '世界…');
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('\x1b[32mhello world\x1b[39m', 6), '\x1b[32mhello…\x1b[0m');
  assert.equal(truncate('abc', 0), '');
});

test('splits text into whole terminal rows', () => {
  assert.deepEqual(splitRows('abcdefg', 3), { full: 'abcdef', rest: 'g' });
  assert.deepEqual(splitRows('abcdef', 3), { full: 'abcdef', rest: '' });
  assert.deepEqual(splitRows('ab', 3), { full: '', rest: 'ab' });
  // a wide character that does not fit wraps early and leaves a blank cell
  assert.deepEqual(splitRows('ab世', 3), { full: 'ab', rest: '世' });
  assert.deepEqual(splitRows('ab世cd', 3), { full: 'ab世c', rest: 'd' });
});

test('shows control characters instead of sending them to the terminal', () => {
  assert.equal(sanitize('\x1b[2Jred\x07'), '␛[2Jred␇');
  assert.equal(sanitize('line\r\nnext\ttab'), 'line\nnext\ttab');
  assert.equal(sanitize('\x7f\x9b'), '␡�');
});

test('formats durations and sizes', () => {
  assert.equal(formatMs(0.123), '0.12 ms');
  assert.equal(formatMs(12.34), '12.3 ms');
  assert.equal(formatMs(456.7), '457 ms');
  assert.equal(formatMs(1234), '1.23 s');
  assert.equal(formatMs(125_000), '2m 5s');
  assert.equal(formatMs(119_600), '2m 0s');
  assert.equal(formatMs(59_994), '59.99 s');
  assert.equal(formatMs(59_996), '1m 0s');
  assert.equal(formatMs(null), '-');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1500), '1.5 kB');
  assert.equal(formatBytes(2_500_000), '2.50 MB');
  assert.equal(formatBytes(1_250_000_000), '1.25 GB');
});

const report = {
  request: { method: 'POST', url: 'https://api.example.com/v1/chat/completions?key=REDACTED' },
  response: { status: 200, statusText: 'OK', reused: false },
  timing: { dns: 12, tcp: 18, tls: 41, wait: 380, body: 2700, total: 3151 },
  body: {
    kind: 'sse', provider: 'openai', bytes: 48_000, events: 313, firstToken: 451, deltas: 312,
    outputTokens: 312, tokensPerSecond: 114.2, deltasPerSecond: 114.2,
    gaps: { p50: 8, p95: 21, p99: 40, max: 88 },
  },
  warnings: ['stream ended without a completion marker'],
  error: null,
};

test('renders the summary within the terminal width', () => {
  for (const cols of [20, 40, 80, 200]) {
    const lines = renderPanel(report, { cols, style: createStyle(true), gaps: [1, 5, 2, 8] });
    for (const line of lines) assert.ok(stringWidth(line) <= cols - 1, `${cols}: ${line}`);
  }
});

test('the summary carries the numbers and no escapes when colour is off', () => {
  const text = renderPanel(report, { style: createStyle(false) }).join('\n');
  assert.ok(!text.includes('\x1b'));
  assert.match(text, /^200 OK POST https:\/\/api\.example\.com/);
  assert.match(text, /dns 12\.0 ms {2}tcp 18\.0 ms {2}tls 41\.0 ms {2}wait 380 ms {2}body 2\.70 s/);
  assert.match(text, /first token 451 ms {2}· {2}312 tokens {2}· {2}114 tok\/s\ngap between chunks {2}p50 8\.0 ms/);
  assert.match(text, /! stream ended without a completion marker/);
});

test('leaves out phases that did not happen', () => {
  const plain = { ...report, timing: { dns: null, tcp: 1, tls: null, wait: 2, body: 3, total: 6 }, warnings: [] };
  const text = renderPanel(plain, { style: createStyle(false) }).join('\n');
  assert.ok(!/\bdns\b|\btls\b/.test(text));
});

test('renders a failed request', () => {
  const failed = {
    ...report,
    response: null,
    body: null,
    warnings: [],
    timing: { dns: 3, tcp: null, tls: null, wait: null, body: null, total: null },
    error: { kind: 'timeout', phase: 'connect', message: 'no connection after 10000 ms' },
  };
  const [head] = renderPanel(failed, { style: createStyle(false) });
  assert.equal(head, '✗ timeout during connect POST https://api.example.com/v1/chat/completions?key=REDACTED · no connection after 10000 ms');
});

test('draws the phase in progress while live', () => {
  const live = { ...report, response: null, body: null, warnings: [], timing: { dns: 10, tcp: 5, tls: null, wait: null, body: null, total: null } };
  const lines = renderPanel(live, { style: createStyle(false), cols: 80, live: { phase: 'waiting', elapsed: 115, frame: 0 } });
  assert.match(lines[0], /^⠋ waiting POST/);
  assert.match(lines[2], /wait 100 ms…$/);
});

test('the gap sparkline is flat for a steady stream and spikes on a stall', () => {
  const style = createStyle(false);
  const steady = renderPanel(report, { style, gaps: [20, 20.3, 19.9, 20.1] }).at(-2);
  assert.equal(steady, '▃▃▃▃');
  const stall = renderPanel(report, { style, gaps: [20, 20, 200, 20] }).at(-2);
  assert.equal(stall, '▃▃█▃');
});

test('a failed request shows the phase it failed in', () => {
  const failed = {
    ...report,
    response: null,
    body: null,
    warnings: [],
    timing: { dns: 10, tcp: 20, tls: null, wait: null, body: null, total: 100 },
    error: { kind: 'tls', phase: 'tls', message: 'certificate has expired' },
  };
  const legend = renderPanel(failed, { style: createStyle(false) })[2];
  assert.equal(legend, 'dns 10.0 ms  tcp 20.0 ms  tls 70.0 ms ✗');
});

test('the live run counter never passes the planned count', () => {
  const summary = { runs: 3, planned: 3, statuses: { 200: 3 }, failed: {}, timing: {}, request: { method: 'GET', url: 'http://x/' } };
  const [head] = renderRuns(summary, { style: createStyle(false), live: { frame: 0, elapsed: 5 } });
  assert.match(head, /run 3\/3/);
});

test('text from the server is made printable and kept on one line', () => {
  const hostile = {
    ...report,
    response: { status: 500, statusText: 'Oops\x1b]0;pwned\x07', reused: false },
    warnings: ['stream error: \x1b[2Jcleared\nsecond line'],
  };
  const text = renderPanel(hostile, { style: createStyle(true) }).join('\n');
  assert.ok(!/\x1b[\]\[](0;|2J)/.test(text));
  assert.match(text, /Oops␛\]0;pwned␇/);
  assert.match(text, /! stream error: ␛\[2Jcleared second line/);
  const failed = renderPanel({ ...report, error: { kind: 'tls', phase: 'tls', message: 'bad \x1b[31mcert' } }, { style: createStyle(false) })[0];
  assert.match(failed, /bad ␛\[31mcert/);
});
