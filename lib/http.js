import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream';
import { finished } from 'node:stream/promises';

// An ESM import of node:http also evaluates its WebSocket getters, which
// loads all of undici (about 50 ms). getBuiltinModule skips that, and lets
// https and zlib load only when a request needs them.
const builtin = (name) => process.getBuiltinModule(name);
const http = builtin('node:http');

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME']);
const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

export class RequestError extends Error {
  constructor(kind, phase, message, { cause, timing = null } = {}) {
    super(message, { cause });
    this.name = 'RequestError';
    this.kind = kind;
    this.phase = phase;
    this.timing = timing;
  }
}

// Wraps any error raised while reading a response body.
export function bodyError(err, timing) {
  if (err instanceof RequestError) return err;
  if (err.code?.startsWith('Z_') || err.code?.startsWith('ERR_BROTLI') || err.code?.startsWith('ERR_ZSTD')) {
    return new RequestError('protocol', 'body', `could not decode the body: ${err.message}`, { cause: err, timing });
  }
  if ((err.code === 'ECONNRESET' && err.message === 'aborted') || err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
    return new RequestError('network', 'body', 'connection closed before the body was complete', { cause: err, timing });
  }
  return new RequestError('network', 'body', describe(err), { cause: err, timing });
}

// Node only sets Host itself when headers are an object, so duplicates are
// folded into arrays under the first spelling of the name.
export function headerObject(pairs) {
  const out = Object.create(null);
  const names = new Map();
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    const key = names.get(lower);
    if (key === undefined) {
      names.set(lower, name);
      out[name] = value;
    } else {
      out[key] = [].concat(out[key], value);
    }
  }
  return out;
}

function emptyTiming() {
  return { dns: null, connect: null, tls: null, firstByte: null, end: null, failed: null, redirect: null };
}

// Timing marks are milliseconds since the request started. A mark stays
// null when its phase did not happen (IP literal, reused socket, plain http).
// For a failed request, total runs to the moment it failed.
export function phaseDurations(t) {
  const connected = t.tls ?? t.connect ?? t.dns ?? 0;
  const last = t.end ?? t.failed ?? null;
  return {
    redirect: t.redirect ?? null,
    dns: t.dns,
    tcp: t.connect === null ? null : t.connect - (t.dns ?? 0),
    tls: t.tls === null ? null : t.tls - t.connect,
    wait: t.firstByte === null ? null : t.firstByte - connected,
    body: t.end === null || t.firstByte === null ? null : t.end - t.firstByte,
    total: last === null ? null : last + (t.redirect ?? 0),
  };
}

