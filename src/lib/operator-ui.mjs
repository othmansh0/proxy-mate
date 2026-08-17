import crypto from 'node:crypto';
import http from 'node:http';

import { createRedactor } from './redaction.mjs';

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
const DEFAULT_RATE_LIMIT = 120;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const MAX_ITEMS = 100;
const CSP = (nonce) => `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'none'; object-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'`;

/**
 * A small, opt-in, read-only operator view. It deliberately has no mutation
 * endpoints, keeps its bearer token only in process memory while running, and
 * projects provider data to a fixed set of safe summary fields.
 */
export class OperatorUiServer {
  constructor({
    port = 0,
    providers = {},
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
    rateLimit = DEFAULT_RATE_LIMIT,
    rateWindowMs = DEFAULT_RATE_WINDOW_MS,
    redactor = createRedactor(),
  } = {}) {
    this.port = boundedInteger(port, 0, 65_535, 'port');
    this.providers = Object.freeze({ ...providers });
    // The static no-dependency page is below 4 KiB; retain that as the lower
    // bound so this setting constrains every response, not only JSON APIs.
    this.maxResponseBytes = boundedInteger(maxResponseBytes, 4096, 1024 * 1024, 'maxResponseBytes');
    this.maxConcurrentRequests = boundedInteger(maxConcurrentRequests, 1, 64, 'maxConcurrentRequests');
    this.rateLimit = boundedInteger(rateLimit, 1, 10_000, 'rateLimit');
    this.rateWindowMs = boundedInteger(rateWindowMs, 1_000, 60 * 60_000, 'rateWindowMs');
    if (!redactor || typeof redactor.redactUrl !== 'function') throw new TypeError('redactor must provide redactUrl()');
    this.redactor = redactor;
    this.server = null;
    this.token = null;
    this.activeRequests = 0;
    this.rateBuckets = new Map();
    this.startedAt = null;
  }

  get status() {
    return Object.freeze({
      running: Boolean(this.server),
      host: '127.0.0.1',
      port: this.server ? this.port : null,
      url: this.server ? `http://127.0.0.1:${this.port}/` : null,
    });
  }

  async start({ port = this.port } = {}) {
    if (this.server) return { ...this.status, token: this.token };
    this.port = boundedInteger(port, 0, 65_535, 'port');
    this.token = crypto.randomBytes(32).toString('base64url');
    this.startedAt = new Date().toISOString();
    const server = http.createServer((req, res) => this.#handle(req, res));
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 2_000;
    server.maxHeadersCount = 32;
    server.maxRequestsPerSocket = 50;
    server.maxConnections = 64;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, '127.0.0.1', () => {
          server.off('error', reject);
          this.server = server;
          this.port = server.address().port;
          resolve();
        });
      });
    } catch (error) {
      this.token = null;
      this.startedAt = null;
      throw error;
    }
    return { ...this.status, token: this.token };
  }

  async stop() {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.port = 0;
    this.token = null;
    this.rateBuckets.clear();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  async #handle(req, res) {
    if (!this.#validHost(req.headers.host)) return this.#error(res, 421, 'INVALID_HOST');
    if (!this.#validOrigin(req.headers.origin)) return this.#error(res, 403, 'INVALID_ORIGIN');
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.#error(res, 405, 'METHOD_NOT_ALLOWED');
    if (!this.#consumeRate(req.socket.remoteAddress)) {
      res.setHeader('retry-after', String(Math.max(1, Math.ceil(this.rateWindowMs / 1000))));
      return this.#error(res, 429, 'RATE_LIMITED');
    }
    if (req.url === '/' || req.url === '/index.html') return this.#page(req, res);
    if (!this.#authorized(req.headers.authorization)) return this.#error(res, 401, 'UNAUTHORIZED');
    if (this.activeRequests >= this.maxConcurrentRequests) return this.#error(res, 503, 'BUSY');
    this.activeRequests += 1;
    try {
      const payload = await this.#apiPayload(req.url);
      if (!payload) return this.#error(res, 404, 'NOT_FOUND');
      return this.#json(res, 200, payload, req.method === 'HEAD');
    } catch {
      return this.#error(res, 503, 'UNAVAILABLE');
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    }
  }

  async #apiPayload(path) {
    switch (path) {
      case '/api/health': return sanitizeHealth(await this.#provider('health'));
      case '/api/status': return sanitizeStatus(await this.#provider('status'));
      case '/api/flows': return { flows: sanitizeFlows(await this.#provider('recentFlows'), this.redactor) };
      case '/api/rules': return { rules: sanitizeRules(await this.#provider('rules')) };
      default: return null;
    }
  }

  async #provider(name) {
    const provider = this.providers[name];
    if (typeof provider !== 'function') return {};
    return await provider();
  }

  #page(req, res) {
    const nonce = crypto.randomBytes(16).toString('base64url');
    const body = Buffer.from(renderPage(nonce));
    res.writeHead(200, securityHeaders({
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.length),
      'content-security-policy': CSP(nonce),
    }));
    if (req.method !== 'HEAD') res.end(body); else res.end();
  }

  #json(res, status, value, headOnly = false) {
    const body = boundedJson(value, this.maxResponseBytes);
    res.writeHead(status, securityHeaders({
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
    }));
    if (!headOnly) res.end(body); else res.end();
  }

  #error(res, status, code) {
    const body = Buffer.from(JSON.stringify({ ok: false, error: code }));
    res.writeHead(status, securityHeaders({
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
    }));
    res.end(body);
  }

  #validHost(host) {
    return host === `127.0.0.1:${this.port}`;
  }

  #validOrigin(origin) {
    return origin == null || origin === `http://127.0.0.1:${this.port}`;
  }

  #authorized(value) {
    const expected = `Bearer ${this.token}`;
    const actual = typeof value === 'string' ? value : '';
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(actual);
    return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
  }

  #consumeRate(address) {
    const key = address ?? 'unknown';
    const now = Date.now();
    const bucket = this.rateBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= this.rateWindowMs) {
      this.rateBuckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.rateLimit;
  }
}

