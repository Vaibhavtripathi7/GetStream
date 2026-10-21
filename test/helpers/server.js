import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function listen(handler, { host = '127.0.0.1', tls = null } = {}) {
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  await new Promise((resolve) => server.listen(0, host, resolve));
  const { port } = server.address();
  const name = host.includes(':') ? `[${host}]` : host;
  const base = new URL(`${tls ? 'https' : 'http'}://${name}:${port}`);
  return {
    server,
    port,
    url: (path = '/') => new URL(path, base),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

// A throwaway self-signed certificate, generated per test run and deleted
// right away so no key material ever lives in the repository.
export function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), 'req-test-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
