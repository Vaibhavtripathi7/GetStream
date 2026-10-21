export function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 59_995) return `${(ms / 1000).toFixed(2)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatBytes(n) {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(2)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

export function formatRate(value, unit) {
  if (value === null || !Number.isFinite(value)) return null;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}/s`;
}
