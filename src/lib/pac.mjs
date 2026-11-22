import { networksetupBinary } from './test-hooks.mjs';
// PAC file generation + macOS networksetup wiring + state.json persistence.
//
// The PAC server lives on a separate port (default 8081) and is delivered as
// application/x-ns-proxy-autoconfig. macOS and the iOS Simulator both honor
// `networksetup -setautoproxyurl`, so we route only allowlisted hosts through
// the proxy and leave everything else DIRECT.

import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { recordRuntimeEvent } from './runtime-identity.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { patchState, readState, isStateStale, assertRealNetworkCommandAllowed } from './state.mjs';
import { STATE_DIR } from './config.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { createRoutingClaimsStore } from './routing-claims.mjs';
import { selectNetworkService } from './network-service.mjs';

const execFileP = promisify(execFile);
const NETWORKSETUP = networksetupBinary();
// Sample host load for every command, including rollback commands.
async function routingCommand(run, args, { loadavg = os.loadavg, cores = os.availableParallelism(), timeoutCapMs = Infinity, signal, deadline } = {}) {
  signal?.throwIfAborted();
  const load = Number(loadavg()[0]);
  const cap = Math.min(typeof timeoutCapMs === 'function' ? timeoutCapMs() : timeoutCapMs, deadline == null ? Infinity : deadline - performance.now());
  if (cap <= 0) throw Object.assign(new Error('Routing budget exhausted.'), { code: 'ROUTING_COMMAND_TIMEOUT' });
  const timeout = Math.max(1, Math.min(Math.ceil(cap), 20000, Math.ceil(5000 * Math.max(1, (Number.isFinite(load) ? load : 0) / Math.max(1, cores)))));
  if (run === execFileP && NETWORKSETUP === '/usr/sbin/networksetup') assertRealNetworkCommandAllowed();
  try {
    const result = await run(NETWORKSETUP, args, { timeout, signal, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    signal?.throwIfAborted();
    return result;
  }
  catch (error) {
    if (error?.killed || error?.code === 'ETIMEDOUT' || error?.code === 'ERR_CHILD_PROCESS_TIMEOUT') {
      throw Object.assign(new Error(`Routing command timed out after ${timeout} ms.`, { cause: error }), {
        code: 'ROUTING_COMMAND_TIMEOUT', retryable: true,
        recovery: 'Inspect routing status and retry when host load subsides.',
      });
    }
    throw error;
  }
}

const PAC_FILE = path.join(STATE_DIR, 'proxy.pac');

export { PAC_FILE };

export function buildPacText(domains, targetHost, targetPort) {
  const safe = domains
    .filter((d) => typeof d === 'string' && d.trim().length > 0)
    .map((d) => d.trim());
  const matches = safe.map((d) => `shExpMatch(host, ${JSON.stringify(d)})`).join(' || ');
  const fallback = matches || 'false';
  return `// proxyfan generated PAC — only listed hosts go through the intercepting proxy.
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
          ? `PAC port :${port} is held by another process. Their PAC ${existing.matches ? 'matches' : 'does NOT match'} ours. Stop the other daemon (try \`proxyfan doctor\`) or pass a different pac_port.`
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
        process.stderr.write(`[proxyfan] routing lease cleanup failed: ${error.message}\n`);
      });
    }, ms);
    this.leaseTimer.unref?.();
  }
}

// Detect what (if anything) is already serving at http://127.0.0.1:<port>/proxy.pac.
export async function fetchExistingPac(port, { maxBytes = 8192 } = {}) {
  return new Promise((resolve) => {
    let settled = false, deadline;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(value); } };
    const req = http.get({ host: '127.0.0.1', port, path: '/proxy.pac', timeout: 750 }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > maxBytes) { req.destroy(); finish(null); }
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
          matches: ['proxyfan generated PAC', 'proxy-mate generated PAC', 'proxy-mcp generated PAC'].some((marker) => body.includes(marker)),
        });
      });
    });
    deadline = setTimeout(() => { req.destroy(); finish(null); }, 750);
    req.on('error', () => finish(null));
    req.on('timeout', () => { req.destroy(); finish(null); });
  });
}

