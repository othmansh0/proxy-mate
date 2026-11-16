import { readEnvironment } from './environment.mjs';
// Daemon control plane — local HTTP server that lets a separate MCP-server
// process forward tool calls into a long-running daemon. Token-authenticated
// via ~/.proxy-mate/handshake.json (0600).
//
// Endpoint shape: POST /rpc with body { tool: "name", args: {...} }
// Returns: { ok: true, result: ... } or { ok: false, error: "..." }
// Auth: Authorization: Bearer <token-from-handshake-json>

import http from 'node:http';
import crypto from 'node:crypto';
import { z } from 'zod';
import { writeHandshake, clearHandshake } from './state.mjs';
import { MCP_TOOLS } from './mcp-contract.mjs';
import { SERVER_VERSION } from './config.mjs';

export const DEFAULT_CONTROL_PORT = 8082;
const MAX_RPC_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;
const DEFAULT_RATE_LIMIT = 600;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const READ_ONLY_TOOL_NAMES = new Set(MCP_TOOLS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name));
export const SERIAL_TOOL_NAMES = new Set([
  'acquire_capture_lease', 'release_capture_lease', 'finish_capture_task', 'toggle_recording', 'import_har', 'restart_sim_apps',
  'start_proxy', 'stop_proxy', 'set_proxy_routing', 'clear_proxy_routing',
  'start_app_capture',
  'setup_host_certificate', 'remove_host_certificate', 'setup_simulator_certificate',
  'rotate_certificate_authority',
  'setup_xcode_preview_certificate', 'trust_ca_on_simulators',
  'verify_simulator_certificate',
  'create_capture_session', 'select_capture_session', 'import_capture_session',
  'purge_capture_session', 'clear_session',
  'create_map_local', 'create_map_remote', 'create_blacklist', 'create_breakpoint',
  'mock_json_response', 'patch_mock_json',
  'create_network_condition', 'create_no_cache_rule', 'capture_to_mock',
  'update_rule', 'set_rule_enabled', 'set_rule_priority', 'reorder_rules',
  'remove_rule', 'clear_rules', 'import_rules',
  'start_sim_watcher', 'stop_sim_watcher', 'start_device_onboarding',
  'stop_device_onboarding', 'create_reverse_proxy', 'remove_reverse_proxy',
  'start_operator_ui', 'stop_operator_ui',
  'upsert_transform_plugin', 'remove_transform_plugin',
  'set_transform_plugin_enabled', 'create_transform_plugin_rule',
  'enable_ssl_proxying', 'reconcile_state', 'kill_orphan_proxy', 'update_capture_session',
]);

export function rpcTimeoutFor(tool, args = {}) {
  const requested = Number.isFinite(args.timeout_ms) ? args.timeout_ms : 30_000;
  if (tool === 'wait_for_flow' || /request|repeat|curl/.test(tool)) return Math.min(310_000, Math.max(30_000, requested + 5_000));
  return MCP_TOOLS.find((item) => item.name === tool)?.longRunning ? 300_000 : 30_000;
}

export class ControlServer {
  constructor({
    port = DEFAULT_CONTROL_PORT,
    tools,
    scopes = ['observe', 'control', ...(readEnvironment('PROXY_MATE_ALLOW_SENSITIVE') === '1' ? ['sensitive'] : [])],
    maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
    rateLimit = DEFAULT_RATE_LIMIT,
    rateWindowMs = DEFAULT_RATE_WINDOW_MS,
  }) {
    this.port = port;
    this.tools = tools;
    this.server = null;
    this.token = null;
    this.queue = Promise.resolve();
    this.scopes = new Set(scopes);
    this.maxConcurrentRequests = boundedInteger(maxConcurrentRequests, 1, 256, 'maxConcurrentRequests');
    this.rateLimit = boundedInteger(rateLimit, 1, 100_000, 'rateLimit');
    this.rateWindowMs = boundedInteger(rateWindowMs, 1_000, 60 * 60_000, 'rateWindowMs');
    this.activeRequests = 0;
    this.rateBuckets = new Map();
    this.controllers = new Set();
    this.sockets = new Set();
  }

