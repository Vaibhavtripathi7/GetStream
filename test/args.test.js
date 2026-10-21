import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCli, parseUrl, parseHeader, duration, loadBody, defaultHeaders, UsageError } from '../lib/args.js';
import { redactHeader, redactHeaderRecord, redactUrl } from '../lib/redact.js';

const usage = (fn, pattern) => assert.throws(fn, (err) => err instanceof UsageError && pattern.test(err.message));

test('defaults to GET, and to POST when a body is given', () => {
  assert.equal(parseCli(['example.com']).method, 'GET');
  assert.equal(parseCli(['example.com', '-d', 'x']).method, 'POST');
  assert.equal(parseCli(['example.com', '-d', 'x', '-X', 'put']).method, 'PUT');
});

test('rejects a missing URL, extra arguments and unknown options', () => {
  usage(() => parseCli([]), /missing URL/);
  usage(() => parseCli(['a.com', 'b.com']), /one URL/);
  usage(() => parseCli(['a.com', '--nope']), /Unknown option/);
  usage(() => parseCli(['a.com', '-X', 'GET X']), /invalid method/);
});

test('accepts URLs the way curl and HTTPie do', () => {
  assert.equal(parseUrl('example.com/x').href, 'http://example.com/x');
  assert.equal(parseUrl(':3000/health').href, 'http://localhost:3000/health');
  assert.equal(parseUrl('https://[::1]:8443/').hostname, '[::1]');
  usage(() => parseUrl('ftp://example.com'), /unsupported scheme "ftp"/);
  usage(() => parseUrl('http://us%zzer:pw@example.com/'), /invalid % escape/);
  usage(() => parseUrl('http://exa mple.com/?key=secret'), /^invalid URL "http:\/\/exa mple.com\/"$/);
});

test('parses headers and never echoes a malformed one', () => {
  assert.deepEqual(parseHeader('X-Time: 12:30'), ['X-Time', '12:30']);
  assert.deepEqual(parseHeader('X-Empty:'), ['X-Empty', '']);
  assert.throws(() => parseHeader('Authorization Bearer sk-live-123'), (err) => !err.message.includes('sk-live'));
  usage(() => parseHeader('Bad Name: x'), /invalid header name/);
  usage(() => parseHeader('X-A: one\r\nX-B: two'), /line break/);
  usage(() => parseHeader('X-Price: 5 €'), /characters a header cannot carry/);
  assert.deepEqual(parseHeader('X-Latin: café'), ['X-Latin', 'café']);
});

test('reads durations in ms or seconds', () => {
  assert.equal(duration('500', 'x'), 500);
  assert.equal(duration('250ms', 'x'), 250);
  assert.equal(duration('1.5s', 'x'), 1500);
  usage(() => duration('soon', '--idle-timeout'), /--idle-timeout expects/);
  assert.equal(parseCli(['a.com']).idleTimeout, 60_000);
});

test('loads a body from a string, a file or stdin', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'req-args-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'body.json'), '{"a":1}');
  assert.equal((await loadBody('plain')).toString(), 'plain');
  assert.equal((await loadBody(`@${join(dir, 'body.json')}`)).toString(), '{"a":1}');
  assert.equal((await loadBody('@-', Readable.from([Buffer.from('from '), Buffer.from('stdin')]))).toString(), 'from stdin');
  assert.equal(await loadBody(null), null);
  await assert.rejects(loadBody(`@${join(dir, 'missing')}`), /no such file/);
});

test('adds defaults without overriding the user', () => {
  const json = defaultHeaders([], Buffer.from('{"a":1}'), { userAgent: 'req/x' });
  assert.deepEqual(json, [['User-Agent', 'req/x'], ['Accept', '*/*'], ['Content-Type', 'application/json']]);
  const text = defaultHeaders([['user-agent', 'me'], ['ACCEPT', 'text/plain']], Buffer.from('a=1'), { userAgent: 'req/x' });
  assert.deepEqual(text, [['user-agent', 'me'], ['ACCEPT', 'text/plain']]);
});

test('redacts credentials in headers and URLs', () => {
  assert.equal(redactHeader('Authorization', 'Bearer sk-abc'), 'Bearer REDACTED');
  assert.equal(redactHeader('authorization', 'Basic dXNlcjpwYXNz'), 'Basic REDACTED');
  assert.equal(redactHeader('x-api-key', 'abc'), 'REDACTED');
  assert.equal(redactHeader('Cookie', 'sid=1'), 'REDACTED');
  assert.equal(redactHeader('X-Session-Id', 'abc'), 'REDACTED');
  assert.equal(redactHeader('Content-Type', 'application/json'), 'application/json');
  assert.equal(
    redactUrl(new URL('https://user:pw@api.example.com/v1?key=abc&alt=sse&access_token=t')),
    'https://REDACTED:REDACTED@api.example.com/v1?key=REDACTED&alt=sse&access_token=REDACTED',
  );
  assert.equal(redactUrl(new URL('https://ghp_secret@api.github.com/user')), 'https://REDACTED@api.github.com/user');
  assert.deepEqual({ ...redactHeaderRecord({ 'set-cookie': ['sid=1', 'b=2'], etag: 'x' }) }, { 'set-cookie': ['REDACTED', 'REDACTED'], etag: 'x' });
  assert.equal(redactUrl(new URL('https://example.com/a?q=1')), 'https://example.com/a?q=1');
});
