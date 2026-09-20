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
    return "PROXY ${targetHost}:${targetPort}";
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
    if (!this.server) return;
    const closed = new Promise((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
    this.server = null;
    this.port = null;
  }

  setBody(body) { this.body = body; }
}

// Detect what (if anything) is already serving at http://127.0.0.1:<port>/proxy.pac.
async function fetchExistingPac(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/proxy.pac', timeout: 750 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          content_type: res.headers['content-type'] ?? null,
          body_preview: body.slice(0, 200),
          matches: body.includes('proxy-mcp generated PAC'),
        });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
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
  const services = await listEnabledNetworkServices();
  if (preferred) {
    if (services.includes(preferred)) return preferred;
    throw Object.assign(new Error(`Network service is missing or disabled: ${preferred}`), { code: 'NETWORK_SERVICE_UNAVAILABLE' });
  }
  if (services.includes('Wi-Fi')) return 'Wi-Fi';
  const eth = services.find((s) => /ethernet/i.test(s));
  if (eth) return eth;
  if (services.length === 0) throw new Error('no enabled network services found');
  return services[0];
}

export async function setAutoProxyOn(networkService, pacUrl, run = execFileP) {
  await run(NETWORKSETUP, ['-setautoproxyurl', networkService, pacUrl], COMMAND_OPTIONS);
  await run(NETWORKSETUP, ['-setautoproxystate', networkService, 'on'], COMMAND_OPTIONS);
}

export async function getAutoProxyState(networkService, run = execFileP) {
  try {
    const { stdout } = await run(NETWORKSETUP, ['-getautoproxyurl', networkService], COMMAND_OPTIONS);
    const url = stdout.match(/^URL:\s*(.*)$/mi)?.[1]?.trim() ?? '';
    const enabled = /^Enabled:\s*Yes$/mi.test(stdout);
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
export async function applyPacRouting({ domains, networkService, pacPort, proxyPort, pacServer }) {
  const service = await pickActiveNetworkService(networkService);
  let currentState = await readState();
  if (currentState?.routing_active && currentState.pid !== process.pid) {
    throw Object.assign(new Error('Routing is owned by another runtime.'), { code: 'ROUTING_OWNED' });
  }
  if (currentState?.routing_active && currentState.network_service !== service) {
    await clearPacRouting({ pacServer });
    currentState = await readState();
  }
  const priorAutoProxy = currentState?.routing_active && currentState?.network_service === service
    ? currentState.prior_auto_proxy
    : await getAutoProxyState(service);
  if (priorAutoProxy?.unreadable) throw Object.assign(new Error('Cannot snapshot the current PAC configuration; routing was not changed.'), { code: 'ROUTING_SNAPSHOT_FAILED' });
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
    prior_auto_proxy: priorAutoProxy,
    started_at: new Date().toISOString(),
  });

  await setAutoProxyOn(service, pacUrl);
  return { networkService: service, pacUrl, domains };
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
  const stillOwned = current.url === persisted.pac_url;
  if (stillOwned) {
    const prior = persisted.prior_auto_proxy ?? { enabled: false, url: '' };
    await run(NETWORKSETUP, ['-setautoproxyurl', service, prior.url ?? ''], COMMAND_OPTIONS);
    await run(NETWORKSETUP, ['-setautoproxystate', service, prior.enabled ? 'on' : 'off'], COMMAND_OPTIONS);
  }
  if (pacServer) await pacServer.stop();
  await patchState({ routing_active: false, cleared_at: new Date().toISOString() });
  return { networkService: service ?? null, status: stillOwned ? 'restored' : 'changed_externally' };
}
