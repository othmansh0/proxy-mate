// Shared tool implementations. Both the daemon's control HTTP server and the
// in-process MCP-server route through these functions. Each tool returns
// JSON-serializable data; the MCP transport layer wraps that into MCP content.

import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';

import { CA_CERT, CA_DIR, ensureCA, rotateCA } from './proxy.mjs';
import { applyPacRouting, clearPacRouting } from './pac.mjs';
import {
  trustCaOnSimulators, restartSimApps, watchSimulators,
  setupSimulatorCertificates, setupXcodePreviewCertificate, discoverXcodePreviewDeviceSets,
  simulatorPreflight, inspectCertificate, listSimulators,
} from './sim.mjs';
import { loadRules, saveRules, exportRulesTo, importRulesFrom } from './rules.mjs';
import {
  flowBodyToMockBody, exportBody, truncateInline, deleteFlowBodies,
} from './bodies.mjs';
import { doctorSweep, PROXY_PORT_DEFAULT, PAC_PORT_DEFAULT } from './doctor.mjs';
import {
  readState, patchState, clearState, isStateStale,
  defensiveNetworkResetAllServices, readPidFile,
} from './state.mjs';
import { STATE_DIR, SERVER_VERSION, TRANSFORM_PLUGIN_GRANT_ENV, liveTransformGrantEnabled } from './config.mjs';
import { getHostCertificateStatus, setupHostCertificate, removeHostCertificate } from './host-cert.mjs';
import { authorizeReadPath, authorizeWritePath, requireSensitiveAccess } from './paths.mjs';
import { DeviceOnboardingPortal } from './device-onboarding.mjs';
import {
  composeHttpRequest, diffFlows, generateRequestCode, generateSwiftUrlSession, parseCurlCommand,
} from './request-tools.mjs';
import { analyzeFlows, evaluateCaptureAssertions } from './analytics.mjs';
import { decodeProtobuf, inspectGraphQLBody, parseGrpcFrames, protocolCapabilities } from './protocols.mjs';
import { ReverseProxyManager } from './reverse-proxy.mjs';
import { ruleUrlMatchers, urlPattern } from './url-match.mjs';
import {
  MAX_OPENAPI_BODY_BYTES, MAX_OPENAPI_DOCUMENT_BYTES,
  MAX_OPENAPI_FLOW_BATCH_LIMIT, validateOpenApiFlow, validateOpenApiFlows,
} from './openapi.mjs';
import { redactBody, redactHeaders, redactUrl, SENSITIVE_QUERY } from './redaction.mjs';
import { buildWebSocketReplayPlan } from './websocket-store.mjs';
import { OperatorUiServer } from './operator-ui.mjs';
import { executeTransform } from './transform-sandbox.mjs';
import {
  listCaptureAdapters, getCaptureAdapterDescriptor, preflightCaptureAdapter,
  buildCaptureSetupPlan, captureAdapterCapabilitySummary,
} from './capture-adapters.mjs';
import {
  prepareUpstreamProxyConfig, upstreamProxyCapabilitySummary,
  mockttpWebSocketCapabilitySummary,
} from './upstream-proxy.mjs';

const HAR_EXPORT_DIR = path.join(STATE_DIR, 'exports');

