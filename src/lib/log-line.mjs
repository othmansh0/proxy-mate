// One timestamped, single-line stderr record per event. Callers pass scalar
// diagnostic fields only: never paths, queries, headers, bodies or tokens.
// Shared by the daemon, the guardian and the bridge so every log line can be
// dated and attributed (see the 17 Nov 2026 multi-agent incident).

const SAFE_BARE = /^[A-Za-z0-9_.:/@+-]+$/;

function formatValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  const text = String(value).replace(/[\r\n]+/g, ' ').slice(0, 300);
  return SAFE_BARE.test(text) ? text : JSON.stringify(text);
}

export function formatLogLine(component, message, fields = {}, { now = () => new Date(), pid = process.pid } = {}) {
  const parts = [`${now().toISOString()} [proxy-mate ${component} pid=${pid}] ${String(message).replace(/[\r\n]+/g, ' ')}`];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) continue;
    if (!/^[a-z][a-z0-9_]*$/.test(key)) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return `${parts.join(' ')}\n`;
}

export function logLine(component, message, fields, options = {}) {
  const { write = (line) => process.stderr.write(line), ...rest } = options;
  try { write(formatLogLine(component, message, fields, rest)); } catch { /* logging never throws */ }
}

// Summarise an error for a log line or event without stacks or payloads.
export function errorFields(error) {
  if (!error || typeof error !== 'object') return { error_message: String(error) };
  return {
    error_code: error.code ?? null,
    error_name: error.name ?? null,
    error_message: typeof error.message === 'string' ? error.message.slice(0, 200) : null,
    ...(error.signal ? { error_signal: error.signal } : {}),
    ...(error.killed ? { error_killed: true } : {}),
  };
}
