#!/usr/bin/env node
// proxy-mcp — local HTTP(S) capture, routing, mocking, and Simulator setup.
//
// Two run shapes share the same internals:
//   * stdio MCP server (default)  — for Claude Code. Auto-detects a running
//                                    daemon and forwards tool calls to it
//                                    over the control plane; falls back to
//                                    in-process operation if no daemon.
//   * `--daemon`                   — long-lived. Owns the proxy, PAC server,
//                                    state, rules, simulator watcher, and a
//                                    control HTTP server (default :8082) so
//                                    multiple MCP clients can share state.
//
// Plus CLI subcommands: `doctor`, `install`, `uninstall`, `status`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import asyncExitHook from 'async-exit-hook';
import { promises as fs } from 'node:fs';
import url from 'node:url';

import { ProxyEngine, CA_CERT } from './lib/proxy.mjs';
import { PacServer } from './lib/pac.mjs';
import { makeTools } from './lib/tools.mjs';
import {
  readState, isStateStale, defensiveNetworkResetAllServices,
  writePidFile, readPidFile, clearPidFile, clearState, patchState, readHandshake,
} from './lib/state.mjs';
import { ControlServer, callDaemon, probeDaemon, DEFAULT_CONTROL_PORT } from './lib/control.mjs';
import { doctorSweep, PROXY_PORT_DEFAULT, PAC_PORT_DEFAULT } from './lib/doctor.mjs';
import { installLaunchAgent, uninstallLaunchAgent, launchAgentStatus } from './lib/launchagent.mjs';
import { applyPacRouting, clearPacRouting } from './lib/pac.mjs';
import { trustCaOnSimulators } from './lib/sim.mjs';
import { ensureCA } from './lib/proxy.mjs';
import { STATE_DIR, SERVER_NAME, SERVER_VERSION } from './lib/config.mjs';
import { setupHostCertificate, removeHostCertificate } from './lib/host-cert.mjs';
import { loadRules } from './lib/rules.mjs';
import {
  MCP_RESOURCE_URIS, registerMcpPrompts, registerMcpResources,
  registerMcpResourceSubscriptions, registerMcpTools,
} from './lib/mcp-contract.mjs';

const STATUS_MUTATION_TOOLS = new Set([
  'start_proxy', 'stop_proxy', 'set_proxy_routing', 'clear_proxy_routing',
  'toggle_recording', 'clear_session', 'select_capture_session',
  'create_capture_session', 'update_capture_session', 'purge_capture_session',
  'start_sim_watcher', 'stop_sim_watcher', 'enable_ssl_proxying',
  'upsert_transform_plugin', 'remove_transform_plugin',
  'set_transform_plugin_enabled', 'create_transform_plugin_rule',
  'start_operator_ui', 'stop_operator_ui',
]);