// Factory: builds a tool object given an engine + pac server pair. Optionally
// owns lifecycle helpers (sim watcher stop fn, etc.).
export function makeTools({ engine, pacServer, mode = 'in-process' }) {
  let simWatchStop = null;
  const simWatcherEvents = [];
  const onboardingPortal = new DeviceOnboardingPortal();
  const operatorUi = new OperatorUiServer({
    providers: {
      health: async () => ({ ok: true, service: 'proxy-mcp' }),
      status: async () => {
        const status = await get_proxy_status();
        return {
          proxy_running: status.running,
          capture_active: status.recording,
          session_id: engine.sessionId,
          flow_count: status.flows_count,
          rule_count: status.mock_rules_count,
          updated_at: new Date().toISOString(),
        };
      },
      recentFlows: async () => (await get_flows({ limit: 50 })).flows,
      rules: async () => engine.listRuleConfigs(),
    },
  });
  const reverseProxies = new ReverseProxyManager({
    onExchange: (exchange) => {
      engine.diagnostics.push({ kind: 'reverse-proxy-exchange', timestamp: Date.now(), ...exchange });
      if (engine.diagnostics.length > engine.maxDiagnostics) engine.diagnostics.shift();
    },
  });

  // ---- helpers ----
  async function ensureProxyRunning() {
    if (!engine.isRunning()) throw new Error('Proxy is not running. Call start_proxy first.');
  }

  async function activeCaCertificate() {
    const certPath = engine.caCertPath ?? CA_CERT;
    if (certPath === CA_CERT) await ensureCA();
    return certPath;
  }

  async function persistRules() {
    await saveRules(engine.listRuleConfigs());
  }

  function flowSummary(f, { includeSensitive = false } = {}) {
    return {
      id: f.id,
      method: f.request?.method,
      url: includeSensitive ? f.request?.url : redactUrl(f.request?.url),
      hostname: f.request?.hostname ?? safeHostname(f.request?.url),
      status: f.response?.statusCode,
      size: f.response?.body_size ?? 0,
      timestamp: f.timestamp,
      protocol: f.request?.protocol ?? null,
      http_version: f.request?.http_version ?? f.response?.http_version ?? null,
      duration_ms: flowDurationMs(f),
      matched_rule_id: f.request?.matched_rule_id ?? null,
    };
  }

  function safeHostname(url) {
    try { return new URL(url).hostname; } catch { return null; }
  }

  function flowDetailForReturn(f, { full = false, includeSensitive = false } = {}) {
    const reqRaw = full ? f.request?.body_inline : truncateInline(f.request?.body_inline).text;
    const resRaw = full ? f.response?.body_inline : truncateInline(f.response?.body_inline).text;
    const reqInline = includeSensitive ? reqRaw : redactBody(reqRaw, f.request?.headers);
    const resInline = includeSensitive ? resRaw : redactBody(resRaw, f.response?.headers);
    return {
      id: f.id,
      timestamp: f.timestamp,
      request: f.request && {
        method: f.request.method,
        protocol: f.request.protocol ?? null,
        http_version: f.request.http_version ?? null,
        url: includeSensitive ? f.request.url : redactUrl(f.request.url),
        hostname: f.request.hostname ?? safeHostname(f.request.url),
        path: f.request.path,
        headers: includeSensitive ? f.request.headers : redactHeaders(f.request.headers),
        query_params: queryParams(f.request.url, includeSensitive),
        cookies: parseCookies(f.request.headers?.cookie, includeSensitive),
        trailers: includeSensitive ? f.request.trailers : redactHeaders(f.request.trailers),
        timing: f.request.timing ?? null,
        remote_ip: f.request.remote_ip ?? null,
        remote_port: f.request.remote_port ?? null,
        body_inline: reqInline,
        body_path: f.request.body_path,
        body_size: f.request.body_size,
        body_sha: f.request.body_sha,
        body_encoding: f.request.body_encoding ?? (f.request.body_path ? 'binary' : 'utf8'),
        body_omitted: Boolean(f.request.body_omitted),
        body_omission_reason: f.request.body_omitted ?? null,
        body_truncated: f.request?.body_inline && !full
          ? truncateInline(f.request.body_inline).truncated : false,
        untrusted_content: true,
      },
      response: f.response && {
        statusCode: f.response.statusCode,
        statusMessage: f.response.statusMessage,
        http_version: f.response.http_version ?? f.request?.http_version ?? null,
        headers: includeSensitive ? f.response.headers : redactHeaders(f.response.headers),
        cookies: parseSetCookies(f.response.headers?.['set-cookie'], includeSensitive),
        trailers: includeSensitive ? f.response.trailers : redactHeaders(f.response.trailers),
        timing: f.response.timing ?? null,
        body_inline: resInline,
        body_path: f.response.body_path,
        body_size: f.response.body_size,
        body_sha: f.response.body_sha,
        body_encoding: f.response.body_encoding ?? (f.response.body_path ? 'binary' : 'utf8'),
        body_omitted: Boolean(f.response.body_omitted),
        body_omission_reason: f.response.body_omitted ?? null,
        body_truncated: f.response?.body_inline && !full
          ? truncateInline(f.response.body_inline).truncated : false,
        untrusted_content: true,
      },
    };
  }

  // ---- proxy lifecycle ----
  async function start_proxy(args = {}) {
    const {
      port, auto_setup = false, network_service, pac_port, tls_passthrough, max_body_size,
      trust_host_ca = false, allow_remote = false, allowed_remote_ips = [],
      remote_access_ttl_seconds = 3600,
      capture_body_mode = 'text',
      enable_socks = false,
    } = args;
    if ((args.ca_key_path == null) !== (args.ca_cert_path == null)) {
      const error = new Error('ca_key_path and ca_cert_path must be provided together.');
      error.code = 'CUSTOM_CA_PAIR_REQUIRED';
      throw error;
    }
    const caKeyPath = args.ca_key_path ? await authorizeReadPath(args.ca_key_path) : null;
    const caCertPath = args.ca_cert_path ? await authorizeReadPath(args.ca_cert_path) : null;
    const upstream = args.upstream_proxy == null
      ? null
      : await prepareAuthorizedUpstreamProxy(args.upstream_proxy);
    const stateBefore = await readState();
    const domains = args.domains?.length
      ? args.domains
      : (stateBefore?.domains?.length ? stateBefore.domains : ['*']);
    const started = await engine.start({
      port: port ?? PROXY_PORT_DEFAULT,
      tlsPassthrough: tls_passthrough,
      maxBodySize: max_body_size,
      allowRemote: allow_remote,
      allowedRemoteIps: allowed_remote_ips,
      remoteAccessTtlSeconds: remote_access_ttl_seconds,
      captureBodyMode: capture_body_mode,
      enableSocks: enable_socks,
      caKeyPath,
      caCertPath,
      upstreamProxyConfig: upstream?.proxyConfig ?? null,
      upstreamProxyPublicConfig: upstream?.publicConfig ?? null,
    });
    // Replay valid rules and surface invalid persisted entries instead of
    // silently claiming that every rule was restored.
    try {
      const persisted = await loadRules();
      const failures = [];
      for (const r of persisted) {
        try { await engine.registerRule(r); }
        catch (error) { failures.push({ rule_id: r.rule_id ?? r.id ?? null, error: error?.message ?? String(error) }); }
      }
      if (failures.length) engine.diagnostics.push({ kind: 'rule-replay-failures', timestamp: Date.now(), failures });
    } catch (error) {
      engine.diagnostics.push({ kind: 'rule-load-error', timestamp: Date.now(), error: error?.message ?? String(error) });
    }

    await patchState({ pid: process.pid, proxy_port: engine.port, started_at: new Date().toISOString() });
    if (!auto_setup) return { ...started, auto_setup: false };

    if (!caCertPath) await ensureCA();
    const activeCaCert = caCertPath ?? CA_CERT;
    const hostCertificate = trust_host_ca
      ? await setupHostCertificate(activeCaCert)
      : await getHostCertificateStatus(activeCaCert);
    const broadRouting = domains.includes('*');
    if ((trust_host_ca && (!hostCertificate.ok || !hostCertificate.trusted))
      || (!hostCertificate.trusted && broadRouting)) {
      await engine.stop();
      const error = new Error(hostCertificate.recovery ?? hostCertificate.error
        ?? 'Broad routing requires the proxy CA to be trusted in the user login keychain. Enable trust_host_ca or supply narrow domains.');
      error.code = hostCertificate.code ?? 'HOST_CA_NOT_TRUSTED';
      throw error;
    }

    let routing;
    try {
      routing = await applyPacRouting({
        domains,
        networkService: network_service,
        pacPort: pac_port ?? PAC_PORT_DEFAULT,
        proxyPort: engine.port,
        pacServer,
      });
    } catch (error) {
      try { await clearPacRouting({ pacServer }); } catch { /* preserve setup error */ }
      await engine.stop();
      await patchState({ proxy_port: null, routing_active: false, setup_error: error.message });
      throw error;
    }
    const trust = await trustCaOnSimulators(activeCaCert);
    const restartReport = trust.trusted?.length
      ? await restartSimApps({})
      : { restarted: [], skipped: 'certificate was not imported on a booted simulator' };
    const watcher = await start_sim_watcher({ interval: 5000 });
    return { ...started, auto_setup: true, host_certificate: hostCertificate, routing, trust, restart: restartReport, watcher };
  }

  async function stop_proxy() {
    let routingCleanupError = null;
    try { await clearPacRouting({ pacServer }); }
    catch (error) { routingCleanupError = error?.message ?? String(error); }
    const out = await engine.stop();
    await stop_sim_watcher();
    await onboardingPortal.stop();
    await reverseProxies.stopAll();
    await patchState({
      proxy_port: null,
      stopped_at: new Date().toISOString(),
      ...(routingCleanupError ? { cleanup_error: routingCleanupError } : {}),
    });
    return routingCleanupError
      ? { ...out, status: 'stopped_with_routing_warning', routing_cleanup_error: routingCleanupError }
      : out;
  }

  async function set_proxy_routing(args = {}) {
    await ensureProxyRunning();
    const { domains, network_service, pac_port } = args;
    if (!Array.isArray(domains) || domains.length === 0) {
      throw new Error('domains must be a non-empty array.');
    }
    const routing = await applyPacRouting({
      domains, networkService: network_service,
      pacPort: pac_port ?? PAC_PORT_DEFAULT,
      proxyPort: engine.port, pacServer,
    });
    return { status: 'routing_on', ...routing };
  }

  async function clear_proxy_routing(args = {}) {
    const out = await clearPacRouting({ pacServer, networkService: args.network_service });
    return { status: 'routing_off', ...out };
  }

  async function trust_ca_on_simulators_tool() {
    return await trustCaOnSimulators(await activeCaCertificate());
  }

  async function setup_simulator_certificate(args = {}) {
    return setupSimulatorCertificates({
      cert_path: await activeCaCertificate(),
      scope: args.scope ?? 'booted',
      device_ids: args.device_ids,
      developer_dir: args.developer_dir,
      boot_shutdown: args.boot_shutdown ?? false,
      restart_apps: args.restart_apps ?? true,
      bundle_id: args.bundle_id,
    });
  }

  async function setup_xcode_preview_certificate(args = {}) {
    return setupXcodePreviewCertificate({
      cert_path: await activeCaCertificate(),
      scope: args.scope ?? 'booted',
      preview_device_set: args.preview_device_set,
      developer_dir: args.developer_dir,
      boot_shutdown: args.boot_shutdown ?? false,
      restart_apps: args.restart_apps ?? true,
      bundle_id: args.bundle_id,
    });
  }

  async function get_certificate_status(args = {}) {
    const caCert = await activeCaCertificate();
    const [certificate, preflight, host, previews] = await Promise.all([
      inspectCertificate(caCert, { stage_der: false }),
      simulatorPreflight({ developer_dir: args.developer_dir }),
      getHostCertificateStatus(caCert),
      discoverXcodePreviewDeviceSets({}),
    ]);
    let simulators = [];
    if (preflight.ok) {
      simulators = (await listSimulators({ scope: 'booted', developer_dir: preflight.developer_dir })).simulators;
    }
    const expiresInDays = certificate.ok
      ? Math.max(0, Math.floor((Date.parse(certificate.valid_to) - Date.now()) / 86_400_000))
      : null;
    return {
      generated: certificate.ok,
      ca_cert: caCert,
      certificate,
      expires_in_days: expiresInDays,
      rotation_recommended: expiresInDays != null && expiresInDays <= 30,
      host,
      xcode: preflight,
      booted_simulators: simulators,
      xcode_previews: previews,
      verification: 'Per-device TLS trust currently uses simctl trusted-root import success; end-to-end URLSession probing is not bundled yet.',
    };
  }

  async function start_device_onboarding(args = {}) {
    await ensureProxyRunning();
    if (!engine.allowRemote) {
      const error = new Error('Physical-device onboarding requires a time-limited LAN proxy allowlist. Stop it and call start_proxy with allow_remote=true and allowed_remote_ips, then retry.');
      error.code = 'REMOTE_PROXY_ACCESS_DISABLED';
      error.recovery = ['Stop the proxy', 'Restart with allow_remote=true, the device IP/CIDR in allowed_remote_ips, and a short remote_access_ttl_seconds'];
      throw error;
    }
    const caCert = await activeCaCertificate();
    return onboardingPortal.start({
      certPath: caCert,
      proxyPort: engine.port,
      port: args.portal_port ?? 0,
      ttlMs: (args.ttl_seconds ?? 900) * 1000,
    });
  }

  async function stop_device_onboarding() {
    return onboardingPortal.stop();
  }

  async function diagnose_ios_capture(args = {}) {
    const [certificate, state] = await Promise.all([get_certificate_status(args), readState()]);
    const checks = {
      proxy_running: engine.isRunning(),
      recording: engine.recording,
      routing_active: state?.routing_active ?? false,
      host_ca_trusted: certificate.host?.trusted ?? false,
      simulator_tooling_ready: certificate.xcode?.ok ?? false,
      booted_simulators: certificate.booted_simulators?.length ?? 0,
      captured_flows: engine.flows.size,
    };
    const diagnostics = engine.diagnostics.slice(-30);
    const tlsFailures = diagnostics.filter((item) => item.kind === 'tls-client-error');
    const passthroughs = diagnostics.filter((item) => item.kind === 'tls-passthrough-opened');
    const findings = [];
    if (!checks.proxy_running) findings.push(finding('PROXY_NOT_RUNNING', 'Start capture before diagnosing an iOS client.', 'error'));
    if (!checks.recording) findings.push(finding('RECORDING_PAUSED', 'Proxying is active but flows are not being recorded.', 'warning'));
    if (!checks.routing_active) findings.push(finding('ROUTING_INACTIVE', 'Automatic PAC routing is not active. Confirm the Simulator/device proxy configuration.', 'warning'));
    if (!checks.host_ca_trusted) findings.push(finding('HOST_CA_UNTRUSTED', 'The proxy CA is not trusted in the current macOS login keychain.', 'warning'));
    if (!checks.simulator_tooling_ready) findings.push(finding(certificate.xcode?.code ?? 'SIMULATOR_TOOLING_UNAVAILABLE', certificate.xcode?.recovery ?? 'Select a full Xcode installation with Command Line Tools.', 'error'));
    if (checks.simulator_tooling_ready && checks.booted_simulators === 0) findings.push(finding('NO_BOOTED_SIMULATOR', 'Boot the target Simulator, then run setup_simulator_certificate.', 'warning'));
    if (tlsFailures.length) findings.push(finding('TLS_HANDSHAKE_FAILURE', 'The client reached the proxy but TLS failed. Check CA trust first, then certificate pinning or a custom trust evaluator.', 'error', { count: tlsFailures.length }));
    if (passthroughs.length) findings.push(finding('TLS_PASSTHROUGH_ACTIVE', 'Some TLS connections were intentionally passed through without decryption.', 'info', { count: passthroughs.length }));
    if (checks.proxy_running && checks.recording && engine.flows.size === 0 && tlsFailures.length === 0) {
      findings.push(finding('NO_REQUEST_OBSERVED', 'No request reached the proxy. Check URLSession cache, localhost bypass, VPN, Flutter/custom proxy behavior, or URLSessionWebSocketTask SOCKS routing.', 'warning'));
    }
    if (args.hostname && engine.tlsPassthrough.some((value) => hostnameMatches(value, args.hostname))) {
      findings.push(finding('HOSTNAME_PASSTHROUGH', `${args.hostname} is configured for TLS passthrough.`, 'warning'));
    }
    return {
      ok: !findings.some((item) => item.severity === 'error'),
      checks,
      hostname: args.hostname ?? null,
      findings,
      verification: 'This diagnostic distinguishes observed proxy/TLS failures. Full system trust verification requires the optional Simulator URLSession probe.',
    };
  }

  async function create_reverse_proxy(args = {}) {
    return reverseProxies.create(args);
  }

  async function list_reverse_proxies() {
    return { reverse_proxies: reverseProxies.list() };
  }

  async function remove_reverse_proxy(args = {}) {
    return reverseProxies.remove(args.id);
  }

  async function setup_host_certificate() {
    return setupHostCertificate(await activeCaCertificate());
  }

  async function remove_host_certificate() {
    return removeHostCertificate(await activeCaCertificate());
  }

  async function rotate_certificate_authority(args = {}) {
    if (engine.isRunning()) {
      const error = new Error('Stop the proxy before rotating its certificate authority.');
      error.code = 'CA_ROTATION_REQUIRES_STOPPED_PROXY';
      throw error;
    }
    const hostRemoval = args.remove_host_trust === false
      ? { removed: false, skipped: true }
      : await removeHostCertificate(CA_CERT);
    const rotation = await rotateCA({ archivePrivateKey: args.archive_private_key === true });
    engine.caCertPath = CA_CERT;
    return {
      ...rotation,
      old_host_trust: hostRemoval,
      certificate: await inspectCertificate(CA_CERT, { stage_der: false }),
      trust_requires_refresh: rotation.rotated,
      next_actions: rotation.rotated
        ? ['Re-run setup_host_certificate if host trust is needed', 'Re-run Simulator/device certificate setup']
        : [],
    };
  }

  async function restart_sim_apps_tool(args = {}) {
    return await restartSimApps({ udid: args.udid, bundle_id: args.bundle_id });
  }

  async function get_proxy_status() {
    const [state, pid, storage] = await Promise.all([
      readState(), readPidFile(), engine.sessionStore.storageStatus(),
    ]);
    return {
      running: engine.isRunning(),
      port: engine.port,
      allow_remote: engine.allowRemote,
      socks_enabled: engine.socksEnabled ?? false,
      remote_access: engine.remoteAccessStatus(),
      mode,
      ca_cert: engine.caCertPath ?? CA_CERT,
      mock_rules_count: engine.mockRules.size,
      flows_count: engine.flows.size,
      diagnostics_count: engine.diagnostics.length,
      recording: engine.recording,
      routing_active: state?.routing_active ?? false,
      network_service: state?.network_service ?? null,
      pac_url: state?.pac_url ?? null,
      daemon_pid: pid,
      state_pid: state?.pid ?? null,
      domains: state?.domains ?? [],
      tls_passthrough: engine.tlsPassthrough,
      simulator_watcher: simWatchStop ? 'running' : 'stopped',
      recent_simulator_events: simWatcherEvents.slice(-10),
      breakpoints: engine.breakpoints.getStatus(),
      storage,
      capture_storage_policy: engine.captureBodyMode,
      persistence_queue_depth: engine.flowPersistence.size,
      persistence_queue_limit: engine.maxPendingPersistence,
      persistence_queue_high_water_mark: engine.persistenceHighWaterMark,
      persistence_backpressure_waits: engine.persistenceBackpressureWaits,
      persistence_health: engine.persistenceHealth(),
      upstream_proxy: engine.upstreamProxyPublicConfig ?? null,
    };
  }

  async function prepareAuthorizedUpstreamProxy(input) {
    const settings = Array.isArray(input) ? input : [input];
    const authorizedCaPaths = [];
    for (const setting of settings) {
      if (!setting || typeof setting !== 'object' || Array.isArray(setting)) continue;
      const descriptors = setting.additionalTrustedCAs
        ?? setting.extra_ca_certificates
        ?? setting.extraCACertificates
        ?? [];
      for (const descriptor of descriptors) {
        const requested = descriptor?.certPath ?? descriptor?.cert_path;
        if (requested) authorizedCaPaths.push(await authorizeReadPath(requested));
      }
    }
    const normalizedInput = structuredClone(input);
    const normalizedSettings = Array.isArray(normalizedInput) ? normalizedInput : [normalizedInput];
    let index = 0;
    for (const setting of normalizedSettings) {
      if (!setting || typeof setting !== 'object' || Array.isArray(setting)) continue;
      const descriptors = setting.additionalTrustedCAs
        ?? setting.extra_ca_certificates
        ?? setting.extraCACertificates
        ?? [];
      for (const descriptor of descriptors) {
        if (descriptor?.certPath) descriptor.certPath = authorizedCaPaths[index++];
        else if (descriptor?.cert_path) descriptor.cert_path = authorizedCaPaths[index++];
      }
    }
    return prepareUpstreamProxyConfig(normalizedInput, {
      authorizedCaPaths,
      allowInlineCa: true,
    });
  }

  async function get_version() {
    return { name: 'proxy-mcp', version: SERVER_VERSION, node: process.version, mode };
  }

  async function start_operator_ui(args = {}) {
    const alreadyRunning = operatorUi.status.running;
    const started = await operatorUi.start({ port: args.port });
    return {
      status: alreadyRunning ? 'already_running' : 'started',
      dashboard: { running: started.running, url: started.url, port: started.port },
      // This generated loopback-only code is intentionally returned to
      // the MCP caller so a human can paste it into the read-only dashboard.
      access_code: started.token,
    };
  }

  async function stop_operator_ui() {
    const wasRunning = operatorUi.status.running;
    await operatorUi.stop();
    return { status: wasRunning ? 'stopped' : 'not_running', dashboard: operatorUi.status };
  }

  async function get_operator_ui_status() {
    return { dashboard: operatorUi.status };
  }

  async function toggle_recording(args = {}) {
    return engine.setRecording(args.enabled == null ? !engine.recording : args.enabled);
  }

  async function get_ssl_proxying_list() {
    const state = await readState();
    return {
      include: state?.domains ?? [],
      exclude: engine.tlsPassthrough ?? [],
      routing_active: state?.routing_active ?? false,
    };
  }

  async function enable_ssl_proxying(args = {}) {
    await ensureProxyRunning();
    if (!args.domain) throw new Error('domain is required');
    const state = await readState();
    const domains = [...new Set([...(state?.domains ?? []), args.domain])];
    const routing = await applyPacRouting({
      domains,
      networkService: state?.network_service,
      pacPort: state?.pac_port ?? PAC_PORT_DEFAULT,
      proxyPort: engine.port,
      pacServer,
    });
    return { status: 'enabled', domain: args.domain, de_duplicated: domains.length === (state?.domains?.length ?? 0), routing };
  }

  async function clear_session(args = {}) {
    if (args.session_id && args.session_id !== engine.sessionId) {
      const flows = await allSessionFlows(args.session_id);
      const removed = await engine.sessionStore.purgeSession(args.session_id);
      if (removed) await Promise.all(flows.map((flow) => deleteFlowBodies(flow.id)));
      return { status: removed ? 'cleared' : 'not_found', session_id: args.session_id };
    }
    const cleared = await engine.clearFlows();
    const webSockets = engine.webSocketStore.clear();
    return { status: 'cleared', flows_count: 0, websocket_connections_cleared: webSockets.cleared, ...cleared };
  }

  async function create_capture_session(args = {}) {
    const session = await engine.sessionStore.createSession({
      id: args.session_id,
      name: args.name,
      retention: args.retention,
      metadata: args.metadata,
    });
    if (args.activate) await engine.setActiveSession(session.id, { create: false });
    return { session, active: engine.sessionId === session.id };
  }

  async function list_capture_sessions() {
    return { active_session_id: engine.sessionId, sessions: await engine.sessionStore.listSessions() };
  }

  async function select_capture_session(args = {}) {
    const session = await engine.setActiveSession(args.session_id, { name: args.name, create: args.create ?? true });
    return { status: 'selected', session };
  }

  async function update_capture_session(args = {}) {
    const sessionId = args.session_id ?? engine.sessionId;
    const result = await engine.sessionStore.updateSession({
      sessionId,
      name: args.name,
      retention: args.retention,
      metadata: args.metadata,
      mergeMetadata: args.merge_metadata ?? true,
    });
    await Promise.all((result.retention?.removed_flow_ids ?? []).map((id) => deleteFlowBodies(id)));
    return { status: 'updated', ...result };
  }

  async function export_capture_session(args = {}) {
    const sessionId = args.session_id ?? engine.sessionId;
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const document = await engine.sessionStore.exportSession(sessionId);
    for (const exportedFlow of document.session.flows) {
      const storedFlow = await engine.sessionStore.getFlow({ sessionId, flowId: exportedFlow.id });
      if (!storedFlow) continue;
      if (exportedFlow.request) {
        exportedFlow.request.url = includeSensitive
          ? exportedFlow.request.url
          : redactUrl(exportedFlow.request.url);
      }
      for (const kind of ['request', 'response']) {
        const exported = exportedFlow[kind];
        const stored = storedFlow[kind];
        if (!exported || !stored) continue;
        exported.headers = includeSensitive ? exported.headers : redactHeaders(exported.headers);
        exported.trailers = includeSensitive ? exported.trailers : redactHeaders(exported.trailers);
        if (exported.body_inline != null && !includeSensitive) {
          exported.body_inline = redactBody(exported.body_inline, exported.headers);
        }
        if (stored.body_path && existsSync(stored.body_path)) {
          if (includeSensitive) {
            exported.body_base64 = (await fs.readFile(stored.body_path)).toString('base64');
            exported.body_encoding = 'base64';
          } else {
            exported.body_omitted = true;
            exported.body_omission_reason = 'spilled or binary bodies require include_sensitive=true and the server-level sensitive-data grant';
          }
        }
      }
    }
    document.redacted = !includeSensitive;
    const out = args.path
      ? await authorizeWritePath(args.path)
      : path.join(HAR_EXPORT_DIR, `${sessionId}-${Date.now()}.proxy-mcp-session.json`);
    await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
    await fs.writeFile(out, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    return { path: out, session_id: sessionId, flow_count: document.session.flows.length };
  }

  async function import_capture_session(args = {}) {
    const source = await authorizeReadPath(args.path);
    const stat = await fs.stat(source);
    if (stat.size > 512 * 1024 * 1024) throw new Error('Capture-session import exceeds the 512 MB safety limit.');
    const document = JSON.parse(await fs.readFile(source, 'utf8'));
    const session = await engine.sessionStore.importSession({
      document,
      sessionId: args.session_id,
      name: args.name,
      replace: args.replace ?? false,
    });
    return { status: 'imported', session };
  }

  async function purge_capture_session(args = {}) {
    const sessionId = args.session_id ?? engine.sessionId;
    const existingFlows = await allSessionFlows(sessionId);
    if (args.delete_session) {
      if (sessionId === engine.sessionId && engine.isRunning()) {
        throw new Error('Stop the proxy before deleting the active session.');
      }
      const removed = await engine.sessionStore.purgeSession(sessionId);
      if (removed) await Promise.all(existingFlows.map((flow) => deleteFlowBodies(flow.id)));
      return { status: removed ? 'deleted' : 'not_found', session_id: sessionId };
    }
    const result = await engine.sessionStore.purgeFlows({
      sessionId,
      before_sequence: args.before_sequence,
      older_than_ms: args.older_than_ms,
    });
    await Promise.all((result.purged_flow_ids ?? []).map((id) => deleteFlowBodies(id)));
    return result;
  }

  async function allSessionFlows(sessionId) {
    if (!await engine.sessionStore.getSession(sessionId)) return [];
    const flows = [];
    let cursor = null;
    do {
      const page = await engine.sessionStore.listFlows({ sessionId, cursor, limit: 1000 });
      flows.push(...page.flows);
      cursor = page.next_cursor;
    } while (cursor);
    return flows;
  }

  async function wait_for_flow(args = {}, context = {}) {
    const timeoutMs = args.timeout_ms ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    let cursor = args.cursor ?? null;
    let sinceFlowId = args.since_flow_id ?? null;
    if (!cursor && !sinceFlowId && !args.include_existing) sinceFlowId = engine.flowOrder.at(-1) ?? null;
    do {
      throwIfAborted(context.signal);
      const page = await engine.listDurableFlows({
        session_id: args.session_id,
        cursor,
        since_flow_id: cursor ? undefined : sinceFlowId,
        limit: Math.min(args.limit ?? 100, 1000),
        filters: args,
      });
      const flow = page.flows.find((item) =>
        matchHost(item, args) && matchUrl(item, args) && matchMethod(item, args) && matchStatus(item, args));
      if (flow) return {
        matched: true,
        flow: flowSummary(flow, { includeSensitive: requireSensitiveAccess(args.include_sensitive ?? false) }),
        next_cursor: page.next_cursor,
        snapshot_id: page.snapshot_id,
      };
      if (page.next_cursor) {
        cursor = page.next_cursor;
        sinceFlowId = null;
      } else if (page.flows.length) {
        cursor = null;
        sinceFlowId = page.flows.at(-1).id;
      }
      if (Date.now() >= deadline) break;
      await abortableDelay(Math.min(250, Math.max(10, deadline - Date.now())), context.signal);
    } while (Date.now() < deadline);
    return { matched: false, timed_out: true, timeout_ms: timeoutMs, next_cursor: cursor };
  }

  async function get_diagnostics() {
    return {
      diagnostics: engine.diagnostics.slice(),
      storage: await engine.sessionStore.storageStatus(),
      capture_storage_policy: engine.captureBodyMode,
      persistence_queue_depth: engine.flowPersistence.size,
      persistence_queue_limit: engine.maxPendingPersistence,
      persistence_queue_high_water_mark: engine.persistenceHighWaterMark,
      persistence_backpressure_waits: engine.persistenceBackpressureWaits,
      persistence_health: engine.persistenceHealth(),
    };
  }

  async function list_websocket_connections(args = {}) {
    return engine.webSocketStore.listConnections({
      state: args.state,
      url_contains: args.url_contains,
      limit: args.limit,
      includeSensitive: requireSensitiveAccess(args.include_sensitive ?? false),
    });
  }

  async function get_websocket_connection(args = {}) {
    const connection = engine.webSocketStore.getConnection({
      connectionId: args.connection_id,
      includeSensitive: requireSensitiveAccess(args.include_sensitive ?? false),
    });
    if (!connection) throw new Error(`WebSocket connection not found: ${args.connection_id}`);
    return connection;
  }

  async function get_websocket_messages(args = {}) {
    return engine.webSocketStore.listMessages({
      connectionId: args.connection_id,
      cursor: args.cursor,
      limit: args.limit,
      direction: args.direction,
      contains: args.contains,
      includeSensitive: requireSensitiveAccess(args.include_sensitive ?? false),
    });
  }

  async function export_websocket_transcript(args = {}) {
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const transcript = engine.webSocketStore.exportTranscript({ connectionId: args.connection_id, includeSensitive });
    const out = args.path
      ? await authorizeWritePath(args.path)
      : path.join(HAR_EXPORT_DIR, `websocket-${args.connection_id}-${Date.now()}.json`);
    await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
    await fs.writeFile(out, `${JSON.stringify(transcript, null, 2)}\n`, { mode: 0o600 });
    return { path: out, connection_id: args.connection_id, message_count: transcript.connection?.messages?.length ?? 0, redacted: !includeSensitive };
  }

  async function import_websocket_transcript(args = {}) {
    const source = await authorizeReadPath(args.path);
    const stat = await fs.stat(source);
    if (stat.size > 64 * 1024 * 1024) throw Object.assign(new Error('WebSocket transcript exceeds 64 MB.'), { code: 'WEBSOCKET_IMPORT_TOO_LARGE' });
    const transcript = JSON.parse(await fs.readFile(source, 'utf8'));
    return { status: 'imported', ...engine.webSocketStore.importTranscript(transcript, { replace: args.replace ?? false }) };
  }

  async function plan_websocket_replay(args = {}) {
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const transcript = engine.webSocketStore.exportTranscript({ connectionId: args.connection_id, includeSensitive });
    return buildWebSocketReplayPlan(transcript, { mutations: args.mutations ?? [] });
  }

  // ---- bounded transform plugins ----
  // An early, explicit tool-layer error. The engine re-checks the same
  // predicate so replayed and imported rules cannot bypass this.
  function requireLiveTransformGrant() {
    if (liveTransformGrantEnabled()) return;
    const error = new Error(`Live transform plugins require ${TRANSFORM_PLUGIN_GRANT_ENV}=1 on the server.`);
    error.code = 'TRANSFORM_PLUGINS_NOT_ENABLED';
    error.recovery = [`Set ${TRANSFORM_PLUGIN_GRANT_ENV}=1 only for a trusted local proxy-mcp deployment, then restart the server.`];
    throw error;
  }

  function pluginRuleReferences(pluginId) {
    return engine.listRuleConfigs().filter((rule) => rule.type === 'plugin_transform' && rule.plugin_id === pluginId);
  }

  async function list_transform_plugins(args = {}) {
    return engine.pluginStore.list({ stage: args.stage, enabled: args.enabled });
  }

  async function get_transform_plugin(args = {}) {
    let includeSource = false;
    if (args.include_source === true) {
      if (args.include_sensitive !== true) {
        const error = new Error('Plugin source requires include_sensitive: true in addition to include_source: true.');
        error.code = 'SENSITIVE_ACCESS_REQUIRED';
        error.retryable = false;
        error.recovery = ['Pass include_sensitive: true along with include_source: true to request plugin source.'];
        throw error;
      }
      includeSource = requireSensitiveAccess(true);
    }
    const plugin = await engine.pluginStore.get(args.plugin_id, { includeSource });
    if (!plugin) throw Object.assign(new Error(`Transform plugin not found: ${args.plugin_id}`), { code: 'PLUGIN_NOT_FOUND' });
    return { plugin };
  }

  async function upsert_transform_plugin(args = {}) {
    if (args.enabled === true && ['request', 'response'].includes(args.stage)) requireLiveTransformGrant();
    const existing = await engine.pluginStore.get(args.plugin_id);
    if (existing && pluginRuleReferences(args.plugin_id).length && existing.stage !== args.stage) {
      throw Object.assign(new Error('Remove rules that reference this plugin before changing its stage.'), { code: 'PLUGIN_IN_USE' });
    }
    const plugin = await engine.pluginStore.upsert({
      id: args.plugin_id,
      name: args.name,
      description: args.description,
      stage: args.stage,
      enabled: args.enabled ?? existing?.enabled ?? false,
      source: args.source,
    });
    return { status: existing ? 'updated' : 'created', plugin };
  }

  async function remove_transform_plugin(args = {}) {
    const rules = pluginRuleReferences(args.plugin_id);
    if (rules.length) {
      throw Object.assign(new Error('Remove rules that reference this plugin before deleting it.'), {
        code: 'PLUGIN_IN_USE',
        details: { rule_ids: rules.map((rule) => rule.rule_id) },
      });
    }
    return { status: 'removed', ...(await engine.pluginStore.remove(args.plugin_id)) };
  }

  async function set_transform_plugin_enabled(args = {}) {
    const plugin = await engine.pluginStore.get(args.plugin_id);
    if (!plugin) throw Object.assign(new Error(`Transform plugin not found: ${args.plugin_id}`), { code: 'PLUGIN_NOT_FOUND' });
    if (args.enabled && ['request', 'response'].includes(plugin.stage)) requireLiveTransformGrant();
    if (!args.enabled) {
      const rules = pluginRuleReferences(args.plugin_id).filter((rule) => rule.enabled);
      if (rules.length) {
        throw Object.assign(new Error('Disable or remove active rules that reference this plugin first.'), {
          code: 'PLUGIN_IN_USE', details: { rule_ids: rules.map((rule) => rule.rule_id) },
        });
      }
    }
    return { status: args.enabled ? 'enabled' : 'disabled', plugin: await engine.pluginStore.enable(args.plugin_id, args.enabled) };
  }

  async function test_transform_plugin(args = {}) {
    if ((args.source == null) === (args.plugin_id == null)) {
      const error = new Error('Provide exactly one of plugin_id or source.');
      error.code = 'PLUGIN_TEST_SOURCE_REQUIRED';
      throw error;
    }
    if (args.source != null) {
      return { output: await executeTransform({ source: args.source, input: args.input }) };
    }
    const plugin = await engine.pluginStore.get(args.plugin_id, { includeSource: true });
    if (!plugin) throw Object.assign(new Error(`Transform plugin not found: ${args.plugin_id}`), { code: 'PLUGIN_NOT_FOUND' });
    return { plugin_id: plugin.id, stage: plugin.stage, output: await executeTransform({ source: plugin.source, input: args.input }) };
  }

  async function create_transform_plugin_rule(args = {}) {
    requireLiveTransformGrant();
    await ensureProxyRunning();
    const plugin = await engine.pluginStore.get(args.plugin_id);
    if (!plugin) throw Object.assign(new Error(`Transform plugin not found: ${args.plugin_id}`), { code: 'PLUGIN_NOT_FOUND' });
    if (!['request', 'response'].includes(plugin.stage)) {
      throw Object.assign(new Error('Live rules require a request or response plugin.'), { code: 'PLUGIN_STAGE_MISMATCH' });
    }
    const url = args.url ?? args.url_pattern;
    if (!url) throw new Error('url or url_pattern is required');
    const rule = await engine.registerRule({
      ...args,
      type: 'plugin_transform',
      plugin_stage: plugin.stage,
      rule_id: args.rule_id ?? stableRuleId('plugin', `${args.plugin_id}:${url}`),
      ...ruleUrlMatchers(url, args),
    });
    await persistRules();
    return { status: 'registered', rule };
  }

  async function transform_websocket_transcript(args = {}) {
    const plugin = await engine.pluginStore.get(args.plugin_id);
    if (!plugin) throw Object.assign(new Error(`Transform plugin not found: ${args.plugin_id}`), { code: 'PLUGIN_NOT_FOUND' });
    if (plugin.stage !== 'websocket_offline') {
      throw Object.assign(new Error('This tool requires a websocket_offline plugin.'), { code: 'PLUGIN_STAGE_MISMATCH' });
    }
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const transcript = engine.webSocketStore.exportTranscript({ connectionId: args.connection_id, includeSensitive });
    const messages = transcript.connection?.messages ?? [];
    const maximum = Math.min(args.max_messages ?? 100, 1000);
    const mutations = [];
    for (const message of messages.slice(0, maximum)) {
      const output = await engine.pluginStore.execute({
        id: plugin.id,
        stage: 'websocket_offline',
        input: {
          stage: 'websocket_offline',
          connection: { id: transcript.connection.id, request: transcript.connection.request },
          message,
        },
      });
      mutations.push(normalizeOfflineWebSocketMutation(message.sequence, output));
    }
    const plan = buildWebSocketReplayPlan(transcript, { mutations });
    const out = args.path
      ? await authorizeWritePath(args.path)
      : path.join(HAR_EXPORT_DIR, `websocket-${args.connection_id}-${plugin.id}-${Date.now()}.replay.json`);
    await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
    await fs.writeFile(out, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
    return {
      path: out,
      plugin_id: plugin.id,
      connection_id: args.connection_id,
      processed: Math.min(messages.length, maximum),
      truncated: messages.length > maximum,
      live_injection_supported: false,
    };
  }

  // ---- capture setup adapters and capability boundaries ----
  async function list_capture_adapters() { return { adapters: listCaptureAdapters() }; }
  async function get_capture_adapter(args = {}) { return { adapter: getCaptureAdapterDescriptor(args.adapter_id) }; }
  async function preflight_capture_adapter(args = {}) {
    return preflightCaptureAdapter(args.adapter_id, { timeout_ms: args.timeout_ms });
  }
  async function build_capture_setup_plan(args = {}) {
    return buildCaptureSetupPlan(args.adapter_id, args.options ?? {});
  }
  async function get_extended_capabilities() {
    return {
      protocols: protocolCapabilities(),
      capture_adapters: captureAdapterCapabilitySummary(),
      upstream_proxy: upstreamProxyCapabilitySummary(),
      websocket_engine: mockttpWebSocketCapabilitySummary(),
      transform_plugins: {
        sandbox: 'QuickJS',
        stages: ['request', 'response', 'websocket_offline'],
        live_activation_granted: liveTransformGrantEnabled(),
        host_api_access: false,
      },
    };
  }

  // ---- mock rules ----
  async function create_map_local(args = {}) {
    await ensureProxyRunning();
    args = await authorizeRulePaths({ ...args });
    args.rule_id ??= stableRuleId('map-local', args.url_pattern ?? args.url);
    Object.assign(args, ruleUrlMatchers(args.url, args));
    args.type = 'map_local';
    if (!args.url_pattern) throw new Error('url or url_pattern is required');
    if (!args.body_file && args.body == null && args.body_inline == null) args.body_inline = '';
    if (args.body_file) args.body_file = await authorizeReadPath(args.body_file);
    const rule = await engine.registerRule(args);
    await persistRules();
    return { status: 'registered', ...rule };
  }

  async function create_map_remote(args = {}) {
    await ensureProxyRunning();
    args = await authorizeRulePaths({ ...args });
    const from = args.from_url ?? args.url;
    if (!from || !args.to_url) throw new Error('from_url and to_url are required');
    const rule = await engine.registerRule({
      ...args,
      type: 'map_remote',
      rule_id: args.rule_id ?? stableRuleId('map-remote', `${from}->${args.to_url}`),
      ...ruleUrlMatchers(from, args),
    });
    await persistRules();
    return { status: 'registered', ...rule };
  }

  async function create_blacklist(args = {}) {
    await ensureProxyRunning();
    args = await authorizeRulePaths({ ...args });
    const url = args.url ?? args.url_pattern;
    if (!url) throw new Error('url is required');
    const rule = await engine.registerRule({
      ...args,
      type: 'blacklist',
      rule_id: args.rule_id ?? stableRuleId('blacklist', url),
      ...ruleUrlMatchers(url, args),
      status: args.status ?? 403,
    });
    await persistRules();
    return { status: 'registered', ...rule };
  }

  async function create_network_condition(args = {}) {
    await ensureProxyRunning();
    args = await authorizeRulePaths({ ...args });
    const presets = {
      offline: { fault: 'timeout', delay_ms: 0 },
      very_bad: { delay_ms: 2000 }, edge: { delay_ms: 1000 },
      '3g': { delay_ms: 500 }, lte: { delay_ms: 100 }, wifi: { delay_ms: 30 },
    };
    const preset = args.profile ? presets[args.profile] : null;
    if (args.profile && !preset) throw new Error(`unknown network profile: ${args.profile}`);
    const url = args.url ?? '*';
    const rule = await engine.registerRule({
      ...args,
      ...preset,
      delay_ms: args.delay_ms ?? preset?.delay_ms ?? 0,
      fault: args.fault ?? preset?.fault ?? null,
      type: 'network_condition',
      rule_id: args.rule_id ?? stableRuleId('network', `${url}:${args.profile ?? args.delay_ms ?? args.fault}`),
      ...ruleUrlMatchers(url, args),
    });
    await persistRules();
    return {
      status: 'registered',
      rule,
      fidelity: 'request-level latency/failure simulation; bandwidth and packet-level shaping are not provided by the current HTTP engine',
    };
  }

  async function create_no_cache_rule(args = {}) {
    return create_network_condition({
      ...args,
      rule_id: args.rule_id ?? stableRuleId('no-cache', args.url ?? '*'),
      request_transform: {
        update_headers: {
          'if-match': null,
          'if-none-match': null,
          'if-modified-since': null,
          'if-unmodified-since': null,
        },
      },
      response_transform: {
        update_headers: {
          'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
          pragma: 'no-cache', expires: '0',
        },
      },
    });
  }

  async function create_breakpoint(args = {}) {
    await ensureProxyRunning();
    const url = args.url ?? args.url_pattern;
    if (!url) throw new Error('url or url_pattern is required');
    const rule = await engine.registerRule({
      ...args,
      type: 'breakpoint',
      rule_id: args.rule_id ?? stableRuleId('breakpoint', `${url}:${args.direction ?? 'request'}`),
      ...ruleUrlMatchers(url, args),
    });
    await persistRules();
    return { status: 'registered', rule };
  }

  async function list_pending_breakpoints(args = {}) {
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    return {
      breakpoints: engine.breakpoints.listPending({
        ruleId: args.rule_id,
        direction: args.direction,
        includeSensitive,
      }),
      status: engine.breakpoints.getStatus(),
    };
  }

  async function get_pending_breakpoint(args = {}) {
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const breakpoint = engine.breakpoints.getPending(args.breakpoint_id, { includeSensitive });
    if (!breakpoint) {
      const error = new Error(`Breakpoint ${args.breakpoint_id} is not pending.`);
      error.code = 'BREAKPOINT_NOT_PENDING';
      error.recovery = ['Call list_pending_breakpoints to get an active breakpoint ID.'];
      throw error;
    }
    return { breakpoint };
  }

  async function resolve_breakpoint(args = {}) {
    const outcome = engine.breakpoints.resolve(args.breakpoint_id, {
      action: args.action,
      ...(args.changes ? { changes: args.changes } : {}),
      ...(args.response ? { response: args.response } : {}),
    });
    return { status: 'resolved', outcome };
  }

  async function cancel_breakpoint(args = {}) {
    const outcome = engine.breakpoints.cancel(args.breakpoint_id, {
      reason: args.reason,
      action: args.action,
    });
    return { status: 'cancelled', outcome };
  }

  async function get_breakpoint_history(args = {}) {
    return {
      history: engine.breakpoints.getHistory({
        limit: args.limit,
        ruleId: args.rule_id,
        direction: args.direction,
        outcome: args.outcome,
      }),
    };
  }

  async function list_rules() {
    return { rules: engine.listRuleConfigs() };
  }

  async function remove_rule(args = {}) {
    const ok = await engine.removeRule(args.rule_id);
    await persistRules();
    return { status: ok ? 'removed' : 'not_found', rule_id: args.rule_id };
  }

  async function update_rule(args = {}) {
    const { rule_id, patch = {} } = args;
    const rule = await engine.updateRule(rule_id, await authorizeRulePaths(patch));
    await persistRules();
    return { status: 'updated', rule };
  }

  async function set_rule_enabled(args = {}) {
    const rule = await engine.setRuleEnabled(args.rule_id, args.enabled);
    await persistRules();
    return { status: args.enabled ? 'enabled' : 'disabled', rule };
  }

  async function set_rule_priority(args = {}) {
    const rule = await engine.setRulePriority(args.rule_id, args.priority);
    await persistRules();
    return { status: 'reprioritized', rule };
  }

  async function reorder_rules(args = {}) {
    const rules = await engine.reorderRules(args.rule_ids);
    await persistRules();
    return { status: 'reordered', rules };
  }

  async function test_rule(args = {}) {
    if (args.rule_id) return engine.testRuleMatch(args.rule_id, args.request ?? {});
    return engine.explainRuleMatch(args.request ?? {});
  }

  async function clear_rules_tool() {
    await engine.clearRules();
    await persistRules();
    return { status: 'cleared' };
  }

  async function export_rules(args = {}) {
    const outputPath = args.path ? await authorizeWritePath(args.path) : undefined;
    const dest = await exportRulesTo(engine.listRuleConfigs(), outputPath);
    return { path: dest, count: engine.listRuleConfigs().length };
  }

  async function import_rules(args = {}) {
    await ensureProxyRunning();
    if (!args.path) throw new Error('path is required');
    const sourcePath = await authorizeReadPath(args.path);
    const rules = await importRulesFrom(sourcePath);
    if (args.replace) await engine.clearRules();
    const registered = [];
    const failed = [];
    for (const r of rules) {
      try { registered.push(await engine.registerRule(await authorizeRulePaths(r))); }
      catch (e) { failed.push({ rule_id: r.rule_id, error: e?.message ?? String(e) }); }
    }
    await persistRules();
    return { registered: registered.length, failed };
  }

  // ---- flows ----
  function matchHost(flow, args) {
    const host = flow.request?.hostname ?? safeHostname(flow.request?.url) ?? '';
    if (args.host_equals != null) return host === args.host_equals;
    if (args.host_regex != null) return safeRegex(args.host_regex).test(host);
    if (args.host_filter != null) return host.includes(args.host_filter);
    if (args.host_contains != null) return host.includes(args.host_contains);
    if (args.domain != null) return host.includes(args.domain); // back-compat
    return true;
  }
  function matchUrl(flow, args) {
    const url = flow.request?.url ?? '';
    if (args.url_equals != null) return url === args.url_equals;
    if (args.url_regex != null) return safeRegex(args.url_regex).test(url);
    if (args.url_contains != null) return url.includes(args.url_contains);
    return true;
  }
  function matchMethod(flow, args) {
    const method = args.method ?? args.method_filter;
    if (!method) return true;
    return (flow.request?.method ?? '').toUpperCase() === method.toUpperCase();
  }
  function matchStatus(flow, args) {
    const s = flow.response?.statusCode ?? -1;
    if (args.status_filter != null) {
      const statuses = Array.isArray(args.status_filter) ? args.status_filter : [args.status_filter];
      if (!statuses.includes(s)) return false;
    }
    if (args.status_min != null && s < args.status_min) return false;
    if (args.status_max != null && s > args.status_max) return false;
    return true;
  }

  async function get_flows(args = {}) {
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    if (args.cursor || args.since_flow_id || args.session_id) {
      const page = await engine.listDurableFlows({
        session_id: args.session_id,
        cursor: args.cursor,
        since_flow_id: args.since_flow_id,
        limit,
        filters: args,
      });
      const filtered = page.flows
        .filter((flow) => matchHost(flow, args) && matchUrl(flow, args) && matchMethod(flow, args) && matchStatus(flow, args))
        .map((flow) => flowSummary(flow, { includeSensitive }));
      return {
        flows: filtered,
        session: page.session,
        next_cursor: page.next_cursor,
        snapshot_id: page.snapshot_id,
        has_more: page.has_more,
        order: 'oldest_first',
      };
    }
    const matching = [];
    for (let i = engine.flowOrder.length - 1; i >= 0; i--) {
      const f = engine.flows.get(engine.flowOrder[i]);
      if (!f) continue;
      if (!matchHost(f, args)) continue;
      if (!matchUrl(f, args)) continue;
      if (!matchMethod(f, args)) continue;
      if (!matchStatus(f, args)) continue;
      matching.push(f);
    }
    const items = matching.slice(offset, offset + limit)
      .map((flow) => flowSummary(flow, { includeSensitive }));
    return { flows: items, offset, limit, total: matching.length, has_more: matching.length > offset + items.length };
  }

  async function get_flow_detail(args = {}) {
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const f = await engine.getDurableFlow(args.flow_id, args.session_id);
    if (!f) throw new Error(`flow not found: ${args.flow_id}`);
    const bodyMode = args.body_mode ?? (args.full_body ? 'full' : 'preview');
    const detail = flowDetailForReturn(f, {
      full: bodyMode === 'full', includeSensitive,
    });
    if (bodyMode === 'full') {
      for (const [returned, stored] of [[detail.request, f.request], [detail.response, f.response]]) {
        if (!returned || returned.body_inline != null) continue;
        if (stored?.body_base64 != null) {
          if (includeSensitive) {
            returned.body_base64 = stored.body_base64;
            returned.body_encoding = 'base64';
          } else {
            returned.body_omitted = true;
            returned.body_omission_reason = 'binary body requires include_sensitive=true and the server-level sensitive-data grant';
          }
          continue;
        }
        if (!stored?.body_path) continue;
        const body = await fs.readFile(stored.body_path);
        if (stored.body_encoding === 'binary') {
          if (includeSensitive) {
            returned.body_base64 = body.toString('base64');
            returned.body_encoding = 'base64';
          } else {
            returned.body_omitted = true;
            returned.body_omission_reason = 'binary body requires include_sensitive=true and the server-level sensitive-data grant';
          }
        } else {
          const text = body.toString('utf8');
          returned.body_inline = includeSensitive ? text : redactBody(text, stored.headers);
        }
      }
    }
    if (bodyMode === 'none') {
      for (const part of [detail.request, detail.response]) {
        if (!part) continue;
        delete part.body_inline;
        delete part.body_path;
        delete part.body_base64;
        delete part.body_omitted;
        delete part.body_omission_reason;
      }
    }
    return detail;
  }

  async function filter_flows(args = {}) {
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const conditions = Array.isArray(args.conditions) ? args.conditions : [];
    const combination = (args.combination ?? 'AND').toUpperCase();
    if (conditions.length === 0) throw new Error('conditions must be a non-empty array');
    const pageSize = args.limit ?? 50;
    let sourceFlows;
    let page = null;
    if (args.session_id || args.cursor || args.since_flow_id) {
      page = await engine.listDurableFlows({
        session_id: args.session_id,
        cursor: args.cursor,
        since_flow_id: args.since_flow_id,
        limit: pageSize,
      });
      sourceFlows = page.flows;
    } else {
      sourceFlows = engine.flowOrder.slice().reverse().map((id) => engine.flows.get(id)).filter(Boolean);
    }
    const results = [];
    for (const flow of sourceFlows) {
      if (results.length >= pageSize) break;
      const checks = conditions.map((condition) => matchFlowCondition(flow, condition));
      const matches = combination === 'OR' ? checks.some(Boolean) : checks.every(Boolean);
      if (matches) results.push(flowSummary(flow, { includeSensitive }));
    }
    return {
      flows: results,
      combination,
      conditions_count: conditions.length,
      ...(page ? {
        session: page.session,
        next_cursor: page.next_cursor,
        snapshot_id: page.snapshot_id,
        has_more: page.has_more,
        order: 'oldest_first',
      } : { order: 'newest_first' }),
    };
  }

  async function export_flow_curl(args = {}) {
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const flow = await engine.getDurableFlow(args.flow_id, args.session_id);
    if (!flow?.request) throw new Error(`flow not found: ${args.flow_id}`);
    const redactedFields = [];
    const headers = includeSensitive ? flow.request.headers : redactHeaders(flow.request.headers, redactedFields);
    const url = includeSensitive ? flow.request.url : redactUrl(flow.request.url, redactedFields);
    const parts = ['curl', '-X', shellQuote(flow.request.method ?? 'GET'), shellQuote(url)];
    for (const [name, value] of Object.entries(headers ?? {})) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) parts.push('-H', shellQuote(`${name}: ${item}`));
    }
    let bodyOmitted = false;
    if (flow.request.body_inline) {
      const body = includeSensitive
        ? flow.request.body_inline
        : redactBody(flow.request.body_inline, flow.request.headers, redactedFields);
      parts.push('--data-raw', shellQuote(body));
    }
    else if (flow.request.body_size > 0) bodyOmitted = true;
    return { curl: parts.join(' '), redacted_fields: [...new Set(redactedFields)], body_omitted: bodyOmitted };
  }

  async function compose_request(args = {}, context = {}) {
    return composeHttpRequest({ ...args, signal: context.signal });
  }

  async function repeat_flow(args = {}, context = {}) {
    const flow = await engine.getDurableFlow(args.flow_id, args.session_id);
    if (!flow?.request) throw flowNotFound(args.flow_id);
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    return composeHttpRequest({
      url: includeSensitive ? flow.request.url : redactUrl(flow.request.url),
      method: flow.request.method,
      headers: includeSensitive ? flow.request.headers : redactHeadersForReplay(flow.request.headers),
      body: includeSensitive
        ? (flow.request.body_inline ?? undefined)
        : (redactBody(flow.request.body_inline, flow.request.headers) ?? undefined),
      timeout_ms: args.timeout_ms,
      signal: context.signal,
    });
  }

  async function edit_and_repeat_flow(args = {}, context = {}) {
    const flow = await engine.getDurableFlow(args.flow_id, args.session_id);
    if (!flow?.request) throw flowNotFound(args.flow_id);
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    return composeHttpRequest({
      url: args.url ?? (includeSensitive ? flow.request.url : redactUrl(flow.request.url)),
      method: args.method ?? flow.request.method,
      headers: {
        ...(includeSensitive ? flow.request.headers : redactHeadersForReplay(flow.request.headers)),
        ...(args.headers ?? {}),
      },
      body: args.body ?? (includeSensitive
        ? (flow.request.body_inline ?? undefined)
        : (redactBody(flow.request.body_inline, flow.request.headers) ?? undefined)),
      json: args.json,
      form: args.form,
      timeout_ms: args.timeout_ms,
      signal: context.signal,
    });
  }

  async function compare_flows(args = {}) {
    const left = await engine.getDurableFlow(args.left_flow_id, args.session_id);
    const right = await engine.getDurableFlow(args.right_flow_id, args.session_id);
    if (!left) throw flowNotFound(args.left_flow_id);
    if (!right) throw flowNotFound(args.right_flow_id);
    return {
      left_flow_id: left.id,
      right_flow_id: right.id,
      ...diffFlows(redactedFlowForComparison(left), redactedFlowForComparison(right)),
    };
  }

  async function export_flow_swift(args = {}) {
    const flow = await engine.getDurableFlow(args.flow_id, args.session_id);
    if (!flow?.request) throw flowNotFound(args.flow_id);
    const safe = structuredClone(flow);
    if (safe.request) {
      safe.request.url = redactUrl(safe.request.url);
      safe.request.headers = redactHeaders(safe.request.headers);
      safe.request.body_inline = redactBody(safe.request.body_inline, safe.request.headers);
    }
    return generateSwiftUrlSession(safe);
  }

  async function export_flow_code(args = {}) {
    const flow = await engine.getDurableFlow(args.flow_id, args.session_id);
    if (!flow?.request) throw flowNotFound(args.flow_id);
    return generateRequestCode(flow, args.language ?? 'javascript');
  }

  async function import_curl(args = {}, context = {}) {
    const request = parseCurlCommand(args.command);
    if (!args.execute) return { executed: false, request };
    return { executed: true, request, result: await composeHttpRequest({ ...request, timeout_ms: args.timeout_ms, signal: context.signal }) };
  }

  async function analyze_capture(args = {}) {
    const sessionId = args.session_id ?? engine.sessionId;
    const flows = await allSessionFlows(sessionId);
    return {
      session_id: sessionId,
      ...analyzeFlows(flows, {
        slow_limit: args.slow_limit,
        group_limit: args.group_limit,
        include_successes: args.include_successes,
      }),
    };
  }

  async function assert_capture(args = {}) {
    const analysis = await analyze_capture(args);
    return { analysis, assertions: evaluateCaptureAssertions(analysis, args.assertions ?? {}) };
  }

  async function inspect_flow_protocol(args = {}) {
    const flow = await engine.getDurableFlow(args.flow_id, args.session_id);
    if (!flow) throw flowNotFound(args.flow_id);
    const kind = args.kind ?? 'res';
    const part = kind === 'req' ? flow.request : flow.response;
    if (!part) throw new Error(`flow has no ${kind === 'req' ? 'request' : 'response'}`);
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    if (part.body_omitted && part.body_inline == null && part.body_base64 == null && !part.body_path) {
      const error = new Error(`The ${kind} body was not retained under the active capture body policy.`);
      error.code = 'BODY_NOT_CAPTURED';
      error.recovery = ['Use capture_body_mode=text for redacted textual protocols', 'Use the explicit sensitive-storage grant and capture_body_mode=all for trusted binary inspection'];
      throw error;
    }
    const buffer = part.body_base64 != null
      ? Buffer.from(part.body_base64, 'base64')
      : part.body_path && existsSync(part.body_path)
        ? await fs.readFile(part.body_path)
        : Buffer.from(part.body_inline ?? '', 'utf8');
    const contentType = String(part.headers?.['content-type'] ?? part.headers?.['Content-Type'] ?? '');
    let format = args.format ?? 'auto';
    if (format === 'auto') {
      if (/grpc/i.test(contentType)) format = 'grpc';
      else if (/protobuf|proto/i.test(contentType)) format = 'protobuf';
      else if (/graphql/i.test(contentType) || /"(?:query|operationName|variables)"\s*:/.test(buffer.toString('utf8', 0, Math.min(buffer.length, 4096)))) format = 'graphql';
      else format = 'unknown';
    }
    if (format === 'graphql') {
      const text = includeSensitive ? buffer.toString('utf8') : redactBody(buffer.toString('utf8'), part.headers);
      return { format, content_type: contentType, redacted: !includeSensitive, ...inspectGraphQLBody(text) };
    }
    if (format === 'grpc') {
      requireProtocolSensitiveAccess(includeSensitive, 'gRPC payload inspection');
      const grpcWebText = /grpc-web-text/i.test(contentType);
      const framed = grpcWebText ? Buffer.from(buffer.toString('ascii').replace(/\s+/g, ''), 'base64') : buffer;
      const parsed = parseGrpcFrames(framed, {
        contentEncoding: part.headers?.['grpc-encoding'] ?? part.headers?.['Grpc-Encoding'] ?? null,
      });
      return {
        format, content_type: contentType, transport: grpcWebText ? 'grpc-web-text' : /grpc-web/i.test(contentType) ? 'grpc-web' : 'grpc', valid: parsed.valid,
        frames: parsed.frames.map(({ payload, ...frame }) => ({
          ...frame,
          payload_preview_base64: payload.subarray(0, 32 * 1024).toString('base64'),
          payload_truncated: payload.length > 32 * 1024,
        })),
        ...(parsed.error ? { error: parsed.error } : {}),
      };
    }
    if (format === 'protobuf') {
      requireProtocolSensitiveAccess(includeSensitive, 'Protobuf decoding');
      const descriptorPath = args.descriptor_path ? await authorizeReadPath(args.descriptor_path) : undefined;
      const protoc = args.protoc_path ? await authorizeReadPath(args.protoc_path) : 'protoc';
      return { format, content_type: contentType, ...(await decodeProtobuf(buffer, {
        protoc, descriptor_path: descriptorPath, message_type: args.message_type, timeout_ms: args.timeout_ms,
      })) };
    }
    return {
      format: 'unknown', content_type: contentType, body_size: buffer.length,
      suggestions: ['Pass format=graphql, protobuf, or grpc explicitly if automatic detection is incorrect.'],
    };
  }

  function requireProtocolSensitiveAccess(includeSensitive, operation) {
    if (includeSensitive) return;
    const error = new Error(`${operation} can expose arbitrary binary application data and requires include_sensitive=true plus the server-level sensitive-data grant.`);
    error.code = 'SENSITIVE_ACCESS_REQUIRED';
    error.retryable = false;
    error.recovery = ['Keep binary payloads opaque', 'Or explicitly grant sensitive access for a trusted temporary session'];
    throw error;
  }

  async function validate_flow_openapi(args = {}) {
    const hasDocument = args.document !== undefined;
    const hasDocumentPath = typeof args.document_path === 'string' && args.document_path.trim() !== '';
    if (hasDocument === hasDocumentPath) {
      const error = new Error('Provide exactly one of document or document_path.');
      error.code = 'OPENAPI_DOCUMENT_SOURCE_REQUIRED';
      error.retryable = false;
      error.recovery = ['Pass a parsed JSON document with document', 'Or pass one authorized JSON file with document_path'];
      throw error;
    }
    const maxDocumentBytes = args.max_document_bytes ?? MAX_OPENAPI_DOCUMENT_BYTES;
    const maxBodyBytes = args.max_body_bytes ?? MAX_OPENAPI_BODY_BYTES;
    let document = args.document;
    let documentSource = 'inline';
    if (hasDocumentPath) {
      const source = await authorizeReadPath(args.document_path);
      const stat = await fs.stat(source);
      if (stat.size > maxDocumentBytes) {
        const error = new Error(`OpenAPI document exceeds ${maxDocumentBytes} bytes.`);
        error.code = 'OPENAPI_DOCUMENT_TOO_LARGE';
        error.retryable = false;
        throw error;
      }
      document = await fs.readFile(source, 'utf8');
      documentSource = 'authorized_path';
    }
    const flow = await engine.getDurableFlow(args.flow_id, args.session_id);
    if (!flow?.request) throw flowNotFound(args.flow_id);
    const validationFlow = await hydrateOpenApiFlowBodies(flow, maxBodyBytes);
    return {
      flow_id: flow.id,
      session_id: args.session_id ?? engine.sessionId ?? null,
      document_source: documentSource,
      limits: { max_document_bytes: maxDocumentBytes, max_body_bytes: maxBodyBytes },
      ...validateOpenApiFlow(document, validationFlow, {
        maxBytes: maxDocumentBytes,
        maxBodyBytes,
        externalDocuments: args.external_documents ?? {},
      }),
    };
  }

  async function validate_capture_openapi(args = {}) {
    const hasDocument = args.document !== undefined;
    const hasDocumentPath = typeof args.document_path === 'string' && args.document_path.trim() !== '';
    if (hasDocument === hasDocumentPath) {
      const error = new Error('Provide exactly one of document or document_path.');
      error.code = 'OPENAPI_DOCUMENT_SOURCE_REQUIRED';
      error.retryable = false;
      error.recovery = ['Pass a parsed JSON document with document', 'Or pass one authorized JSON file with document_path'];
      throw error;
    }
    const maxDocumentBytes = args.max_document_bytes ?? MAX_OPENAPI_DOCUMENT_BYTES;
    const maxBodyBytes = args.max_body_bytes ?? MAX_OPENAPI_BODY_BYTES;
    const maxFlows = Math.min(args.max_flows ?? 100, MAX_OPENAPI_FLOW_BATCH_LIMIT);
    let document = args.document;
    let documentSource = 'inline';
    if (hasDocumentPath) {
      const source = await authorizeReadPath(args.document_path);
      const stat = await fs.stat(source);
      if (stat.size > maxDocumentBytes) {
        const error = new Error(`OpenAPI document exceeds ${maxDocumentBytes} bytes.`);
        error.code = 'OPENAPI_DOCUMENT_TOO_LARGE';
        error.retryable = false;
        throw error;
      }
      document = await fs.readFile(source, 'utf8');
      documentSource = 'authorized_path';
    }
    const sessionId = args.session_id ?? engine.sessionId;
    const page = await engine.sessionStore.listFlows({ sessionId, limit: maxFlows });
    const flows = [];
    for (const flow of page.flows) flows.push(await hydrateOpenApiFlowBodies(flow, maxBodyBytes));
    const result = validateOpenApiFlows(document, flows, {
      maxBytes: maxDocumentBytes,
      maxBodyBytes,
      maxFlows,
      externalDocuments: args.external_documents ?? {},
    });
    return {
      session_id: sessionId,
      document_source: documentSource,
      limits: { max_document_bytes: maxDocumentBytes, max_body_bytes: maxBodyBytes, max_flows: maxFlows },
      ...result,
      // The storage page can be truncated independently of the validator.
      truncated: result.truncated || page.has_more,
      skipped_count: result.skipped_count + (page.has_more ? Math.max(0, (page.session?.flow_count ?? flows.length) - flows.length) : 0),
      total: page.session?.flow_count ?? result.total,
    };
  }

  async function get_protocol_capabilities() {
    return protocolCapabilities();
  }

  // Flow bodies may have been spilled to proxy-mcp's private state directory.
  // Read at most the explicit validation cap; the validator receives metadata
  // for larger bodies and reports that schema validation was skipped.
  async function hydrateOpenApiFlowBodies(flow, maxBodyBytes) {
    const copy = structuredClone(flow);
    for (const part of [copy.request, copy.response]) {
      if (!part || part.body_inline != null || !part.body_path) continue;
      try {
        const stat = await fs.stat(part.body_path);
        part.body_size = Number.isFinite(part.body_size) ? part.body_size : stat.size;
        if (stat.size <= maxBodyBytes) part.body_inline = await fs.readFile(part.body_path);
      } catch {
        // Body capture may have expired. Preserve metadata so a declared body
        // is not mistaken for an absent one; validation can still check status,
        // parameters, and media type.
      }
    }
    return copy;
  }

  async function save_body_to_file(args = {}) {
    if (args.include_sensitive !== true) {
      const error = new Error('Raw body export requires include_sensitive=true and the server-level sensitive-data grant.');
      error.code = 'SENSITIVE_ACCESS_REQUIRED';
      error.recovery = ['Set include_sensitive=true for this call', 'Restart a trusted local session with PROXY_MCP_ALLOW_SENSITIVE=1'];
      throw error;
    }
    requireSensitiveAccess(true);
    const { flow_id, kind = 'res', path: destPath } = args;
    const f = await engine.getDurableFlow(flow_id, args.session_id);
    if (!f) throw new Error(`flow not found: ${flow_id}`);
    const part = kind === 'req' ? f.request : f.response;
    if (!part) throw new Error(`flow has no ${kind}`);
    let dest = destPath ? await authorizeWritePath(destPath) : null;
    if (!dest) {
      const dir = path.join(STATE_DIR, 'exports');
      await fs.mkdir(dir, { recursive: true });
      dest = path.join(dir, `${flow_id}.${kind}.bin`);
    }
    if (part.body_path && existsSync(part.body_path)) {
      await exportBody(part.body_path, dest);
    } else if (part.body_base64 != null) {
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fs.writeFile(dest, Buffer.from(part.body_base64, 'base64'), { mode: 0o600 });
    } else if (part.body_inline != null) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, part.body_inline);
    } else {
      throw new Error('flow has no body to save');
    }
    return { path: dest, size: part.body_size, sha: part.body_sha };
  }

  // Capture-to-mock — the Proxyman killer feature.
  async function capture_to_mock(args = {}) {
    await ensureProxyRunning();
    const { flow_id, rule_id, method, url_pattern, status, content_type } = args;
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const f = await engine.getDurableFlow(flow_id, args.session_id);
    if (!f) throw new Error(`flow not found: ${flow_id}`);
    if (!f.response) throw new Error('flow has no response yet');
    if (f.response.body_path && !includeSensitive) {
      const error = new Error('A spilled or binary captured response can only become a mock with include_sensitive=true and the server-level sensitive-data grant.');
      error.code = 'SENSITIVE_ACCESS_REQUIRED';
      error.recovery = ['Keep the body redacted and create_map_local manually', 'Or explicitly grant sensitive access for this trusted local session'];
      throw error;
    }
    const id = rule_id ?? `capture-${flow_id}`;
    const bodyFile = await flowBodyToMockBody({
      ruleId: id,
      srcPath: includeSensitive ? f.response.body_path : null,
      inlineText: includeSensitive
        ? f.response.body_inline
        : redactBody(f.response.body_inline, f.response.headers),
    });
    // The captured URL goes through the same builder every other rule uses, so
    // the mock is anchored on the endpoint it was captured from. The old
    // escapeRegex(pathname) was unanchored and host-less, so a mock of
    // GET /v1/users also answered http://evil.test/x/v1/users/extra — and when
    // the URL failed to parse it fell back to the whole URL, query included.
    const rule = await engine.registerRule({
      rule_id: id,
      ...ruleUrlMatchers(f.request?.url ?? '', { ...args, url_pattern }, { normalize: true }),
      method: method ?? f.request?.method ?? 'ANY',
      status: status ?? f.response.statusCode ?? 200,
      content_type: content_type ?? f.response.headers?.['content-type'] ?? 'application/json',
      body_file: bodyFile,
      created_at: new Date().toISOString(),
    });
    await persistRules();
    return { status: 'registered', source_flow: flow_id, redacted: !includeSensitive, ...rule };
  }

  async function get_ca_cert_path() {
    const caCert = await activeCaCertificate();
    return { ca_cert: caCert, ca_dir: caCert === CA_CERT ? CA_DIR : path.dirname(caCert), custom: caCert !== CA_CERT };
  }

  // ---- orphan / doctor ----
  async function kill_orphan_proxy(args = {}) {
    return await doctorSweep({ ports: args.ports, force: false });
  }

  async function reconcile_state() {
    const state = await readState();
    if (!state) return { reconciled: false, reason: 'no state.json' };
    if (await isStateStale()) {
      const reset = await defensiveNetworkResetAllServices();
      if (!reset.failed?.length) await clearState();
      return { reconciled: !reset.failed?.length, prior_state: state, network_reset: reset };
    }
    return { reconciled: false, reason: 'state is live' };
  }

  // ---- HAR export (subset; one flow per entry) ----
  async function export_har(args = {}) {
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const limit = args.limit ?? 200;
    let sourceFlows;
    if (args.session_id || args.since_flow_id || args.cursor) {
      sourceFlows = [];
      let cursor = args.cursor ?? null;
      let sinceFlowId = args.since_flow_id ?? null;
      do {
        const page = await engine.listDurableFlows({
          session_id: args.session_id,
          cursor,
          since_flow_id: cursor ? undefined : sinceFlowId,
          limit: Math.min(1000, limit - sourceFlows.length),
        });
        sourceFlows.push(...page.flows);
        cursor = page.next_cursor;
        sinceFlowId = null;
      } while (cursor && sourceFlows.length < limit);
    } else {
      sourceFlows = engine.flowOrder.slice(-limit).map((id) => engine.flows.get(id)).filter(Boolean);
    }
    const entries = [];
    for (const f of sourceFlows) {
      entries.push({
        startedDateTime: new Date(f.request?.timing?.startTime ?? f.timestamp).toISOString(),
        time: harTiming(f).total,
        request: {
          method: f.request?.method ?? 'GET',
          url: includeSensitive ? (f.request?.url ?? '') : redactUrl(f.request?.url ?? ''),
          httpVersion: f.request?.http_version ?? 'HTTP/1.1',
          cookies: parseCookies(f.request?.headers?.cookie, includeSensitive),
          headers: toHarHeaders(includeSensitive ? f.request?.headers : redactHeaders(f.request?.headers)),
          queryString: Object.entries(queryParams(f.request?.url, includeSensitive)).flatMap(([name, value]) =>
            (Array.isArray(value) ? value : [value]).map((item) => ({ name, value: String(item) }))),
          postData: f.request?.body_inline ? {
            mimeType: f.request?.headers?.['content-type'] ?? 'application/octet-stream',
            text: includeSensitive ? f.request.body_inline : redactBody(f.request.body_inline, f.request.headers),
          } : undefined,
          headersSize: -1,
          bodySize: f.request?.body_size ?? -1,
        },
        response: f.response ? {
          status: f.response.statusCode ?? 0,
          statusText: f.response.statusMessage ?? '',
          httpVersion: f.response.http_version ?? f.request?.http_version ?? 'HTTP/1.1',
          cookies: parseSetCookies(f.response.headers?.['set-cookie'], includeSensitive),
          headers: toHarHeaders(includeSensitive ? f.response.headers : redactHeaders(f.response.headers)),
          content: {
            size: f.response.body_size ?? 0,
            mimeType: f.response.headers?.['content-type'] ?? 'application/octet-stream',
            text: f.response.body_inline != null
              ? (includeSensitive ? f.response.body_inline : redactBody(f.response.body_inline, f.response.headers))
              : (f.response.body_path && includeSensitive ? (await fs.readFile(f.response.body_path)).toString('base64') : ''),
            encoding: f.response.body_inline == null && f.response.body_path && includeSensitive ? 'base64' : undefined,
            ...(f.response.body_inline == null && f.response.body_path && !includeSensitive
              ? { _proxy_mcp_omitted: true, _proxy_mcp_omission_reason: 'binary or spilled body redacted' }
              : {}),
          },
          redirectURL: f.response.headers?.location ?? '',
          headersSize: -1,
          bodySize: f.response.body_size ?? -1,
        } : { status: 0, statusText: '', httpVersion: 'HTTP/1.1', cookies: [], headers: [], content: { size: 0, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1 },
        cache: {},
        timings: harTimingsOnly(f),
      });
    }
    await fs.mkdir(HAR_EXPORT_DIR, { recursive: true });
    const out = args.path
      ? await authorizeWritePath(args.path)
      : path.join(HAR_EXPORT_DIR, `flows-${Date.now()}.har`);
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'proxy-mcp', version: SERVER_VERSION },
        entries,
      },
    };
    await fs.writeFile(out, JSON.stringify(har, null, 2), { mode: 0o600 });
    return { path: out, entry_count: entries.length };
  }

  async function import_har(args = {}) {
    const source = await authorizeReadPath(args.path);
    const stat = await fs.stat(source);
    if (stat.size > 256 * 1024 * 1024) throw new Error('HAR import exceeds the 256 MB safety limit.');
    const har = JSON.parse(await fs.readFile(source, 'utf8'));
    const entries = har?.log?.entries;
    if (!Array.isArray(entries)) throw new Error('Invalid HAR: expected log.entries array.');
    const sessionId = args.session_id ?? `har_${Date.now()}`;
    if (args.replace) await engine.sessionStore.purgeSession(sessionId);
    await engine.sessionStore.ensureSession({ id: sessionId, name: args.name ?? path.basename(source) });
    let imported = 0;
    const failed = [];
    for (const [index, entry] of entries.entries()) {
      try {
        const requestBody = harBody(entry.request?.postData);
        const responseBody = harBody(entry.response?.content);
        await engine.sessionStore.appendFlow({ sessionId, flow: {
          id: `har-${index + 1}-${crypto.randomBytes(5).toString('hex')}`,
          timestamp: Date.parse(entry.startedDateTime) || Date.now(),
          request: {
            method: entry.request?.method ?? 'GET', url: entry.request?.url ?? '',
            protocol: safeProtocol(entry.request?.url), http_version: entry.request?.httpVersion ?? null,
            hostname: safeHostname(entry.request?.url), path: safePath(entry.request?.url),
            headers: fromHarHeaders(entry.request?.headers), body_inline: requestBody.text,
            body_base64: requestBody.base64, body_size: entry.request?.bodySize ?? requestBody.size,
            body_encoding: requestBody.encoding,
          },
          response: {
            statusCode: entry.response?.status ?? 0, statusMessage: entry.response?.statusText ?? '',
            http_version: entry.response?.httpVersion ?? null,
            headers: fromHarHeaders(entry.response?.headers), body_inline: responseBody.text,
            body_base64: responseBody.base64, body_size: entry.response?.bodySize ?? responseBody.size,
            body_encoding: responseBody.encoding,
          },
          imported_timing: entry.timings ?? null,
        } });
        imported += 1;
      } catch (error) {
        failed.push({ index, error: error.message });
      }
    }
    return { status: 'imported', session_id: sessionId, imported, failed };
  }

  function toHarHeaders(headers) {
    if (!headers) return [];
    return Object.entries(headers).flatMap(([k, v]) => {
      if (Array.isArray(v)) return v.map((vv) => ({ name: k, value: String(vv) }));
      return [{ name: k, value: String(v) }];
    });
  }

  // ---- sim watcher control ----
  async function start_sim_watcher(args = {}) {
    if (simWatchStop) return { status: 'already_running' };
    const caCert = await activeCaCertificate();
    const preflight = await simulatorPreflight({ developer_dir: args.developer_dir });
    if (!preflight.ok) return { status: 'unavailable', preflight };
    simWatchStop = watchSimulators({
      interval: args.interval ?? 5000,
      certPath: caCert,
      developer_dir: preflight.developer_dir,
      onNew: async (sim) => {
        try { await restartSimApps({ udid: sim.udid }); } catch { /* ignore */ }
      },
      onResult: async (result) => {
        simWatcherEvents.push({ ...result, timestamp: new Date().toISOString() });
        if (simWatcherEvents.length > 50) simWatcherEvents.splice(0, simWatcherEvents.length - 50);
      },
    });
    return { status: 'started', developer_dir: preflight.developer_dir, xcode_version: preflight.xcode_version };
  }
  async function stop_sim_watcher() {
    if (simWatchStop) { simWatchStop(); simWatchStop = null; return { status: 'stopped' }; }
    return { status: 'not_running' };
  }

  return {
    // lifecycle
    start_proxy, stop_proxy, set_proxy_routing, clear_proxy_routing,
    start_operator_ui, stop_operator_ui, get_operator_ui_status,
    trust_ca_on_simulators: trust_ca_on_simulators_tool,
    setup_simulator_certificate, setup_xcode_preview_certificate,
    setup_host_certificate, remove_host_certificate, rotate_certificate_authority, get_certificate_status,
    start_device_onboarding, stop_device_onboarding, diagnose_ios_capture,
    create_reverse_proxy, list_reverse_proxies, remove_reverse_proxy,
    restart_sim_apps: restart_sim_apps_tool,
    get_version, get_proxy_status, toggle_recording,
    get_ssl_proxying_list, enable_ssl_proxying,
    clear_session, get_diagnostics, wait_for_flow,
    list_websocket_connections, get_websocket_connection, get_websocket_messages,
    export_websocket_transcript, import_websocket_transcript, plan_websocket_replay,
    transform_websocket_transcript,
    create_capture_session, list_capture_sessions, select_capture_session, update_capture_session,
    export_capture_session, import_capture_session, purge_capture_session,
    // rules
    create_map_local, create_map_remote, create_blacklist, create_breakpoint,
    list_pending_breakpoints, get_pending_breakpoint, resolve_breakpoint,
    cancel_breakpoint, get_breakpoint_history,
    create_network_condition, create_no_cache_rule,
    list_rules, remove_rule, clear_rules: clear_rules_tool,
    update_rule, set_rule_enabled, set_rule_priority, reorder_rules, test_rule,
    export_rules, import_rules, capture_to_mock,
    list_transform_plugins, get_transform_plugin, upsert_transform_plugin,
    remove_transform_plugin, set_transform_plugin_enabled, test_transform_plugin,
    create_transform_plugin_rule,
    list_capture_adapters, get_capture_adapter, preflight_capture_adapter,
    build_capture_setup_plan, get_extended_capabilities,
    // flows
    get_flows, filter_flows, get_flow_detail, export_flow_curl,
    compose_request, repeat_flow, edit_and_repeat_flow, compare_flows, export_flow_swift,
    export_flow_code, import_curl, analyze_capture, assert_capture,
    inspect_flow_protocol, validate_flow_openapi, validate_capture_openapi, get_protocol_capabilities,
    save_body_to_file, get_ca_cert_path,
    // safety
    kill_orphan_proxy, reconcile_state, export_har, import_har,
    // sim
    start_sim_watcher, stop_sim_watcher,
  };
}

