import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { aggregateRuns, buildReport } from '../lib/report.js';
import { runOnce } from '../lib/run.js';
import { StreamMeter } from '../lib/stream.js';
import { renderRuns } from '../lib/term/panel.js';
import { createStyle } from '../lib/term/style.js';
import { listen } from './helpers/server.js';

const CLI = new URL('../bin/cli.js', import.meta.url).pathname;

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const report = (total, extra = {}) => ({
  request: { method: 'GET', url: 'http://x/' },
  response: { status: 200, reused: false },
  timing: { dns: null, tcp: 1, tls: null, wait: total - 2, body: 1, total },
  body: { firstToken: null, tokensPerSecond: null, deltasPerSecond: null },
  error: null,
  ...extra,
});

test('aggregates timing across runs and leaves failures out of it', () => {
  const failed = report(0, { response: null, timing: null, body: null, error: { kind: 'timeout' } });
  const summary = aggregateRuns([report(10), report(20), failed, report(30)], 5);
  assert.equal(summary.runs, 4);
  assert.equal(summary.planned, 5);
  assert.equal(summary.ok, 3);
  assert.deepEqual(summary.failed, { timeout: 1 });
  assert.deepEqual(summary.statuses, { 200: 3 });
  assert.equal(summary.timing.total.p50, 20);
  assert.equal(summary.timing.dns, null);
  assert.equal(summary.samples.length, 4);
});

test('the runs table only shows phases that have samples', () => {
  const lines = renderRuns(aggregateRuns([report(10), report(12)]), { style: createStyle(false) });
  const text = lines.join('\n');
  assert.match(text, /^2 runs GET http:\/\/x\//);
  assert.match(text, /^tcp +2 +1\.0 ms/m);
  assert.ok(!/^dns/m.test(text));
  assert.ok(!/first token/.test(text));
});

test('--runs with --json reports percentiles per phase', async (t) => {
  const srv = await listen((req, res) => res.end('ok'));
  t.after(srv.close);
  const { code, stdout } = await run([srv.url('/').href, '-n', '5', '--json']);
  assert.equal(code, 0);
  const summary = JSON.parse(stdout);
  assert.equal(summary.runs, 5);
  assert.equal(summary.timing.tcp.count, 5);
  assert.equal(summary.timing.total.count, 5);
  assert.ok(summary.timing.total.min <= summary.timing.total.p50);
});

test('--keep-alive connects once and reuses the socket', async (t) => {
  const sockets = new Set();
  const srv = await listen((req, res) => {
    sockets.add(req.socket);
    res.end('ok');
  });
  t.after(srv.close);
  const { stdout } = await run([srv.url('/').href, '-n', '4', '--keep-alive', '--json']);
  const summary = JSON.parse(stdout);
  assert.equal(sockets.size, 1);
  assert.equal(summary.timing.tcp.count, 1);
  assert.equal(summary.timing.wait.count, 4);
  assert.deepEqual(summary.samples.map((s) => s.reused), [false, true, true, true]);
});

test('counts failed runs and exits with the timeout code', async (t) => {
  let n = 0;
  const srv = await listen((req, res) => {
    if (++n === 2) return;
    res.end('ok');
  });
  t.after(srv.close);
  const { code, stderr } = await run([srv.url('/').href, '-n', '3', '--idle-timeout', '400ms']);
  assert.equal(code, 3);
  assert.match(stderr, /2 × 200 {2}· {2}1 × timeout error/);
});

test('rejects a run count that is not a positive whole number', async () => {
  for (const n of ['0', '-1', '2.5', 'many']) {
    assert.equal((await run(['example.com', '-n', n])).code, 1);
  }
});

test('warns when the first address failed and another was used', () => {
  const exchange = {
    url: new URL('http://localhost/'), status: 200, statusMessage: 'OK', httpVersion: '1.1', headers: {},
    remote: { address: '127.0.0.1' }, tls: null, reused: false, redirects: [], encoding: null,
    attempts: [{ address: '::1', start: 1, end: 1.5, error: 'ECONNREFUSED' }, { address: '127.0.0.1', start: 1.5, end: 2, error: null }],
    timing: { dns: 1, connect: 2, tls: null, firstByte: 3, end: 4, failed: null, redirect: null },
  };
  const report = buildReport({ request: { method: 'GET', url: exchange.url, headers: [], body: null }, exchange });
  assert.deepEqual(report.warnings, ['::1 failed with ECONNREFUSED after 0.5 ms, used 127.0.0.1']);
});

test('a bug inside the tool is thrown, not reported as a network error', async () => {
  const srv = await listen((req, res) => res.end('ok'));
  try {
    const output = { head() { throw new TypeError('bug'); }, write: () => true, end() {} };
    const options = { connectTimeout: 1000, idleTimeout: 1000, maxTime: 0, insecure: false, location: false, timeline: false };
    await assert.rejects(runOnce({ url: srv.url('/'), method: 'GET', headers: [], body: null }, options, output), TypeError);
  } finally {
    await srv.close();
  }
});

test('the live aggregate leaves out the per-run samples', () => {
  assert.equal(aggregateRuns([report(10)], 1, { samples: false }).samples, undefined);
  assert.equal(aggregateRuns([report(10)], 1).samples.length, 1);
});

test('warns when an event stream carries no events', () => {
  const meter = new StreamMeter({ contentType: 'text/event-stream' });
  meter.push(Buffer.from('{"error":{"code":503,"message":"high demand"}}\n'), 1);
  meter.finish(2);
  const report = buildReport({ request: { method: 'POST', url: new URL('http://x/'), headers: [], body: null }, meter });
  assert.deepEqual(report.warnings, ['labelled text/event-stream, but no events arrived (the body is shown as received)']);
});
