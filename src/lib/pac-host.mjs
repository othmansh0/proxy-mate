// Read-only PAC hosting independent of the daemon's lifetime.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';
import { buildPacText, PacServer, fetchExistingPac } from './pac.mjs';
import { createRoutingClaimsStore, unionDomains } from './routing-claims.mjs';
import { logLine, errorFields } from './log-line.mjs';

export function createPacHost({ port = 8081, host = '127.0.0.1', directory = STATE_DIR,
  claimsStore = createRoutingClaimsStore({ directory }), readState = async () => {
    try { return JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, now = Date.now,
} = {}) {
  if (host !== '127.0.0.1') throw new Error('PAC host must bind to loopback');
  let server = null, actualPort = null, cached = null, expires = 0, pending;
  const direct = buildPacText([], '127.0.0.1', 8080);
  async function body() {
    const at = Number(now());
    if (cached !== null && at < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      let nextExpiry = at + 500;
      try {
        const [claims, state] = await Promise.all([claimsStore.listClaims({ now: at }), readState()]);
        if (claims.corrupt) throw new Error('Corrupt routing claims');
        const live = claims.filter(c => Date.parse(c.expires_at) > at);
        const domains = unionDomains(live);
        if (state?.routing_active) domains.push(...state.domains);
        const proxyPort = state?.proxy_port ?? state?.daemon_proxy_port ?? 8080;
        if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error('Invalid proxy port');
        cached = buildPacText([...new Set(domains)], '127.0.0.1', proxyPort);
        nextExpiry = Math.min(nextExpiry, ...live.map(c => Date.parse(c.expires_at)));
      } catch { cached = direct; }
      expires = nextExpiry;
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  }
  return {
    get port() { return actualPort; },
    async start() {
      if (server) return actualPort;
      const srv = http.createServer({ maxHeaderSize: 4096, headersTimeout: 2000,
        requestTimeout: 2000, keepAliveTimeout: 1000, connectionsCheckingInterval: 500 }, (req, res) => {
        res.setHeader('connection', 'close');
        if (req.method !== 'GET' || !['/', '/proxy.pac'].includes(req.url) ||
          req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
          res.writeHead(404); res.end(); return;
        }
        body().then(text => {
          if (res.destroyed) return;
          res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', 'cache-control': 'no-store' });
          res.end(text);
        }).catch(() => { res.end(direct); });
      });
      srv.maxHeadersCount = 32;
      srv.setTimeout(2000, socket => socket.destroy());
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, host, resolve);
      });
      server = srv; actualPort = srv.address().port;
      return actualPort;
    },
    async stop() {
      if (!server) return;
      const srv = server; server = null; actualPort = null;
      const closed = new Promise(resolve => srv.close(resolve));
      srv.closeAllConnections(); await closed;
    },
  };
}

export class ExternalPacServer {
  constructor() { this.port = null; this.server = null; this.leaseTimer = null; }
  async start(port) {
    const existing = await fetchExistingPac(port, { maxBytes: 128 * 1024 });
    if (existing?.status !== 200 || !existing.matches ||
      !existing.content_type?.startsWith('application/x-ns-proxy-autoconfig')) {
      throw Object.assign(new Error(`Guardian PAC host unavailable on 127.0.0.1:${port}`), { code: 'PAC_HOST_UNAVAILABLE' });
    }
    this.port = port;
    return port;
  }
  async stop() { this.port = null; }
  setBody() {}
  setLease() {}
}

// Only launchd daemon mode opts in. Resolve the host on first routing use,
// retaining the body for the explicitly logged in-process fallback.
export function createDaemonPacServer({ env = process.env, log = logLine } = {}) {
  if (env.PROXY_MATE_PAC_HOST !== 'guardian') return new PacServer();
  let active = new ExternalPacServer(), body = '', firstUse = true;
  return {
    get port() { return active.port; },
    get server() { return active.server; },
    get leaseTimer() { return active.leaseTimer; },
    set leaseTimer(value) { active.leaseTimer = value; },
    setBody(value) { body = value; active.setBody(value); },
    setLease(...args) { active.setLease(...args); },
    async start(port) {
      try { return await active.start(port); }
      catch (error) {
        if (!firstUse || error.code !== 'PAC_HOST_UNAVAILABLE') throw error;
        log('daemon', 'guardian PAC host unavailable; using in-process fallback', { port, ...errorFields(error) });
        active = new PacServer(); active.setBody(body);
        return await active.start(port);
      } finally { firstUse = false; }
    },
    stop: () => active.stop(),
  };
}
