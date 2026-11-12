// PAC file generation + macOS networksetup wiring + state.json persistence.
//
// The PAC server lives on a separate port (default 8081) and is delivered as
// application/x-ns-proxy-autoconfig. macOS and the iOS Simulator both honor
// `networksetup -setautoproxyurl`, so we route only allowlisted hosts through
// the proxy and leave everything else DIRECT.

import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { patchState, readState, isStateStale } from './state.mjs';
import { STATE_DIR } from './config.mjs';
import { selectNetworkService } from './network-service.mjs';

const execFileP = promisify(execFile);
const NETWORKSETUP = '/usr/sbin/networksetup';
const COMMAND_OPTIONS = { timeout: 5_000, maxBuffer: 1024 * 1024 };

const PAC_FILE = path.join(STATE_DIR, 'proxy.pac');

export { PAC_FILE };

export function buildPacText(domains, targetHost, targetPort) {
  const safe = domains
    .filter((d) => typeof d === 'string' && d.trim().length > 0)
    .map((d) => d.trim());
  const matches = safe.map((d) => `shExpMatch(host, ${JSON.stringify(d)})`).join(' || ');
  const fallback = matches || 'false';
  return `// proxy-mcp generated PAC — only listed hosts go through the intercepting proxy.
function FindProxyForURL(url, host) {
  if (isPlainHostName(host) || host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return "DIRECT";
  }
  if (${fallback}) {
    return "PROXY ${targetHost}:${targetPort}; DIRECT";
  }
  return "DIRECT";
}
`;
}

export class PacServer {
  constructor() {
    this.server = null;
    this.port = null;
    this.body = '';
    this.leaseTimer = null;
  }

  async start(port) {
    if (this.server) return this.port;
    try {
      await new Promise((resolve, reject) => {
        const srv = http.createServer((req, res) => {
          if (req.url === '/proxy.pac' || req.url === '/') {
            res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', 'cache-control': 'no-store' });
            res.end(this.body);
          } else {
            res.writeHead(404); res.end();
          }
        });
        srv.once('error', reject);
        srv.listen(port, '127.0.0.1', () => {
          this.server = srv;
          this.port = srv.address().port;
          resolve();
        });
      });
    } catch (e) {
      if (e?.code === 'EADDRINUSE') {
        // Diagnose: who's serving on this port? If it's a PAC server (responds
        // with our content-type), surface that as a hard error so the caller
        // doesn't silently configure macOS to point at someone else's PAC.
        const existing = await fetchExistingPac(port);
        const reason = existing
          ? `PAC port :${port} is held by another process. Their PAC ${existing.matches ? 'matches' : 'does NOT match'} ours. Stop the other daemon (try \`proxy-mcp doctor\`) or pass a different pac_port.`
          : `PAC port :${port} is busy but not serving PAC content. Free the port and retry.`;
        const err = new Error(reason);
        err.code = 'PAC_PORT_BUSY';
        err.diagnostics = existing;
        throw err;
      }
      throw e;
    }
    return this.port;
  }

  async stop() {
    clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    if (!this.server) return;
    const closed = new Promise((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
    this.server = null;
    this.port = null;
  }

  setBody(body) { this.body = body; }

  setLease(ms, restore = () => clearPacRouting({ pacServer: this })) {
    clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => {
      restore().catch((error) => {
        this.body = 'function FindProxyForURL() { return "DIRECT"; }';
        process.stderr.write(`[proxy-mcp] routing lease cleanup failed: ${error.message}\n`);
      });
    }, ms);
    this.leaseTimer.unref?.();
  }
}

// Detect what (if anything) is already serving at http://127.0.0.1:<port>/proxy.pac.
async function fetchExistingPac(port) {
  return new Promise((resolve) => {
    let settled = false, deadline;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(value); } };
    const req = http.get({ host: '127.0.0.1', port, path: '/proxy.pac', timeout: 750 }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > 8192) { req.destroy(); finish(null); }
        else chunks.push(c);
      });
      res.on('error', () => finish(null));
      res.on('aborted', () => finish(null));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        finish({
          status: res.statusCode,
          content_type: res.headers['content-type'] ?? null,
          body_preview: body.slice(0, 200),
          matches: body.includes('proxy-mcp generated PAC'),
        });
      });
    });
    deadline = setTimeout(() => { req.destroy(); finish(null); }, 750);
    req.on('error', () => finish(null));
    req.on('timeout', () => { req.destroy(); finish(null); });
  });
}

