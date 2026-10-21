import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
export const RSS_PROBE = fileURLToPath(new URL('./rss-probe.js', import.meta.url));

export async function startMock() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./mock-server.js', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [line] = await once(child.stdout, 'data');
  const { port } = JSON.parse(line);
  return { base: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

// Runs a command to completion; `wall` is spawn-to-exit in ms.
export function exec(cmd, args, { stdout = 'pipe', env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(cmd, args, { stdio: ['ignore', stdout, 'pipe'], env });
    const out = [];
    let err = '';
    child.stdout?.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, wall: performance.now() - start, stdout: Buffer.concat(out).toString(), stderr: err });
    });
  });
}

export function machine() {
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model.trim(),
    cores: cpus.length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
    os: `${os.type()} ${os.release()}`,
    date: new Date().toISOString(),
  };
}

export function save(name, data) {
  const dir = fileURLToPath(new URL('./results/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${name}.json`, `${JSON.stringify({ machine: machine(), ...data }, null, 2)}\n`);
}

export const round = (v, digits = 3) => (v === null || v === undefined ? null : Number(v.toFixed(digits)));

export function roundStats(s, digits = 3) {
  return s && Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'count' ? v : round(v, digits)]));
}
