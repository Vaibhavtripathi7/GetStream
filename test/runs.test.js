import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { aggregateRuns } from '../lib/report.js';
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
