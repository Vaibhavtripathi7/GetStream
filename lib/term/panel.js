import { formatBytes, formatMs, formatRate } from '../format.js';
import { truncate } from './text.js';

const PHASES = [
  { name: 'dns', color: 'cyan', glyph: '░' },
  { name: 'tcp', color: 'blue', glyph: '▒' },
  { name: 'tls', color: 'magenta', glyph: '▓' },
  { name: 'wait', color: 'yellow', glyph: '─' },
  { name: 'body', color: 'green', glyph: '█' },
];
const LIVE_PHASE = { resolving: 'dns', connecting: 'tcp', handshake: 'tls', waiting: 'wait', receiving: 'body' };
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const SPARK = '▁▂▃▄▅▆▇█';

// Renders a report as a few terminal lines. The same function draws the
// live panel (with `live`) and the final summary, so both always agree.
export function renderPanel(report, { cols = Infinity, style, live = null, gaps = null }) {
  const width = Number.isFinite(cols) ? Math.max(10, Math.min(cols - 1, 100)) : 60;
  const segments = phaseSegments(report, live);
  const lines = [headline(report, style, live)];

  if (segments.length > 0) {
    lines.push(bar(segments, width, style), legend(segments, report, style));
  }
  const bodyMs = report.timing?.body ?? segments.find((s) => s.live && s.name === 'body')?.ms ?? null;
  const body = bodyLine(report.body, bodyMs);
  if (body) lines.push(body);
  const tokens = tokenLine(report.body, style);
  if (tokens) lines.push(tokens);
  if (report.body?.gaps) lines.push(gapLine(report.body.gaps, report.body.provider ? 'chunks' : 'events'));
  if (gaps && gaps.length > 1) lines.push(style.gray(sparkline(gaps, width)));
  for (const warning of report.warnings) lines.push(style.yellow(`! ${warning}`));

  return Number.isFinite(cols) ? lines.map((line) => truncate(line, cols - 1)) : lines;
}

function headline(report, style, live) {
  const target = `${report.request.method} ${report.request.url}`;
  const sep = style.gray('·');
  if (live) {
    return `${style.cyan(SPINNER[live.frame % SPINNER.length])} ${style.bold(live.phase)} ${target} ${sep} ${formatMs(live.elapsed)}`;
  }
  const parts = [];
  if (report.error) {
    const { kind, phase, message } = report.error;
    parts.push(style.red(style.bold(`✗ ${kind}`)) + (phase ? style.gray(` during ${phase}`) : ''));
  }
  if (report.response) {
    const { status, statusText } = report.response;
    const paint = status >= 500 ? style.red : status >= 400 ? style.yellow : status >= 300 ? style.cyan : style.green;
    parts.push(paint(style.bold(`${status} ${statusText}`)));
  }
  parts.push(target);
  const kind = streamLabel(report.body);
  if (kind) parts.push(sep, kind);
  if (report.error) parts.push(sep, report.error.message);
  else if (report.timing?.total != null) parts.push(sep, formatMs(report.timing.total));
  return parts.join(' ');
}

function streamLabel(body) {
  if (!body || body.kind === 'raw') return null;
  return body.provider ? `${body.kind} · ${body.provider}` : body.kind;
}

function phaseSegments(report, live) {
  const timing = report.timing ?? {};
  const segments = PHASES.filter((p) => timing[p.name] != null).map((p) => ({ ...p, ms: timing[p.name] }));
  if (live) {
    const done = segments.reduce((sum, s) => sum + s.ms, 0);
    const current = PHASES.find((p) => p.name === LIVE_PHASE[live.phase]);
    if (current && live.elapsed > done) segments.push({ ...current, ms: live.elapsed - done, live: true });
  }
  return segments;
}

function bar(segments, width, style) {
  const total = segments.reduce((sum, s) => sum + s.ms, 0);
  if (!(total > 0) || width < segments.length) return '';
  const cells = segments.map((s) => (s.ms > 0 ? Math.max(1, Math.round((s.ms / total) * width)) : 0));
  let diff = cells.reduce((a, b) => a + b, 0) - width;
  while (diff !== 0) {
    const i = cells.indexOf(Math.max(...cells));
    cells[i] -= Math.sign(diff);
    diff -= Math.sign(diff);
  }
  return segments
    .map((s, i) => {
      const paint = s.live ? (x) => style.dim(style[s.color](x)) : style[s.color];
      return paint((style.enabled ? '█' : s.glyph).repeat(cells[i]));
    })
    .join('');
}

function legend(segments, report, style) {
  const parts = segments.map((s) => `${style[s.color](s.name)} ${formatMs(s.ms)}${s.live ? '…' : ''}`);
  if (report.response?.reused) parts.unshift(style.gray('reused connection'));
  return parts.join('  ');
}

function bodyLine(body, bodyMs) {
  if (!body || (body.bytes === 0 && body.events === 0)) return null;
  const parts = [formatBytes(body.bytes)];
  if (bodyMs > 0) parts.push(`${formatBytes(Math.round((body.bytes * 1000) / bodyMs))}/s`);
  if (body.kind !== 'raw') parts.push(`${body.events} events`);
  return parts.join('  ·  ');
}

function tokenLine(body, style) {
  if (!body?.provider) return null;
  const parts = [`first token ${style.bold(formatMs(body.firstToken))}`];
  if (body.outputTokens !== null) {
    parts.push(`${body.outputTokens} tokens`, formatRate(body.tokensPerSecond, 'tok'));
  } else {
    parts.push(`${body.deltas} chunks`, formatRate(body.deltasPerSecond, 'chunk'));
  }
  return parts.filter(Boolean).join('  ·  ');
}

function gapLine(g, between) {
  return `gap between ${between}  p50 ${formatMs(g.p50)}  p95 ${formatMs(g.p95)}  p99 ${formatMs(g.p99)}  max ${formatMs(g.max)}`;
}

function sparkline(gaps, width) {
  const recent = gaps.slice(-width);
  const max = Math.max(...recent);
  return recent.map((g) => SPARK[max > 0 ? Math.round((g / max) * (SPARK.length - 1)) : 0]).join('');
}
