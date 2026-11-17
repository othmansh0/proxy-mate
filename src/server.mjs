#!/usr/bin/env node
import { readEnvironment } from './lib/environment.mjs';
// proxy-mate — local HTTP(S) capture, routing, mocking, and Simulator setup.
//
// Two run shapes share the same internals:
//   * stdio MCP server (default)  — forwards to the shared daemon. It never
//                                    starts a competing capture engine.
//   * `--daemon`                   — long-lived. Owns the proxy, PAC server,
//                                    state, rules, simulator watcher, and a
//                                    control HTTP server (default :8082) so
//                                    multiple MCP clients can share state.
//
// Plus CLI subcommands: `doctor`, `install`, `uninstall`, `status`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { promises as fs } from 'node:fs';
import url from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runCaptureSetup } from './lib/setup.mjs';
import { initializePackage } from './lib/onboarding.mjs';
import { acquireRuntime, reconcileRuntime, installShutdownHandlers } from './lib/runtime.mjs';
import { startLogMaintenance } from './lib/log-maintenance.mjs';
import { waitForReadyDaemon } from './lib/daemon-connection.mjs';
import { startResourceSubscriptionMonitor } from './lib/resource-monitor.mjs';
import { SERVER_INSTRUCTIONS } from './lib/guidance.mjs';
import { recordRuntimeEvent, recordPreviousExit } from './lib/runtime-identity.mjs';
import { logLine, errorFields } from './lib/log-line.mjs';
import { rememberCaptureLease, INTERNAL_CAPTURE_CONTROL } from './lib/capture-lease.mjs';
import { configureConnectionAttempts, connectionAttemptTimeout } from './lib/network-policy.mjs';

import { ProxyEngine, CA_CERT } from './lib/proxy.mjs';
import { PacServer } from './lib/pac.mjs';
import { makeTools } from './lib/tools.mjs';
import {
  readState, isStateStale, defensiveNetworkResetAllServices, sweepStaleTempFiles, readProcessIdentity,
  writePidFile, readPidFile, clearPidFile, clearState, patchState, readHandshake,
} from './lib/state.mjs';
import { startLiveness } from './lib/liveness.mjs';
import { startEventLoopMetrics } from './lib/event-loop-metrics.mjs';
import { ControlServer, callDaemon, probeDaemon, DEFAULT_CONTROL_PORT, SERIAL_TOOL_NAMES } from './lib/control.mjs';
import { doctorSweep, PROXY_PORT_DEFAULT, PAC_PORT_DEFAULT } from './lib/doctor.mjs';
import { validateCustomCaPaths } from './lib/ca-paths.mjs';
import { installLaunchAgent, uninstallLaunchAgent, launchAgentStatus } from './lib/launchagent.mjs';
import { applyPacRouting, clearPacRouting, validateRoutingDomains } from './lib/pac.mjs';
import { trustCaOnSimulators } from './lib/sim.mjs';
import { setupSimulatorRouting } from './lib/simulator-routing.mjs';
import { ensureCA } from './lib/proxy.mjs';
import { STATE_DIR, SERVER_NAME, SERVER_VERSION } from './lib/config.mjs';
import { setupHostCertificate, removeHostCertificate } from './lib/host-cert.mjs';
import { loadRules } from './lib/rules.mjs';
import {
  MCP_RESOURCE_URIS, registerMcpPrompts, registerMcpResources,
  registerMcpResourceSubscriptions, registerMcpTools,
} from './lib/mcp-contract.mjs';

const STATUS_MUTATION_TOOLS = new Set([
  'start_app_capture',
  'start_proxy', 'stop_proxy', 'set_proxy_routing', 'clear_proxy_routing',
  'toggle_recording', 'clear_session', 'select_capture_session',
  'create_capture_session', 'update_capture_session', 'purge_capture_session',
  'start_sim_watcher', 'stop_sim_watcher', 'enable_ssl_proxying',
  'upsert_transform_plugin', 'remove_transform_plugin',
  'set_transform_plugin_enabled', 'create_transform_plugin_rule',
  'start_operator_ui', 'stop_operator_ui',
]);

