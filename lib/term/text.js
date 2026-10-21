// Display width of terminal text. Wide ranges follow East Asian Width (W, F)
// plus emoji presentation; combining marks and format characters take no cell.

const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];
const ZERO = /[\p{Mn}\p{Me}\p{Cf}]/u;
const SGR = /\x1b\[[0-9;]*m/y;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

function charWidth(cp) {
  if (cp < 0x300) return cp < 0x20 || (cp >= 0x7f && cp < 0xa0) ? 0 : 1;
  if (ZERO.test(String.fromCodePoint(cp))) return 0;
  for (const [lo, hi] of WIDE) {
    if (cp < lo) return 1;
    if (cp <= hi) return 2;
  }
  return 1;
}

// Calls fn(text, width) for each visible character and fn(seq, 0, true) for
// each SGR colour sequence; stops early when fn returns false.
function scan(s, fn) {
  for (let i = 0; i < s.length;) {
    if (s.charCodeAt(i) === 0x1b) {
      SGR.lastIndex = i;
      if (SGR.test(s)) {
        if (fn(s.slice(i, SGR.lastIndex), 0, true) === false) return;
        i = SGR.lastIndex;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    if (fn(s.slice(i, i + len), charWidth(cp), false) === false) return;
    i += len;
  }
}

export function stringWidth(s) {
  let width = 0;
  scan(s, (ch, w) => {
    width += w;
  });
  return width;
}

export function truncate(s, cols) {
  if (cols <= 0) return '';
  if (stringWidth(s) <= cols) return s;
  let out = '';
  let width = 0;
  let styled = false;
  scan(s, (ch, w, isStyle) => {
    if (isStyle) {
      out += ch;
      styled = true;
      return true;
    }
    if (width + w > cols - 1) return false;
    out += ch;
    width += w;
    return true;
  });
  return `${out}…${styled ? '\x1b[0m' : ''}`;
}

// Splits text that will be printed from column 0 into the part that fills
// whole rows of `cols` cells and the remainder, the way the terminal wraps.
export function splitRows(s, cols) {
  let row = 0;
  let cut = 0;
  let pos = 0;
  scan(s, (ch, w) => {
    if (row + w > cols) {
      cut = pos;
      row = 0;
    }
    row += w;
    pos += ch.length;
    if (row === cols) {
      cut = pos;
      row = 0;
    }
  });
  return { full: s.slice(0, cut), rest: s.slice(cut) };
}

// Response bytes reach the terminal only through here: control characters,
// including ESC, are shown as visible symbols instead of being executed.
export function sanitize(text) {
  return text.replace(CONTROL, (c) => {
    const code = c.charCodeAt(0);
    if (code === 0x0d) return '';
    if (code < 0x20) return String.fromCharCode(0x2400 + code);
    if (code === 0x7f) return '␡';
    return '�';
  });
}