export function send(request, options = {}) {
  const { url, method = 'GET', headers = [], body = null } = request;
  const {
    connectTimeout = 10_000,
    idleTimeout = 60_000,
    maxTime = 0,
    insecure = false,
    agent = false,
    signal = null,
    onMark = null,
  } = options;

  const secure = url.protocol === 'https:';
  const transport = secure ? builtin('node:https') : http;
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const literal = net.isIP(hostname) !== 0;
  const timing = emptyTiming();
  const attempts = [];
  const start = performance.now();
  const since = () => performance.now() - start;
  const mark = (name) => {
    timing[name] = since();
    onMark?.(name, timing);
  };

  return new Promise((resolve, reject) => {
    let response = null;
    let reused = false;

    const phase = () => {
      if (timing.firstByte !== null) return 'body';
      if (reused || (secure ? timing.tls : timing.connect) !== null) return 'wait';
      if (timing.connect !== null) return 'tls';
      if (!literal && timing.dns === null) return 'dns';
      return 'connect';
    };

    // Node validates headers, the agent and the URL's userinfo synchronously,
    // so the request is built before any timer exists.
    let req;
    try {
      const hasAuth = headers.some(([name]) => name.toLowerCase() === 'authorization');
      req = transport.request({
        hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method,
        headers: headerObject(headers),
        auth: url.username && !hasAuth
          ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
          : undefined,
        agent: typeof agent === 'function' ? agent(url) : agent,
        rejectUnauthorized: !insecure,
      });
    } catch (err) {
      reject(new RequestError('invalid', null, `cannot send this request: ${err.message}`, { cause: err, timing }));
      return;
    }

    const fail = (kind, message) => {
      timing.failed ??= since();
      (response ?? req).destroy(new RequestError(kind, phase(), message, { timing }));
    };

    const connectTimer = connectTimeout > 0
      ? setTimeout(() => fail('timeout', `no connection after ${connectTimeout} ms`), connectTimeout)
      : null;
    const maxTimer = maxTime > 0
      ? setTimeout(() => fail('timeout', `request took longer than ${maxTime} ms`), maxTime)
      : null;
    const onAbort = () => fail('aborted', 'request aborted');
    const cleanup = () => {
      clearTimeout(connectTimer);
      clearTimeout(maxTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted) {
      queueMicrotask(onAbort);
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }
    if (idleTimeout > 0) {
      req.setTimeout(idleTimeout, () => fail('timeout', `no data for ${idleTimeout} ms`));
    }

    req.on('socket', (socket) => {
      if (!socket.connecting) {
        reused = true;
        clearTimeout(connectTimer);
        return;
      }
      const settle = (address, error) => {
        const attempt = attempts.findLast((a) => a.address === address && a.end === null);
        if (attempt) Object.assign(attempt, { end: since(), error });
      };
      socket.once('lookup', (err) => {
        if (!err) mark('dns');
      });
      socket.on('connectionAttempt', (address) => {
        attempts.push({ address, start: since(), end: null, error: null });
      });
      socket.on('connectionAttemptFailed', (address, port, family, err) => settle(address, err?.code ?? 'failed'));
      socket.on('connectionAttemptTimeout', (address) => settle(address, 'timeout'));
      socket.once('connect', () => {
        mark('connect');
        settle(socket.remoteAddress, null);
        if (!secure) clearTimeout(connectTimer);
      });
      if (secure) {
        socket.once('secureConnect', () => {
          mark('tls');
          clearTimeout(connectTimer);
        });
      }
    });

    req.once('response', (res) => {
      response = res;
      mark('firstByte');
      res.once('end', () => mark('end'));
      res.once('close', cleanup);
      const { socket } = res;

      // A compressed body is decoded so streams can be parsed. Arrival times
      // then come from the compressed bytes, not from the decoder's output.
      const encoding = res.headers['content-encoding']?.trim().toLowerCase() ?? null;
      const decoder = decoderFor(encoding);
      const wire = { bytes: 0, last: null };
      if (decoder) {
        res.on('data', (chunk) => {
          wire.bytes += chunk.length;
          wire.last = since();
        });
        pipeline(res, decoder, () => {});
      }

      resolve({
        url,
        status: res.statusCode,
        statusMessage: res.statusMessage,
        httpVersion: res.httpVersion,
        headers: res.headers,
        rawHeaders: res.rawHeaders,
        remote: { address: socket.remoteAddress, port: socket.remotePort, family: socket.remoteFamily },
        tls: secure ? tlsInfo(socket) : null,
        reused,
        attempts,
        redirects: [],
        timing,
        elapsed: since,
        arrivedAt: decoder ? () => wire.last ?? since() : since,
        encoding: decoder ? encoding : null,
        wire,
        body: decoder ?? res,
      });
    });

    req.on('error', (err) => {
      timing.failed ??= since();
      cleanup();
      const error = classify(err, phase(), timing);
      // After the headers, Node gives the body only a generic "aborted";
      // the real cause (a malformed chunk, say) arrives here.
      if (response && !response.destroyed) response.destroy(error);
      reject(error);
    });

    req.end(body ?? undefined);
  });
}

// The first request in a process pays for lazy setup inside Node (socket
// handles, the HTTP parser, header handling): about 6 ms on loopback that
// would otherwise be reported as TCP and wait time. Two requests to a local
// throwaway socket move that cost to before the clock starts (a third gains
// nothing); the target server never sees them. A lookup of localhost starts
// the resolver's thread pool, and for https the root certificates are
// loaded as well.
let warmed = false;

export async function warmUp({ tls = false } = {}) {
  if (warmed) return;
  warmed = true;
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () => socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n'));
  });
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const url = new URL(`http://127.0.0.1:${server.address().port}/`);
    for (let i = 0; i < 2; i++) {
      const exchange = await send({ url }, { connectTimeout: 1000, idleTimeout: 1000 });
      exchange.body.resume();
      await finished(exchange.body);
    }
  } catch {
    // Warming up is an optimisation; a sandbox without loopback still works.
  } finally {
    server.close();
  }
  await builtin('node:dns').promises.lookup('localhost').catch(() => {});
  if (tls) builtin('node:tls').createSecureContext();
}

