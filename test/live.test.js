import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveView } from '../lib/term/live.js';
import { LiveOutput, LiveRunsOutput, PlainOutput } from '../lib/output.js';
import { StreamMeter } from '../lib/stream.js';
import { aggregateRuns, buildReport } from '../lib/report.js';
import { stringWidth } from '../lib/term/text.js';
import { listen } from './helpers/server.js';

class FakeTerminal extends EventEmitter {
  isTTY = true;
  columns = 40;
  rows = 12;
  output = '';
  write(s) {
    this.output += s;
    return true;
  }
}

function view(render = () => ['panel']) {
  const term = new FakeTerminal();
  const live = new LiveView(term, { render, interval: 1e6 });
  return { term, live };
}

// The text a frame prints, without the cursor and erase sequences.
const visible = (s) => s.replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '').replace(/^\r/, '');

test('hides the cursor while live and restores it on stop', () => {
  const { term, live } = view();
  live.start();
  assert.ok(term.output.startsWith('\x1b[?25l'));
  live.stop();
  assert.ok(term.output.endsWith('\x1b[?2026l\x1b[?25h'));
});

test('prints finished lines above the panel and keeps the open line pinned', () => {
  const { term, live } = view(() => ['status', 'timing']);
  live.start();
  term.output = '';
  live.text('first line\nsecond');
  live.draw();
  assert.equal(visible(term.output), 'first line\r\nsecond\r\nstatus\r\ntiming');
  term.output = '';
  live.draw();
  // moves up over the open line and both panel rows before redrawing
  assert.ok(term.output.startsWith('\x1b[?2026h\x1b[2A\r\x1b[J'));
  assert.equal(visible(term.output), 'second\r\nstatus\r\ntiming');
  live.stop();
});

test('a megabyte on one line never makes a frame redraw more than one row', () => {
  const { term, live } = view();
  live.start();
  live.text('x'.repeat(1_000_000));
  live.draw();
  term.output = '';
  live.draw();
  const redrawn = visible(term.output).split('\r\n')[0];
  assert.ok(stringWidth(redrawn) < term.columns);
  live.stop();
});

test('control sequences from the response are shown, not executed', () => {
  const { term, live } = view();
  live.start();
  live.text('\x1b[2J\x1b]0;title\x07 bell');
  live.stop();
  assert.ok(!term.output.includes('\x1b[2J'));
  assert.ok(!term.output.includes('\x1b]0'));
  assert.ok(term.output.includes('␛[2J␛]0;title␇ bell'));
});

test('expands tabs from the current column', () => {
  const { term, live } = view(() => []);
  live.start();
  live.text('ab\tc\n\td');
  live.stop();
  assert.ok(visible(term.output).includes('ab      c\r\n        d'));
});

test('the panel is cut to fit a short terminal', () => {
  const { term, live } = view(() => Array.from({ length: 30 }, (_, i) => `line ${i}`));
  term.rows = 5;
  live.start();
  assert.equal(visible(term.output).split('\r\n').length, 4);
  live.stop();
});

const pty = process.platform === 'linux' && spawnSync('script', ['--version']).status === 0;

test('end to end in a pseudo terminal: live panel, then the summary, then Ctrl-C', { skip: !pty && 'needs util-linux script' }, async (t) => {
  const srv = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url === '/hang') return;
    let n = 0;
    const timer = setInterval(() => {
      res.write(`data: {"choices":[{"delta":{"content":"word${n} "}}]}\n\n`);
      if (++n === 5) {
        clearInterval(timer);
        res.end('data: [DONE]\n\n');
      }
    }, 20);
  });
  t.after(srv.close);
  const dir = mkdtempSync(join(tmpdir(), 'req-pty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = new URL('../bin/cli.js', import.meta.url).pathname;

  // spawnSync would block this process, and with it the server under test.
  const script = (path, name, stdio) => spawn('script', ['-qfec', `node ${cli} ${srv.url(path).href}`, join(dir, name)], { stdio });
  const exited = (child) => new Promise((resolve) => child.on('close', resolve));

  assert.equal(await exited(script('/s', 'ok', 'ignore')), 0);
  const out = readFileSync(join(dir, 'ok'), 'utf8');
  assert.ok(out.includes('\x1b[?25l') && out.includes('\x1b[?25h'));
  assert.match(visible(out), /word0 word1 word2 word3 word4/);
  assert.match(visible(out), /200 OK GET .* sse · openai/);

  // Ctrl-C only once the panel shows the request waiting, however slowly node starts.
  const child = script('/hang', 'int', ['pipe', 'ignore', 'ignore']);
  const poll = setInterval(() => {
    let seen = '';
    try {
      seen = readFileSync(join(dir, 'int'), 'utf8');
    } catch {}
    if (seen.includes('waiting')) {
      clearInterval(poll);
      child.stdin.write('\x03');
    }
  }, 20);
  t.after(() => clearInterval(poll));
  assert.equal(await exited(child), 130);
  const interrupted = readFileSync(join(dir, 'int'), 'utf8');
  assert.match(visible(interrupted), /✗ aborted during wait/);
  assert.ok(interrupted.lastIndexOf('\x1b[?25h') > interrupted.lastIndexOf('\x1b[?25l'));
});

test('the live view shows generated text even when the stream opens with a textless event', () => {
  const term = new FakeTerminal();
  const options = { color: false, quiet: false, raw: false, include: false };
  const output = new LiveOutput({ stdout: term, options, onInterrupt() {} });
  const request = { method: 'POST', url: new URL('http://api.test/v1/messages'), headers: [], body: null };
  output.begin(request);
  const meter = new StreamMeter({ contentType: 'text/event-stream', onText: (text) => output.text(text) });
  output.head({ status: 200, statusMessage: 'OK', headers: { 'content-type': 'text/event-stream' }, rawHeaders: [] }, meter);
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
  ];
  events.forEach((e, i) => {
    const chunk = Buffer.from(e);
    meter.push(chunk, i);
    output.write(chunk);
  });
  meter.finish(2);
  output.end(buildReport({ request, meter }), meter);
  assert.ok(visible(term.output).includes('Hello'));
  assert.ok(!term.output.includes('message_start'));
});

