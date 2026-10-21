#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseCli, loadBody, defaultHeaders, UsageError } from '../lib/args.js';
import { runOnce } from '../lib/run.js';
import { PlainOutput, JsonOutput } from '../lib/output.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `Usage: req [options] <url>

Sends an HTTP request and shows where the time went: DNS, TCP, TLS, waiting
for the server, and the body. Server-sent events, NDJSON and LLM token
streams are measured as they arrive.

Request
  -X, --method <method>       default GET, or POST when a body is given
  -H, --header <name: value>  add a header, repeatable
  -d, --data <body>           request body; @file reads a file, @- reads stdin
  -k, --insecure              do not verify the TLS certificate

Timeouts (500, 500ms or 10s)
      --connect-timeout <t>   until TCP and TLS are done (default 10s)
      --idle-timeout <t>      longest silence while waiting or reading (default 60s)
      --max-time <t>          limit for the whole request (default none)

Output
  -i, --include               print the response status and headers
  -q, --quiet                 do not print the body
      --json                  print a JSON report instead of the body
      --timeline              add per-event arrival times to the JSON report
      --no-color              no colours (NO_COLOR is honoured too)
  -f, --fail                  exit with 4 when the status is 400 or above

  -h, --help                  show this help
  -V, --version               show the version

Exit status: 0 ok, 1 usage, 2 network or TLS error, 3 timeout,
4 HTTP error with --fail, 130 interrupted.
`;

export function exitCode(report, options) {
  if (report.error) return { timeout: 3, aborted: 130 }[report.error.kind] ?? 2;
  if (options.fail && report.response.status >= 400) return 4;
  return 0;
}

async function main(argv) {
  const options = parseCli(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`req ${version}\n`);
    return 0;
  }

  const body = await loadBody(options.data);
  const request = {
    url: options.url,
    method: options.method,
    headers: defaultHeaders(options.headers, body, { userAgent: `req/${version}` }),
    body,
  };

  const controller = new AbortController();
  let brokenPipe = false;
  process.stdout.on('error', (err) => {
    if (err.code !== 'EPIPE') throw err;
    brokenPipe = true;
    controller.abort();
  });
  let interrupts = 0;
  process.on('SIGINT', () => {
    if (++interrupts > 1) process.exit(130);
    controller.abort();
  });

  const io = { stdout: process.stdout, stderr: process.stderr, options, muted: () => brokenPipe };
  const output = options.json ? new JsonOutput(io) : new PlainOutput(io);
  const report = await runOnce(request, options, output, { signal: controller.signal });
  return brokenPipe ? 0 : exitCode(report, options);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`req: ${err.message}\nTry 'req --help'.\n`);
    process.exitCode = 1;
  },
);