export async function listEnabledNetworkServices() {
  const { stdout } = await execFileP(NETWORKSETUP, ['-listallnetworkservices'], COMMAND_OPTIONS);
  return stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'));
}

export async function pickActiveNetworkService(preferred) {
  return selectNetworkService(preferred);
}

export function validateRoutingDomains(domains, { allowBroad = false } = {}) {
  if (!Array.isArray(domains) || !domains.length || domains.length > 64) throw routingError('ROUTING_DOMAINS_REQUIRED', 'Supply 1-64 explicit API host globs before changing system routing.');
  const normalized = domains.map((value) => typeof value === 'string' ? value.trim().toLowerCase() : '');
  if (normalized.some((host) => !host || host.length > 253 || !/^[a-z0-9*?._-]+$/.test(host))) throw routingError('ROUTING_DOMAIN_INVALID', 'Routing accepts host globs, without schemes, paths, ports or control characters.');
  if (!allowBroad && normalized.some((host) => !/[a-z0-9]/.test(host))) throw routingError('BROAD_ROUTING_REQUIRES_CONSENT', 'All-host routing requires allow_broad_routing=true. Prefer explicit API hosts to avoid affecting unrelated Mac traffic.');
  return [...new Set(normalized)];
}

function routingError(code, message) { return Object.assign(new Error(message), { code, retryable: false }); }

export async function setAutoProxyOn(networkService, pacUrl, run = execFileP) {
  await run(NETWORKSETUP, ['-setautoproxyurl', networkService, pacUrl], COMMAND_OPTIONS);
  await run(NETWORKSETUP, ['-setautoproxystate', networkService, 'on'], COMMAND_OPTIONS);
}

export async function getAutoProxyState(networkService, run = execFileP) {
  try {
    const { stdout } = await run(NETWORKSETUP, ['-getautoproxyurl', networkService], COMMAND_OPTIONS);
    const rawUrl = stdout.match(/^URL:[ \t]*([^\r\n]*)/mi)?.[1]?.trim() ?? '';
    const url = rawUrl === '(null)' ? '' : rawUrl;
    const enabled = /^Enabled:[ \t]*Yes[ \t]*$/mi.test(stdout);
    return { enabled, url };
  } catch (error) {
    return { enabled: false, url: '', unreadable: error?.message ?? String(error) };
  }
}

export async function setAutoProxyOff(networkService, run = execFileP) {
  await run(NETWORKSETUP, ['-setautoproxystate', networkService, 'off'], COMMAND_OPTIONS);
  await run(NETWORKSETUP, ['-setautoproxyurl', networkService, ''], COMMAND_OPTIONS);
}

