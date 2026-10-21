import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { listen, readAll } from './helpers/server.js';

const CLI = new URL('../bin/cli.js', import.meta.url).pathname;

function run(args, { input = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, NO_COLOR: '1' } });
    const stdout = [];
    let stderr = '';
    child.stdout.on('data', (c) => stdout.push(c));
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.end(input ?? undefined);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr }));
  });
}

async function server(t, handler) {
  const srv = await listen(handler);
  t.after(srv.close);
  return srv;
}

test('writes the body untouched to stdout and the summary to stderr', async (t) => {
  const payload = randomBytes(256 * 1024);
  const srv = await server(t, (req, res) => res.end(payload));
  const { code, stdout, stderr } = await run([srv.url('/bin').href]);
  assert.equal(code, 0);
  assert.ok(stdout.equals(payload));
  assert.match(stderr, /^200 OK GET http:\/\/127\.0\.0\.1:\d+\/bin · /);
  assert.match(stderr, /tcp .* wait .* body /);
});

test('exit codes: usage 1, network 2, timeout 3, --fail 4', async (t) => {
  const srv = await server(t, (req, res) => {
    if (req.url === '/hang') return;
    res.statusCode = 404;
    res.end('missing');
  });
  assert.equal((await run([])).code, 1);
  assert.equal((await run([srv.url('/x').href])).code, 0);
  assert.equal((await run([srv.url('/x').href, '--fail'])).code, 4);
  assert.equal((await run([srv.url('/hang').href, '--idle-timeout', '100ms'])).code, 3);
  const closed = await listen(() => {});
  await closed.close();
  const refused = await run([closed.url('/').href]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /✗ connect during connect/);
});

test('sends a JSON body as POST with a content type', async (t) => {
  const srv = await server(t, async (req, res) => {
    res.end(`${req.method} ${req.headers['content-type']} ${req.headers['user-agent']} ${await readAll(req)}`);
  });
  const { stdout } = await run([srv.url('/').href, '-d', '{"q":1}']);
  assert.match(stdout.toString(), /^POST application\/json req\/\d+\.\d+\.\d+ \{"q":1\}$/);
});

test('reads the body from stdin', async (t) => {
  const srv = await server(t, async (req, res) => res.end(await readAll(req)));
  const { stdout } = await run([srv.url('/').href, '-d', '@-', '-X', 'PUT'], { input: 'piped body' });
  assert.equal(stdout.toString(), 'piped body');
});

test('--include prints the status line and headers first', async (t) => {
  const srv = await server(t, (req, res) => {
    res.setHeader('X-Probe', 'yes');
    res.end('body');
  });
  const { stdout } = await run([srv.url('/').href, '-i']);
  assert.match(stdout.toString(), /^HTTP\/1\.1 200 OK\nX-Probe: yes\n[\s\S]*\n\nbody$/);
});

test('--json reports a stream and redacts credentials', async (t) => {
  const srv = await server(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
    setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'), 30);
  });
  const url = srv.url('/v1/chat?key=sk-test-123');
  const { code, stdout } = await run([url.href, '--json', '--timeline', '-H', 'Authorization: Bearer sk-test-456']);
  assert.equal(code, 0);
  const text = stdout.toString();
  assert.ok(!text.includes('sk-test'));
  const report = JSON.parse(text);
  assert.equal(report.request.headers.Authorization, 'Bearer REDACTED');
  assert.match(report.request.url, /key=REDACTED/);
  assert.equal(report.body.kind, 'sse');
  assert.equal(report.body.provider, 'openai');
  assert.equal(report.body.outputTokens, 2);
  // A busy machine can read both writes at once, so only the order is fixed here.
  const [first, second] = report.body.timeline;
  assert.equal(report.body.timeline.length, 2);
  assert.ok(first === report.body.firstToken && first <= second && second === report.body.lastToken);
  assert.ok(report.timing.total >= report.body.lastToken);
  assert.deepEqual(report.warnings, []);
});

test('stops quietly when the reader closes the pipe', async (t) => {
  const srv = await server(t, (req, res) => {
    const chunk = Buffer.alloc(64 * 1024, 97);
    const timer = setInterval(() => res.write(chunk), 1);
    res.on('close', () => clearInterval(timer));
  });
  const child = spawn(process.execPath, [CLI, srv.url('/').href]);
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  child.stdout.once('data', () => child.stdout.destroy());
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.equal(stderr, '');
});
