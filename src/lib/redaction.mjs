const DEFAULT_HEADER_PATTERNS = Object.freeze([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key',
]);
const DEFAULT_FIELD_PATTERNS = Object.freeze([
  'access_token', 'access-token', 'refresh_token', 'refresh-token', 'api_key', 'api-key',
  'apikey', 'auth', 'authorization', 'client_secret', 'client-secret', 'password', 'passwd',
  'secret', 'session', 'token',
]);
const ENV_KEYS = Object.freeze({
  headers: 'PROXY_MCP_REDACT_HEADERS',
  query: 'PROXY_MCP_REDACT_QUERY_FIELDS',
  body: 'PROXY_MCP_REDACT_BODY_FIELDS',
});
const MAX_EXTRA_PATTERNS = 64;
const MAX_PATTERN_LENGTH = 80;
const SAFE_PATTERN = /^[\p{L}\p{N}_.?*-]+$/u;

// Kept for compatibility with callers that import the default query matcher.
export const SENSITIVE_QUERY = /^(access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|auth|authorization|client[_-]?secret|password|passwd|secret|session|token)$/i;

/**
 * Build an additive redaction configuration. Extra patterns are safe globs:
 * `*` matches any run of characters and `?` matches one character. Defaults
 * are always retained, so configuration cannot accidentally weaken redaction.
 */
export function createRedactionConfig({
  headerPatterns = [],
  queryPatterns = [],
  bodyFieldPatterns = [],
  env = process.env,
} = {}) {
  const headers = mergePatterns(DEFAULT_HEADER_PATTERNS, env?.[ENV_KEYS.headers], headerPatterns, 'headerPatterns');
  const query = mergePatterns(DEFAULT_FIELD_PATTERNS, env?.[ENV_KEYS.query], queryPatterns, 'queryPatterns');
  const body = mergePatterns(DEFAULT_FIELD_PATTERNS, env?.[ENV_KEYS.body], bodyFieldPatterns, 'bodyFieldPatterns');
  return Object.freeze({
    headers: Object.freeze(headers),
    query: Object.freeze(query),
    body: Object.freeze(body),
  });
}

export function createRedactor(options = {}) {
  const config = createRedactionConfig(options);
  return Object.freeze({
    config,
    redactHeaders: (headers, fields = []) => redactHeaders(headers, fields, config),
    redactUrl: (url, fields = []) => redactUrl(url, fields, config),
    redactBody: (body, headers, fields = []) => redactBody(body, headers, fields, config),
    preview: (sample = {}) => previewRedaction(sample, config),
  });
}

export function previewRedaction({ url, headers, body } = {}, config = createRedactionConfig()) {
  const redactedFields = [];
  const safeHeaders = redactHeaders(headers, redactedFields, config);
  return {
    url: redactUrl(url, redactedFields, config),
    headers: safeHeaders,
    body: redactBody(body, headers, redactedFields, config),
    redacted_fields: [...new Set(redactedFields)],
    patterns: {
      headers: [...config.headers],
      query: [...config.query],
      body: [...config.body],
    },
  };
}

export function redactHeaders(headers, redactedFields = [], config = createRedactionConfig()) {
  if (!headers) return headers;
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => {
    if (!matchesAny(name, config.headers)) return [name, value];
    redactedFields.push(`header:${name}`);
    return [name, '[REDACTED]'];
  }));
}