export async function listEnabledNetworkServices({ run = execFileP, ...options } = {}) {
  const { stdout } = await routingCommand(run, ['-listallnetworkservices'], options);
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

function routingError(code, message) { return Object.assign(new Error(message), { code, retryable: false, recovery: 'Inspect the routing configuration and correct the request before retrying.' }); }

export async function setAutoProxyOn(networkService, pacUrl, run = execFileP, options = {}) {
  await routingCommand(run, ['-setautoproxyurl', networkService, pacUrl], options);
  await routingCommand(run, ['-setautoproxystate', networkService, 'on'], options);
}

export async function getAutoProxyState(networkService, run = execFileP, options = {}) {
  try {
    const { stdout } = await routingCommand(run, ['-getautoproxyurl', networkService], options);
    const rawUrl = stdout.match(/^URL:[ \t]*([^\r\n]*)/mi)?.[1]?.trim() ?? '';
    const url = rawUrl === '(null)' ? '' : rawUrl;
    const enabled = /^Enabled:[ \t]*Yes[ \t]*$/mi.test(stdout);
    return { enabled, url };
  } catch (error) {
    if (options.signal?.aborted || error?.code === 'ABORT_ERR' || error?.code === 'ROUTING_COMMAND_TIMEOUT') throw error;
    return { enabled: false, url: '', unreadable: error?.message ?? String(error) };
  }
}

export async function setAutoProxyOff(networkService, run = execFileP, options = {}) {
  await routingCommand(run, ['-setautoproxystate', networkService, 'off'], options);
  await routingCommand(run, ['-setautoproxyurl', networkService, ''], options);
}

// Compose a full PAC setup: writes the PAC file, starts the PAC server, applies
// networksetup. **Records state.json BEFORE touching networksetup** so dirty
// kills can be reconciled on next boot.
export async function applyPacRouting(options) {
  const domains = validateRoutingDomains(options.domains, { allowBroad: options.allowBroad });
  return applyValidatedPacRouting({ ...options, domains });
}

async function applyValidatedPacRouting({ domains, networkService, pacPort, proxyPort, pacServer,
  allowBroad = false, replaceExisting = false, durationSeconds = 3600,
  run = execFileP, select = pickActiveNetworkService, loadavg, cores, manageLease = true, signal, deadline, timeoutCapMs, routingMode = 'legacy', expectedAutoProxy, priorAutoProxyOverride,
}) {
  const rawRun = run;
  run = (_file, args) => routingCommand(rawRun, args, { loadavg, cores, signal, deadline, timeoutCapMs });
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
  if (expectedAutoProxy && (actualBefore.enabled !== expectedAutoProxy.enabled || actualBefore.url !== expectedAutoProxy.url)) throw routingError('ROUTING_CONFLICT', 'System routing changed during re-arm; nothing was changed.');
  const ownedBefore = currentState?.routing_active && currentState.network_service === service && actualBefore.url === currentState.pac_url;
  const priorAutoProxy = priorAutoProxyOverride ?? (ownedBefore ? currentState.prior_auto_proxy : actualBefore);
  if (priorAutoProxy?.unreadable) throw Object.assign(new Error('Cannot snapshot the current PAC configuration; routing was not changed.'), { code: 'ROUTING_SNAPSHOT_FAILED' });
  if (actualBefore.enabled && !ownedBefore && !replaceExisting) throw routingError('ROUTING_CONFLICT', 'Another automatic proxy is enabled. Inspect it first; replacing it requires replace_existing_proxy=true.');
  for (const command of ['-getwebproxy', '-getsecurewebproxy']) {
    const { stdout } = await run(NETWORKSETUP, [command, service]);
    if (/^Enabled:\s*Yes$/mi.test(stdout) && !replaceExisting) throw routingError('ROUTING_CONFLICT', 'An HTTP(S) system proxy is already enabled. Inspect the other proxy before explicitly replacing system routing.');
  }
  const pacBody = buildPacText(domains, '127.0.0.1', proxyPort);
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(PAC_FILE, pacBody);
  signal?.throwIfAborted();
  pacServer.setBody(pacBody);
  await pacServer.start(pacPort);
  signal?.throwIfAborted();
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
    routing_mode: routingMode,
    prior_auto_proxy: priorAutoProxy,
    routing_expires_at: new Date(Date.now() + durationSeconds * 1000).toISOString(),
    started_at: new Date().toISOString(),
  });

  try {
    await setAutoProxyOn(service, pacUrl, run);
    const actual = await getAutoProxyState(service, run);
    if (!actual.enabled || actual.url !== pacUrl) throw routingError('ROUTING_APPLY_FAILED', 'macOS did not apply the requested PAC configuration.');
    await patchState({ routing_phase: 'active' });
    if (manageLease) pacServer.setLease?.(durationSeconds * 1000, () => clearPacRouting({ pacServer, run }));
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

export async function clearPacRouting({ pacServer, networkService, recoverStale = false, run = execFileP, loadavg, cores, timeoutCapMs, signal, deadline, verifyRestore = false } = {}) {
  const rawRun = run;
  run = (_file, args) => routingCommand(rawRun, args, { loadavg, cores, timeoutCapMs, signal, deadline });
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
    await run(NETWORKSETUP, ['-setautoproxyurl', service, prior.url ?? '']);
    await run(NETWORKSETUP, ['-setautoproxystate', service, prior.enabled ? 'on' : 'off']);
    if (verifyRestore) {
      const actual = await getAutoProxyState(service, run);
      if (actual.unreadable || actual.url !== (prior.url ?? '') || actual.enabled !== Boolean(prior.enabled)) {
        throw routingError('ROUTING_RESTORE_FAILED', 'Restored PAC settings could not be verified; recovery state retained.');
      }
    }
  }
  if (pacServer) await pacServer.stop();
  await patchState({ routing_active: false, routing_phase: null, routing_expires_at: null, cleared_at: new Date().toISOString() });
  return { networkService: service ?? null, status: stillOwned ? 'restored' : 'changed_externally' };
}