export function createOperatorUi(options) {
  return new OperatorUiServer(options);
}

function securityHeaders(headers) {
  return {
    ...headers,
    'cache-control': 'no-store, max-age=0',
    'pragma': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  };
}

function sanitizeHealth(value) {
  const source = object(value);
  return {
    ok: source.ok !== false,
    service: string(source.service, 'proxy-mcp', 80),
    started_at: string(source.started_at, null, 64),
  };
}

function sanitizeStatus(value) {
  const source = object(value);
  return {
    proxy_running: Boolean(source.proxy_running ?? source.running),
    capture_active: Boolean(source.capture_active),
    session_id: string(source.session_id, null, 96),
    session_name: string(source.session_name, null, 128),
    flow_count: number(source.flow_count, 0),
    rule_count: number(source.rule_count, 0),
    updated_at: string(source.updated_at, null, 64),
  };
}

function sanitizeFlows(value, redactor) {
  const input = Array.isArray(value) ? value : Array.isArray(value?.flows) ? value.flows : [];
  return input.slice(0, MAX_ITEMS).map((item) => {
    const flow = object(item);
    const request = object(flow.request);
    const response = object(flow.response);
    return {
      id: string(flow.id, null, 96),
      method: string(request.method ?? flow.method, 'GET', 12).toUpperCase(),
      url: safeUrl(request.url ?? flow.url, redactor),
      status: integer(response.statusCode ?? flow.status, null, 100, 599),
      duration_ms: integer(flow.duration_ms ?? flow.durationMs, null, 0, 86_400_000),
      timestamp: string(flow.timestamp ?? flow.created_at, null, 64),
    };
  });
}

function sanitizeRules(value) {
  const input = Array.isArray(value) ? value : Array.isArray(value?.rules) ? value.rules : [];
  return input.slice(0, MAX_ITEMS).map((item) => {
    const rule = object(item);
    return {
      id: string(rule.id ?? rule.rule_id, null, 96),
      name: string(rule.name, null, 128),
      type: string(rule.type ?? rule.kind, null, 64),
      enabled: rule.enabled !== false,
      priority: integer(rule.priority, null, -1_000_000, 1_000_000),
    };
  });
}

function safeUrl(value, redactor) {
  if (typeof value !== 'string' || !value) return null;
  const redacted = redactor.redactUrl(value);
  try {
    const url = new URL(redacted);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return String(redacted).split(/[?#]/, 1)[0].slice(0, 256);
  }
}

function boundedJson(value, maximum) {
  let body = Buffer.from(JSON.stringify(value));
  if (body.length <= maximum) return body;
  // All public collections have a small hard cap. If providers still produce
  // too much data, return a stable bounded notice instead of partial records.
  body = Buffer.from(JSON.stringify({ ok: false, error: 'RESPONSE_TOO_LARGE' }));
  return body;
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function string(value, fallback, limit) { return typeof value === 'string' ? value.slice(0, limit) : fallback; }
function number(value, fallback) { return Number.isFinite(value) ? value : fallback; }
function integer(value, fallback, min, max) { return Number.isInteger(value) && value >= min && value <= max ? value : fallback; }
function boundedInteger(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function renderPage(nonce) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proxy MCP operator</title><style>body{font:15px system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#18212b}input{width:min(30rem,100%)}button{margin-left:.4rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:1rem}small{color:#52606d}</style><main><h1>Proxy MCP operator</h1><p><label>Bearer token <input id="token" type="password" autocomplete="off"></label><button id="connect">Connect</button></p><p id="message" role="status">Read-only local status. Token stays in this page’s memory.</p><section><h2>Status</h2><pre id="status">Not connected.</pre></section><section><h2>Recent flows</h2><pre id="flows">Not connected.</pre></section><section><h2>Rules</h2><pre id="rules">Not connected.</pre></section><small>Refreshes every five seconds while connected.</small></main><script nonce="${nonce}">(()=>{let token='';let timer;const $=id=>document.getElementById(id);const show=(id,value)=>{$(id).textContent=typeof value==='string'?value:JSON.stringify(value,null,2)};const load=async()=>{try{const h={Authorization:'Bearer '+token};const [health,status,flows,rules]=await Promise.all(['/api/health','/api/status','/api/flows','/api/rules'].map(async path=>{const r=await fetch(path,{headers:h,cache:'no-store',credentials:'same-origin'});if(!r.ok)throw new Error('Request failed ('+r.status+')');return r.json()}));show('status',{health,status});show('flows',flows.flows);show('rules',rules.rules);$('message').textContent='Connected. Last refreshed '+new Date().toLocaleTimeString()}catch(e){$('message').textContent=e.message}};$('connect').addEventListener('click',()=>{token=$('token').value;$('token').value='';if(timer)clearInterval(timer);load();timer=setInterval(load,5000)});})();</script></html>`;
}