// ---- run modes ----
async function runStdio({ requireDaemon = false } = {}) {
  const { createDaemonReadiness } = await import('./lib/daemon-connection.mjs');
  const { newClientId, normalizeTaskId } = await import('./lib/client-identity.mjs');
  const client = { client_id: newClientId(), task_id: null };
  const readiness = createDaemonReadiness({ client });
  let localReady = null, localTools = null, releaseRuntime = null;
  let daemonSeen = false, closing = false;
  let stopResourceMonitor = () => {};
  let localQueue = Promise.resolve();
  installShutdownHandlers(async () => {
    closing = true;
    stopResourceMonitor();
    await localReady?.catch(() => {});
    await localQueue;
    if (localTools) {
      await localTools.stop_operator_ui();
      await localTools[INTERNAL_CAPTURE_CONTROL].stop_proxy();
    }
    if (releaseRuntime) await releaseRuntime();
  }, { stdin: true });
  const dispatch = async (tool, args, context = {}) => {
    if (['get_started', 'acquire_capture_lease', 'finish_capture_task'].includes(tool) && args?.task_id !== undefined) {
      client.task_id = normalizeTaskId(args.task_id);
    }
    if (closing) throw new Error('proxy-mate is shutting down.');
    // Resolve the handshake for EVERY call: launchd restarts rotate the token
    // and can change the port. Never retry a mutation after an ambiguous error.
    if (!localReady) {
      const state = await readState();
      const daemonExpected = requireDaemon || daemonSeen || (state?.pid && !await isStateStale());
      const handshake = await readiness.waitForReady({
        timeoutMs: daemonExpected ? 15_000 : 0, signal: context.signal,
      });
      if (handshake) {
        daemonSeen = true;
        const result = await callDaemon({ ...handshake, client, tool, args, signal: context.signal });
        readiness.recordSuccess(handshake);
        return result;
      }
      if (daemonExpected) {
        throw Object.assign(new Error('The shared daemon is unavailable after a bounded readiness wait. This MCP connection remains open.'), {
          code: 'DAEMON_UNAVAILABLE', retryable: true,
          recovery: ['Run proxy-mate status and inspect the daemon stderr log.',
            'If not installed, run proxy-mate install with the capture options for your workflow.',
            'Retry the tool call after daemon recovery; do not restart the MCP client.'],
        });
      }
      // Claim state lazily: initializing/listing MCP tools must never change
      // network settings or create a competing proxy.
      if (!localReady) localReady = (async () => {
        configureConnectionAttempts();
        releaseRuntime = await acquireRuntime();
        await reconcileRuntime();
        localTools = makeTools({ engine: new ProxyEngine(), pacServer: new PacServer(), mode: 'in-process' });
      })();
    }
    try { await localReady; }
    catch (error) {
      localReady = null;
      if (releaseRuntime) { await releaseRuntime(); releaseRuntime = null; }
      throw error;
    }
    const invoke = () => {
      if (closing || context.signal?.aborted) throw Object.assign(new Error('Request cancelled.'), { code: 'REQUEST_CANCELLED' });
      if (!Object.hasOwn(localTools, tool)) throw new Error(`unknown tool: ${tool}`);
      return localTools[tool](args ?? {}, context);
    };
    const operation = SERIAL_TOOL_NAMES.has(tool) ? localQueue.then(invoke) : Promise.resolve().then(invoke);
    if (SERIAL_TOOL_NAMES.has(tool)) localQueue = operation.catch(() => {});
    return operation;
  };

  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, logging: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const resourceSubscriptions = registerMcpResourceSubscriptions(mcp);
  const observableDispatch = async (tool, args, context) => {
    const value = await dispatch(tool, args, context);
    if (STATUS_MUTATION_TOOLS.has(tool)) void resourceSubscriptions.notifyStatus().catch(() => {});
    const flowId = value?.flow?.id ?? value?.flow_id ?? value?.id;
    if (flowId && /flow|request|curl/.test(tool)) void resourceSubscriptions.notifyLiveFlow(flowId).catch(() => {});
    return value;
  };
  registerMcpTools(mcp, rememberCaptureLease(observableDispatch), { legacyAliases: readEnvironment('PROXY_MATE_LEGACY_OUTPUT') === '1' });
  registerMcpResources(mcp, observableDispatch);
  registerMcpPrompts(mcp);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  stopResourceMonitor = startResourceSubscriptionMonitor(dispatch, resourceSubscriptions);
}

