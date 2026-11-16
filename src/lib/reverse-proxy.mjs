import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { buildRemoteAccessPolicy } from './proxy.mjs';

export class ReverseProxyManager {
  constructor({ onExchange, getProxyPort } = {}) {
    this.entries = new Map();
    this.onExchange = onExchange;
    this.getProxyPort = getProxyPort;
  }

  async create({
    id, target_url, listen_host = '127.0.0.1', listen_port = 0, allow_remote = false,
    allowed_remote_ips = [], remote_access_ttl_seconds = 3600,
    preserve_host_header = false, timeout_ms = 30_000,
  } = {}) {
    const target = validateTarget(target_url);
    const proxyPort = this.getProxyPort?.();
    if (this.getProxyPort && !proxyPort) throw codedError('PROXY_NOT_RUNNING', 'Start the capture engine before creating a captured reverse proxy.');
    if (!allow_remote && !isLoopback(listen_host)) throw codedError('REMOTE_BIND_REQUIRES_CONSENT', 'Set allow_remote=true explicitly before binding a reverse proxy to a non-loopback interface.');
    const remotePolicy = buildRemoteAccessPolicy({
      allowRemote: allow_remote,
      allowedRemoteIps: allowed_remote_ips,
      remoteAccessTtlSeconds: remote_access_ttl_seconds,
    });
    const entryId = id ?? `reverse_${crypto.randomUUID()}`;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(entryId)) throw codedError('INVALID_REVERSE_PROXY_ID', 'id may contain only letters, numbers, dot, underscore, and hyphen.');
    if (this.entries.has(entryId)) throw codedError('REVERSE_PROXY_EXISTS', `Reverse proxy already exists: ${entryId}`);
    const server = http.createServer((incoming, outgoing) => {
      const started = Date.now();
      const destination = resolveDestination(target, incoming.url);
      const headers = { ...incoming.headers };
      if (!preserve_host_header) headers.host = destination.host;
      const transport = proxyPort ? http : (destination.protocol === 'https:' ? https : http);
      const endpoint = proxyPort ? new URL(`http://127.0.0.1:${proxyPort}`) : destination;
      const upstream = transport.request(endpoint, {
        method: incoming.method,
        ...(proxyPort ? { path: destination.toString() } : {}),
        headers,
        timeout: timeout_ms,
      }, (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
        response.pipe(outgoing);
        response.once('end', () => this.onExchange?.({
          id: crypto.randomUUID(), reverse_proxy_id: entryId, method: incoming.method,
          source_url: incoming.url, target_url: destination.toString(), status: response.statusCode,
          duration_ms: Date.now() - started,
        }));
      });
      upstream.once('timeout', () => upstream.destroy(codedError('UPSTREAM_TIMEOUT', 'Reverse-proxy upstream timed out.')));
      upstream.once('error', (error) => {
        if (!outgoing.headersSent) outgoing.writeHead(error.code === 'UPSTREAM_TIMEOUT' ? 504 : 502, { 'content-type': 'application/json' });
        if (!outgoing.writableEnded) outgoing.end(JSON.stringify({ error: 'reverse_proxy_upstream_failed', code: error.code ?? 'UPSTREAM_FAILED' }));
      });
      incoming.pipe(upstream);
      incoming.once('aborted', () => upstream.destroy());
      outgoing.once('close', () => { if (!outgoing.writableEnded) upstream.destroy(); });
    });
    server.requestTimeout = Math.max(1_000, timeout_ms + 1_000);
    server.headersTimeout = Math.min(server.requestTimeout, 10_000);
    const sockets = new Set();
    server.prependListener('connection', (socket) => {
      const address = String(socket.remoteAddress ?? '').split('%', 1)[0].toLowerCase();
      const allowed = isLoopback(address) || (remotePolicy.enabled
        && Date.now() < Date.parse(remotePolicy.expiresAt)
        && remotePolicy.allowlist.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4'));
      if (!allowed) return socket.destroy();
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listen_port, listen_host, resolve);
    });
    const address = server.address();
    const config = {
      id: entryId,
      target_url: target.toString(),
      listen_host,
      listen_port: typeof address === 'object' ? address.port : listen_port,
      allow_remote,
      allowed_remote_ips: remotePolicy.entries,
      remote_access_expires_at: remotePolicy.expiresAt,
      preserve_host_header,
      timeout_ms,
      created_at: new Date().toISOString(),
      capture_enabled: Boolean(proxyPort),
      local_url: `http://${listen_host.includes(':') ? `[${listen_host}]` : listen_host}:${typeof address === 'object' ? address.port : listen_port}`,
    };
    const timer = remotePolicy.enabled
      ? setTimeout(() => this.remove(entryId), remotePolicy.ttlSeconds * 1000)
      : null;
    timer?.unref?.();
    this.entries.set(entryId, { server, config, timer, sockets });
    return config;
  }

  list() { return [...this.entries.values()].map(({ config }) => ({ ...config })); }

  async remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return { status: 'not_found', id };
    this.entries.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    for (const socket of entry.sockets) socket.destroy();
    await new Promise((resolve) => entry.server.close(resolve));
    return { status: 'removed', id };
  }

  async stopAll() {
    const ids = [...this.entries.keys()];
    await Promise.all(ids.map((id) => this.remove(id)));
    return { status: 'stopped', count: ids.length };
  }
}

export function resolveDestination(target, incomingUrl = '/') {
  const base = target instanceof URL ? target : validateTarget(target);
  const incoming = new URL(incomingUrl || '/', 'http://proxy-mate.local');
  const destination = new URL(base);
  const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  destination.pathname = `${basePath}${incoming.pathname.startsWith('/') ? incoming.pathname : `/${incoming.pathname}`}` || '/';
  destination.search = incoming.search;
  return destination;
}

function validateTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw codedError('INVALID_TARGET_URL', 'target_url must be an absolute HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw codedError('UNSUPPORTED_TARGET_SCHEME', 'Reverse proxy supports HTTP and HTTPS targets.');
  if (url.username || url.password) throw codedError('TARGET_CREDENTIALS_REJECTED', 'Credentials in target_url are not accepted.');
  return url;
}

function isLoopback(host) {
  const value = String(host).toLowerCase();
  return value === 'localhost' || value === '::1' || value === '::ffff:127.0.0.1' || value.startsWith('127.');
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
