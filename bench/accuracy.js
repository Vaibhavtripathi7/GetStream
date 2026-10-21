// How close are the event times req reports to the times the server
// actually sent each event? The mock server logs every send; req reports
// every arrival with --timeline. Gaps are compared, so the two processes'
// clocks never need to agree, only tick at the same rate.
import { summarize } from '../lib/stats.js';
import { CLI, exec, roundStats, save, startMock } from './common.js';

const CONFIGS = [
  { gap: 20, n: 200 },
  { gap: 5, n: 500 },
  { gap: 1, n: 1000 },
  { gap: 0, n: 2000 },
];
const RUNS = 5;

const mock = await startMock();
const results = [];
try {
  for (const { gap, n } of CONFIGS) {
    const errors = [];
    const signed = [];
    let firstTokenOk = 0;
    for (let run = 0; run < RUNS; run++) {
      const url = `${mock.base}/stream?n=${n}&gap=${gap}&ttft=50`;
      const { stdout, code } = await exec(process.execPath, [CLI, url, '--json', '--timeline']);
      if (code !== 0) throw new Error(`req exited with ${code}`);
      const report = JSON.parse(stdout);
      const sent = await (await fetch(`${mock.base}/log?id=${report.response.headers['x-run-id']}`)).json();
      const seen = report.body.timeline;
      if (seen.length !== sent.length) throw new Error(`saw ${seen.length} events, server sent ${sent.length}`);
      if (report.body.firstToken === seen[0] && report.body.deltas === n) firstTokenOk++;
      for (let i = 1; i < seen.length; i++) {
        const error = seen[i] - seen[i - 1] - (sent[i] - sent[i - 1]);
        errors.push(Math.abs(error));
        signed.push(error);
      }
    }
    const abs = summarize(errors);
    const bias = signed.reduce((a, b) => a + b, 0) / signed.length;
    results.push({ gap, events: n, runs: RUNS, gapsCompared: errors.length, absErrorMs: roundStats(abs, 4), meanErrorMs: Number(bias.toFixed(5)), firstTokenMatched: `${firstTokenOk}/${RUNS}` });
    console.log(`gap ${String(gap).padStart(2)} ms: |error| p50 ${abs.p50.toFixed(3)} ms  p99 ${abs.p99.toFixed(3)} ms  max ${abs.max.toFixed(3)} ms over ${errors.length} gaps`);
  }
} finally {
  mock.stop();
}
save('accuracy', { method: 'per-gap difference between req --timeline arrivals and mock-server send times', results });
