export function colorEnabled(stream, wanted, env = process.env) {
  if (!wanted || env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY) && env.TERM !== 'dumb';
}

export function createStyle(enabled) {
  const sgr = (open, close) => (enabled ? (s) => `\x1b[${open}m${s}\x1b[${close}m` : (s) => s);
  return {
    enabled,
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    red: sgr(31, 39),
    green: sgr(32, 39),
    yellow: sgr(33, 39),
    blue: sgr(34, 39),
    magenta: sgr(35, 39),
    cyan: sgr(36, 39),
    gray: sgr(90, 39),
  };
}
