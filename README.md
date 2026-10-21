# GetStream

`req` is a terminal HTTP client that shows where the time of a request went:
DNS, TCP, TLS, waiting for the server, and the body. It understands
streaming responses. For server-sent events and NDJSON it times every
event, and for LLM APIs (OpenAI, Anthropic, Gemini, Ollama) it reports time
to first token, the gaps between chunks and the token rate.

No dependencies, Node 22.3 or newer.

```
$ req https://example.com/ -q
200 OK GET https://example.com/ · 54.4 ms
░░░░░░░░░░░░▒▒▒▒▒▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓─────────────█
dns 10.9 ms  tcp 5.6 ms  tls 25.1 ms  wait 11.6 ms  body 1.2 ms
577 B  ·  480.8 kB/s
```

A streamed chat completion (from the benchmark's mock server, which sends a
token every 20 ms after a 400 ms pause):

```
$ req "127.0.0.1:40701/stream?n=150&gap=20&ttft=400" -q
200 OK GET http://127.0.0.1:40701/stream?n=150&gap=20&ttft=400 · sse · openai · 3.45 s
▒───────████████████████████████████████████████████████████
tcp 1.4 ms  wait 407 ms  body 3.04 s
14.5 kB  ·  4.8 kB/s  ·  153 events
first token 410 ms  ·  150 tokens  ·  49.4 tok/s
gap between chunks  p50 20.3 ms  p95 21.0 ms  p99 21.4 ms  max 21.6 ms
▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃
```

On a terminal this panel is live: the generated text streams above it and
the numbers update as chunks arrive. The last line plots recent gaps against
their median, so a steady stream is flat and a stall shows up as a spike.

## Install

```sh
git clone https://github.com/Vaibhavtripathi7/GetStream.git
cd GetStream
npm link        # puts `req` on your PATH
```

## Examples

```sh
# a plain request; curl-style flags
req https://api.github.com/repos/nodejs/node -i

# JSON body: POST and Content-Type: application/json are implied
req :3000/items -d '{"name":"box"}'

# body from a file or stdin
req :3000/upload -d @payload.json
echo '{"q":1}' | req :3000/search -d @-

# an OpenAI stream; include_usage makes the server report token counts
req https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{"model":"gpt-4o-mini","stream":true,"stream_options":{"include_usage":true},
       "messages":[{"role":"user","content":"Write a haiku about latency"}]}'

# Ollama streams NDJSON by default
req :11434/api/chat -d '{"model":"llama3.2","messages":[{"role":"user","content":"hi"}]}'

# send it 20 times and get percentiles per phase
req https://example.com/ -n 20
req https://example.com/ -n 20 --keep-alive

# machine-readable report for scripts and CI
req https://example.com/ --json | jq .timing
```

Keep keys in environment variables as above. Anything req prints about the
request goes through redaction first (see Safety), but your shell history
is your own.

## What the numbers mean

| Phase | From | To |
|---|---|---|
| redirect | start | start of the last hop (only with `-L`) |
| dns | start of the hop | the address is resolved (absent for an IP address) |
| tcp | dns | the connection is open |
| tls | tcp | the handshake is done (https only) |
| wait | connection ready | the response headers arrive |
| body | headers | the last byte arrives |
| total | start | the last byte arrives |

For streams:

- **first token** is the time from the start of the request to the first
  chunk that carries generated text. OpenAI opens a stream with an empty
  chunk that only sets the role; that one does not count.
- **gap between chunks** is the time between consecutive chunks with text
  (or between events, for a stream that is not an LLM). Several chunks read
  from the socket at once have a gap of 0.
- **tokens** are only reported when the server sends a token count (OpenAI
  needs `stream_options.include_usage`). Without one, req counts chunks and
  says so, because a chunk can hold more than one token.
- **tok/s** is `(tokens - 1) / (last token time - first token time)`, the
  decode rate after the first token.

`--timeline` adds the arrival time of every chunk to the JSON report.

## Output

- **Terminal**: the live view described above. Ctrl-C stops the request
  and still prints what was measured; Ctrl-Z suspends.
