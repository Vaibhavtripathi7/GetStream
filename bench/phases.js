// Phase timings for a real HTTPS request, req next to curl (forced to
// HTTP/1.1, which is what req speaks). Runs alternate so both see the same
// network conditions. Needs internet; the URL can be passed as an argument.
import { summarize } from '../lib/stats.js';
import { CLI, exec, round, save } from './common.js';

const url = process.argv[2] ?? 'https://example.com/';
const N = 40;
const PHASES = ['dns', 'tcp', 'tls', 'wait', 'total'];
const CURL_FORMAT = '%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}';

const samples = { req: Object.fromEntries(PHASES.map((p) => [p, []])), curl: Object.fromEntries(PHASES.map((p) => [p, []])) };

for (let i = 0; i < N; i++) {
  const r = await exec(process.execPath, [CLI, url, '--json']);
  const t = JSON.parse(r.stdout).timing;
  for (const p of PHASES) samples.req[p].push(t[p]);

  const c = await exec('curl', ['--http1.1', '-s', '-o', '/dev/null', '-w', CURL_FORMAT, url]);
  const [dns, connect, tls, start, total] = c.stdout.split(' ').map((v) => Number(v) * 1000);
  const curl = { dns, tcp: connect - dns, tls: tls - connect, wait: start - tls, total };
  for (const p of PHASES) samples.curl[p].push(curl[p]);
}

const medians = PHASES.map((phase) => ({
  phase,
  req: round(summarize(samples.req[phase]).p50, 2),
  curl: round(summarize(samples.curl[phase]).p50, 2),
}));
for (const m of medians) console.log(`${m.phase.padEnd(6)} req ${String(m.req).padStart(8)} ms   curl ${String(m.curl).padStart(8)} ms`);

save('phases', { method: `${N} alternating runs each, medians; curl --http1.1`, url, medians });
