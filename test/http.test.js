import { test } from 'node:test';
import assert from 'node:assert/strict';
import { send, phaseDurations, headerObject, RequestError } from '../lib/http.js';
import { listen, readAll, selfSignedCert } from './helpers/server.js';

test('marks phases in order for a hostname', async (t) => {
  const srv = await listen((req, res) => res.end('ok'));
  t.after(srv.close);
  const url = srv.url('/');
  url.hostname = 'localhost';
  const ex = await send({ url });
  assert.equal((await readAll(ex.body)).toString(), 'ok');
  const { dns, connect, sent, firstByte, end } = ex.timing;
  assert.ok(dns !== null && dns <= connect && connect <= sent && sent <= firstByte && firstByte <= end);
  assert.equal(ex.timing.tls, null);
});

test('skips dns for an IP literal', async (t) => {
  const srv = await listen((req, res) => res.end());
  t.after(srv.close);
  const ex = await send({ url: srv.url('/') });
  await readAll(ex.body);
  assert.equal(ex.timing.dns, null);
  assert.equal(phaseDurations(ex.timing).dns, null);
  assert.ok(phaseDurations(ex.timing).tcp >= 0);
});

test('connects to an IPv6 literal and sends a bracketed Host', async (t) => {
  let srv;
  try {
    srv = await listen((req, res) => res.end(req.headers.host), { host: '::1' });
  } catch {
    t.skip('no IPv6 loopback');
    return;
  }
  t.after(srv.close);
  const ex = await send({ url: srv.url('/') });
  assert.equal((await readAll(ex.body)).toString(), `[::1]:${srv.port}`);
});

test('records the failed attempt when localhost falls back from ::1', async (t) => {
  const srv = await listen((req, res) => res.end());
  t.after(srv.close);
  const url = srv.url('/');
  url.hostname = 'localhost';
  const ex = await send({ url });
  await readAll(ex.body);
  assert.equal(ex.remote.address, '127.0.0.1');
  const failed = ex.attempts.filter((a) => a.error);
  if (ex.attempts.length > 1) assert.equal(failed[0].address, '::1');
});

test('keeps duplicate headers and their spelling', async (t) => {
  const srv = await listen((req, res) => res.end(JSON.stringify(req.rawHeaders)));
  t.after(srv.close);
  const headers = [['X-Tag', 'a'], ['x-tag', 'b'], ['Accept', 'text/plain']];
  const ex = await send({ url: srv.url('/'), headers });
  const raw = JSON.parse(await readAll(ex.body));
  assert.deepEqual(raw.slice(0, 6), ['X-Tag', 'a', 'X-Tag', 'b', 'Accept', 'text/plain']);
  assert.deepEqual(headerObject(headers), { 'X-Tag': ['a', 'b'], Accept: 'text/plain' });
});

test('sends a body with content-length', async (t) => {
  const srv = await listen(async (req, res) => {
    res.end(`${req.method} ${req.headers['content-length']} ${await readAll(req)}`);
  });
  t.after(srv.close);
  const ex = await send({ url: srv.url('/'), method: 'POST', body: Buffer.from('héllo') });
  assert.equal((await readAll(ex.body)).toString(), 'POST 6 héllo');
});

test('handles 204 and HEAD without a body', async (t) => {
  const srv = await listen((req, res) => {
    res.writeHead(req.url === '/empty' ? 204 : 200, { 'content-length': '5' });
    res.end(req.method === 'HEAD' ? undefined : req.url === '/empty' ? undefined : 'hello');
  });
  t.after(srv.close);
  const empty = await send({ url: srv.url('/empty') });
  assert.equal(empty.status, 204);
  assert.equal((await readAll(empty.body)).length, 0);
  const head = await send({ url: srv.url('/'), method: 'HEAD' });
  assert.equal((await readAll(head.body)).length, 0);
  assert.notEqual(head.timing.end, null);
});

test('times out while waiting for the response', async (t) => {
  const srv = await listen(() => {});
  t.after(srv.close);
  await assert.rejects(send({ url: srv.url('/') }, { idleTimeout: 80 }), (err) => {
    assert.ok(err instanceof RequestError);
    assert.equal(err.kind, 'timeout');
    assert.equal(err.phase, 'wait');
    return true;
  });
});

test('times out between body chunks without a total limit', async (t) => {
  const srv = await listen((req, res) => {
    res.write('first');
  });
  t.after(srv.close);
  const ex = await send({ url: srv.url('/') }, { idleTimeout: 80 });
  await assert.rejects(readAll(ex.body), (err) => err.kind === 'timeout' && err.phase === 'body');
});

test('a slow stream survives when every gap is under the idle timeout', async (t) => {
  const srv = await listen((req, res) => {
    let n = 0;
    const timer = setInterval(() => {
      res.write(`${n}\n`);
      if (++n === 5) {
        clearInterval(timer);
        res.end();
      }
    }, 40);
  });
  t.after(srv.close);
  const ex = await send({ url: srv.url('/') }, { idleTimeout: 150 });
  assert.equal((await readAll(ex.body)).toString(), '0\n1\n2\n3\n4\n');
  assert.ok(phaseDurations(ex.timing).total > 150);
});

test('max time covers the whole exchange', async (t) => {
  const srv = await listen((req, res) => {
    const timer = setInterval(() => res.write('.'), 20);
    res.on('close', () => clearInterval(timer));
  });
  t.after(srv.close);
  const ex = await send({ url: srv.url('/') }, { maxTime: 120 });
  await assert.rejects(readAll(ex.body), (err) => err.kind === 'timeout' && err.phase === 'body');
});

test('reports a refused connection as a connect error', async () => {
  const srv = await listen(() => {});
  const url = srv.url('/');
  await srv.close();
  await assert.rejects(send({ url }), (err) => err.kind === 'connect' && err.phase === 'connect');
});

test('reports an unknown host as a dns error', async () => {
  await assert.rejects(send({ url: new URL('http://does-not-exist.invalid/') }), (err) => err.kind === 'dns');
});

test('aborts through a signal', async (t) => {
  const srv = await listen(() => {});
  t.after(srv.close);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(send({ url: srv.url('/') }, { signal: controller.signal }), (err) => err.kind === 'aborted');
});

test('reports a malformed response as a protocol error', async (t) => {
  const srv = await listen(() => {});
  srv.server.on('connection', (socket) => socket.end('garbage\r\n\r\n'));
  t.after(srv.close);
  await assert.rejects(send({ url: srv.url('/') }), (err) => err.kind === 'protocol');
});

test('times the TLS handshake and rejects an untrusted certificate', async (t) => {
  const tls = selfSignedCert();
  if (!tls) {
    t.skip('openssl not available');
    return;
  }
  const srv = await listen((req, res) => res.end('secure'), { tls });
  t.after(srv.close);

  await assert.rejects(send({ url: srv.url('/') }), (err) => err.kind === 'tls');

  const ex = await send({ url: srv.url('/') }, { insecure: true });
  assert.equal((await readAll(ex.body)).toString(), 'secure');
  assert.ok(ex.timing.connect <= ex.timing.tls && ex.timing.tls <= ex.timing.firstByte);
  assert.match(ex.tls.protocol, /^TLSv1\.[23]$/);
  assert.equal(ex.tls.authorized, false);
});
