// What req costs compared with curl on the same local request: wall time
// from spawn to exit, and whether both agree on time to first byte when
// the server is known to wait 100 ms.
import { summarize } from '../lib/stats.js';
import { CLI, exec, roundStats, save, startMock } from './common.js';

const N = 30;
const WARMUP = 3;

async function sample(cmd, args, n = N) {
  for (let i = 0; i < WARMUP; i++) await exec(cmd, args, { stdout: 'ignore' });
  const walls = [];
  for (let i = 0; i < n; i++) walls.push((await exec(cmd, args, { stdout: 'ignore' })).wall);
  return roundStats(summarize(walls));
}

const mock = await startMock();
try {
  const fast = `${mock.base}/delay?ms=0&size=1024`;
  const wall = {
    nodeStartup: await sample(process.execPath, ['-e', '']),
    req: await sample(process.execPath, [CLI, fast, '--no-tui']),
    curl: await sample('curl', ['-s', '-o', '/dev/null', fast]),
  };
  console.log(`wall p50: node -e '' ${wall.nodeStartup.p50} ms, req ${wall.req.p50} ms, curl ${wall.curl.p50} ms`);

  const slow = `${mock.base}/delay?ms=100&size=1024`;
  const req = { connect: [], ttfb: [] };
  const curl = { connect: [], ttfb: [] };
  for (let i = 0; i < N; i++) {
    const r = JSON.parse((await exec(process.execPath, [CLI, slow, '--json'])).stdout);
    req.connect.push(r.timing.tcp);
    req.ttfb.push(r.timing.tcp + r.timing.wait);
    const c = await exec('curl', ['-s', '-o', '/dev/null', '-w', '%{time_connect} %{time_starttransfer}', slow]);
    const [connect, start] = c.stdout.split(' ').map((v) => Number(v) * 1000);
    curl.connect.push(connect);
    curl.ttfb.push(start);
  }
  const ttfb = {
    serverDelayMs: 100,
    req: { connect: roundStats(summarize(req.connect)), ttfb: roundStats(summarize(req.ttfb)) },
    curl: { connect: roundStats(summarize(curl.connect)), ttfb: roundStats(summarize(curl.ttfb)) },
  };
  console.log(`connect p50: req ${ttfb.req.connect.p50} ms, curl ${ttfb.curl.connect.p50} ms`);
  console.log(`ttfb p50 with a 100 ms server delay: req ${ttfb.req.ttfb.p50} ms, curl ${ttfb.curl.ttfb.p50} ms`);

  save('overhead', {
    method: `${N} runs after ${WARMUP} warm-up runs; wall is spawn to exit; ttfb is connect + wait for req and time_starttransfer for curl`,
    wall,
    ttfb,
  });
} finally {
  mock.stop();
}