function normalizeOfflineWebSocketMutation(sequence, output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    const error = new Error('A websocket_offline plugin must return an object with optional drop, text, or base64 fields.');
    error.code = 'PLUGIN_INVALID_WEBSOCKET_MUTATION';
    throw error;
  }
  const allowed = new Set(['drop', 'text', 'base64']);
  const unknown = Object.keys(output).filter((key) => !allowed.has(key));
  if (unknown.length || (output.text != null && output.base64 != null)
    || (output.drop != null && typeof output.drop !== 'boolean')
    || (output.text != null && typeof output.text !== 'string')
    || (output.base64 != null && (typeof output.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output.base64)))) {
    const error = new Error('The websocket_offline plugin returned an invalid mutation.');
    error.code = 'PLUGIN_INVALID_WEBSOCKET_MUTATION';
    throw error;
  }
  return { sequence, ...output };
}

function finding(code, message, severity, details) {
  return { code, message, severity, ...(details ? { details } : {}) };
}

function hostnameMatches(pattern, hostname) {
  if (pattern === hostname) return true;
  if (!pattern.includes('*') && !pattern.includes('?')) return false;
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${escaped}$`, 'i').test(hostname);
}

function flowNotFound(flowId) {
  const error = new Error(`flow not found: ${flowId}`);
  error.code = 'FLOW_NOT_FOUND';
  error.retryable = false;
  return error;
}

function redactHeadersForReplay(headers) {
  if (!headers) return {};
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    !/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|host|content-length)$/i.test(name)));
}

function redactedFlowForComparison(flow) {
  const safe = structuredClone(flow);
  if (safe.request) {
    safe.request.url = redactUrl(safe.request.url);
    safe.request.headers = redactHeaders(safe.request.headers);
  }
  if (safe.response) safe.response.headers = redactHeaders(safe.response.headers);
  return safe;
}

async function authorizeRulePaths(input) {
  const output = structuredClone(input ?? {});
  for (const key of ['body_file', 'directory', 'body_directory']) {
    if (output[key]) output[key] = await authorizeReadPath(output[key]);
  }
  for (const key of ['request_transform', 'response_transform']) {
    const transform = output[key];
    if (!transform || typeof transform !== 'object' || Array.isArray(transform)) continue;
    for (const pathKey of ['replace_body_file', 'body_file']) {
      if (transform[pathKey]) transform[pathKey] = await authorizeReadPath(transform[pathKey]);
    }
  }
  return output;
}

function queryParams(value, includeSensitive = false) {
  try {
    const out = {};
    for (const [key, raw] of new URL(value).searchParams) {
      const item = !includeSensitive && SENSITIVE_QUERY.test(key) ? '[REDACTED]' : raw;
      if (out[key] == null) out[key] = item;
      else out[key] = Array.isArray(out[key]) ? [...out[key], item] : [out[key], item];
    }
    return out;
  } catch { return {}; }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error('Request cancelled.');
  error.code ??= 'REQUEST_CANCELLED';
  error.retryable ??= true;
  throw error;
}

function abortableDelay(milliseconds, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', cancelled);
      resolve();
    }
    function cancelled() {
      clearTimeout(timer);
      try { throwIfAborted(signal); }
      catch (error) { reject(error); }
    }
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}

function parseCookies(value, includeSensitive) {
  if (!value) return [];
  return String(value).split(';').map((part) => {
    const [name, ...rest] = part.trim().split('=');
    return { name, value: includeSensitive ? rest.join('=') : '[REDACTED]' };
  });
}

function parseSetCookies(value, includeSensitive) {
  const values = value == null ? [] : (Array.isArray(value) ? value : [value]);
  return values.map((entry) => {
    const [pair] = String(entry).split(';');
    const [name, ...rest] = pair.split('=');
    return { name, value: includeSensitive ? rest.join('=') : '[REDACTED]' };
  });
}

function safeRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 500) throw new Error('regex must be at most 500 characters');
  // Reject common nested-quantifier forms that can catastrophically backtrack.
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) throw new Error('unsafe nested regex quantifier');
  return new RegExp(pattern);
}

function stableRuleId(prefix, input = '') {
  const digest = crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 12);
  return `${prefix}-${digest}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function harTiming(flow) {
  const timing = flow.response?.timing ?? flow.request?.timing ?? {};
  const start = Number(timing.startTimestamp);
  const requestEnd = Number(timing.bodyReceivedTimestamp);
  const responseStart = Number(timing.headersSentTimestamp);
  const responseEnd = Number(timing.responseSentTimestamp);
  const valid = (...values) => values.every(Number.isFinite);
  const send = valid(start, requestEnd) ? Math.max(0, requestEnd - start) : -1;
  const wait = valid(requestEnd, responseStart) ? Math.max(0, responseStart - requestEnd) : -1;
  const receive = valid(responseStart, responseEnd) ? Math.max(0, responseEnd - responseStart) : -1;
  const total = valid(start, responseEnd) ? Math.max(0, responseEnd - start)
    : [send, wait, receive].every((value) => value >= 0) ? send + wait + receive : 0;
  return { send, wait, receive, total };
}

function flowDurationMs(flow) {
  const { total } = harTiming(flow);
  return total || null;
}

function harTimingsOnly(flow) {
  const { total: _total, ...timings } = harTiming(flow);
  return timings;
}

function safeProtocol(value) {
  try { return new URL(value).protocol.replace(':', ''); } catch { return null; }
}

function safePath(value) {
  try { const url = new URL(value); return `${url.pathname}${url.search}`; } catch { return null; }
}

function fromHarHeaders(headers) {
  const result = {};
  for (const entry of headers ?? []) {
    if (!entry?.name) continue;
    const key = String(entry.name).toLowerCase();
    if (result[key] == null) result[key] = String(entry.value ?? '');
    else result[key] = Array.isArray(result[key])
      ? [...result[key], String(entry.value ?? '')]
      : [result[key], String(entry.value ?? '')];
  }
  return result;
}

function harBody(content) {
  if (!content?.text) return { text: '', base64: null, size: 0, encoding: 'utf8' };
  if (content.encoding === 'base64') {
    const buffer = Buffer.from(content.text, 'base64');
    return { text: null, base64: content.text, size: buffer.length, encoding: 'base64' };
  }
  return { text: String(content.text), base64: null, size: Buffer.byteLength(String(content.text)), encoding: 'utf8' };
}

function matchFlowCondition(flow, condition) {
  const field = condition?.field;
  let actual;
  if (field === 'url') actual = flow.request?.url ?? '';
  else if (field === 'host') actual = flow.request?.hostname ?? '';
  else if (field === 'method') actual = flow.request?.method ?? '';
  else if (field === 'status') actual = flow.response?.statusCode ?? -1;
  else if (field === 'request_headers') actual = JSON.stringify(flow.request?.headers ?? {});
  else if (field === 'response_headers') actual = JSON.stringify(flow.response?.headers ?? {});
  else if (field === 'request_body') actual = flow.request?.body_inline ?? '';
  else if (field === 'response_body') actual = flow.response?.body_inline ?? '';
  else throw new Error(`unsupported filter field: ${field}`);
  const expected = condition.value;
  switch (condition.operator ?? 'contains') {
    case 'equals': return String(actual) === String(expected);
    case 'contains': return String(actual).includes(String(expected));
    case 'wildcard': return safeRegex(urlPattern(String(expected))).test(String(actual));
    case 'regex': return safeRegex(String(expected)).test(String(actual));
    case 'gte': return Number(actual) >= Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    default: throw new Error(`unsupported filter operator: ${condition.operator}`);
  }
}