async function runDaemon(args) {
  configureConnectionAttempts();
  let releaseRuntime = async () => {}, stopLogMaintenance = () => {};
  let engine, tools, startupResourcesReady = false;
  // Liveness answers from a worker thread so the guardian can tell a slow main
  // loop from a hung process; loop metrics feed /metrics and the liveness body.
  let liveness = null, loopMetrics = null;
  const stopObservability = async () => {
    loopMetrics?.stop(); loopMetrics = null;
    try { await liveness?.stop(); } catch { /* best effort */ }
    liveness = null;
  };
  const durations = Object.fromEntries(['lock', 'reconcile', 'session_restore', 'ca', 'host_trust', 'engine', 'routing', 'trust', 'rules', 'watcher', 'control'].map(name => [`${name}_ms`, 0]));
  let phase = 'lock', phaseAt = performance.now();
  const phaseStart = (next) => {
    durations[`${phase}_ms`] += Math.round(performance.now() - phaseAt);
    phase = next; phaseAt = performance.now();
  };
  let ctrl = null;
  let finishStartup;
  const startupSettled = new Promise((resolve) => { finishStartup = resolve; });
  const cleanup = async () => {
    stopLogMaintenance();
    await startupSettled;
    // Cancel control work before draining capture or restoring routing.
    await ctrl?.stop();
    await tools.stop_operator_ui();
    const stopped = await tools[INTERNAL_CAPTURE_CONTROL].stop_proxy();
    await clearPidFile();
    if (!stopped.routing_cleanup_error) {
      const lease = (await readState())?.capture_lease;
      await clearState();
      await patchState({ active_session_id: engine.sessionId,
        ...(lease && Date.parse(lease.expires_at) > Date.now() ? { capture_lease: lease } : {}) });
    }
    await stopObservability();
    await releaseRuntime();
  };
  const shutdown = installShutdownHandlers(async () => {
    await startupSettled;
    if (startupResourcesReady) return cleanup();
    stopLogMaintenance();
    await stopObservability();
    await releaseRuntime();
  });
  try {
  releaseRuntime = await acquireRuntime({ shutdown });
  phaseStart('reconcile');
  await sweepStaleTempFiles(STATE_DIR);
  await reconcileRuntime();
  loopMetrics = startEventLoopMetrics();
  try { liveness = await startLiveness(); }
  catch (error) { logLine('daemon', 'liveness unavailable', errorFields(error)); }
  stopLogMaintenance = startLogMaintenance();
  phaseStart('session_restore');
  engine = new ProxyEngine();
  const priorState = await readState();
  if (priorState?.active_session_id) {
    try { await engine.setActiveSession(priorState.active_session_id, { create: false }); }
    catch (error) { engine.diagnostics.push({ kind: 'session-restore-failed', code: error.code ?? 'SESSION_RESTORE_FAILED' }); }
  }
  const pacServer = new PacServer();
  tools = makeTools({ engine, pacServer, mode: 'daemon' });

  const { domains, tls_passthrough } = await loadDomainsConfig(args);
  if (!args.skipRouting && domains.length) validateRoutingDomains(domains, { allowBroad: args.allowBroadRouting === true });

  const proxyPort = args.proxyPort ?? PROXY_PORT_DEFAULT;
  const pacPort   = args.pacPort   ?? PAC_PORT_DEFAULT;
  const controlPort = args.controlPort ?? DEFAULT_CONTROL_PORT;

  if (!args.skipRouting && args.skipHostTrust && domains.includes('*')) {
    throw new Error('--no-host-trust cannot be combined with broad default routing; supply narrow --domains or use --no-routing');
  }

  startupResourcesReady = true;
  phaseStart('ca');
  if ((args.caKeyPath == null) !== (args.caCertPath == null)) {
    throw new Error('--ca-key and --ca-cert must be provided together');
  }
  if (!args.caCertPath) await ensureCA();
  phaseStart('host_trust');
  const activeCaCert = args.caCertPath ?? CA_CERT;
  if (!args.skipHostTrust) {
    const hostTrust = await setupHostCertificate(activeCaCert);
    if (!hostTrust.ok || !hostTrust.trusted) {
      const error = new Error(hostTrust.recovery ?? hostTrust.error ?? 'host CA trust could not be verified');
      error.code = hostTrust.code ?? 'HOST_CA_NOT_TRUSTED';
      throw error;
    }
  }
  phaseStart('engine');
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
  process.stderr.write(`[proxy-mate] proxy listening on :${engine.port}\n`);

  phaseStart('routing');
  let routing = null;
  let trust = null;
  if (!args.skipRouting && domains.length > 0) {
    const applyRouting = async () => {
      phaseStart('routing');
      const result = await applyPacRouting({
      domains,
      networkService: args.networkService,
      pacPort,
      proxyPort: engine.port,
      pacServer,
      allowBroad: args.allowBroadRouting === true,
      });
      phaseStart('trust');
      return result;
    };
    if (args.skipTrust) routing = await applyRouting();
    else {
      phaseStart('trust');
      ({ trust, routing } = await setupSimulatorRouting({
        certPath: activeCaCert, keyPath: engine.caKeyPath, applyRouting,
      }));
    }
    process.stderr.write(`[proxy-mate] routing on for ${routing.networkService} via ${routing.pacUrl}\n`);
  }

  phaseStart('trust');
  if (!args.skipTrust) {
    trust ??= await trustCaOnSimulators(activeCaCert);
    if (trust.trusted?.length) {
      process.stderr.write(`[proxy-mate] CA imported on ${trust.trusted.length} simulator(s): ${trust.trusted.map((s) => s.name).join(', ')}\n`);
    }
  }

  phaseStart('rules');
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
    if (replayed) process.stderr.write(`[proxy-mate] replayed ${replayed} persisted rule(s)\n`);
    if (failures.length) {
      engine.diagnostics.push({ kind: 'rule-replay-failures', timestamp: Date.now(), failures });
      process.stderr.write(`[proxy-mate] failed to replay ${failures.length} persisted rule(s); inspect get_diagnostics\n`);
    }
  } catch (error) {
    engine.diagnostics.push({ kind: 'rule-load-error', timestamp: Date.now(), error: error?.message ?? String(error) });
    process.stderr.write(`[proxy-mate] could not load persisted rules: ${error?.message ?? error}\n`);
  }

  phaseStart('watcher');
  // Start the sim watcher in the daemon (Phase 3.4).
  if (!args.skipTrust) await tools[INTERNAL_CAPTURE_CONTROL].start_sim_watcher({ interval: 5000 });
  phaseStart('control');
  // Publish readiness only after routing, trust and persisted rules are ready.
  ctrl = new ControlServer({ port: controlPort, tools });
  await writePidFile(process.pid);
  await patchState({ ...await readProcessIdentity(process.pid), control_port: controlPort, daemon_proxy_port: proxyPort, pid: process.pid, runtime_role: 'daemon', runtime_entry: url.fileURLToPath(import.meta.url) });
  await ctrl.start();
  process.stderr.write(`[proxy-mate] control plane listening on :${ctrl.port}\n`);
  await recordPreviousExit();
  phaseStart('ready');
  const readyDetails = { ...durations, proxy_port: engine.port, pac_port: pacServer.port ?? pacPort, control_port: ctrl.port };
  await recordRuntimeEvent('ready', { details: readyDetails });
  logLine('daemon', 'ready', readyDetails);
  } catch (error) {
    logLine('daemon', 'startup failed; rolling back', { phase, error_code: error?.code ?? null, error_message: error?.message ?? String(error) });
    await recordRuntimeEvent('startup_failed', { code: 1, reason: 'startup_failed', details: {
      phase, error_code: error?.code ?? null, error_message: error?.message ?? String(error),
    } }).catch(() => {});
    finishStartup();
    await shutdown(1, 'startup_failed');
    return;
  }
  finishStartup();

  // Keep the loop alive.
  setInterval(() => {}, 1 << 30);
}

