#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { send, phaseDurations, bodyError } from '../lib/http.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    method: { type: 'string', short: 'X' },
    header: { type: 'string', short: 'H', multiple: true, default: [] },
    data: { type: 'string', short: 'd' },
    timeout: { type: 'string', short: 't', default: '60000' },
  },
});

const target = positionals[0];
if (!target) {
  console.error('usage: req [-X method] [-H "name: value"] [-d body|@file] <url>');
  process.exit(1);
}

const headers = values.header.map((h) => {
  const i = h.indexOf(':');
  return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
});
const body = values.data?.startsWith('@') ? readFileSync(values.data.slice(1)) : values.data;

try {
  const ex = await send(
    { url: new URL(target), method: values.method ?? (body ? 'POST' : 'GET'), headers, body },
    { idleTimeout: Number(values.timeout) },
  );
  await pipeline(ex.body, process.stdout, { end: false }).catch((err) => {
    throw bodyError(err, ex.timing);
  });
  const d = phaseDurations(ex.timing);
  const ms = (v) => (v === null ? '-' : `${v.toFixed(1)}ms`);
  console.error(`${ex.status} dns ${ms(d.dns)} tcp ${ms(d.tcp)} tls ${ms(d.tls)} wait ${ms(d.wait)} body ${ms(d.body)} total ${ms(d.total)}`);
} catch (err) {
  console.error(`error (${err.phase ?? 'request'}): ${err.message}`);
  process.exit(err.kind === 'timeout' ? 3 : 2);
}