  async start() {
    if (this.server) return this.port;
    this.token = crypto.randomBytes(32).toString('hex');
    await new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.#handle(req, res));
      srv.requestTimeout = 35_000;
      srv.headersTimeout = 10_000;
      srv.keepAliveTimeout = 5_000;
      // Tool deadlines are enforced below; certificate setup and flow waits
      // legitimately outlive the HTTP idle timeout used in earlier versions.
      srv.timeout = 0;
      srv.maxHeadersCount = 100;
      srv.maxRequestsPerSocket = 100;
      srv.maxConnections = 128;
      srv.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
      });
      srv.once('error', reject);
      srv.listen(this.port, '127.0.0.1', () => {
        this.server = srv;
        this.port = srv.address().port;
        resolve();
      });
    });
    try { await writeHandshake(this.token, `http://127.0.0.1:${this.port}`, [...this.scopes]); }
    catch (error) { await this.stop(); throw error; }
    return this.port;
  }

  async stop() {
    if (!this.server) return;
    const closed = new Promise((resolve) => this.server.close(() => resolve()));
    for (const controller of this.controllers) controller.abort(codedCancellation('Daemon is shutting down.'));
    for (const socket of this.sockets) socket.destroy();
    await closed;
    await this.queue;
    this.server = null;
    await clearHandshake(this.token);
  }

  #handle(req, res) {
    res.setHeader('cache-control', 'no-store');
    req.on('error', () => res.destroy());
    if (!this.#validAuthority(req.headers.host)) {
      writeControlError(res, 421, 'INVALID_HOST', 'Host header does not identify this local control server.');
      return;
    }
    if (!this.#validOrigin(req.headers.origin)) {
      writeControlError(res, 403, 'INVALID_ORIGIN', 'Origin is not permitted for this local control server.');
      return;
    }
    if (!this.#consumeRate(req.socket.remoteAddress)) {
      res.setHeader('retry-after', String(Math.max(1, Math.ceil(this.rateWindowMs / 1000))));
      writeControlError(res, 429, 'RATE_LIMITED', 'Local control request rate limit exceeded.');
      return;
    }
    if (this.activeRequests >= this.maxConcurrentRequests) {
      writeControlError(res, 503, 'CONTROL_BUSY', 'Local control server concurrency limit reached.');
      return;
    }
    this.activeRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    };
    res.once('finish', release);
    res.once('close', release);

    const auth = req.headers['authorization'] ?? '';
    const expected = `Bearer ${this.token}`;
    if (!constantTimeEqual(auth, expected)) {
      res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'unauthorized' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      // Headerless pre-rename bridges require the old service marker. New
      // clients identify themselves and accept either generation of daemon.
      res.end(JSON.stringify({ ok: true, service: req.headers['x-proxy-mate-client'] === '1' ? 'proxy-mate' : 'proxy-mcp', name: 'proxy-mate', pid: process.pid }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404); res.end(); return;
    }
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > MAX_RPC_BYTES) {
        tooLarge = true;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: `RPC body exceeds ${MAX_RPC_BYTES} bytes` } }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (tooLarge) return;
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'bad json' })); return; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || typeof payload.tool !== 'string'
        || (payload.args != null && (typeof payload.args !== 'object' || Array.isArray(payload.args)))) {
        writeControlError(res, 400, 'INVALID_RPC', 'Expected an object containing a tool name and object args.');
        return;
      }
      const { tool } = payload;
      let args = payload.args ?? {};
      const fn = Object.hasOwn(this.tools, tool) ? this.tools[tool] : null;
      if (typeof fn !== 'function') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'UNKNOWN_TOOL', message: `unknown tool: ${tool}` } }));
        return;
      }
      const definition = MCP_TOOLS.find((item) => item.name === tool);
      if (definition) {
        const parsed = z.object(definition.inputSchema).safeParse(args);
        if (!parsed.success) {
          writeControlError(res, 400, 'INVALID_ARGUMENTS', 'Arguments do not satisfy the MCP tool schema.');
          return;
        }
        args = parsed.data;
      }
      const requiredScope = READ_ONLY_TOOL_NAMES.has(tool) || !MCP_TOOLS.some((definition) => definition.name === tool)
        ? 'observe'
        : 'control';
      if (!this.scopes.has(requiredScope) || (args?.include_sensitive === true && !this.scopes.has('sensitive'))) {
        res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({
          ok: false,
          error: {
            code: 'FORBIDDEN_SCOPE',
            message: `Control token lacks required ${args?.include_sensitive === true ? 'sensitive' : requiredScope} scope.`,
            details: { required_scope: args?.include_sensitive === true ? 'sensitive' : requiredScope },
            recovery: args?.include_sensitive === true
              ? ['Retry include_sensitive=false for redacted text. Do not restart shared capture merely to export JSON.']
              : ['Use a control-authorized connection for this mutation.'],
          },
        }));
        return;
      }
      const controller = new AbortController();
      this.controllers.add(controller);
      const deadline = setTimeout(() => controller.abort(Object.assign(new Error('Tool deadline exceeded.'), { code: 'DAEMON_TIMEOUT' })), rpcTimeoutFor(tool, args ?? {}));
      try {
        // Serialize only shared-state mutations. Reads, waits, request replay,
        // and breakpoint resolution must remain concurrent: a composed request
        // may itself be paused and need a second MCP call to resolve it.
        res.once('close', () => {
          if (!res.writableEnded) controller.abort(codedCancellation('RPC client disconnected.'));
        });
        const invoke = () => {
          if (controller.signal.aborted) throw controller.signal.reason ?? codedCancellation();
          return fn(args ?? {}, { signal: controller.signal,
            bridge_version: typeof payload.client?.bridge_version === 'string' ? payload.client.bridge_version.slice(0, 32) : null });
        };
        const operation = SERIAL_TOOL_NAMES.has(tool)
          ? this.queue.then(invoke)
          : Promise.resolve().then(invoke);
        if (SERIAL_TOOL_NAMES.has(tool)) this.queue = operation.catch(() => {});
        const result = await Promise.race([
          operation,
          new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
        ]);
        // Serialize before committing headers. A stringify failure after
        // writeHead lands in the catch below, which would writeHead a second
        // time; that throws ERR_HTTP_HEADERS_SENT inside this async 'end'
        // handler, where nothing can catch it, and takes the daemon down.
        const body = JSON.stringify({ ok: true, result });
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      } catch (e) {
        if (res.headersSent || res.writableEnded || res.destroyed) { res.destroy(); return; }
        let body;
        try { body = JSON.stringify({ ok: false, error: serializeToolError(e, tool) }); }
        catch { body = JSON.stringify({ ok: false, error: { code: 'TOOL_FAILED', message: 'Tool failed with non-serializable error details.' } }); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      } finally {
        clearTimeout(deadline);
        this.controllers.delete(controller);
      }
    });
  }

  #validAuthority(host) {
    if (typeof host !== 'string' || host.length > 255) return false;
    const normalized = host.trim().toLowerCase();
    return normalized === `127.0.0.1:${this.port}`
      || normalized === `localhost:${this.port}`
      || normalized === `[::1]:${this.port}`;
  }

  #validOrigin(origin) {
    if (origin === undefined) return true; // CLI/stdio daemon calls have no Origin.
    if (typeof origin !== 'string' || origin.length > 512) return false;
    try {
      const parsed = new URL(origin);
      return parsed.protocol === 'http:'
        && parsed.username === ''
        && parsed.password === ''
        && parsed.pathname === '/'
        && parsed.search === ''
        && parsed.hash === ''
        && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname.toLowerCase())
        && Number(parsed.port || 80) === this.port;
    } catch { return false; }
  }

  #consumeRate(remoteAddress) {
    const key = String(remoteAddress ?? 'local');
    const now = Date.now();
    const current = this.rateBuckets.get(key);
    if (!current || now - current.startedAt >= this.rateWindowMs) {
      this.rateBuckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.rateLimit;
  }
}

