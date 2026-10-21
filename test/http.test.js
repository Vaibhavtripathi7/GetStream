import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { send, sendFollowing, redirectRequest, bodyError, phaseDurations, headerObject, RequestError } from '../lib/http.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { listen, readAll, selfSignedCert } from './helpers/server.js';

test('marks phases in order for a hostname', async (t) => {
  const srv = await listen((req, res) => res.end('ok'));
  t.after(srv.close);
  const url = srv.url('/');
  url.hostname = 'localhost';
  const ex = await send({ url });
  assert.equal((await readAll(ex.body)).toString(), 'ok');
  const { dns, connect, firstByte, end } = ex.timing;
  assert.ok(dns !== null && dns <= connect && connect <= firstByte && firstByte <= end);
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
  assert.deepEqual({ ...headerObject(headers) }, { 'X-Tag': ['a', 'b'], Accept: 'text/plain' });
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

test('follows redirects and counts the earlier hops in the total', async (t) => {
  const srv = await listen((req, res) => {
    if (req.url === '/old') {
      res.writeHead(301, { location: '/mid' });
      res.end('moved');
    } else if (req.url === '/mid') {
      setTimeout(() => {
        res.writeHead(302, { location: `http://127.0.0.1:${srv.port}/new?x=1` });
        res.end();
      }, 30);
    } else {
      res.end(`${req.method} ${req.url}`);
    }
  });
  t.after(srv.close);
  const ex = await sendFollowing({ url: srv.url('/old') }, { maxRedirects: 10 });
  assert.equal((await readAll(ex.body)).toString(), 'GET /new?x=1');
  assert.deepEqual(ex.redirects.map((r) => r.status), [301, 302]);
  assert.ok(ex.timing.redirect >= 30);
  assert.ok(phaseDurations(ex.timing).total >= ex.timing.redirect + ex.timing.end);

  const stay = await sendFollowing({ url: srv.url('/old') });
  assert.equal(stay.status, 301);
  await readAll(stay.body);
});

test('stops a redirect loop and refuses non-http targets', async (t) => {
  const srv = await listen((req, res) => {
    res.writeHead(302, { location: req.url === '/ftp' ? 'ftp://example.com/' : '/loop' });
    res.end();
  });
  t.after(srv.close);
  await assert.rejects(sendFollowing({ url: srv.url('/loop') }, { maxRedirects: 3 }), /stopped after 3 redirects/);
  await assert.rejects(sendFollowing({ url: srv.url('/ftp') }, { maxRedirects: 3 }), /refusing to follow a redirect to ftp:/);
});

test('applies the fetch rules for method and body on redirect', () => {
  const post = {
    url: new URL('http://a.test/form'),
    method: 'POST',
    headers: [['Content-Type', 'application/json'], ['Authorization', 'Bearer t'], ['X-Keep', '1']],
    body: Buffer.from('{}'),
  };
  const same = new URL('http://a.test/next');
  const other = new URL('https://b.test/next');

  const r302 = redirectRequest(post, 302, same);
  assert.equal(r302.method, 'GET');
  assert.equal(r302.body, null);
  assert.deepEqual(r302.headers, [['Authorization', 'Bearer t'], ['X-Keep', '1']]);

  const r307 = redirectRequest(post, 307, same);
  assert.equal(r307.method, 'POST');
  assert.equal(r307.body.toString(), '{}');

  const r303 = redirectRequest({ ...post, method: 'PUT' }, 303, same);
  assert.equal(r303.method, 'GET');
  assert.equal(redirectRequest({ ...post, method: 'HEAD' }, 303, same).method, 'HEAD');
  assert.equal(redirectRequest({ ...post, method: 'PUT' }, 302, same).method, 'PUT');

  const cross = redirectRequest({ ...post, headers: [...post.headers, ['Cookie', 'a=1'], ['Host', 'a.test']] }, 308, other);
  assert.deepEqual(cross.headers.map(([n]) => n), ['Content-Type', 'X-Keep']);
});

test('does not send credentials to another origin', async (t) => {
  const seen = [];
  const target = await listen((req, res) => {
    seen.push(req.headers.authorization ?? null);
    res.end();
  });
  t.after(target.close);
  const origin = await listen((req, res) => {
    seen.push(req.headers.authorization ?? null);
    if (req.url === '/done') return res.end();
    res.writeHead(302, { location: req.url === '/same' ? '/done' : target.url('/done').href });
    res.end();
  });
  t.after(origin.close);
  const headers = [['Authorization', 'Bearer secret']];
  await readAll((await sendFollowing({ url: origin.url('/same'), headers }, { maxRedirects: 5 })).body);
  await readAll((await sendFollowing({ url: origin.url('/other'), headers }, { maxRedirects: 5 })).body);
  assert.deepEqual(seen, ['Bearer secret', 'Bearer secret', 'Bearer secret', null]);
});

test('decodes gzip, deflate and br and keeps the wire size', async (t) => {
  const text = 'stream '.repeat(5000);
  const encoders = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync };
  const srv = await listen((req, res) => {
    const name = req.url.slice(1);
    res.writeHead(200, { 'content-encoding': name });
    res.end(encoders[name](text));
  });
  t.after(srv.close);
  for (const name of Object.keys(encoders)) {
    const ex = await send({ url: srv.url(`/${name}`) });
    assert.equal((await readAll(ex.body)).toString(), text, name);
    assert.equal(ex.encoding, name);
    assert.ok(ex.wire.bytes > 0 && ex.wire.bytes < text.length / 10, name);
  }
});

test('a gzip SSE stream is decoded event by event', async (t) => {
  const srv = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    const gzip = zlib.createGzip();
    gzip.pipe(res);
    let n = 0;
    const timer = setInterval(() => {
      gzip.write(`data: ${n}\n\n`);
      gzip.flush();
      if (++n === 3) {
        clearInterval(timer);
        gzip.end();
      }
    }, 30);
  });
  t.after(srv.close);
  const ex = await send({ url: srv.url('/') });
  const arrivals = [];
  ex.body.on('data', () => arrivals.push(ex.arrivedAt()));
  assert.equal((await readAll(ex.body)).toString(), 'data: 0\n\ndata: 1\n\ndata: 2\n\n');
  assert.ok(arrivals.length >= 3);
});