// ---- run modes ----
async function runStdio() {
  // On every Claude session start, first reconcile any half-configured network
  // state from a prior dirty exit (Issue #13 partial fix).
  if (await isStateStale()) {
    try {
      const reset = await defensiveNetworkResetAllServices();
      if (reset.failed?.length) throw new Error(reset.failed.map((item) => item.error).join('; '));
      await clearState();
    }
    catch { /* best effort */ }
  }

  // Detect a running daemon and use client mode if present (Phase 2).
  const handshake = await readHandshake();
  let dispatch;
  if (handshake && await probeDaemon(handshake.controlUrl, handshake.token)) {
    process.stderr.write(`[proxy-mcp] connecting to daemon at ${handshake.controlUrl} (PID file: ${await readPidFile()})\n`);
    dispatch = async (tool, args, context = {}) => callDaemon({ ...handshake, tool, args, signal: context.signal });
  } else {
    // Fallback: in-process, like v0.1. Slimmer feature surface — no sim
    // watcher, no daemon-shared state across MCP sessions.
    const engine = new ProxyEngine();
    const pacServer = new PacServer();
    const tools = makeTools({ engine, pacServer, mode: 'in-process' });
    dispatch = async (tool, args, context = {}) => {
      const fn = tools[tool];
      if (typeof fn !== 'function') throw new Error(`unknown tool: ${tool}`);
      return await fn(args ?? {}, context);
    };
    asyncExitHook(async (done) => {
      try { await tools.stop_operator_ui(); } catch { /* ignore */ }
      try { await tools.stop_proxy(); } catch { /* ignore */ }
      done();
    });
    process.stderr.write('[proxy-mcp] no daemon detected — running in-process. Run `proxy-mcp install` for a persistent zero-config daemon.\n');
  }

  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, logging: {} } },
  );
  const resourceSubscriptions = registerMcpResourceSubscriptions(mcp);
  const observableDispatch = async (tool, args, context) => {
    const value = await dispatch(tool, args, context);
    if (STATUS_MUTATION_TOOLS.has(tool)) void resourceSubscriptions.notifyStatus().catch(() => {});
    const flowId = value?.flow?.id ?? value?.flow_id ?? value?.id;
    if (flowId && /flow|request|curl/.test(tool)) void resourceSubscriptions.notifyLiveFlow(flowId).catch(() => {});
    return value;
  };
  registerMcpTools(mcp, observableDispatch);
  registerMcpResources(mcp, observableDispatch);
  registerMcpPrompts(mcp);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  const stopResourceMonitor = startResourceSubscriptionMonitor(dispatch, resourceSubscriptions);
  asyncExitHook((done) => { stopResourceMonitor(); done(); });
}

