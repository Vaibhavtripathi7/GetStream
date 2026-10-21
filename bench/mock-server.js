// Mock API for the benchmarks. It records the moment every event is handed
// to the socket, which is the ground truth the client's timings are checked
// against. Prints {"port": n} on stdout once it is listening.
import http from 'node:http';
import { performance } from 'node:perf_hooks';

const logs = new Map();
let nextId = 1;

function streamEvents(req, res, q) {
  const n = Number(q.get('n') ?? 100);
  const gap = Number(q.get('gap') ?? 10);
  const ttft = Number(q.get('ttft') ?? 50);
  const id = String(nextId++);
  const sent = [];
  logs.set(id, sent);

  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-run-id': id });
  const write = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
    sent.push(performance.now());
  };
  const chunk = (content) => ({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content } }] });

  let i = 0;
  const next = () => {
    if (i === n) {
      res.write(`data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 8, completion_tokens: n } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    write(chunk(`tok${i++} `));
    if (gap === 0) setImmediate(next);
    else setTimeout(next, gap);
  };
  setTimeout(() => {
    // OpenAI opens with an empty delta that carries the role; it is not a token.
    res.write(`data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
    next();
  }, ttft);
}

function bytes(res, q) {
  const total = Number(q.get('mb') ?? 100) * 1024 * 1024;
  const block = Buffer.alloc(64 * 1024, 0x61);
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(total) });
  let left = total;
  const pump = () => {
    while (left > 0) {
      const piece = left >= block.length ? block : block.subarray(0, left);
      left -= piece.length;
      if (!res.write(piece)) return res.once('drain', pump);
    }
    res.end();
  };
  pump();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const q = url.searchParams;
  switch (url.pathname) {
    case '/stream':
      return streamEvents(req, res, q);
    case '/log': {
      const sent = logs.get(q.get('id')) ?? [];
      logs.delete(q.get('id'));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(sent));
    }
    case '/bytes':
      return bytes(res, q);
    case '/delay':
      return setTimeout(() => res.end('x'.repeat(Number(q.get('size') ?? 1024))), Number(q.get('ms') ?? 0));
    default:
      res.writeHead(404);
      return res.end();
  }
});

server.keepAliveTimeout = 1000;
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