// Compose a full PAC setup: writes the PAC file, starts the PAC server, applies
// networksetup. **Records state.json BEFORE touching networksetup** so dirty
// kills can be reconciled on next boot.
export async function applyPacRouting({ domains, networkService, pacPort, proxyPort, pacServer,
  allowBroad = false, replaceExisting = false, durationSeconds = 3600,
  run = execFileP, select = pickActiveNetworkService,
}) {
  domains = validateRoutingDomains(domains, { allowBroad });
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86400) throw routingError('ROUTING_LEASE_INVALID', 'Routing duration must be 1-86400 seconds.');
  const service = await select(networkService);
  let currentState = await readState();
  if (currentState?.routing_active && currentState.pid !== process.pid) {
    throw Object.assign(new Error('Routing is owned by another runtime.'), { code: 'ROUTING_OWNED' });
  }
  if (currentState?.routing_active && currentState.network_service !== service) {
    await clearPacRouting({ pacServer, run });
    currentState = await readState();
  }
  const actualBefore = await getAutoProxyState(service, run);
  if (actualBefore.unreadable) throw routingError('ROUTING_SNAPSHOT_FAILED', 'Cannot read current PAC settings; nothing was changed.');
  const ownedBefore = currentState?.routing_active && currentState.network_service === service && actualBefore.url === currentState.pac_url;
  const priorAutoProxy = ownedBefore ? currentState.prior_auto_proxy : actualBefore;
  if (priorAutoProxy?.unreadable) throw Object.assign(new Error('Cannot snapshot the current PAC configuration; routing was not changed.'), { code: 'ROUTING_SNAPSHOT_FAILED' });
  if (actualBefore.enabled && !ownedBefore && !replaceExisting) throw routingError('ROUTING_CONFLICT', 'Another automatic proxy is enabled. Inspect it first; replacing it requires replace_existing_proxy=true.');
  for (const command of ['-getwebproxy', '-getsecurewebproxy']) {
    const { stdout } = await run(NETWORKSETUP, [command, service], COMMAND_OPTIONS);
    if (/^Enabled:\s*Yes$/mi.test(stdout) && !replaceExisting) throw routingError('ROUTING_CONFLICT', 'An HTTP(S) system proxy is already enabled. Inspect the other proxy before explicitly replacing system routing.');
  }
  const pacBody = buildPacText(domains, '127.0.0.1', proxyPort);
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(PAC_FILE, pacBody);
  pacServer.setBody(pacBody);
  await pacServer.start(pacPort);
  const pacUrl = `http://127.0.0.1:${pacServer.port}/proxy.pac`;

  // Pre-record state: pid, modifiedServices, pacUrl. Written BEFORE networksetup
  // so a SIGKILL between this write and the networksetup call still has
  // breadcrumbs.
  await patchState({
    pid: process.pid,
    pac_url: pacUrl,
    pac_port: pacServer.port,
    proxy_port: proxyPort,
    network_service: service,
    domains,
    routing_active: true,
    routing_phase: 'applying',
    prior_auto_proxy: priorAutoProxy,
    routing_expires_at: new Date(Date.now() + durationSeconds * 1000).toISOString(),
    started_at: new Date().toISOString(),
  });

  try {
    await setAutoProxyOn(service, pacUrl, run);
    const actual = await getAutoProxyState(service, run);
    if (!actual.enabled || actual.url !== pacUrl) throw routingError('ROUTING_APPLY_FAILED', 'macOS did not apply the requested PAC configuration.');
    await patchState({ routing_phase: 'active' });
    pacServer.setLease?.(durationSeconds * 1000, () => clearPacRouting({ pacServer, run }));
    return { networkService: service, pacUrl, domains, fail_open: true, expires_at: new Date(Date.now() + durationSeconds * 1000).toISOString() };
  } catch (error) {
    try { await clearPacRouting({ pacServer, run }); }
    catch (cleanup) {
      pacServer.setBody('function FindProxyForURL() { return "DIRECT"; }');
      error.details = { rollback_error: cleanup.message, recovery_state_retained: true };
    }
    throw error;
  }
}

export async function clearPacRouting({ pacServer, networkService, recoverStale = false, run = execFileP } = {}) {
  const persisted = await readState();
  if (!persisted?.routing_active) {
    await pacServer?.stop();
    return { networkService: null, status: 'not_active' };
  }
  if (persisted.pid !== process.pid && !(recoverStale && await isStateStale())) {
    throw Object.assign(new Error('Routing is owned by another runtime.'), { code: 'ROUTING_OWNED' });
  }
  const service = persisted.network_service;
  if (networkService && networkService !== service) throw new Error('Only the recorded network service can be restored.');
  const current = await getAutoProxyState(service, run);
  if (current.unreadable) throw Object.assign(new Error('Cannot read current PAC settings; recovery state retained.'), { code: 'ROUTING_READ_FAILED' });
  // Leave changes made by a VPN, another proxy, or the user alone.
  const stillOwned = current.url === persisted.pac_url && (current.enabled || persisted.routing_phase === 'applying');
  if (stillOwned) {
    const prior = persisted.prior_auto_proxy ?? { enabled: false, url: '' };
    await run(NETWORKSETUP, ['-setautoproxyurl', service, prior.url ?? ''], COMMAND_OPTIONS);
    await run(NETWORKSETUP, ['-setautoproxystate', service, prior.enabled ? 'on' : 'off'], COMMAND_OPTIONS);
  }
  if (pacServer) await pacServer.stop();
  await patchState({ routing_active: false, routing_phase: null, routing_expires_at: null, cleared_at: new Date().toISOString() });
  return { networkService: service ?? null, status: stillOwned ? 'restored' : 'changed_externally' };
}