function startResourceSubscriptionMonitor(dispatch, subscriptions, intervalMs = 750) {
  const fingerprints = new Map();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    const uris = subscriptions.subscriptions();
    if (uris.length === 0) return;
    busy = true;
    try {
      if (uris.includes(MCP_RESOURCE_URIS.status)) {
        const status = await dispatch('get_proxy_status', {});
        const next = JSON.stringify(status);
        if (fingerprints.has(MCP_RESOURCE_URIS.status) && fingerprints.get(MCP_RESOURCE_URIS.status) !== next) {
          await subscriptions.notifyStatus();
        }
        fingerprints.set(MCP_RESOURCE_URIS.status, next);
      }
      const flowIds = new Set(uris.flatMap(resourceFlowId));
      for (const flowId of flowIds) {
        try {
          const detail = await dispatch('get_flow_detail', { flow_id: flowId, body_mode: 'none', include_sensitive: false });
          const key = `${MCP_RESOURCE_URIS.liveFlowPrefix}${encodeURIComponent(flowId)}`;
          const next = JSON.stringify(detail);
          if (fingerprints.has(key) && fingerprints.get(key) !== next) await subscriptions.notifyLiveFlow(flowId);
          fingerprints.set(key, next);
        } catch { /* A removed or expired flow simply stops producing updates. */ }
      }
    } catch { /* Resource update notifications are advisory. */ }
    finally { busy = false; }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function resourceFlowId(uri) {
  if (!uri.startsWith(MCP_RESOURCE_URIS.liveFlowPrefix)) return [];
  const remainder = uri.slice(MCP_RESOURCE_URIS.liveFlowPrefix.length);
  const encoded = remainder.split('/bodies/')[0];
  try { return encoded ? [decodeURIComponent(encoded)] : []; }
  catch { return []; }
}

async function runDaemon(args) {
  // Reconcile any prior dirty state before binding ports.
  if (await isStateStale()) {
    process.stderr.write('[proxy-mcp] daemon: stale state.json found, reconciling network state…\n');
    try {
      const reset = await defensiveNetworkResetAllServices();
      if (reset.failed?.length) throw new Error(reset.failed.map((item) => item.error).join('; '));
      await clearState();
    }
    catch (e) { process.stderr.write(`[proxy-mcp] daemon: reconcile failed (ignored): ${e?.message}\n`); }
  }

  const engine = new ProxyEngine();
  const pacServer = new PacServer();
  const tools = makeTools({ engine, pacServer, mode: 'daemon' });

  const { domains, tls_passthrough } = await loadDomainsConfig(args);

  const proxyPort = args.proxyPort ?? PROXY_PORT_DEFAULT;
  const pacPort   = args.pacPort   ?? PAC_PORT_DEFAULT;
  const controlPort = args.controlPort ?? DEFAULT_CONTROL_PORT;

  if (!args.skipRouting && args.skipHostTrust && domains.includes('*')) {
    throw new Error('--no-host-trust cannot be combined with broad default routing; supply narrow --domains or use --no-routing');
  }

  let ctrl = null;
  try {
  if ((args.caKeyPath == null) !== (args.caCertPath == null)) {
    throw new Error('--ca-key and --ca-cert must be provided together');
  }
  if (!args.caCertPath) await ensureCA();
  const activeCaCert = args.caCertPath ?? CA_CERT;
  if (!args.skipHostTrust) {
    const hostTrust = await setupHostCertificate(activeCaCert);
    if (!hostTrust.ok || !hostTrust.trusted) {
      const error = new Error(hostTrust.recovery ?? hostTrust.error ?? 'host CA trust could not be verified');
      error.code = hostTrust.code ?? 'HOST_CA_NOT_TRUSTED';
      throw error;
    }
  }
  await engine.start({
    port: proxyPort,
    tlsPassthrough: tls_passthrough,
    allowRemote: args.allowRemoteProxy,
    allowedRemoteIps: args.remoteAllowlist,
    remoteAccessTtlSeconds: args.remoteAccessTtlSeconds,
    captureBodyMode: args.captureBodyMode,
    enableSocks: args.enableSocks,
    caKeyPath: args.caKeyPath,
    caCertPath: args.caCertPath,
  });
  process.stderr.write(`[proxy-mcp] proxy listening on :${engine.port}\n`);

  let routing = null;
  if (!args.skipRouting && domains.length > 0) {
    routing = await applyPacRouting({
      domains,
      networkService: args.networkService,
      pacPort,
      proxyPort: engine.port,
      pacServer,
    });
    process.stderr.write(`[proxy-mcp] routing on for ${routing.networkService} via ${routing.pacUrl}\n`);
  }

  if (!args.skipTrust) {
    const trust = await trustCaOnSimulators(activeCaCert);
    if (trust.trusted?.length) {
      process.stderr.write(`[proxy-mcp] CA imported on ${trust.trusted.length} simulator(s): ${trust.trusted.map((s) => s.name).join(', ')}\n`);
    }
  }

  // Start the control plane so MCP clients can forward tool calls to us.
  ctrl = new ControlServer({ port: controlPort, tools });
  await ctrl.start();
  process.stderr.write(`[proxy-mcp] control plane listening on :${ctrl.port}\n`);

  await writePidFile(process.pid);
  await patchState({ control_port: ctrl.port, pid: process.pid });

  // Replay any previously persisted rules.
  try {
    const persisted = await loadRules();
    let replayed = 0;
    const failures = [];
    for (const r of persisted) {
      try { await engine.registerRule(r); replayed += 1; }
      catch (error) {
        failures.push({ rule_id: r.rule_id ?? r.id ?? null, error: error?.message ?? String(error) });
      }
    }
    if (replayed) process.stderr.write(`[proxy-mcp] replayed ${replayed} persisted rule(s)\n`);
    if (failures.length) {
      engine.diagnostics.push({ kind: 'rule-replay-failures', timestamp: Date.now(), failures });
      process.stderr.write(`[proxy-mcp] failed to replay ${failures.length} persisted rule(s); inspect get_diagnostics\n`);
    }
  } catch (error) {
    engine.diagnostics.push({ kind: 'rule-load-error', timestamp: Date.now(), error: error?.message ?? String(error) });
    process.stderr.write(`[proxy-mcp] could not load persisted rules: ${error?.message ?? error}\n`);
  }

  // Start the sim watcher in the daemon (Phase 3.4).
  await tools.start_sim_watcher({ interval: 5000 });
  } catch (error) {
    process.stderr.write(`[proxy-mcp] daemon startup failed; rolling back: ${error?.message ?? error}\n`);
    try { await tools.stop_sim_watcher(); } catch { /* best effort */ }
    let routingRestored = true;
    try { await clearPacRouting({ pacServer }); } catch { routingRestored = false; }
    try { await ctrl?.stop(); } catch { /* best effort */ }
    try { await engine.stop(); } catch { /* best effort */ }
    try { await clearPidFile(); } catch { /* best effort */ }
    if (routingRestored) { try { await clearState(); } catch { /* best effort */ } }
    throw error;
  }

  // Graceful shutdown — async-exit-hook gives us real awaits before launchd
  // escalates to SIGKILL (plist ExitTimeOut=20).
  asyncExitHook(async (done) => {
    process.stderr.write('[proxy-mcp] shutting down, restoring network…\n');
    try { await tools.stop_operator_ui(); } catch { /* ignore */ }
    try { await tools.stop_sim_watcher(); } catch { /* ignore */ }
    let routingRestored = true;
    try { await clearPacRouting({ pacServer }); }
    catch (error) {
      routingRestored = false;
      process.stderr.write(`[proxy-mcp] failed to restore PAC state; retaining recovery state: ${error?.message ?? error}\n`);
    }
    try { await ctrl.stop(); } catch { /* ignore */ }
    try { await engine.stop(); } catch { /* ignore */ }
    try { await clearPidFile(); } catch { /* ignore */ }
    if (routingRestored) { try { await clearState(); } catch { /* ignore */ } }
    done();
  });

  // Keep the loop alive.
  setInterval(() => {}, 1 << 30);
}

// ---- CLI ----
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--daemon') args.daemon = true;
    else if (a === '--proxy-port')   args.proxyPort = parseInt(argv[++i], 10);
    else if (a === '--pac-port')     args.pacPort = parseInt(argv[++i], 10);
    else if (a === '--control-port') args.controlPort = parseInt(argv[++i], 10);
    else if (a === '--domains-file') args.domainsFile = argv[++i];
    else if (a === '--domains')      args.domainsInline = argv[++i];
    else if (a === '--network-service') args.networkService = argv[++i];
    else if (a === '--no-trust-ca')  args.skipTrust = true;
    else if (a === '--no-host-trust') args.skipHostTrust = true;
    else if (a === '--keep-ca') args.keepCa = true;
    else if (a === '--no-routing')   args.skipRouting = true;
    else if (a === '--allow-remote-proxy') args.allowRemoteProxy = true;
    else if (a === '--remote-allowlist') args.remoteAllowlist = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--remote-access-ttl') args.remoteAccessTtlSeconds = parseInt(argv[++i], 10);
    else if (a === '--capture-body-mode') args.captureBodyMode = argv[++i];
    else if (a === '--enable-socks') args.enableSocks = true;
    else if (a === '--ca-key') args.caKeyPath = argv[++i];
    else if (a === '--ca-cert') args.caCertPath = argv[++i];
    else if (a === '--tls-passthrough') args.tlsPassthrough = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

async function loadDomainsConfig(args) {
  // Returns { domains: string[], tls_passthrough: string[] }.
  if (args.domainsInline) {
    return { domains: args.domainsInline.split(',').map((s) => s.trim()).filter(Boolean), tls_passthrough: args.tlsPassthrough ?? [] };
  }
  if (args.domainsFile) {
    const raw = await fs.readFile(args.domainsFile, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return { domains: data, tls_passthrough: args.tlsPassthrough ?? [] };
    if (Array.isArray(data?.domains)) {
      return {
        domains: data.domains,
        tls_passthrough: args.tlsPassthrough ?? data.tls_passthrough ?? [],
      };
    }
    throw new Error(`domains file ${args.domainsFile} must be a JSON array or { "domains": [...] }`);
  }
  return { domains: args.skipRouting ? [] : ['*'], tls_passthrough: args.tlsPassthrough ?? [] };
}

function validateCliArgs(args) {
  for (const [name, value] of [
    ['proxy-port', args.proxyPort], ['pac-port', args.pacPort], ['control-port', args.controlPort],
  ]) {
    if (value != null && (!Number.isInteger(value) || value < 1 || value > 65535)) {
      throw new Error(`--${name} must be an integer from 1 to 65535`);
    }
  }
  if (args.allowRemoteProxy && !args.remoteAllowlist?.length) {
    throw new Error('--allow-remote-proxy requires --remote-allowlist with one or more exact client IPs or CIDRs');
  }
  if (args.remoteAccessTtlSeconds != null
    && (!Number.isInteger(args.remoteAccessTtlSeconds) || args.remoteAccessTtlSeconds < 1 || args.remoteAccessTtlSeconds > 86_400)) {
    throw new Error('--remote-access-ttl must be an integer from 1 to 86400 seconds');
  }
  if (args.captureBodyMode != null && !['metadata_only', 'text', 'all'].includes(args.captureBodyMode)) {
    throw new Error('--capture-body-mode must be metadata_only, text, or all');
  }
  if ((args.caKeyPath == null) !== (args.caCertPath == null)) {
    throw new Error('--ca-key and --ca-cert must be provided together');
  }
}

function printHelp() {
  process.stderr.write(`proxy-mcp v${SERVER_VERSION} — selective HTTP(S) interception for iOS Simulator testing

USAGE
  proxy-mcp                         Run as stdio MCP server (auto-connects to a running daemon if present)
  proxy-mcp --daemon [opts]         Long-lived daemon (manages proxy, PAC, sim trust, control plane)
  proxy-mcp doctor                  Inspect ports, stop only a verified stale daemon, restore recorded PAC state
  proxy-mcp install [opts]          Install LaunchAgent for persistent daemon (~/Library/LaunchAgents)
  proxy-mcp uninstall               Remove the LaunchAgent
  proxy-mcp status                  Daemon + LaunchAgent + handshake state

DAEMON OPTIONS
  --proxy-port <n>          Proxy port (default ${PROXY_PORT_DEFAULT})
  --pac-port <n>            PAC server port (default ${PAC_PORT_DEFAULT})
  --control-port <n>        Daemon control plane port (default ${DEFAULT_CONTROL_PORT})
  --domains-file <path>     JSON file: { "domains": ["*.example.com", ...], "tls_passthrough": [...] }
  --domains <list>          Comma-separated host globs (overrides --domains-file)
  --network-service <name>  macOS network service (default: auto-detect Wi-Fi)
  --no-routing              Start proxy only; skip PAC + networksetup
  --allow-remote-proxy      Accept allowlisted LAN proxy clients for a bounded time
  --remote-allowlist <list> Comma-separated exact client IPs/CIDRs (required with remote access)
  --remote-access-ttl <s>   Revoke remote access after 1-86400 seconds (default 3600)
  --capture-body-mode <m>   metadata_only, text (default), or all (requires sensitive grant)
  --enable-socks            Accept SOCKS clients on the local proxy listener
  --ca-key <path>           Custom CA private key (must be paired with --ca-cert)
  --ca-cert <path>          Custom CA certificate (must be paired with --ca-key)
  --no-trust-ca             Skip simctl CA trust step
  --no-host-trust           Do not add the CA to the user login keychain (use narrow --domains)
  --tls-passthrough <list>  Comma-separated hostnames to tunnel raw (cert-pinned hosts)

UNINSTALL OPTIONS
  --keep-ca                 Keep the proxy-mcp CA in the user login keychain

State lives in ${STATE_DIR}.
`);
}

async function runDoctor() {
  const sweep = await doctorSweep();
  const stale = await isStateStale();
  let networkReset = null;
  if (stale) {
    networkReset = await defensiveNetworkResetAllServices();
    if (!networkReset.failed?.length) await clearState();
  }
  process.stdout.write(JSON.stringify({ ...sweep, state_was_stale: stale, network_reset: networkReset }, null, 2) + '\n');
}

async function runInstall(args) {
  const serverPath = url.fileURLToPath(import.meta.url);
  const installRouting = await loadDomainsConfig(args);
  if (!args.skipRouting && args.skipHostTrust && installRouting.domains.includes('*')) {
    throw new Error('--no-host-trust requires narrow --domains/--domains-file or --no-routing');
  }
  if (!args.caCertPath) await ensureCA();
  const activeCaCert = args.caCertPath ?? CA_CERT;
  let hostCertificate = { status: 'skipped' };
  if (!args.skipHostTrust) {
    hostCertificate = await setupHostCertificate(activeCaCert);
    if (!hostCertificate.ok || !hostCertificate.trusted) {
      throw new Error(hostCertificate.recovery ?? hostCertificate.error ?? 'host CA trust could not be verified');
    }
  }
  const extraArgs = [];
  if (args.skipTrust) extraArgs.push('--no-trust-ca');
  if (args.skipHostTrust) extraArgs.push('--no-host-trust');
  if (args.skipRouting) extraArgs.push('--no-routing');
  if (args.allowRemoteProxy) extraArgs.push('--allow-remote-proxy');
  if (args.remoteAllowlist?.length) extraArgs.push('--remote-allowlist', args.remoteAllowlist.join(','));
  if (args.remoteAccessTtlSeconds) extraArgs.push('--remote-access-ttl', String(args.remoteAccessTtlSeconds));
  if (args.captureBodyMode) extraArgs.push('--capture-body-mode', args.captureBodyMode);
  if (args.enableSocks) extraArgs.push('--enable-socks');
  if (args.caKeyPath) extraArgs.push('--ca-key', args.caKeyPath);
  if (args.caCertPath) extraArgs.push('--ca-cert', args.caCertPath);
  if (args.networkService) extraArgs.push('--network-service', args.networkService);
  if (args.domainsInline) extraArgs.push('--domains', args.domainsInline);
  if (args.tlsPassthrough?.length) extraArgs.push('--tls-passthrough', args.tlsPassthrough.join(','));
  const out = await installLaunchAgent({
    nodeBin: process.execPath,
    serverPath,
    domainsFile: args.domainsFile,
    proxyPort: args.proxyPort,
    pacPort: args.pacPort,
    controlPort: args.controlPort,
    extraArgs,
  });
  process.stdout.write(JSON.stringify({ installed: true, host_certificate: hostCertificate, ...out }, null, 2) + '\n');
}

async function runUninstall(args) {
  const out = await uninstallLaunchAgent();
  const hostCertificate = args.keepCa ? { removed: false, reason: '--keep-ca' } : await removeHostCertificate(CA_CERT);
  process.stdout.write(JSON.stringify({ ...out, host_certificate: hostCertificate }, null, 2) + '\n');
}

async function runStatus() {
  const la = await launchAgentStatus();
  const state = await readState();
  const pid = await readPidFile();
  const handshake = await readHandshake();
  let daemonAlive = false;
  if (handshake) daemonAlive = await probeDaemon(handshake.controlUrl, handshake.token);
  process.stdout.write(JSON.stringify({
    launch_agent: la,
    state,
    pid_file: pid,
    handshake_present: !!handshake,
    daemon_alive: daemonAlive,
  }, null, 2) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  validateCliArgs(args);
  if (args.help) { printHelp(); return; }
  const cmd = args._[0];
  if (cmd === 'doctor')    { await runDoctor(); return; }
  if (cmd === 'install')   { await runInstall(args); return; }
  if (cmd === 'uninstall') { await runUninstall(args); return; }
  if (cmd === 'status')    { await runStatus(); return; }
  if (args.daemon)         { await runDaemon(args); return; }
  await runStdio();
}

main().catch((e) => {
  process.stderr.write(`[proxy-mcp] fatal: ${e?.stack || e}\n`);
  process.exit(1);
});
