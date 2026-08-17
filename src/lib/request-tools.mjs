import { performance } from 'node:perf_hooks';

const MAX_RETURN_BODY = 64 * 1024;

export async function composeHttpRequest({
  url, method = 'GET', headers = {}, body, json, form, timeout_ms = 30_000, signal,
} = {}) {
  const target = validateHttpUrl(url);
  const normalizedHeaders = new Headers(headers);
  let payload = body;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    if (!normalizedHeaders.has('content-type')) normalizedHeaders.set('content-type', 'application/json');
  } else if (form !== undefined) {
    payload = new URLSearchParams(form).toString();
    if (!normalizedHeaders.has('content-type')) normalizedHeaders.set('content-type', 'application/x-www-form-urlencoded');
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('request timeout'));
  }, Math.max(100, timeout_ms));
  const cancel = () => controller.abort(signal.reason ?? new Error('request cancelled'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const started = performance.now();
  try {
    const response = await fetch(target, {
      method: String(method).toUpperCase(),
      headers: normalizedHeaders,
      body: ['GET', 'HEAD'].includes(String(method).toUpperCase()) ? undefined : payload,
      redirect: 'manual',
      signal: controller.signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const returned = bytes.subarray(0, MAX_RETURN_BODY);
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const textual = isTextual(contentType);
    return {
      ok: response.ok,
      request: { method: String(method).toUpperCase(), url: target.toString() },
      response: {
        status: response.status,
        status_text: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: textual ? returned.toString('utf8') : undefined,
        body_base64: textual ? undefined : returned.toString('base64'),
        body_encoding: textual ? 'utf8' : 'base64',
        body_size: bytes.length,
        body_returned_bytes: returned.length,
        body_truncated: returned.length < bytes.length,
      },
      timing: { total_ms: Math.round((performance.now() - started) * 1000) / 1000 },
    };
  } catch (error) {
    const cancelled = signal?.aborted && !timedOut;
    const wrapped = new Error(cancelled
      ? 'Request cancelled.'
      : timedOut ? `Request timed out after ${timeout_ms}ms` : error?.message ?? String(error));
    wrapped.code = cancelled ? 'REQUEST_CANCELLED' : timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED';
    wrapped.retryable = true;
    throw wrapped;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export function generateSwiftUrlSession(flow) {
  if (!flow?.request?.url) throw codedError('INVALID_FLOW', 'The flow does not contain a request URL.');
  const request = flow.request;
  const lines = [
    `var request = URLRequest(url: URL(string: ${swiftString(request.url)})!)`,
    `request.httpMethod = ${swiftString(request.method ?? 'GET')}`,
  ];
  for (const [name, raw] of Object.entries(request.headers ?? {})) {
    if (/^(host|content-length|authorization|cookie|proxy-authorization)$/i.test(name)) continue;
    const value = Array.isArray(raw) ? raw.join(', ') : String(raw);
    lines.push(`request.setValue(${swiftString(value)}, forHTTPHeaderField: ${swiftString(name)})`);
  }
  if (request.body_inline) {
    lines.push(`request.httpBody = ${swiftString(request.body_inline)}.data(using: .utf8)`);
  } else if ((request.body_size ?? 0) > 0) {
    lines.push('// Request body was binary or omitted from the captured preview; load it explicitly here.');
  }
  lines.push('', 'let (data, response) = try await URLSession.shared.data(for: request)');
  return {
    language: 'swift',
    client: 'URLSession async/await',
    code: lines.join('\n'),
    redacted_headers: Object.keys(request.headers ?? {}).filter((name) => /^(authorization|cookie|proxy-authorization)$/i.test(name)),
  };
}

export function parseCurlCommand(command) {
  const tokens = shellTokens(command);
  if (tokens[0] !== 'curl') throw codedError('CURL_REQUIRED', 'Command must start with curl.');
  const request = { method: null, url: null, headers: {}, body: undefined };
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '-X' || token === '--request') request.method = requireToken(tokens, ++index, token).toUpperCase();
    else if (token.startsWith('--request=')) request.method = token.slice(10).toUpperCase();
    else if (token === '-H' || token === '--header') addHeader(request.headers, requireToken(tokens, ++index, token));
    else if (token.startsWith('--header=')) addHeader(request.headers, token.slice(9));
    else if (['-d', '--data', '--data-raw', '--data-binary'].includes(token)) request.body = requireToken(tokens, ++index, token);
    else if (/^--data(?:-raw|-binary)?=/.test(token)) request.body = token.slice(token.indexOf('=') + 1);
    else if (token === '--url') request.url = requireToken(tokens, ++index, token);
    else if (token.startsWith('--url=')) request.url = token.slice(6);
    else if (['-L', '--location', '-s', '--silent', '-S', '--show-error', '-i', '--include', '-k', '--insecure', '--compressed'].includes(token)) continue;
    else if (token.startsWith('-')) throw codedError('CURL_OPTION_UNSUPPORTED', `Unsupported cURL option: ${token}`);
    else if (!request.url) request.url = token;
    else throw codedError('CURL_ARGUMENT_UNEXPECTED', `Unexpected cURL argument: ${token}`);
  }
  const target = validateHttpUrl(request.url);
  request.url = target.toString();
  request.method ??= request.body === undefined ? 'GET' : 'POST';
  return request;
}

export function generateRequestCode(flow, language = 'javascript') {
  if (!flow?.request?.url) throw codedError('INVALID_FLOW', 'The flow does not contain a request URL.');
  const request = sanitizeCodeRequest(flow.request);
  const normalized = String(language).toLowerCase();
  if (normalized === 'swift') {
    const generated = generateSwiftUrlSession({ request });
    return { ...generated, redacted_headers: [...new Set([...request.redacted_headers, ...generated.redacted_headers])] };
  }
  if (normalized === 'javascript' || normalized === 'js' || normalized === 'fetch') {
    const options = { method: request.method, headers: request.headers };
    if (request.body_inline) options.body = request.body_inline;
    return {
      language: 'javascript', client: 'fetch', redacted_headers: request.redacted_headers,
      code: `const response = await fetch(${JSON.stringify(request.url)}, ${JSON.stringify(options, null, 2)});\nconst body = await response.text();`,
    };
  }
  if (normalized === 'python' || normalized === 'py') {
    const lines = ['import requests', '', `response = requests.request(`, `    ${JSON.stringify(request.method)},`, `    ${JSON.stringify(request.url)},`, `    headers=${pythonValue(request.headers)},`];
    if (request.body_inline) lines.push(`    data=${JSON.stringify(request.body_inline)},`);
    lines.push(')', 'print(response.status_code)', 'print(response.text)');
    return { language: 'python', client: 'requests', redacted_headers: request.redacted_headers, code: lines.join('\n') };
  }
  if (normalized === 'go' || normalized === 'golang') {
    const body = request.body_inline ? `strings.NewReader(${goString(request.body_inline)})` : 'nil';
    const lines = ['req, err := http.NewRequest(' + goString(request.method) + ', ' + goString(request.url) + ', ' + body + ')', 'if err != nil { log.Fatal(err) }'];
    for (const [name, value] of Object.entries(request.headers)) lines.push(`req.Header.Set(${goString(name)}, ${goString(Array.isArray(value) ? value.join(', ') : value)})`);
    lines.push('resp, err := http.DefaultClient.Do(req)', 'if err != nil { log.Fatal(err) }', 'defer resp.Body.Close()');
    return { language: 'go', client: 'net/http', redacted_headers: request.redacted_headers, code: lines.join('\n'), imports: ['net/http', ...(request.body_inline ? ['strings'] : []), 'log'] };
  }
  throw codedError('LANGUAGE_UNSUPPORTED', 'language must be javascript, python, go, or swift.');
}

export function diffFlows(left, right) {
  if (!left || !right) throw codedError('FLOW_REQUIRED', 'Both flows are required.');
  const changes = [];
  compare('request.method', left.request?.method, right.request?.method, changes);
  compare('request.url', left.request?.url, right.request?.url, changes);
  compare('response.status', left.response?.statusCode, right.response?.statusCode, changes);
  compareObjects('request.headers', left.request?.headers ?? {}, right.request?.headers ?? {}, changes);
  compareObjects('response.headers', left.response?.headers ?? {}, right.response?.headers ?? {}, changes);
  compare('request.body_sha', left.request?.body_sha, right.request?.body_sha, changes);
  compare('response.body_sha', left.response?.body_sha, right.response?.body_sha, changes);
  return { equal: changes.length === 0, changes };
}

function compare(field, before, after, changes) {
  if (before !== after) changes.push({ field, before: before ?? null, after: after ?? null });
}

function compareObjects(prefix, before, after, changes) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const a = Array.isArray(before[key]) ? before[key].join('\n') : before[key];
    const b = Array.isArray(after[key]) ? after[key].join('\n') : after[key];
    compare(`${prefix}.${key.toLowerCase()}`, a, b, changes);
  }
}

function validateHttpUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw codedError('INVALID_URL', 'url must be an absolute HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw codedError('UNSUPPORTED_SCHEME', 'Only HTTP and HTTPS URLs are supported.');
  if (parsed.username || parsed.password) throw codedError('URL_CREDENTIALS_REJECTED', 'Credentials in URLs are not accepted; use an Authorization header in a trusted session.');
  return parsed;
}

function sanitizeCodeRequest(request) {
  const headers = {};
  const redacted = [];
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (/^(host|content-length)$/i.test(name)) continue;
    if (/^(authorization|cookie|proxy-authorization|x-api-key|api-key)$/i.test(name)) {
      redacted.push(name);
      continue;
    }
    headers[name] = value;
  }
  return {
    method: String(request.method ?? 'GET').toUpperCase(), url: validateHttpUrl(request.url).toString(),
    headers, body_inline: request.body_inline ?? '', redacted_headers: redacted,
  };
}

