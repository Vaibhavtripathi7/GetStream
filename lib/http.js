import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { performance } from 'node:perf_hooks';

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME']);
const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;

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
  return new RequestError('network', 'body', describe(err), { cause: err, timing });
}

// Node only sets Host itself when headers are an object, so duplicates are
// folded into arrays under the first spelling of the name.
export function headerObject(pairs) {
  const out = {};
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

// Timing marks are milliseconds since the request started. A mark stays
// null when its phase did not happen (IP literal, reused socket, plain http).
export function phaseDurations(t) {
  const connected = t.tls ?? t.connect ?? t.dns ?? 0;
  return {
    dns: t.dns,
    tcp: t.connect === null ? null : t.connect - (t.dns ?? 0),
    tls: t.tls === null ? null : t.tls - t.connect,
    wait: t.firstByte === null ? null : t.firstByte - connected,
    body: t.end === null || t.firstByte === null ? null : t.end - t.firstByte,
    total: t.end === null ? null : t.end + (t.redirect ?? 0),
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
  } = options;

  const secure = url.protocol === 'https:';
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const literal = net.isIP(hostname) !== 0;
  const timing = { dns: null, connect: null, tls: null, sent: null, firstByte: null, end: null, redirect: null };
  const attempts = [];
  const start = performance.now();
  const since = () => performance.now() - start;

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

    const fail = (kind, message) => {
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

    const hasAuth = headers.some(([name]) => name.toLowerCase() === 'authorization');
    const req = (secure ? https : http).request({
      hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method,
      headers: headerObject(headers),
      auth: url.username && !hasAuth
        ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
        : undefined,
      agent,
      rejectUnauthorized: !insecure,
    });

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
        if (!err) timing.dns = since();
      });
      socket.on('connectionAttempt', (address, port, family) => {
        attempts.push({ address, family, start: since(), end: null, error: null });
      });
      socket.on('connectionAttemptFailed', (address, port, family, err) => settle(address, err?.code ?? 'failed'));
      socket.on('connectionAttemptTimeout', (address) => settle(address, 'timeout'));
      socket.once('connect', () => {
        timing.connect = since();
        settle(socket.remoteAddress, null);
        if (!secure) clearTimeout(connectTimer);
      });
      if (secure) {
        socket.once('secureConnect', () => {
          timing.tls = since();
          clearTimeout(connectTimer);
        });
      }
    });

    req.once('finish', () => {
      timing.sent = since();
    });

    req.once('response', (res) => {
      response = res;
      timing.firstByte = since();
      res.once('end', () => {
        timing.end = since();
      });
      res.once('close', cleanup);
      const { socket } = res;
      resolve({
        url,
        method,
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
        body: res,
      });
    });

    req.on('error', (err) => {
      cleanup();
      reject(classify(err, phase(), timing));
    });

    req.end(body ?? undefined);
  });
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
