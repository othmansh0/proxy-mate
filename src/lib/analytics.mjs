// Deterministic capture analysis shared by MCP tools and headless CI workflows.
// This intentionally returns compact aggregates instead of copying bodies.

const DEFAULT_SLOW_LIMIT = 10;
const DEFAULT_GROUP_LIMIT = 50;

export function analyzeFlows(flows, {
  slow_limit = DEFAULT_SLOW_LIMIT,
  group_limit = DEFAULT_GROUP_LIMIT,
  include_successes = true,
} = {}) {
  if (!Array.isArray(flows)) throw codedError('FLOWS_REQUIRED', 'flows must be an array');
  const endpoints = new Map();
  const statusCounts = new Map();
  const failures = [];
  const timed = [];
  let completed = 0;
  let totalBytes = 0;

  for (const flow of flows) {
    const method = String(flow?.request?.method ?? 'UNKNOWN').toUpperCase();
    const url = safeUrl(flow?.request?.url);
    const route = routeTemplate(url?.pathname ?? flow?.request?.path ?? '/');
    const key = `${method} ${url?.hostname ?? flow?.request?.hostname ?? 'unknown'}${route}`;
    const status = integerOrNull(flow?.response?.statusCode ?? flow?.response?.status);
    const duration = durationMs(flow);
    const bytes = finiteNumber(flow?.response?.body_size) ?? 0;
    totalBytes += Math.max(0, bytes);
    if (status != null) {
      completed += 1;
      statusCounts.set(String(status), (statusCounts.get(String(status)) ?? 0) + 1);
    }
    if (status == null || status >= 400) failures.push(summary(flow, duration));
    if (duration != null) timed.push(summary(flow, duration));

    let endpoint = endpoints.get(key);
    if (!endpoint) {
      endpoint = { endpoint: key, count: 0, failures: 0, durations: [], bytes: 0, statuses: new Map() };
      endpoints.set(key, endpoint);
    }
    endpoint.count += 1;
    endpoint.bytes += Math.max(0, bytes);
    if (status == null || status >= 400) endpoint.failures += 1;
    if (duration != null) endpoint.durations.push(duration);
    if (status != null) endpoint.statuses.set(String(status), (endpoint.statuses.get(String(status)) ?? 0) + 1);
  }

  const endpointRows = [...endpoints.values()].map((entry) => ({
    endpoint: entry.endpoint,
    count: entry.count,
    failures: entry.failures,
    error_rate: ratio(entry.failures, entry.count),
    average_ms: average(entry.durations),
    p95_ms: percentile(entry.durations, 0.95),
    response_bytes: entry.bytes,
    statuses: sortedObject(entry.statuses),
  })).sort((a, b) => b.count - a.count || b.p95_ms - a.p95_ms || a.endpoint.localeCompare(b.endpoint));

  const duplicateRequests = endpointRows
    .filter((entry) => entry.count > 1)
    .sort((a, b) => b.count - a.count || a.endpoint.localeCompare(b.endpoint))
    .slice(0, normalizeLimit(group_limit, DEFAULT_GROUP_LIMIT));

  return {
    flow_count: flows.length,
    completed_count: completed,
    failure_count: failures.length,
    error_rate: ratio(failures.length, flows.length),
    response_bytes: totalBytes,
    status_counts: sortedObject(statusCounts),
    slowest: timed.sort((a, b) => b.duration_ms - a.duration_ms).slice(0, normalizeLimit(slow_limit, DEFAULT_SLOW_LIMIT)),
    failures: failures.slice(0, normalizeLimit(group_limit, DEFAULT_GROUP_LIMIT)),
    endpoints: (include_successes ? endpointRows : endpointRows.filter((entry) => entry.failures > 0))
      .slice(0, normalizeLimit(group_limit, DEFAULT_GROUP_LIMIT)),
    duplicate_requests: duplicateRequests,
  };
}

export function evaluateCaptureAssertions(analysis, assertions = {}) {
  if (!analysis || typeof analysis !== 'object') throw codedError('ANALYSIS_REQUIRED', 'analysis is required');
  if (!assertions || typeof assertions !== 'object' || Array.isArray(assertions)) {
    throw codedError('ASSERTIONS_REQUIRED', 'assertions must be an object');
  }
  const checks = [];
  addMaximum(checks, 'max_error_rate', analysis.error_rate, assertions.max_error_rate);
  addMaximum(checks, 'max_failures', analysis.failure_count, assertions.max_failures);
  addMaximum(checks, 'max_p95_ms', maximum(analysis.endpoints?.map((entry) => entry.p95_ms)), assertions.max_p95_ms);
  addMaximum(checks, 'max_response_bytes', analysis.response_bytes, assertions.max_response_bytes);
  addMinimum(checks, 'min_flows', analysis.flow_count, assertions.min_flows);
  if (Array.isArray(assertions.allowed_statuses)) {
    const allowed = new Set(assertions.allowed_statuses.map(String));
    const unexpected = Object.keys(analysis.status_counts ?? {}).filter((status) => !allowed.has(status));
    checks.push({ assertion: 'allowed_statuses', passed: unexpected.length === 0, actual: unexpected, expected: [...allowed] });
  }
  return {
    passed: checks.every((check) => check.passed),
    checks,
    failed: checks.filter((check) => !check.passed),
  };
}

function summary(flow, duration) {
  return {
    flow_id: flow?.id ?? null,
    method: flow?.request?.method ?? null,
    url: flow?.request?.url ?? null,
    status: integerOrNull(flow?.response?.statusCode ?? flow?.response?.status),
    duration_ms: duration,
  };
}

function durationMs(flow) {
  const explicit = finiteNumber(flow?.duration_ms ?? flow?.timing?.total_ms);
  if (explicit != null) return Math.max(0, explicit);
  const timing = flow?.response?.timing ?? flow?.request?.timing ?? {};
  const start = finiteNumber(timing.startTimestamp);
  const end = finiteNumber(timing.responseSentTimestamp ?? timing.bodyReceivedTimestamp);
  return start != null && end != null ? Math.max(0, end - start) : null;
}

function routeTemplate(pathname) {
  return String(pathname || '/')
    .split('/')
    .map((part) => {
      if (/^\d+$/.test(part)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)) return ':uuid';
      if (/^[0-9a-f]{16,}$/i.test(part)) return ':hex';
      return part;
    })
    .join('/');
}

function safeUrl(value) { try { return new URL(value); } catch { return null; } }
function integerOrNull(value) { const number = Number(value); return Number.isInteger(number) ? number : null; }
function finiteNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function ratio(value, total) { return total > 0 ? Math.round((value / total) * 1_000_000) / 1_000_000 : 0; }
function average(values) { return values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000 : 0; }
function maximum(values = []) { return values.length ? Math.max(...values.map((value) => finiteNumber(value) ?? 0)) : 0; }
function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function normalizeLimit(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? Math.min(number, 1_000) : fallback;
}
function sortedObject(map) { return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))); }
function addMaximum(checks, name, actual, expected) {
  if (expected == null) return;
  const limit = finiteNumber(expected);
  if (limit == null) throw codedError('INVALID_ASSERTION', `${name} must be finite`);
  checks.push({ assertion: name, passed: actual <= limit, actual, expected: limit });
}
function addMinimum(checks, name, actual, expected) {
  if (expected == null) return;
  const limit = finiteNumber(expected);
  if (limit == null) throw codedError('INVALID_ASSERTION', `${name} must be finite`);
  checks.push({ assertion: name, passed: actual >= limit, actual, expected: limit });
}
function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