class FakeKeyboard extends EventEmitter {
  isTTY = true;
  isRaw = false;
  reading = false;
  setRawMode(on) {
    this.isRaw = on;
  }
  resume() {
    this.reading = true;
  }
  pause() {
    this.reading = false;
  }
}

test('resuming after the request already ended leaves the terminal alone', () => {
  const term = new FakeTerminal();
  const keys = new FakeKeyboard();
  let suspended = 0;
  const live = new LiveView(term, { input: keys, render: () => ['panel'], interval: 1e6, suspend: () => suspended++ });
  live.start();
  assert.equal(keys.isRaw, true);
  keys.emit('data', Buffer.from([0x1a]));
  assert.equal(suspended, 1);
  assert.equal(keys.isRaw, false);
  live.stop();
  term.output = '';
  process.emit('SIGCONT');
  assert.equal(term.output, '');
  assert.equal(keys.isRaw, false);
  assert.equal(keys.reading, false);
});

test('resuming while the request is still running takes the terminal back', () => {
  const term = new FakeTerminal();
  const keys = new FakeKeyboard();
  const live = new LiveView(term, { input: keys, render: () => ['panel'], interval: 1e6, suspend: () => {} });
  live.start();
  keys.emit('data', Buffer.from([0x1a]));
  process.emit('SIGCONT');
  assert.equal(keys.isRaw, true);
  assert.ok(term.output.endsWith('\x1b[?2026l'));
  live.stop();
  assert.equal(keys.isRaw, false);
  assert.equal(keys.reading, false);
});

function liveOutput(options = {}) {
  const term = new FakeTerminal();
  const output = new LiveOutput({ stdout: term, options: { color: false, quiet: false, raw: false, include: false, ...options }, onInterrupt() {} });
  const request = { method: 'GET', url: new URL('http://api.test/'), headers: [], body: null };
  output.begin(request);
  return { term, output, request };
}

function play(output, request, contentType, chunks) {
  const meter = new StreamMeter({ contentType, onText: (text) => output.text(text) });
  const headers = contentType ? { 'content-type': contentType } : {};
  output.head({ status: 200, statusMessage: 'OK', headers, rawHeaders: [] }, meter);
  chunks.forEach((chunk, i) => {
    meter.push(chunk, i);
    output.write(chunk);
  });
  meter.finish(chunks.length);
  output.end(buildReport({ request, meter }), meter);
}

test('the live view prints text bodies and holds back binary ones', () => {
  const json = liveOutput();
  play(json.output, json.request, 'application/json', [Buffer.from('{"a":'), Buffer.from('1}\n')]);
  assert.ok(visible(json.term.output).includes('{"a":1}'));

  const binary = liveOutput();
  play(binary.output, binary.request, 'image/png', [Buffer.from([0x89, 0x50, 0x4e, 0x47])]);
  assert.ok(visible(binary.term.output).includes('! binary body not shown'));
  assert.ok(!binary.term.output.includes('PNG'));

  const sniffed = liveOutput();
  play(sniffed.output, sniffed.request, undefined, [Buffer.from([0x00, 0x41, 0x42])]);
  assert.ok(visible(sniffed.term.output).includes('! binary body not shown'));

  const quiet = liveOutput({ quiet: true });
  play(quiet.output, quiet.request, 'text/plain', [Buffer.from('secret body')]);
  assert.ok(!quiet.term.output.includes('secret body'));
});

test('the live runs table ends as the summary', () => {
  const term = new FakeTerminal();
  const output = new LiveRunsOutput({ stdout: term, options: { color: false }, onInterrupt() {} });
  const request = { method: 'GET', url: new URL('http://api.test/'), headers: [], body: null };
  const run = (total) => ({ request: { method: 'GET', url: 'http://api.test/' }, response: { status: 200, reused: false }, timing: { dns: null, tcp: 1, tls: null, wait: total - 1, body: 0, total }, body: null, error: null });
  output.beginRuns(request, 2);
  output.progress([run(10)], 2);
  term.emit('resize');
  assert.match(visible(term.output), /run 2\/2 GET http:\/\/api\.test\/[\s\S]*total +1 +10\.0 ms/);
  output.summary(aggregateRuns([run(10), run(20)], 2));
  const text = visible(term.output);
  assert.match(text, /2 runs GET http:\/\/api\.test\//);
  assert.match(text, /total +2 +10\.0 ms/);
});

test('plain output keeps binary off a terminal but not off a pipe', () => {
  const body = Buffer.from([0x00, 0x1b, 0x5b, 0x32, 0x4a]);
  for (const isTTY of [true, false]) {
    const stdout = new FakeTerminal();
    stdout.isTTY = isTTY;
    const stderr = new FakeTerminal();
    stderr.columns = 0;
    const output = new PlainOutput({ stdout, stderr, options: { color: false, quiet: false, include: false } });
    output.write(body);
    output.end({ request: { method: 'GET', url: 'http://x/' }, response: { status: 200, statusText: 'OK' }, timing: null, body: null, warnings: [], error: null });
    assert.equal(stdout.output, isTTY ? '' : body.toString());
    assert.equal(stderr.output.includes('binary body not shown'), isTTY);
    // a terminal that reports 0 columns must not truncate the summary away
    assert.match(stderr.output, /^200 OK GET http:\/\/x\//);
  }
});