function shellTokens(command) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 256 * 1024) {
    throw codedError('CURL_INVALID', 'cURL command must be a non-empty string under 256 KB.');
  }
  const tokens = [];
  let value = '';
  let quote = null;
  let escaping = false;
  let started = false;
  for (const character of command.trim()) {
    if (escaping) { value += character; escaping = false; started = true; continue; }
    if (character === '\\' && quote !== "'") { escaping = true; started = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      else value += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
    if (/\s/.test(character)) {
      if (started) { tokens.push(value); value = ''; started = false; }
      continue;
    }
    value += character;
    started = true;
  }
  if (escaping || quote) throw codedError('CURL_INVALID', 'cURL command contains an unfinished quote or escape.');
  if (started) tokens.push(value);
  return tokens;
}

function requireToken(tokens, index, option) {
  if (index >= tokens.length) throw codedError('CURL_INVALID', `${option} requires a value.`);
  return tokens[index];
}

function addHeader(headers, line) {
  const separator = String(line).indexOf(':');
  if (separator <= 0) throw codedError('CURL_HEADER_INVALID', `Invalid header: ${line}`);
  const name = String(line).slice(0, separator).trim();
  const value = String(line).slice(separator + 1).trim();
  const current = headers[name];
  headers[name] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
}

function pythonValue(value) {
  if (Array.isArray(value)) return `[${value.map(pythonValue).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonValue(item)}`).join(', ')}}`;
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return JSON.stringify(value);
}

function goString(value) { return JSON.stringify(String(value)).replaceAll('</', '<\\/'); }

function isTextual(contentType) {
  return /(^text\/|json|javascript|xml|yaml|x-www-form-urlencoded|graphql)/i.test(contentType);
}

function swiftString(value) {
  return JSON.stringify(String(value)).replaceAll('\\/', '/');
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
