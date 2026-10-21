import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveView } from '../lib/term/live.js';
import { LiveOutput } from '../lib/output.js';
import { StreamMeter } from '../lib/stream.js';
import { buildReport } from '../lib/report.js';
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