// Persist independently of state.json so reconciliation cannot erase intent.
export async function recordRoutingSuspension({ state, reason, claims = createRoutingClaimsStore(),
  now = Date.now, record = recordRuntimeEvent, phase = 'complete' } = {}) {
  if (!state?.network_service) return;
  const suspension = { reason, phase, at: new Date(now()).toISOString(), network_service: state.network_service,
    restored_auto_proxy: state.prior_auto_proxy ?? { enabled: false, url: '' }, pac_url: state.pac_url };
  await claims.setSuspension(suspension);
  await record('routing_suspended', { details: suspension });
}

// Each retry repeats the comparison: a VPN change during backoff wins too.
export async function rearmRouting({ claims = createRoutingClaimsStore(), controller, run = execFileP,
  record = recordRuntimeEvent, now = Date.now, signal, deadline,
  wait = ms => delay(ms, undefined, { signal, ref: false }), retryDelays = [20000, 40000, 60000],
} = {}) {
  const emit = (event, details) => record(event, { reason: details.reason, code: details.code, details });
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return;
    const rows = await claims.listClaims({ now: now() });
    if (!rows.length) { await claims.setSuspension(null); return; }
    const suspension = await claims.getSuspension();
    if (!suspension) return;
    try {
      const current = await getAutoProxyState(suspension.network_service, run, { signal, deadline });
      const restored = current.enabled === suspension.restored_auto_proxy.enabled && current.url === suspension.restored_auto_proxy.url;
      const pendingOwned = suspension.phase === 'pending' && current.enabled && current.url === suspension.pac_url;
      if (current.unreadable || (!restored && !pendingOwned)) {
        await emit('routing_not_rearmed', { reason: 'external_change' }); return;
      }
      if (signal?.aborted) return;
      await controller.resume?.();
      await controller.sync({ networkService: suspension.network_service, replaceExisting: true, signal, deadline, expectedAutoProxy: current,
        priorAutoProxyOverride: pendingOwned ? suspension.restored_auto_proxy : undefined });
      if (signal?.aborted) return;
    } catch (error) {
      await emit('routing_not_rearmed', { reason: 'rearm_failed', code: error.code ?? 'ROUTING_REARM_FAILED' });
      if (attempt >= retryDelays.length || signal?.aborted) return;
      try { await wait(retryDelays[attempt]); } catch (error) { if (!signal?.aborted) throw error; return; }
      continue;
    }
    await claims.setSuspension(null);
    await emit('routing_rearmed', { claims: rows.length, domains: [...new Set(rows.flatMap(c => c.domains))].sort(),
      downtime_ms: Math.max(0, new Date(now()).getTime() - Date.parse(suspension.at)) });
    return;
  }
}

