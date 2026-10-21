// Peak memory and throughput while a large body streams through req to
// /dev/null, and how memory grows with the number of events in a stream.
// Peak RSS comes from getrusage in the req process (see rss-probe.js).
import { CLI, RSS_PROBE, exec, round, save, startMock } from './common.js';

const SIZES_MB = [10, 100, 1000];
const EVENT_COUNTS = [10_000, 100_000, 400_000];

async function measure(url) {
  const { stderr, wall, code } = await exec(process.execPath, ['--import', RSS_PROBE, CLI, url, '--no-tui', '--idle-timeout', '120s'], { stdout: 'ignore' });
  if (code !== 0) throw new Error(`req exited with ${code}: ${stderr}`);
  const { maxRss } = JSON.parse(stderr.trim().split('\n').at(-1));
  return { maxRssMB: round(maxRss / 2 ** 20, 1), wallMs: round(wall, 1) };
}

const mock = await startMock();
try {
  const bodies = [];
  for (const mb of SIZES_MB) {
    const url = `${mock.base}/bytes?mb=${mb}`;
    const req = await measure(url);
    const curl = await exec('curl', ['-s', '-o', '/dev/null', '-w', '%{speed_download}', url]);
    const row = {
      sizeMB: mb,
      reqPeakRssMB: req.maxRssMB,
      reqMBps: round(mb / (req.wallMs / 1000), 1),
      curlMBps: round(Number(curl.stdout) / 2 ** 20, 1),
    };
    bodies.push(row);
    console.log(`${mb} MB body: req peak RSS ${row.reqPeakRssMB} MB, ${row.reqMBps} MB/s; curl ${row.curlMBps} MB/s`);
  }

  const streams = [];
  for (const n of EVENT_COUNTS) {
    const row = { events: n, ...(await measure(`${mock.base}/stream?n=${n}&gap=0&ttft=0`)) };
    streams.push(row);
    console.log(`${n} SSE events: req peak RSS ${row.maxRssMB} MB`);
  }
  const [small, , large] = streams;
  const perEvent = ((large.maxRssMB - small.maxRssMB) * 2 ** 20) / (large.events - small.events);
  console.log(`about ${perEvent.toFixed(0)} bytes of memory per event`);

  save('memory', {
    method: 'peak RSS via getrusage in the req process; body written to /dev/null; MB/s for req is size over spawn-to-exit time, so it includes startup',
    bodies,
    streams,
    bytesPerEvent: Math.round(perEvent),
  });
} finally {
  mock.stop();
}
