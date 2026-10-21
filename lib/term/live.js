import { sanitize, splitRows, stringWidth, truncate } from './text.js';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const ERASE_DOWN = '\x1b[J';
const FLUSH_AT = 256 * 1024;

// Streams text into the normal scrollback and keeps a panel pinned under it.
// Each frame moves the cursor back to the top of the previous panel, erases
// down and redraws, so finished text scrolls away like ordinary output.
export class LiveView {
  #out;
  #input;
  #render;
  #onInterrupt;
  #interval;
  #timer = null;
  #rows = 0;
  #pending = '';
  #committed = [];
  #committedSize = 0;
  #frame = 0;
  #active = false;
  #interrupts = 0;
  #suspendProcess;

  constructor(out, { input = null, render, onInterrupt = () => {}, interval = 60, suspend = () => process.kill(process.pid, 'SIGTSTP') }) {
    this.#out = out;
    this.#input = input?.isTTY ? input : null;
    this.#render = render;
    this.#onInterrupt = onInterrupt;
    this.#interval = interval;
    this.#suspendProcess = suspend;
  }

  get frame() {
    return this.#frame;
  }

  start() {
    this.#active = true;
    this.#out.write(HIDE_CURSOR);
    this.#rawMode(true);
    this.#out.on('resize', this.#onResize);
    process.on('exit', this.restore);
    process.on('SIGTERM', this.#onTerm);
    this.#timer = setInterval(() => this.draw(), this.#interval);
    this.#timer.unref();
    this.draw();
  }

  text(raw) {
    const lines = sanitize(raw).split('\n');
    for (let i = 0; i < lines.length; i++) {
      this.#pending += expandTabs(lines[i], stringWidth(this.#pending));
      if (i < lines.length - 1) {
        this.#commit(this.#pending);
        this.#pending = '';
      }
    }
    // A line longer than the terminal is committed row by row, so the part
    // redrawn each frame never exceeds one row.
    const cols = this.#cols();
    if (stringWidth(this.#pending) >= cols) {
      const { full, rest } = splitRows(this.#pending, cols);
      if (full) this.#commit(full);
      this.#pending = rest;
    }
    if (this.#committedSize > FLUSH_AT) this.draw();
  }

  draw(final = false) {
    if (!this.#active) return;
    this.#frame++;
    const cols = this.#cols();
    let out = this.#rows > 1 ? `\x1b[${this.#rows - 1}A\r${ERASE_DOWN}` : `\r${ERASE_DOWN}`;
    for (const line of this.#committed) out += `${line}\r\n`;
    this.#committed = [];
    this.#committedSize = 0;

    let rows = 0;
    if (this.#pending) {
      out += `${this.#pending}\r\n`;
      rows += Math.max(1, Math.ceil(stringWidth(this.#pending) / cols));
      if (final) this.#pending = '';
    }
    const room = Math.max(1, (this.#out.rows || 24) - rows - 1);
    const panel = this.#render(cols, final).slice(0, room).map((line) => truncate(line, cols - 1));
    out += panel.join('\r\n');
    rows += panel.length;
    if (final) {
      out += '\r\n';
      rows = 0;
    }
    this.#rows = rows;
    this.#out.write(SYNC_START + out + SYNC_END);
  }

  stop() {
    if (!this.#active) return;
    clearInterval(this.#timer);
    this.draw(true);
    this.restore();
    this.#active = false;
    this.#out.off('resize', this.#onResize);
    process.off('exit', this.restore);
    process.off('SIGTERM', this.#onTerm);
    process.off('SIGCONT', this.#onContinue);
  }

  // Safe to call more than once and from an 'exit' handler: it only writes
  // synchronously to a TTY and resets the input mode.
  restore = () => {
    if (!this.#active) return;
    this.#out.write(SHOW_CURSOR);
    this.#rawMode(false);
  };

  #commit(line) {
    this.#committed.push(line);
    this.#committedSize += line.length;
  }

  #cols() {
    return Math.max(10, this.#out.columns || 80);
  }

  #rawMode(on) {
    if (!this.#input) return;
    this.#input.setRawMode(on);
    if (on) {
      this.#input.on('data', this.#onKey);
      this.#input.resume();
    } else {
      this.#input.off('data', this.#onKey);
      this.#input.pause();
    }
  }

  #onResize = () => this.draw();

  #onTerm = () => {
    this.restore();
    process.exit(143);
  };

  // Raw mode turns off the terminal's own signal keys, so they are handled here.
  #onKey = (data) => {
    for (const byte of data) {
      if (byte === 0x03 || byte === 0x71) {
        // The first press stops the request and keeps the summary; a second
        // one leaves at once, in case stopping takes a while.
        if (++this.#interrupts > 1) {
          this.restore();
          process.exit(130);
        }
        this.#onInterrupt();
      } else if (byte === 0x1a) {
        this.#suspend();
      }
    }
  };

  #suspend() {
    this.restore();
    process.once('SIGCONT', this.#onContinue);
    this.#suspendProcess();
  }

  // After `fg`, the data that piled up while stopped is handled before this
  // signal, so the request may already be over; then there is nothing to
  // take back.
  #onContinue = () => {
    if (!this.#active) return;
    this.#out.write(HIDE_CURSOR);
    this.#rawMode(true);
    this.#rows = 0;
    this.draw();
  };
}

function expandTabs(text, column) {
  if (!text.includes('\t')) return text;
  let out = '';
  let col = column;
  for (const ch of text) {
    if (ch === '\t') {
      const n = 8 - (col % 8);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col += stringWidth(ch);
    }
  }
  return out;
}