- **Pipe or file**: the body goes to stdout byte for byte and the summary to
  stderr, so `req url | jq` and `req url > file` work.
- **`--json`**: one report on stdout instead of the body.

For LLM streams the live view shows the generated text; `--raw` shows the
events instead. The live view does not print a binary body; redirect stdout
to keep it.

## Options

```
Request
  -X, --method <method>       default GET, or POST when a body is given
  -H, --header <name: value>  add a header, repeatable
  -d, --data <body>           request body; @file reads a file, @- reads stdin
  -L, --location              follow redirects, up to 10
  -k, --insecure              do not verify the TLS certificate
      --compressed            ask for gzip, deflate or br

Timeouts (500, 500ms or 10s)
      --connect-timeout <t>   until TCP and TLS are done (default 10s)
      --idle-timeout <t>      longest silence while waiting or reading (default 60s)
      --max-time <t>          limit for the whole request (default none)

Output
  -i, --include               print the response status and headers
  -q, --quiet                 do not print the body
      --raw                   show raw stream bytes instead of the generated text
      --json                  print a JSON report instead of the body
      --timeline              add per-event arrival times to the JSON report
      --no-tui                plain output even on a terminal
      --no-color              no colours (NO_COLOR is honoured too)
  -f, --fail                  exit with 4 when the status is 400 or above

Repeat
  -n, --runs <n>              send the request n times and print percentiles
      --keep-alive            reuse one connection across runs
```

The idle timeout restarts with every byte, so a slow stream is never cut
off as long as data keeps coming; only `--max-time` limits the total.

Exit status: 0 ok, 1 usage error, 2 network or TLS error, 3 timeout, 4 HTTP
error with `--fail`, 130 interrupted.

## Safety

- Authorization, Cookie, API-key headers, key-like query parameters
  (`key`, `token`, `access_token`, `signature`, ...) and a user name or
  password in the URL are shown as `REDACTED` in the summary and in
  `--json`, and so is Set-Cookie in the JSON report. A malformed `-H` is
  rejected without echoing its value. `-i` prints the response headers as
  the server sent them.
- A redirect to another origin drops Authorization, Cookie and Host.
- In the live view, text from the server is shown with control characters
  made visible, so a response cannot move the cursor, clear the screen or
  retitle the terminal. Piped output is passed through untouched.
- The terminal is restored after Ctrl-C, SIGTERM or a crash.

## How accurate is it

Measured on a laptop, details and method in [BENCHMARKS.md](BENCHMARKS.md):

- Gaps between streamed chunks match what the server sent to within
  0.005 to 0.06 ms at the median and 0.12 to 0.57 ms at p99.
- Against a server that waits 100 ms, req reports the first byte at
  101.8 ms and curl at 101.0 ms. On a real HTTPS request each phase is
  within 2 ms of curl's.
- Peak memory stays near 150 MB whether the body is 100 MB or 1 GB.
- A local GET takes 90 ms from spawn to exit against curl's 13 ms; Node's
  own startup is 29 ms of that.

## Limits

- HTTP/1.1 only, and no proxy support.
- Node adds about 0.8 ms to a loopback connect compared with curl; req
  cannot measure below its own event loop.
- The LLM stream formats are tested against fixtures written from each
  provider's documented format (`test/fixtures/`). The live runs so far
  were against the mock server, not the real APIs.
- Character widths follow East Asian Width; some emoji sequences joined
  with zero-width joiners may be measured wider than a terminal draws them.

## Development

```sh
npm test         # node:test, no dependencies
npm run bench    # writes bench/results/
```

```
bin/cli.js        argument handling, output selection, exit codes
lib/http.js       one request with timing marks, timeouts, redirects, decoding
lib/sse.js        SSE parser (WHATWG rules)
lib/lines.js      NDJSON line splitter
lib/llm.js        OpenAI, Anthropic, Gemini and Ollama chunk formats
lib/stream.js     per-event timing, first token, gaps, token rate
lib/report.js     the report behind every output, run aggregation
lib/output.js     plain, JSON and live outputs
lib/term/         live view, panel rendering, text width, sanitising
bench/            mock server and benchmarks
```

## License

MIT