// Explicit sync is the startup hook. Later runtime wiring owns when it is safe
// to re-arm persisted intent; construction alone never changes system routing.
export function createRoutingController({ claims, pacServer, proxyPort, pacPort, networkService,
  run = execFileP, select = pickActiveNetworkService, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, record = recordRuntimeEvent, loadavg, cores,
}) {
  let queue = Promise.resolve(), timer = null, stopped = false;
  let lastChange = null;
  let cancellation = new AbortController(), inFlight = Promise.resolve();
  const stamp = () => new Date(now()).toISOString();
  const emit = (event, details) => Promise.resolve().then(() => record(event, { details })).catch(() => {});
  const serialize = fn => {
    const result = queue.then(fn); queue = result.catch(() => {}); return result;
  };
  const domainsOf = rows => [...new Set(rows.flatMap(c => c.domains))].sort();
  const trackedRun = (...args) => {
    inFlight = Promise.resolve().then(() => {
      if (run === execFileP && NETWORKSETUP === '/usr/sbin/networksetup') assertRealNetworkCommandAllowed();
      args[2]?.signal?.throwIfAborted();
      return run(...args);
    });
    return inFlight;
  };
  const commandOptions = { pacServer, networkService, run: trackedRun, loadavg, cores };
  async function sweep() {
    const { expired } = await claims.sweepExpired({ now: now() });
    for (const c of expired) await emit('routing_claim_expired', { claim_id: c.claim_id, client_id: c.client_id, task_id: c.task_id });
  }
  function arm(rows) {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (stopped || !rows.length) return;
    const delay = Math.max(0, Math.min(...rows.map(c => Date.parse(c.expires_at))) - new Date(now()).getTime());
    timer = setTimer(() => serialize(async () => { await sweep(); return syncInternal({}, 'expiry'); }).catch(async error => {
      await emit('routing_sync_failed', { code: error.code ?? 'ROUTING_SYNC_FAILED', message: error.message });
      // Keep recovery live after a transient command failure, without a busy loop.
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (!stopped) {
        timer = setTimer(() => controller.sync().catch(() => {}), 1000);
        timer?.unref?.();
      }
    }), delay);
    timer?.unref?.();
  }
  async function syncInternal(options = {}, reason = 'sync') {
    if (stopped) return statusInternal();
    const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
    signal.throwIfAborted();
    const rows = await claims.listClaims({ now: now() });
    const domains = domainsOf(rows);
    try {
      const state = await readState();
      if (domains.length) {
        const service = options.networkService ?? await select(networkService);
        const targetPort = typeof proxyPort === 'function' ? proxyPort() : proxyPort;
        if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw routingError('PROXY_NOT_RUNNING', 'Start the proxy before applying routing.');
        signal.throwIfAborted();
        if (state?.routing_active && state.pid !== process.pid) throw routingError('ROUTING_OWNED', 'Routing is owned by another runtime.');
        if (state?.routing_active && state.network_service === service && pacServer.port != null) {
          clearTimeout(pacServer.leaseTimer); pacServer.leaseTimer = null;
          const body = buildPacText(domains, '127.0.0.1', targetPort);
          await fs.writeFile(PAC_FILE, body);
          signal.throwIfAborted();
          pacServer.setBody(body);
          await patchState({ domains, routing_mode: 'claims', routing_expires_at: rows.map(c => c.expires_at).sort()[0] });
        } else {
          await applyValidatedPacRouting({ ...commandOptions, domains, proxyPort: targetPort, pacPort,
            select: async () => service, replaceExisting: options.replaceExisting, manageLease: false,
            signal, deadline: options.deadline, timeoutCapMs: options.timeoutCapMs, routingMode: 'claims',
            expectedAutoProxy: options.expectedAutoProxy, priorAutoProxyOverride: options.priorAutoProxyOverride });
          // Retire any old single-owner timer when adopting routing.
          clearTimeout(pacServer.leaseTimer); pacServer.leaseTimer = null;
          await patchState({ routing_expires_at: rows.map(c => c.expires_at).sort()[0] });
          await emit('routing_applied', { network_service: service, domain_count: domains.length });
        }
      } else {
        const result = await clearPacRouting({ ...commandOptions, signal, deadline: options.deadline, timeoutCapMs: options.timeoutCapMs });
        if (result.status !== 'not_active') await emit('routing_cleared', { network_service: result.networkService, status: result.status });
      }
      lastChange = { at: stamp(), reason };
    } finally { if (!signal.aborted) arm(rows); }
    return statusInternal();
  }
  async function statusInternal() {
    const rows = await claims.listClaims({ now: now(), includeExpired: true });
    const state = await readState();
    const active = Boolean(state?.routing_active && state.pid === process.pid);
    const at = new Date(now()).getTime();
    return { active, network_service: state?.network_service ?? null,
      union_domains: domainsOf(rows.filter(c => Date.parse(c.expires_at) > at)),
      claims: rows.map(c => ({ claim_id: c.claim_id, client_id: c.client_id, task_id: c.task_id,
        domains: c.domains, expires_at: c.expires_at,
        state: Date.parse(c.expires_at) <= at ? 'expired' : active ? 'active' : 'suspended' })), last_change: lastChange };
  }
  const controller = {
    set: options => serialize(async () => {
      const claim = await claims.upsertClaim({ ...options, now: now() });
      await emit('routing_claim_set', { claim_id: claim.claim_id, client_id: claim.client_id, task_id: claim.task_id, expires_at: claim.expires_at });
      await sweep();
      return syncInternal(options, 'claim_set');
    }),
    clear: options => serialize(async () => {
      const removed = options.all ? await claims.removeAllClaims() : await claims.removeClaim(options);
      for (const c of removed) await emit('routing_claim_cleared', { claim_id: c.claim_id, client_id: c.client_id, task_id: c.task_id });
      await sweep();
      return syncInternal({}, 'claim_cleared');
    }),
    renew: (client_id, { sync = true } = {}) => serialize(async () => {
      await claims.renewClaimsForClient(client_id, { now: now() });
      if (!sync) {
        // Heartbeats change deadlines only. The expiry timer owns pruning and
        // union changes, so renewal never selects a service or runs networksetup.
        arm(await claims.listClaims({ now: now() }));
        return statusInternal();
      }
      await sweep(); return syncInternal({}, 'claim_renewed');
    }),
    sync: (options = {}) => serialize(async () => { await sweep(); return syncInternal(options); }),
    status: () => serialize(statusInternal),
    resume: () => { stopped = false; if (cancellation.signal.aborted) cancellation = new AbortController(); },
    stop: () => {
      stopped = true; cancellation.abort();
      if (timer !== null) clearTimer(timer); timer = null;
      return inFlight.catch(() => {});
    },
  };
  return controller;
}