test('reports a corrupt compressed body as a protocol error', async (t) => {
  const srv = await listen((req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end('this is not gzip');
  });
  t.after(srv.close);
  const ex = await send({ url: srv.url('/') });
  await assert.rejects(readAll(ex.body).catch((err) => { throw bodyError(err, ex.timing); }), (err) => err.kind === 'protocol');
});

test('an empty compressed reply is fine', async (t) => {
  const srv = await listen((req, res) => {
    res.writeHead(204, { 'content-encoding': 'gzip' });
    res.end();
  });
  t.after(srv.close);
  const ex = await send({ url: srv.url('/') });
  assert.equal((await readAll(ex.body)).length, 0);
});

test('a request Node refuses to build fails at once and leaves no timer behind', async () => {
  const started = performance.now();
  await assert.rejects(
    send({ url: new URL('http://127.0.0.1:9/'), headers: [['X-A', '€']] }, { connectTimeout: 50, maxTime: 60 }),
    (err) => err.kind === 'invalid' && /cannot send this request/.test(err.message),
  );
  assert.ok(performance.now() - started < 50);
  // a leaked timer would fire here and throw inside the test process
  await sleep(100);
});

test('a header named like an Object property is sent as a header', async (t) => {
  const srv = await listen((req, res) => res.end(JSON.stringify(req.rawHeaders)));
  t.after(srv.close);
  const ex = await send({ url: srv.url('/'), headers: [['__proto__', 'x'], ['constructor', 'y']] });
  const raw = JSON.parse(await readAll(ex.body));
  assert.deepEqual(raw.slice(0, 4), ['__proto__', 'x', 'constructor', 'y']);
});

test('a failure after a redirect keeps the time of the earlier hops', async (t) => {
  const srv = await listen((req, res) => {
    if (req.url === '/hang') return;
    setTimeout(() => {
      res.writeHead(302, { location: req.url === '/loop' ? '/loop' : '/hang' });
      res.end();
    }, 20);
  });
  t.after(srv.close);

  await assert.rejects(sendFollowing({ url: srv.url('/start') }, { maxRedirects: 5, idleTimeout: 80 }), (err) => {
    assert.equal(err.kind, 'timeout');
    assert.ok(err.timing.redirect >= 20);
    assert.ok(phaseDurations(err.timing).total >= err.timing.redirect + 80);
    return true;
  });
  await assert.rejects(sendFollowing({ url: srv.url('/loop') }, { maxRedirects: 2 }), (err) => {
    assert.match(err.message, /stopped after 2 redirects/);
    assert.ok(phaseDurations(err.timing).total >= 40);
    return true;
  });
});

test('a signal that is already aborted stops the request', async (t) => {
  const srv = await listen((req, res) => res.end());
  t.after(srv.close);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(send({ url: srv.url('/') }, { signal: controller.signal }), (err) => err.kind === 'aborted');
});

test('rejects a redirect whose Location is not a URL', async (t) => {
  const srv = await listen((req, res) => {
    res.writeHead(302, { location: 'http://[broken' });
    res.end();
  });
  t.after(srv.close);
  await assert.rejects(sendFollowing({ url: srv.url('/') }, { maxRedirects: 3 }), /invalid Location header/);
});

test('passes an unknown encoding through and decodes zstd where Node can', async (t) => {
  const srv = await listen((req, res) => {
    if (req.url === '/zstd') {
      res.writeHead(200, { 'content-encoding': 'zstd' });
      return res.end(zlib.zstdCompressSync('zstd body'));
    }
    res.writeHead(200, { 'content-encoding': 'compress' });
    res.end('as sent');
  });
  t.after(srv.close);
  const unknown = await send({ url: srv.url('/') });
  assert.equal((await readAll(unknown.body)).toString(), 'as sent');
  assert.equal(unknown.encoding, null);
  if (zlib.zstdCompressSync) {
    const zstd = await send({ url: srv.url('/zstd') });
    assert.equal((await readAll(zstd.body)).toString(), 'zstd body');
  }
});
