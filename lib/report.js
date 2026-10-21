import { phaseDurations } from './http.js';
import { redactHeaderRecord, redactHeaders, redactUrl } from './redact.js';
import { summarize } from './stats.js';

const PHASES = ['redirect', 'dns', 'tcp', 'tls', 'wait', 'body', 'total'];

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
      url: redactUrl(exchange.url),
      status: exchange.status,
      statusText: exchange.statusMessage,
      httpVersion: exchange.httpVersion,
      headers: redactHeaderRecord(exchange.headers),
      remote: exchange.remote,
      tls: exchange.tls,
      reused: exchange.reused,
      redirects: exchange.redirects.map((r) => ({ status: r.status, url: redactUrl(r.url) })),
    },
    timing: marks && roundAll(phaseDurations(marks)),
    body: stats && { ...bodyReport(stats, timeline), ...encodingReport(exchange) },
    warnings: warnings(exchange, stats, error),
    error: error && { kind: error.kind ?? 'network', phase: error.phase ?? null, message: error.message },
  };
}

// Percentiles across runs. Failed runs are counted but left out of the
// timing, and a phase only gets samples from runs where it happened.
export function aggregateRuns(reports, planned = reports.length, { samples = true } = {}) {
  const ok = reports.filter((r) => !r.error);
  const failed = {};
  for (const r of reports) if (r.error) failed[r.error.kind] = (failed[r.error.kind] ?? 0) + 1;
  const statuses = {};
  for (const r of reports) if (r.response) statuses[r.response.status] = (statuses[r.response.status] ?? 0) + 1;
  const pick = (fn) => roundSummary(summarize(ok.map(fn)));
  return {
    runs: reports.length,
    planned,
    ok: ok.length,
    failed,
    statuses,
    request: reports[0]?.request ?? null,
    timing: Object.fromEntries(PHASES.map((p) => [p, pick((r) => r.timing?.[p])])),
    firstToken: pick((r) => r.body?.firstToken),
    tokensPerSecond: pick((r) => r.body?.tokensPerSecond),
    chunksPerSecond: pick((r) => r.body?.deltasPerSecond),
    samples: samples
      ? reports.map((r) => ({
          status: r.response?.status ?? null,
          total: r.timing?.total ?? null,
          firstToken: r.body?.firstToken ?? null,
          reused: r.response?.reused ?? false,
          error: r.error,
        }))
      : undefined,
  };
}

function roundSummary(s) {
  return s && roundAll(s);
}

function encodingReport(exchange) {
  return exchange?.encoding && !exchange.undecoded ? { encoding: exchange.encoding, wireBytes: exchange.wire.bytes } : {};
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
  if (exchange?.undecoded) out.push(`body is encoded as "${exchange.encoding}", which req cannot decode; shown as received`);
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
  const out = Object.create(null);
  for (const [name, value] of pairs) out[name] = Object.hasOwn(out, name) ? `${out[name]}, ${value}` : value;
  return out;
}

function round(v) {
  return v === null || v === undefined ? null : Math.round(v * 1000) / 1000;
}

function roundAll(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? round(v) : v]));
}
