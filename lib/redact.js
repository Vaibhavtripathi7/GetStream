// Everything the tool prints about the request goes through here, so a
// pasted report or a CI log never carries a credential.

const HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-goog-api-key|x-amz-security-token)$|(^|-)(token|secret|password|apikey|session)($|-)/i;
const PARAM = /^(key|api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|client[_-]?secret|password|passwd|sig|signature|auth|x-amz-signature|x-amz-credential|x-amz-security-token)$/i;
const SCHEME = /^(Bearer|Basic|Token|Digest|ApiKey)\s/i;

export const REDACTED = 'REDACTED';

export function redactHeader(name, value) {
  if (!HEADER.test(name)) return value;
  const scheme = SCHEME.exec(value);
  return scheme ? `${scheme[1]} ${REDACTED}` : REDACTED;
}

export function redactHeaders(pairs) {
  return pairs.map(([name, value]) => [name, redactHeader(name, value)]);
}

// A response header record from Node: values are strings or, for
// set-cookie, arrays.
export function redactHeaderRecord(headers) {
  const out = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    out[name] = Array.isArray(value) ? value.map((v) => redactHeader(name, v)) : redactHeader(name, value);
  }
  return out;
}

// Tokens are often passed as the user name (https://TOKEN@host), so both
// parts of the userinfo are hidden, and an OAuth redirect can carry one in
// the fragment (#access_token=...).
export function redactUrl(url) {
  const copy = new URL(url);
  if (copy.username) copy.username = REDACTED;
  if (copy.password) copy.password = REDACTED;
  redactParams(copy.searchParams);
  if (copy.hash.includes('=')) {
    const fragment = new URLSearchParams(copy.hash.slice(1));
    if (redactParams(fragment)) copy.hash = fragment.toString();
  }
  return copy.href;
}

function redactParams(params) {
  let changed = false;
  for (const key of new Set(params.keys())) {
    if (PARAM.test(key)) {
      params.set(key, REDACTED);
      changed = true;
    }
  }
  return changed;
}