// Follows redirects up to maxRedirects. Earlier hops count toward the total
// and toward maxTime; credentials never cross to another origin.
export async function sendFollowing(request, options = {}) {
  const { maxRedirects = 0, maxTime = 0 } = options;
  const start = performance.now();
  const redirects = [];
  // An error between hops still reports the time the earlier hops took.
  const stop = (kind, message) => {
    const timing = { ...emptyTiming(), failed: 0, redirect: performance.now() - start };
    return new RequestError(kind, 'wait', message, { timing });
  };
  let current = request;
  for (;;) {
    const spent = performance.now() - start;
    if (maxTime > 0 && spent >= maxTime) throw stop('timeout', `request took longer than ${maxTime} ms`);
    let exchange;
    try {
      exchange = await send(current, { ...options, maxTime: maxTime > 0 ? maxTime - spent : 0 });
    } catch (err) {
      if (redirects.length > 0 && err.timing) err.timing.redirect = spent;
      throw err;
    }
    const location = exchange.headers.location;
    if (maxRedirects === 0 || !REDIRECT.has(exchange.status) || !location) {
      exchange.redirects = redirects;
      if (redirects.length > 0) exchange.timing.redirect = spent;
      return exchange;
    }
    exchange.body.resume();
    await finished(exchange.body).catch(() => {});
    if (redirects.length === maxRedirects) throw stop('protocol', `stopped after ${maxRedirects} redirects`);
    let next;
    try {
      next = new URL(location, current.url);
    } catch {
      throw stop('protocol', 'redirect with an invalid Location header');
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw stop('protocol', `refusing to follow a redirect to ${next.protocol}`);
    }
    redirects.push({ status: exchange.status, url: current.url });
    current = redirectRequest(current, exchange.status, next);
  }
}

const BODY_HEADERS = /^(content-type|content-length|content-encoding|transfer-encoding)$/i;
const ORIGIN_HEADERS = /^(authorization|proxy-authorization|cookie|host)$/i;

// Method rules from the fetch spec: 303 turns anything but HEAD into GET,
// 301 and 302 turn POST into GET, 307 and 308 keep method and body.
export function redirectRequest(previous, status, url) {
  let { method, headers, body } = previous;
  if ((status === 303 && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) {
    method = 'GET';
    body = null;
    headers = headers.filter(([name]) => !BODY_HEADERS.test(name));
  }
  if (url.origin !== previous.url.origin) headers = headers.filter(([name]) => !ORIGIN_HEADERS.test(name));
  return { url, method, headers, body };
}

function decoderFor(encoding) {
  if (!encoding || encoding === 'identity') return null;
  const zlib = builtin('node:zlib');
  const sync = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip(sync);
    case 'deflate':
      return zlib.createInflate(sync);
    case 'br':
      return zlib.createBrotliDecompress({
        flush: zlib.constants.BROTLI_OPERATION_FLUSH,
        finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
      });
    case 'zstd':
      return zlib.createZstdDecompress?.() ?? null;
    default:
      return null;
  }
}

function tlsInfo(socket) {
  return {
    protocol: socket.getProtocol(),
    cipher: socket.getCipher()?.name ?? null,
    alpn: socket.alpnProtocol || null,
    authorized: socket.authorized,
    authorizationError: socket.authorizationError ?? null,
  };
}

function classify(err, phase, timing) {
  if (err instanceof RequestError) return err;
  const code = err.code ?? '';
  let kind = 'network';
  let message = describe(err);
  if (DNS_CODES.has(code)) {
    kind = 'dns';
    message = `could not resolve ${err.hostname ?? 'host'} (${code})`;
  } else if (TLS_CODE.test(code) || phase === 'tls') {
    kind = 'tls';
  } else if (phase === 'dns' || phase === 'connect') {
    kind = 'connect';
  } else if (code.startsWith('HPE_')) {
    kind = 'protocol';
    message = `invalid HTTP response: ${err.reason ?? err.message}`;
  }
  return new RequestError(kind, phase, message, { cause: err, timing });
}

// Happy eyeballs failures arrive as an AggregateError with an empty message.
function describe(err) {
  if (err.message) return err.message;
  if (err.errors?.length) return err.errors.map((e) => e.message).join('; ');
  return err.code ?? String(err);
}