function writeControlError(res, status, code, message) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: false, error: { code, message } }));
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function constantTimeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Client side: connect to a running daemon, forward an RPC call.
export async function callDaemon({ controlUrl, token, tool, args, timeoutMs = rpcTimeoutFor(tool, args), signal } = {}) {
  const url = new URL('/rpc', controlUrl);
  const body = JSON.stringify({ tool, args: args ?? {}, client: { bridge_version: SERVER_VERSION } });
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(codedCancellation('Daemon RPC was cancelled before it started.'));
    let settled = false;
    let deadline;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      const error = codedCancellation('Daemon RPC was cancelled.');
      req.destroy(error);
      finish(reject, error);
    };
    const req = http.request({
      method: 'POST',
      host: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'authorization': `Bearer ${token}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > 32 * 1024 * 1024) req.destroy(Object.assign(new Error('Daemon response exceeds 32 MiB; request a smaller page.'), { code: 'RESPONSE_TOO_LARGE' }));
        else chunks.push(c);
      });
      res.on('error', (error) => finish(reject, transportFailure(error, tool)));
      res.on('aborted', () => finish(reject, transportFailure(Object.assign(new Error('Daemon response was interrupted.'), { code: 'ECONNRESET' }), tool)));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return finish(reject, new Error(`daemon returned non-JSON (status ${res.statusCode})`)); }
        if (!parsed || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean') {
          return finish(reject, Object.assign(new Error('Daemon returned an invalid RPC envelope.'), { code: 'INVALID_DAEMON_RESPONSE' }));
        }
        if (!parsed.ok) {
          const detail = typeof parsed.error === 'object' ? parsed.error : { message: parsed.error };
          const error = new Error(detail?.message ?? 'daemon error');
          error.code = detail?.code ?? 'DAEMON_ERROR';
          if (detail?.retryable !== undefined) error.retryable = detail.retryable;
          if (detail?.recovery !== undefined) error.recovery = detail.recovery;
          if (detail?.details !== undefined) error.details = detail.details;
          return finish(reject, error);
        }
        finish(resolve, parsed.result);
      });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    deadline = setTimeout(() => req.destroy(Object.assign(new Error('daemon rpc deadline exceeded'), { code: 'DAEMON_TIMEOUT' })), timeoutMs + 1000);
    req.on('error', (error) => finish(reject, transportFailure(error, tool)));
    req.on('timeout', () => {
      const error = new Error('daemon rpc timeout');
      error.code = 'DAEMON_TIMEOUT';
      req.destroy(error);
    });
    req.write(body);
    req.end();
  });
}

function transportFailure(error, tool) {
  if (!['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'DAEMON_TIMEOUT'].includes(error?.code)) return error;
  const readOnly = READ_ONLY_TOOL_NAMES.has(tool);
  return Object.assign(new Error(readOnly
    ? 'The daemon connection failed. Retry this read after recovery.'
    : 'The daemon connection failed; the operation may have completed. Inspect shared state before resubmitting.'), {
    code: error.code === 'DAEMON_TIMEOUT' ? 'DAEMON_TIMEOUT' : 'DAEMON_DISCONNECTED',
    retryable: readOnly,
    details: { transport_code: error.code, completion_unknown: !readOnly },
    recovery: readOnly ? ['Retry after the daemon is healthy.']
      : ['Reconnect and inspect status, rules or captured flows to determine whether the operation completed.'],
  });
}

function serializeToolError(error, tool) {
  const recovery = error?.recovery ?? (error?.code === 'PATH_NOT_AUTHORIZED'
    && ['save_body_to_file', 'export_har', 'export_capture_session'].includes(tool)
    ? ['Retry without path and read the returned private export file. Arbitrary scratch paths are not authorized.'] : undefined);
  return {
    code: error?.code ?? 'TOOL_FAILED',
    message: error?.message ?? String(error),
    ...(error?.retryable !== undefined ? { retryable: error.retryable === true } : {}),
    ...(recovery !== undefined ? { recovery } : {}),
    ...(error?.details !== undefined ? { details: error.details } : {}),
  };
}

function codedCancellation(message = 'Request cancelled.') {
  const error = new Error(message);
  error.code = 'REQUEST_CANCELLED';
  error.retryable = true;
  return error;
}

// Probe the daemon: GET /health. Returns true if alive.
export async function probeDaemon(controlUrl, token, timeoutMs = 1500) {
  if (!token) return false;
  let url;
  try {
    url = new URL('/health', controlUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return false;
  } catch { return false; }
  return new Promise((resolve) => {
    let timer;
    const finish = (value) => { clearTimeout(timer); resolve(value); };
    const req = http.get({
      host: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      headers: { authorization: `Bearer ${token}`, 'x-proxy-mate-client': '1' },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; if (bytes > 4096) { req.destroy(); finish(false); } else chunks.push(c); });
      res.on('error', () => finish(false));
      res.on('aborted', () => finish(false));
      res.on('end', () => {
        try {
          const p = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          finish(res.statusCode === 200 && p?.ok === true && ['proxy-mate', 'proxy-mcp'].includes(p.service));
        } catch { finish(false); }
      });
    });
    timer = setTimeout(() => { req.destroy(); finish(false); }, timeoutMs);
    req.on('error', () => finish(false));
    req.on('timeout', () => { req.destroy(); finish(false); });
  });
}