// ---- CLI ----
function parseArgs(argv) {
  const args = { _: [], skipHostTrust: true, skipTrust: true };
  const value = (index, flag) => {
    const entry = argv[index];
    if (!entry || entry.startsWith('--')) throw new Error(`${flag} requires a value`);
    return entry;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--daemon') args.daemon = true;
    else if (a === '--require-daemon') args.requireDaemon = true;
    else if (a === '--in-process') args.inProcess = true;
    else if (a === '--allow-broad-routing') args.allowBroadRouting = true;
    else if (a === '--proxy-port')   args.proxyPort = Number(value(++i, a));
    else if (a === '--pac-port')     args.pacPort = Number(value(++i, a));
    else if (a === '--control-port') args.controlPort = Number(value(++i, a));
    else if (a === '--domains-file') args.domainsFile = path.resolve(value(++i, a));
    else if (a === '--domains')      args.domainsInline = value(++i, a);
    else if (a === '--network-service') args.networkService = value(++i, a);
    else if (a === '--no-trust-ca')  args.skipTrust = true;
    else if (a === '--trust-simulators') args.skipTrust = false;
    else if (a === '--no-host-trust') args.skipHostTrust = true;
    else if (a === '--trust-host-ca') args.skipHostTrust = false;
    else if (a === '--keep-ca') args.keepCa = true;
    else if (a === '--no-routing')   args.skipRouting = true;
    else if (a === '--allow-remote-proxy') args.allowRemoteProxy = true;
    else if (a === '--remote-allowlist') args.remoteAllowlist = value(++i, a).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--remote-access-ttl') args.remoteAccessTtlSeconds = Number(value(++i, a));
    else if (a === '--capture-body-mode') args.captureBodyMode = value(++i, a);
    else if (a === '--enable-socks') args.enableSocks = true;
    else if (a === '--ca-key') args.caKeyPath = path.resolve(value(++i, a));
    else if (a === '--ca-cert') args.caCertPath = path.resolve(value(++i, a));
    else if (a === '--tls-passthrough') args.tlsPassthrough = value(++i, a).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--client') args.client = value(++i, a);
    else if (a === '--upgrade') args.upgrade = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (['init', 'install', 'uninstall', 'doctor', 'status', 'setup'].includes(a) && !args._.length) args._.push(a);
    else throw new Error(`Unknown argument: ${a}. Use --help for supported commands.`);
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
  return { domains: [], tls_passthrough: args.tlsPassthrough ?? [] };
}

function validateCliArgs(args) {
  if ((args.client || args.upgrade || args.dryRun) && args._[0] !== 'init') throw new Error('--client, --upgrade and --dry-run require init.');
  if (args._[0] === 'init' && (Object.keys(args).some((key) => !['_', 'skipHostTrust', 'skipTrust', 'client', 'upgrade', 'dryRun', 'help'].includes(key))
    || !args.skipHostTrust || !args.skipTrust)) throw new Error('init only accepts --client, --upgrade and --dry-run. Use install for advanced daemon options.');
  if (args.daemon && args._.length) throw new Error('--daemon cannot be combined with a subcommand.');
  if (args.requireDaemon && (args.daemon || args._.length)) throw new Error('--require-daemon is only supported by the stdio MCP client.');
  if (args.inProcess && (args.requireDaemon || args.daemon || args._.length)) throw new Error('--in-process is a standalone single-client development mode.');
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
  process.stderr.write(`proxy-mate v${SERVER_VERSION} — selective HTTP(S) interception for iOS Simulator testing

USAGE
  proxy-mate init [--client name]    Install the service and connect a client (default claude)
  proxy-mate init --dry-run          Preview setup without changing services or client files
  proxy-mate init --upgrade          Upgrade an idle service; keep existing capture evidence
  proxy-mate                         Run the thin stdio MCP bridge to the shared daemon
  proxy-mate --in-process            Explicit single-client development engine
  proxy-mate --require-daemon        Shared-daemon MCP client; never owns capture or routing
  proxy-mate --daemon [opts]         Long-lived daemon (manages proxy, PAC, sim trust, control plane)
  proxy-mate doctor                  Inspect ports, stop only a verified stale daemon, restore recorded PAC state
  proxy-mate install [opts]          Install LaunchAgent for persistent daemon (~/Library/LaunchAgents)
  proxy-mate uninstall               Remove the LaunchAgent
  proxy-mate status                  Daemon + LaunchAgent + handshake state
  proxy-mate setup                   Friendly interactive capture setup; app-only by default

INIT OPTIONS
  --client <name>          claude (default), codex, cursor, claude-desktop or json
  --dry-run                Print the plan without changing service/client files
  --upgrade                Replace an idle service; plain init reuses healthy capture

DAEMON OPTIONS
  --proxy-port <n>          Proxy port (default ${PROXY_PORT_DEFAULT})
  --pac-port <n>            PAC server port (default ${PAC_PORT_DEFAULT})
  --control-port <n>        Daemon control plane port (default ${DEFAULT_CONTROL_PORT})
  --domains-file <path>     JSON file: { "domains": ["*.example.com", ...], "tls_passthrough": [...] }
  --domains <list>          Comma-separated host globs (overrides --domains-file)
  --network-service <name>  macOS service (default: primary IPv4/IPv6 service)
  --allow-broad-routing     Explicitly permit all-host domain globs
  --no-routing              Start proxy only; skip PAC + networksetup
  --allow-remote-proxy      Accept allowlisted LAN proxy clients for a bounded time
  --remote-allowlist <list> Comma-separated exact client IPs/CIDRs (required with remote access)
  --remote-access-ttl <s>   Revoke remote access after 1-86400 seconds (default 3600)
  --capture-body-mode <m>   metadata_only, text (default), or all (requires sensitive grant)
  --enable-socks            Accept SOCKS clients on the local proxy listener
  --ca-key <path>           Custom CA private key (must be paired with --ca-cert)
  --ca-cert <path>          Custom CA certificate (must be paired with --ca-key)
  --no-trust-ca             Skip simctl CA trust step
  --trust-simulators        Explicitly enable automatic trust on booted Simulators (off by default)
  --no-host-trust           Do not add the CA to the user login keychain (use narrow --domains)
  --trust-host-ca           Explicitly allow Mac CA trust setup (off by default)
  --tls-passthrough <list>  Comma-separated hostnames to tunnel raw (cert-pinned hosts)

UNINSTALL OPTIONS
  --keep-ca                 Keep the proxy-mate CA in the user login keychain

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

async function runInstall(args, { quiet = false, stat = fs.stat } = {}) {
  // Fail before generating/trusting a CA, staging a runtime or activating jobs.
  try {
    await validateCustomCaPaths({ keyPath: args.caKeyPath, certPath: args.caCertPath, stat });
  } catch (error) {
    process.stderr.write(JSON.stringify({ code: error.code, message: error.message,
      details: error.details, recovery: error.recovery }) + '\n');
    throw error;
  }
  connectionAttemptTimeout();
  const serverPath = url.fileURLToPath(import.meta.url);
  const installRouting = await loadDomainsConfig(args);
  if (!args.skipRouting && installRouting.domains.length) validateRoutingDomains(installRouting.domains, { allowBroad: args.allowBroadRouting === true });
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
  if (args.allowBroadRouting) extraArgs.push('--allow-broad-routing');
  if (args.allowRemoteProxy) extraArgs.push('--allow-remote-proxy');
  if (args.remoteAllowlist?.length) extraArgs.push('--remote-allowlist', args.remoteAllowlist.join(','));
  if (args.remoteAccessTtlSeconds) extraArgs.push('--remote-access-ttl', String(args.remoteAccessTtlSeconds));
  if (args.captureBodyMode) extraArgs.push('--capture-body-mode', args.captureBodyMode);
  if (args.enableSocks) extraArgs.push('--enable-socks');
  if (args.caKeyPath) extraArgs.push('--ca-key', args.caKeyPath);
  if (args.caCertPath) extraArgs.push('--ca-cert', args.caCertPath);
  if (args.networkService) extraArgs.push('--network-service', args.networkService);
  if (installRouting.domains.length) extraArgs.push('--domains', installRouting.domains.join(','));
  if (installRouting.tls_passthrough.length) extraArgs.push('--tls-passthrough', installRouting.tls_passthrough.join(','));
  const out = await installLaunchAgent({
    nodeBin: process.execPath,
    serverPath,
    proxyPort: args.proxyPort,
    pacPort: args.pacPort,
    controlPort: args.controlPort,
    extraArgs,
  });
  const result = { installed: true, host_certificate: hostCertificate, ...out };
  if (!quiet) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result;
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

async function runSetup() {
  if (!process.stdin.isTTY) throw Object.assign(new Error('Interactive setup needs a terminal. Use the set-up-capture MCP prompt in chat instead.'), { code: 'INTERACTIVE_TERMINAL_REQUIRED' });
  const handshake = await readHandshake();
  if (!handshake || !await probeDaemon(handshake.controlUrl, handshake.token)) {
    throw new Error('Install or start the shared service first with: proxy-mate install --no-routing --no-trust-ca');
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await runCaptureSetup({ ask: (question) => terminal.question(question), write: (message) => process.stdout.write(message),
      call: (tool, args) => callDaemon({ ...handshake, tool, args }) });
  } finally { terminal.close(); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  validateCliArgs(args);
  if (args.help) { printHelp(); return; }
  const cmd = args._[0];
  if (cmd === 'init') {
    const result = await initializePackage({ client: args.client, upgrade: args.upgrade, dryRun: args.dryRun }, {
      install: async (previous) => runInstall({ skipRouting: true, skipTrust: true, skipHostTrust: true,
        ...(previous ? { proxyPort: previous.port, captureBodyMode: previous.capture_storage_policy,
          tlsPassthrough: previous.tls_passthrough, enableSocks: previous.socks_enabled,
          controlPort: Number(new URL((await readHandshake()).controlUrl).port) } : {}),
      }, { quiet: true }),
    });
    if (args.dryRun || result.client?.status === 'manual') process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else {
      process.stdout.write(`Proxy Mate ${result.service.version} ready. Service ${result.service.status}.\n`);
      process.stdout.write(`${args.client ?? 'claude'}: ${result.client.status} (${result.client.config_path})\n`);
      if (result.client.backup_path) process.stdout.write(`Previous client configuration: ${result.client.backup_path}\n`);
      if (result.update_available) process.stdout.write(`${result.update_available}\n`);
      process.stdout.write(`${result.next_action}\n`);
    }
    return;
  }
  if (cmd === 'setup') {
    if (process.argv.slice(2).length !== 1) throw new Error('Setup is interactive. Choose capture options in its questions instead of passing daemon flags.');
    await runSetup(); return;
  }
  if (cmd === 'doctor')    { await runDoctor(); return; }
  if (cmd === 'install')   { await runInstall(args); return; }
  if (cmd === 'uninstall') { await runUninstall(args); return; }
  if (cmd === 'status')    { await runStatus(); return; }
  if (args.daemon)         { await runDaemon(args); return; }
  if (args.inProcess) await runStdio();
  else await import('./client.mjs');
}

main().catch((e) => {
  const detail = process.argv.includes('setup') || process.argv.includes('init') ? e?.message || String(e) : e?.stack || e;
  process.stderr.write(`[proxy-mate] fatal: ${detail}\n`);
  process.exit(1);
});