export function redactUrl(value, redactedFields = [], config = createRedactionConfig()) {
  if (!value) return value;
  try {
    const absolute = /^[A-Za-z][A-Za-z\d+.-]*:/.test(String(value));
    const url = absolute ? new URL(value) : new URL(value, 'http://proxy-mcp.invalid');
    if (url.username) {
      url.username = '[REDACTED]';
      redactedFields.push('url:username');
    }
    if (url.password) {
      url.password = '[REDACTED]';
      redactedFields.push('url:password');
    }
    for (const key of [...url.searchParams.keys()]) {
      if (!matchesAny(key, config.query)) continue;
      url.searchParams.set(key, '[REDACTED]');
      redactedFields.push(`query:${key}`);
    }
    return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch { return value; }
}

export function redactBody(value, headers, redactedFields = [], config = createRedactionConfig()) {
  if (value == null || value === '') return value;
  const contentType = String(headers?.['content-type'] ?? headers?.['Content-Type'] ?? '').toLowerCase();
  if (contentType.includes('json') || /^[\s]*[\[{]/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      const walk = (item, pointer = '$') => {
        if (Array.isArray(item)) return item.map((child, index) => walk(child, `${pointer}[${index}]`));
        if (!item || typeof item !== 'object') return item;
        return Object.fromEntries(Object.entries(item).map(([key, child]) => {
          if (matchesAny(key, config.body)) {
            redactedFields.push(`body:${pointer}.${key}`);
            return [key, '[REDACTED]'];
          }
          return [key, walk(child, `${pointer}.${key}`)];
        }));
      };
      return JSON.stringify(walk(parsed));
    } catch { /* fall through for malformed JSON */ }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    try {
      const params = new URLSearchParams(value);
      for (const key of [...params.keys()]) {
        if (!matchesAny(key, config.body)) continue;
        params.set(key, '[REDACTED]');
        redactedFields.push(`body:${key}`);
      }
      return params.toString();
    } catch { /* return redacted plain text below */ }
  }

  // Plain text uses bounded, delimiter-aware key matching. This avoids turning
  // configurable glob input into executable regular expressions.
  return String(value)
    .replace(/([\p{L}\p{N}_.-]{1,80})(\s*[=:]\s*)([^\s,;&]+)/gu, (match, key, separator) => {
      if (!matchesAny(key, config.body)) return match;
      redactedFields.push(`body:${key}`);
      return `${key}${separator}[REDACTED]`;
    })
    .replace(/(Bearer\s+)[^\s,;&]+/gi, (_match, prefix) => {
      redactedFields.push('body:bearer');
      return `${prefix}[REDACTED]`;
    });
}

function mergePatterns(defaults, envValue, configured, label) {
  if (!Array.isArray(configured)) throw new TypeError(`${label} must be an array of safe glob strings`);
  const extras = [...parseEnvPatterns(envValue), ...configured];
  if (extras.length > MAX_EXTRA_PATTERNS) {
    throw new RangeError(`${label} accepts at most ${MAX_EXTRA_PATTERNS} extra patterns`);
  }
  const normalized = extras.map((pattern) => validatePattern(pattern, label));
  return [...new Set([...defaults, ...normalized])];
}

function parseEnvPatterns(value) {
  if (value == null || value === '') return [];
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096) {
    throw new RangeError('Redaction environment configuration is too large');
  }
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function validatePattern(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} entries must be strings`);
  const pattern = value.trim().toLowerCase();
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH || !SAFE_PATTERN.test(pattern)) {
    throw new TypeError(`${label} entries must be 1-${MAX_PATTERN_LENGTH} characters using letters, digits, _, -, ., * or ?`);
  }
  return pattern;
}

function matchesAny(value, patterns) {
  const candidate = String(value).toLowerCase();
  return patterns.some((pattern) => globMatches(candidate, pattern));
}

function globMatches(value, pattern) {
  // Linear-time wildcard matching (no RegExp construction or backtracking).
  let valueIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let retryValueIndex = -1;
  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && (pattern[patternIndex] === '?' || pattern[patternIndex] === value[valueIndex])) {
      valueIndex += 1;
      patternIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      starIndex = patternIndex;
      retryValueIndex = valueIndex;
      patternIndex += 1;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      retryValueIndex += 1;
      valueIndex = retryValueIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === '*') patternIndex += 1;
  return patternIndex === pattern.length;
}
