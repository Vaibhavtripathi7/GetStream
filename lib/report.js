import { phaseDurations } from './http.js';
import { redactHeaders, redactUrl } from './redact.js';

export function buildReport({ request, exchange = null, error = null, meter = null, timeline = false }) {
  const marks = exchange?.timing ?? error?.timing ?? null;
  const stats = meter?.stats() ?? null;
  return {
    request: {
      method: request.method,
      url: redactUrl(request.url),
      headers: headerRecord(redactHeaders(request.headers)),
      bodyBytes: request.body?.length ?? 0,
    },
    response: exchange && {
      status: exchange.status,
      statusText: exchange.statusMessage,
      httpVersion: exchange.httpVersion,
      headers: exchange.headers,
      remote: exchange.remote,
      tls: exchange.tls,
      reused: exchange.reused,
      redirects: exchange.redirects.map((r) => ({ status: r.status, url: redactUrl(r.url) })),
    },
    timing: marks && roundAll(phaseDurations(marks)),
    body: stats && bodyReport(stats, timeline),
    warnings: warnings(exchange, stats, error),
    error: error && { kind: error.kind ?? 'network', phase: error.phase ?? null, message: error.message },
  };
}

function bodyReport(s, timeline) {
  return {
    kind: s.kind,
    bytes: s.bytes,
    chunks: s.chunks,
    events: s.events,
    provider: s.provider,
    firstToken: round(s.firstToken),
    lastToken: round(s.lastToken),
    deltas: s.deltas,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    tokensPerSecond: round(s.tokensPerSecond),
    deltasPerSecond: round(s.deltasPerSecond),
    gaps: s.gaps && roundAll(s.gaps),
    done: s.done,
    ...(timeline && s.timeline ? { timeline: s.timeline.map(round) } : {}),
  };
}

function warnings(exchange, stats, error) {
  const out = [];
  if (exchange?.tls && !exchange.tls.authorized) {
    out.push(`TLS certificate not verified (${exchange.tls.authorizationError ?? 'unknown reason'})`);
  }
  for (const a of exchange?.attempts ?? []) {
    if (a.error) out.push(`${a.address} failed with ${a.error} after ${(a.end - a.start).toFixed(1)} ms, used ${exchange.remote.address}`);
  }
  if (!stats) return out;
  if (stats.pending) out.push('stream ended inside an event, the partial event was dropped');
  if (stats.parseErrors) out.push(`${stats.parseErrors} line(s) were not valid JSON`);
  if (stats.oversized) out.push(`${stats.oversized} event(s) over 16 MiB were skipped`);
  for (const message of stats.errors) out.push(`stream error: ${message}`);
  if (stats.provider && !stats.done && !error && stats.errors.length === 0) {
    out.push('stream ended without a completion marker');
  }
  return out;
}

function headerRecord(pairs) {
  const out = {};
  for (const [name, value] of pairs) out[name] = name in out ? `${out[name]}, ${value}` : value;
  return out;
}

function round(v) {
  return v === null || v === undefined ? null : Math.round(v * 1000) / 1000;
}

function roundAll(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? round(v) : v]));
}
