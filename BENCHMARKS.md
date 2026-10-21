# Benchmarks

Every number here comes from a script in `bench/` and is stored in
`bench/results/`. Run them yourself with `npm run bench` (the real-network
comparison needs internet access).

Machine: AMD Ryzen 5 3500U (4 cores, 8 threads), 6 GB RAM, Linux 6.18,
Node v24.12.0, curl 8.23.0. A laptop, not a quiet benchmark box, so the tails
include noise from everything else running on it. The tables are one run on
the code at `750d5f3` while the machine was otherwise idle; later commits do
not touch the timing path. A run with the machine under load moved every
absolute number, `node -e ''` and curl included, but not the comparisons
between req and curl.

## 1. Timing accuracy

`bench/accuracy.js`

The question: when req says two events arrived 20 ms apart, were they sent
20 ms apart? The mock server (`bench/mock-server.js`) streams OpenAI-style
chunks and logs the moment it hands each one to the socket. req runs as a
normal CLI process with `--json --timeline`, which reports the arrival time of
every chunk. For each pair of consecutive chunks the benchmark compares the
gap req saw with the gap the server produced. Only differences are compared,
so the two processes never need synchronised clocks.

| Server gap | Chunks x runs | Gaps compared | median error | p95 | p99 | max |
|---|---|---|---|---|---|---|
| 20 ms | 200 x 5 | 995 | 0.059 ms | 0.237 ms | 0.572 ms | 3.56 ms |
| 5 ms | 500 x 5 | 2,495 | 0.035 ms | 0.189 ms | 0.359 ms | 2.67 ms |
| 1 ms | 1,000 x 5 | 4,995 | 0.005 ms | 0.081 ms | 0.180 ms | 1.51 ms |
| none (burst) | 2,000 x 5 | 9,995 | 0.013 ms | 0.038 ms | 0.117 ms | 3.28 ms |

The mean signed error stays under 0.012 ms, so there is no drift in one
direction. The error includes the server's own scheduling jitter and the
kernel's delivery, so it is an upper bound on what req adds.

Like OpenAI, the mock opens every stream with an empty chunk that only
carries the role. In all 20 runs req skipped it and reported the first token
at the first chunk that had text.

## 2. Agreement with curl

`bench/overhead.js` (local) and `bench/phases.js` (real network)

Local server that waits 100 ms before answering, 30 runs each after 3
warm-up runs:

| | connect p50 | first byte p50 | first byte p95 |
|---|---|---|---|
| req | 0.99 ms | 101.8 ms | 102.2 ms |
| curl | 0.18 ms | 101.0 ms | 101.2 ms |

Once connected, the two agree to within about 0.2 ms. The remaining offset
is in connect: Node takes about 0.8 ms longer than curl to set up a socket
and report it, and req has no way to see below that.

Real HTTPS request to `https://example.com/`, 40 runs each, alternating
between the two tools; curl forced to HTTP/1.1 because that is what req
speaks. Medians:

| | dns | tcp | tls | wait | total |
|---|---|---|---|---|---|
| req | 12.73 ms | 6.31 ms | 15.48 ms | 11.96 ms | 50.31 ms |
| curl | 10.74 ms | 4.55 ms | 13.87 ms | 11.22 ms | 44.20 ms |

req reads 0.7 to 2 ms higher per phase. DNS goes through Node's resolver
thread pool and every phase is reported from the event loop, which curl
does not have to do. Between two 40-run sets the medians moved by up to
2 ms, so read them as "close to curl", not as an exact offset.

### What warming up fixed

The first version of these benchmarks found req reporting the first byte
13 ms late (114 ms against curl's 101 ms) and TCP connect at 10 ms on
loopback. Node initialises sockets, the HTTP parser and header handling on
first use, and that cost landed inside the measured phases. req now sends
two requests to a throwaway loopback socket and resolves `localhost` before
the clock starts. The target server never sees this. A third warm-up pass
gave no further gain.

## 3. Startup

`bench/overhead.js`: spawn to exit for one GET to a local server, 30 runs.

| | p50 | p95 |
|---|---|---|
| `node -e ''` | 29.0 ms | 32.1 ms |
| req | 89.7 ms | 100.6 ms |
| curl | 12.8 ms | 15.5 ms |

req was at 163 ms before the changes in this file; with the warm-up added
and builtins loaded through `process.getBuiltinModule` it is at 90 ms. The
second change is the large one: an ESM `import` of `node:http` also
evaluates its WebSocket getters and loads all of undici, about 50 ms, even
though req never uses it. What remains is mostly Node compiling req's own
modules, which a bundler would cut further; req has no build step on
purpose.

## 4. Memory and throughput

`bench/memory.js`: body streamed through req to `/dev/null`, peak RSS read
with `getrusage` inside the req process.

| Body | req peak RSS | req MB/s | curl MB/s |
|---|---|---|---|
| 10 MB | 84.3 MB | 74.5 | 649.4 |
| 100 MB | 150.5 MB | 347.3 | 1,571.4 |
| 1,000 MB | 152.8 MB | 955.9 | 1,802.3 |

Peak memory stops growing with body size: 150 MB for 100 MB, 153 MB for
1 GB. req's MB/s is size over spawn-to-exit time, so small bodies are
dominated by startup. For bulk downloads curl is about twice as fast; req
is built to time streams, not to replace curl for those.

Streams with many events keep one float per gap for the percentiles.
`bench/parser.js` measures what stays on the heap after garbage collection:
9.4 bytes per event. Peak RSS grows faster (75 MB at 10,000 events, 123 MB
at 400,000, about 128 bytes per event) because V8 lets the heap grow while
it parses JSON before collecting.

## 5. Parser throughput

`bench/parser.js`: 50 MB of stream in 16 KB chunks, in one process, median
of 7 passes.

| Stage | MB/s | events/s |
|---|---|---|
| SSE parser alone | 392.1 | 2,575,272 |
| SSE + JSON + LLM metrics | 73.6 | 483,056 |
| NDJSON + JSON + LLM metrics | 97.6 | 826,830 |

An LLM stream sends a few hundred chunks per second, three orders of
magnitude below this.

## Before the rewrite

Measured on 2026-10-22 against commit `b1599f9`, the March version with the
React dashboard:

- Every `req` command crashed on start: a leftover test request ran when
  the module loaded and passed `undefined` to `AbortSignal.timeout`.
- The dashboard's proxy collected each response into one string before
  answering. A 200 MB response took the server from 87 MB to 1,032 MB of
  peak RSS, and multi-byte characters split across chunks came out as
  `caf��`.
