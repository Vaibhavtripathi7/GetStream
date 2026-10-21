import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';

export class UsageError extends Error {
  name = 'UsageError';
}

const OPTIONS = {
  method: { type: 'string', short: 'X' },
  header: { type: 'string', short: 'H', multiple: true, default: [] },
  data: { type: 'string', short: 'd' },
  insecure: { type: 'boolean', short: 'k', default: false },
  'connect-timeout': { type: 'string', default: '10s' },
  'idle-timeout': { type: 'string', default: '60s' },
  'max-time': { type: 'string', default: '0' },
  include: { type: 'boolean', short: 'i', default: false },
  quiet: { type: 'boolean', short: 'q', default: false },
  json: { type: 'boolean', default: false },
  timeline: { type: 'boolean', default: false },
  raw: { type: 'boolean', default: false },
  'no-tui': { type: 'boolean', default: false },
  'no-color': { type: 'boolean', default: false },
  fail: { type: 'boolean', short: 'f', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'V', default: false },
};

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values: v, positionals } = parsed;
  if (v.help || v.version) return { help: v.help, version: v.version };
  if (positionals.length === 0) throw new UsageError('missing URL');
  if (positionals.length > 1) throw new UsageError(`expected one URL, got ${positionals.length} arguments`);

  const method = (v.method ?? (v.data === undefined ? 'GET' : 'POST')).toUpperCase();
  if (!TOKEN.test(method)) throw new UsageError(`invalid method "${method}"`);

  return {
    url: parseUrl(positionals[0]),
    method,
    headers: v.header.map(parseHeader),
    data: v.data ?? null,
    insecure: v.insecure,
    connectTimeout: duration(v['connect-timeout'], '--connect-timeout'),
    idleTimeout: duration(v['idle-timeout'], '--idle-timeout'),
    maxTime: duration(v['max-time'], '--max-time'),
    include: v.include,
    quiet: v.quiet,
    json: v.json,
    timeline: v.timeline,
    raw: v.raw,
    tui: !v['no-tui'],
    color: !v['no-color'],
    fail: v.fail,
  };
}

// "example.com/x" and ":3000/x" are accepted the way curl and HTTPie accept them.
export function parseUrl(input) {
  let text = input;
  if (text.startsWith(':')) text = `localhost${text}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new UsageError(`invalid URL "${input.split('?')[0]}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`unsupported scheme "${url.protocol.slice(0, -1)}", use http or https`);
  }
  return url;
}

// Error messages never echo the value: a mistyped header is often a credential.
export function parseHeader(raw) {
  const colon = raw.indexOf(':');
  if (colon <= 0) throw new UsageError('a header must look like "Name: value"');
  const name = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();
  if (!TOKEN.test(name)) throw new UsageError(`invalid header name "${name}"`);
  if (/[\r\n\0]/.test(value)) throw new UsageError(`the value of ${name} contains a line break`);
  return [name, value];
}

export function duration(text, flag) {
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(text);
  if (!match) throw new UsageError(`${flag} expects a duration like 500, 500ms or 10s`);
  return Math.round(Number(match[1]) * (match[2] === 's' ? 1000 : 1));
}

export async function loadBody(data, stdin = process.stdin) {
  if (data === null) return null;
  if (data === '@-') {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  if (data.startsWith('@')) {
    const path = data.slice(1);
    try {
      return await readFile(path);
    } catch (err) {
      throw new UsageError(`cannot read ${path}: ${err.code === 'ENOENT' ? 'no such file' : err.message}`);
    }
  }
  return Buffer.from(data);
}

// curl-like defaults that a server may rely on, never overriding the user.
export function defaultHeaders(headers, body, { userAgent }) {
  const has = (name) => headers.some(([n]) => n.toLowerCase() === name);
  const out = [...headers];
  if (!has('user-agent')) out.push(['User-Agent', userAgent]);
  if (!has('accept')) out.push(['Accept', '*/*']);
  if (body && body.length > 0 && !has('content-type') && isJson(body)) out.push(['Content-Type', 'application/json']);
  return out;
}

function isJson(body) {
  try {
    JSON.parse(body.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}
