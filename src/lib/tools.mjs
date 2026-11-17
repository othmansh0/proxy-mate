import { createBreakpointScope } from './breakpoints.mjs';
// Shared tool implementations. Both the daemon's control HTTP server and the
// in-process MCP-server route through these functions. Each tool returns
// JSON-serializable data; the MCP transport layer wraps that into MCP content.

import path from 'node:path';
import { logLine } from './log-line.mjs';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';

import { CA_CERT, CA_DIR, ensureCA, rotateCA, removeOwnedMockBody } from './proxy.mjs';
import { applyPacRouting, clearPacRouting, getAutoProxyState, validateRoutingDomains, createRoutingController, pickActiveNetworkService } from './pac.mjs';
import { createRoutingClaimsStore, validateDeviceUdids } from './routing-claims.mjs';
import { LEGACY_CLIENT_ID } from './client-identity.mjs';
import { gettingStarted, searchHelp, setupWorkflows } from './guidance.mjs';
import { runtimeIdentity, readRuntimeEvents, recordRuntimeEvent } from './runtime-identity.mjs';
import { encodeAgentJson, mergeJsonPatch } from './agent-json.mjs';
import {
  trustCaOnSimulators, restartSimApps, watchSimulators,
  setupSimulatorCertificates, setupXcodePreviewCertificate, discoverXcodePreviewDeviceSets,
  simulatorPreflight, inspectCertificate, listSimulators,
} from './sim.mjs';
import { loadRules, saveRules, exportRulesTo, importRulesFrom } from './rules.mjs';
import {
  flowBodyToMockBody, truncateInline, deleteFlowBodies,
} from './bodies.mjs';
import { doctorSweep, PROXY_PORT_DEFAULT, PAC_PORT_DEFAULT } from './doctor.mjs';
import {
  readState, patchState, clearState, isStateStale,
  defensiveNetworkResetAllServices, readPidFile,
} from './state.mjs';
import { STATE_DIR, SERVER_VERSION, TRANSFORM_PLUGIN_GRANT_ENV, liveTransformGrantEnabled } from './config.mjs';
import { getHostCertificateStatus, setupHostCertificate, removeHostCertificate } from './host-cert.mjs';
import { setupSimulatorRouting } from './simulator-routing.mjs';
import { AppProxyGateway } from './app-gateway.mjs';
import { activeConnectionAttemptTimeout } from './network-policy.mjs';
import { createAppClassifier } from './app-identity.mjs';
import { listSimulatorApplications, resolveSimulatorApplication, refreshSimulatorApplicationPath, simulatorProcessVerifier } from './simulator-apps.mjs';
import { bodyForExport, MAX_EXPORTED_BODY_BYTES } from './body-export.mjs';
import { inspectJson } from './json-inspection.mjs';
import { CaptureLease, LEASE_PROTECTED_TOOLS, INTERNAL_CAPTURE_CONTROL } from './capture-lease.mjs';
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
const RULE_CREATORS = new Set(['create_map_local', 'create_map_remote', 'create_blacklist', 'create_breakpoint',
  'mock_json_response', 'create_network_condition', 'create_no_cache_rule', 'capture_to_mock', 'create_transform_plugin_rule']);

function resourceRevision(config) {
  const { hit_count: _hits, last_hit: _lastHit, ...stable } = config;
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

// Factory: builds a tool object given an engine + pac server pair. Optionally
// owns lifecycle helpers (sim watcher stop fn, etc.).
// Non-enumerable integration hook: tools[INTERNAL_ROUTING_CONTROL] exposes the
// single lazily constructed controller (after the engine has bound its port).
export const INTERNAL_PRESENCE_LOST = Symbol('presence-lost');
export const INTERNAL_ROUTING_CONTROL = Symbol('routing-control');
export function makeTools({ engine, pacServer, mode = 'in-process', run, select,
  clientRegistry, restartApps = restartSimApps,
  pacPort = PAC_PORT_DEFAULT, now = Date.now, setTimer, clearTimer,
  hostCertificateStatus = getHostCertificateStatus,
}) {
  const claims = createRoutingClaimsStore({ now });
  let controller;
  let routingOptions = {};
  let routingCache = null;
  const claimDetails = new Map();
  const routingController = () => controller ??= createRoutingController({ claims, pacServer,
    proxyPort: () => engine.port, pacPort: routingOptions.pac_port ?? pacPort,
    run, select: service => select ? select(routingOptions.network_service ?? service)
      : pickActiveNetworkService(routingOptions.network_service ?? service),
    now, setTimer, clearTimer });
  const owner = context => ({ client_id: context.client_id ?? LEGACY_CLIENT_ID, task_id: context.task_id ?? null });
  const owned = (claim, context) => claim.client_id === owner(context).client_id && claim.task_id === owner(context).task_id;
  engine.breakpointScope = createBreakpointScope({ listClaims: () => claims.listClaims(),
    isAlive: id => id !== LEGACY_CLIENT_ID && Boolean(clientRegistry?.isAlive(id)), now });
  engine.breakpointScope({});
  async function guardGlobal(args, context) {
    if (args.force === true) return;
    const ids = new Set((await claims.listClaims()).filter(c => c.client_id !== owner(context).client_id
      && c.client_id !== LEGACY_CLIENT_ID && clientRegistry?.isAlive(c.client_id)).map(c => c.client_id));
    if (ids.size) throw Object.assign(new Error(`${ids.size} other live client(s) hold routing claims.`), {
      code: 'OTHER_CLIENTS_ACTIVE', details: { other_clients_active: ids.size }, retryable: false,
      recovery: ['Use your own routing or rules, or coordinate with other clients before using force: true.'],
    });
  }
  async function claimedDevices(context) {
    return [...new Set((await claims.listClaims()).filter(c => owned(c, context)).flatMap(c => c.device_udids ?? []))];
  }
  async function restartForCaller(args, context) {
    const devices = args.udid ? [args.udid] : await claimedDevices(context);
    if (!devices.length) return restartApps({ ...args });
    const reports = await Promise.all(devices.map(udid => restartApps({ ...args, udid })));
    return { restarted: reports.flatMap(r => r.restarted ?? []), failed: reports.flatMap(r => r.failed ?? []) };
  }
  async function resolveScope(context = {}, requestedScope) {
    const client_id = context.client_id ?? LEGACY_CLIENT_ID;
    const mode = requestedScope ?? (client_id === LEGACY_CLIENT_ID ? 'all' : 'mine');
    if (!['mine', 'all'].includes(mode)) throw new Error('scope must be mine or all');
    const rows = mode === 'mine' ? (await claims.listClaims()).filter(c => c.client_id === client_id) : [];
    const devices = [...new Set(rows.flatMap(c => c.device_udids ?? []))];
    const domains = [...new Set(rows.flatMap(c => c.domains))];
    const hosts = domains.map(d => new RegExp('^' + d.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.') + '$', 'i'));
    return { mode, client_id, devices, domains, predicate: flow => mode === 'all' || flow.owner_client === client_id ||
      devices.includes(flow.device_udid) || ((!flow.attribution || ['unknown', 'ambiguous'].includes(flow.attribution)) && hosts.some(re => re.test(flow.request?.hostname ?? safeHostname(flow.request?.url) ?? ''))) };
  }
  const scopeMeta = (scope, hidden_count = 0) => ({ scope_applied: scope.mode, hidden_count });
  async function scopedPage(args, scope) {
    if (engine.sessionStore.listScopedFlows) return engine.sessionStore.listScopedFlows({ ...args, sessionId: args.session_id ?? args.sessionId ?? engine.sessionId, scope });
    const page = await engine.listDurableFlows(args);
    return { ...page, flows: page.flows.filter(scope.predicate), ...scopeMeta(scope, page.flows.filter(f => !scope.predicate(f)).length) };
  }
  async function requireSharedConfirmation(args, context, sessionId) {
    const mine = await resolveScope(context, 'mine');
    const count = await engine.sessionStore.countScopedFlows({ sessionId, scope: mine });
    const counts = { removed_count: count.total, kept_other_clients_count: count.hidden };
    if (args.confirm_shared !== true) throw Object.assign(new Error('Shared evidence requires scope: all and confirm_shared: true.'), {
      code: 'CONFIRM_SHARED_REQUIRED', details: counts, recovery: 'Pass scope: all with confirm_shared: true.' });
    return counts;
  }
  const invalidateRouting = () => { routingCache = null; };
  function lossEvent(event) {
    if (event.event === 'routing_claim_expired') return 'lease_expired';
    if (['lease_expired', 'daemon_restart', 'external_change', 'guardian_recovery'].includes(event.reason)) return event.reason;
    if (event.event === 'restored_dead_owner_routing') return 'guardian_recovery';
    if (event.event === 'routing_cleared' && event.status === 'changed_externally') return 'external_change';
    if (event.event === 'routing_suspended') return 'daemon_restart';
    return null;
  }
  async function routingStatus() {
    if (controller) return controller.status();
    const [rows, state] = await Promise.all([claims.listClaims({ includeExpired: true }), readState()]);
    const active = Boolean(state?.routing_active && state.pid === process.pid);
    return { active, network_service: state?.network_service ?? null,
      union_domains: [...new Set(rows.filter(c => Date.parse(c.expires_at) > now()).flatMap(c => c.domains))].sort(),
      claims: rows.map(c => ({ claim_id: c.claim_id, client_id: c.client_id, task_id: c.task_id,
        domains: c.domains, expires_at: c.expires_at,
        state: Date.parse(c.expires_at) <= now() ? 'expired' : active ? 'active' : 'suspended' })), last_change: null };
  }
  async function routingSnapshot(fresh = false) {
    if (!fresh && routingCache && now() - routingCache.at < 1000) return routingCache.value;
    const [status, events, guardian] = await Promise.all([
      routingStatus(), readRuntimeEvents(), readRuntimeEvents('guardian'),
    ]);
    // Expiry sweeps remove rows. Keep their bounded journal tombstones visible
    // until a newer set or explicit clear supersedes them.
    const rows = [...status.claims];
    for (const c of rows) claimDetails.set(c.claim_id, c);
    const latest = new Map();
    for (const e of events) if (e.claim_id && /^routing_claim_/.test(e.event)) latest.set(e.claim_id, e);
    for (const e of latest.values()) if (e.event === 'routing_claim_expired' && !rows.some(c => owned(c, e))) {
      rows.push({ claim_id: e.claim_id, client_id: e.client_id, task_id: e.task_id ?? null,
        domains: claimDetails.get(e.claim_id)?.domains ?? [], expires_at: claimDetails.get(e.claim_id)?.expires_at ?? e.at, state: 'expired' });
    }
    for (const id of claimDetails.keys()) if (!rows.some(c => c.claim_id === id)) claimDetails.delete(id);
    const lost = [...events, ...guardian].filter(e => lossEvent(e)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    const value = { ...status, claims: rows, routing_lost_reason: lost ? lossEvent(lost) : null, routing_lost_at: lost?.at ?? null };
    routingCache = { at: now(), value };
    return value;
  }
  async function routingResult(status, context) {
    const state = await readState();
    const claim = status.claims.find(c => owned(c, context)) ?? null;
    return { claim, routing_union: status.union_domains, routing_status: status,
      domains: status.union_domains, networkService: status.network_service,
      pacUrl: state?.pac_url ?? null, expires_at: claim?.expires_at ?? null };
  }
  async function applyClaim(args, context, preserveExpiry = false) {
    validateRoutingDomains(args.domains, { allowBroad: args.allow_broad_routing === true });
    const device_udids = args.device_udid === undefined ? undefined : validateDeviceUdids(Array.isArray(args.device_udid) ? args.device_udid : [args.device_udid]);
    const duration = args.duration_seconds ?? 3600;
    if (!Number.isInteger(duration) || duration < 1 || duration > 86400) throw Object.assign(new Error('Routing duration must be 1-86400 seconds.'), { code: 'ROUTING_LEASE_INVALID' });
    routingOptions = { network_service: args.network_service, pac_port: args.pac_port };
    const control = routingController();
    const before = await control.status();
    const state = await readState();
    // A pre-claims runtime remains untouched until explicitly cleared.
    if (state?.routing_active && !before.claims.length) throw Object.assign(new Error('Clear legacy routing explicitly before creating claims.'), { code: 'ROUTING_OWNED' });
    if (state?.routing_active) {
      const actual = await getAutoProxyState(state.network_service, run);
      if (!actual.enabled || actual.url !== state.pac_url) {
        if (!args.replace_existing_proxy) throw Object.assign(new Error('System proxy changed externally.'), { code: 'ROUTING_CONFLICT' });
        await clearPacRouting({ pacServer, run });
      }
    }
    const previous = before.claims.find(c => owned(c, context));
    const saved = (await claims.listClaims({ includeExpired: true })).find(c => owned(c, context));
    let status;
    try {
      if (preserveExpiry && previous && Date.parse(previous.expires_at) > now()) {
        // Store upsert accepts an explicit clock; anchoring it at the original
        // renewal preserves both requested duration and the exact expiry.
        const stored = (await claims.listClaims()).find(c => c.claim_id === previous.claim_id);
        await claims.upsertClaim({ ...owner(context), domains: args.domains, device_udids, allowBroad: args.allow_broad_routing === true,
          durationSeconds: stored.requested_seconds, now: Date.parse(stored.expires_at) - stored.requested_seconds * 1000 });
        status = await control.sync();
      } else status = await control.set({ ...owner(context), domains: args.domains, device_udids,
        durationSeconds: args.duration_seconds ?? 3600, allowBroad: args.allow_broad_routing === true,
        replaceExisting: args.replace_existing_proxy === true });
    } catch (error) {
      if (saved) await claims.upsertClaim({ ...saved, durationSeconds: saved.requested_seconds,
        allowBroad: true, now: Date.parse(saved.expires_at) - saved.requested_seconds * 1000 });
      else await claims.removeClaim(owner(context));
      invalidateRouting();
      throw error;
    }
    for (const c of status.claims) claimDetails.set(c.claim_id, c);
    invalidateRouting();
    return routingResult(status, context);
  }

  const captureLease = new CaptureLease({ registry: clientRegistry, clock: now });
  let simWatchStop = null;
  let appGateway = null;
  let appScope = null;
  const simWatcherEvents = [];
  const onboardingPortal = new DeviceOnboardingPortal();
  const operatorUi = new OperatorUiServer({
    providers: {
      health: async () => ({ ok: true, service: 'proxy-mate' }),
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
    getProxyPort: () => engine.isRunning() ? engine.port : null,
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

  async function readBodyBytes(part) {
    if (!part || part.body_omitted) throw Object.assign(new Error(`Captured body is unavailable: ${part?.body_omitted ?? 'missing part'}`), { code: 'BODY_UNAVAILABLE' });
    let bytes;
    if (part.body_path) {
      const file = await authorizeReadPath(part.body_path);
      const handle = await fs.open(file, 'r');
      try {
        if ((await handle.stat()).size > 50 * 1024 * 1024) throw new Error('Stored body exceeds the 50 MiB replay limit.');
        bytes = await handle.readFile();
      } finally { await handle.close(); }
    } else if (part.body_base64) {
      bytes = Buffer.from(part.body_base64, 'base64');
    } else {
      if (part.body_inline == null && part.body_size > 0) throw Object.assign(new Error('Captured body bytes are missing.'), { code: 'BODY_UNAVAILABLE' });
      bytes = Buffer.from(part.body_inline ?? '');
    }
    return bytes;
  }

  async function capturedBody(part, includeSensitive = false) {
    const bytes = await readBodyBytes(part);
    if (includeSensitive) return bytes;
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw Object.assign(new Error('Binary replay requires the explicit sensitive-data grant.'), { code: 'SENSITIVE_ACCESS_REQUIRED' });
    return Buffer.from(redactBody(text, part.headers));
  }

  function replayHeaders(headers, includeSensitive) {
    const filtered = includeSensitive ? headers ?? {} : redactHeadersForReplay(headers);
    return Object.fromEntries(Object.entries(filtered).filter(([name]) => !/^(host|content-length|transfer-encoding|content-encoding)$/i.test(name)));
  }

  function flowSummary(f, { includeSensitive = false, view = 'full' } = {}) {
    const summary = {
      id: f.id,
      owner_client: f.owner_client ?? null, owner_task: f.owner_task ?? null,
      device_udid: f.device_udid ?? null, attribution: f.attribution ?? 'unknown',
      method: f.request?.method,
      url: includeSensitive ? f.request?.url : redactUrl(f.request?.url),
      hostname: f.request?.hostname ?? safeHostname(f.request?.url),
      status: f.response?.statusCode,
      upstream_error: f.response?.upstream_error ?? null,
      size: f.response?.body_size ?? 0,
      timestamp: f.timestamp,
      protocol: f.request?.protocol ?? null,
      http_version: f.request?.http_version ?? f.response?.http_version ?? null,
      duration_ms: flowDurationMs(f),
      matched_rule_id: f.request?.matched_rule_id ?? null,
    };
    if (view === 'compact') for (const key of ['hostname', 'protocol', 'http_version', 'duration_ms']) delete summary[key];
    if (view === 'compact') for (const key of ['upstream_error', 'matched_rule_id']) if (summary[key] == null) delete summary[key];
    return summary;
  }

  function safeHostname(url) {
    try { return new URL(url).hostname; } catch { return null; }
  }

  function flowDetailForReturn(f, { full = false, includeSensitive = false, previewBytes = 2048 } = {}) {
    // Redact complete JSON before truncation; truncated JSON cannot reliably
    // be parsed by the redactor or by an agent expecting a JSON document.
    const reqRaw = includeSensitive ? f.request?.body_inline : redactBody(f.request?.body_inline, f.request?.headers);
    const resRaw = includeSensitive ? f.response?.body_inline : redactBody(f.response?.body_inline, f.response?.headers);
    const reqPreview = truncateInline(reqRaw, previewBytes), resPreview = truncateInline(resRaw, previewBytes);
    const reqInline = full ? reqRaw : reqPreview.text;
    const resInline = full ? resRaw : resPreview.text;
    return {
      id: f.id,
      owner_client: f.owner_client ?? null, owner_task: f.owner_task ?? null,
      device_udid: f.device_udid ?? null, attribution: f.attribution ?? 'unknown',
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
          ? reqPreview.truncated : false,
        untrusted_content: true,
      },
      response: f.response && {
        statusCode: f.response.statusCode,
        statusMessage: f.response.statusMessage,
        tags: f.response.tags ?? [],
        upstream_error: f.response.upstream_error ?? null,
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
          ? resPreview.truncated : false,
        untrusted_content: true,
      },
    };
  }

  // ---- proxy lifecycle ----
  async function start_proxy(args = {}, context = {}) {
    if (args.auto_setup) await guardGlobal(args, context);
    if (appGateway) throw Object.assign(new Error('App-only capture is active. Stop it before switching capture modes.'), { code: 'APP_CAPTURE_ACTIVE' });
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
    if (auto_setup) validateRoutingDomains(domains, { allowBroad: args.allow_broad_routing === true });
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
    const newlyStarted = started.status === 'started';
    if (newlyStarted) await patchState({ active_session_id: engine.sessionId });
    if (!newlyStarted && !auto_setup) return { ...started, auto_setup: false };
    // Replay valid rules and surface invalid persisted entries instead of
    // silently claiming that every rule was restored.
    try {
      const persisted = newlyStarted ? await loadRules() : [];
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

    const activeCaCert = await activeCaCertificate();
    const hostCertificate = trust_host_ca
      ? await setupHostCertificate(activeCaCert)
      : await getHostCertificateStatus(activeCaCert);
    const broadRouting = domains.includes('*');
    if (!hostCertificate.ok || !hostCertificate.trusted) {
      if (newlyStarted) await engine.stop();
      const error = new Error(hostCertificate.recovery ?? hostCertificate.error
        ?? 'System routing requires the proxy CA to be trusted in the user login keychain. Enable trust_host_ca or run setup_host_certificate first.');
      error.code = hostCertificate.code ?? 'HOST_CA_NOT_TRUSTED';
      throw error;
    }

    let routing;
    let trust;
    try {
      ({ trust, routing } = await setupSimulatorRouting({
        certPath: activeCaCert,
        keyPath: engine.caKeyPath,
        applyRouting: () => applyClaim({ ...args, domains }, context),
      }));
    } catch (error) {
      if (newlyStarted) await engine.stop();
      await patchState({ proxy_port: engine.port, setup_error: error.message });
      throw error;
    }
    const restartReport = trust.trusted?.length
      ? await restartForCaller(args, context)
      : { restarted: [], skipped: 'certificate was not imported on a booted simulator' };
    const watcher = await start_sim_watcher({ interval: 5000 });
    return { ...started, auto_setup: true, host_certificate: hostCertificate, routing, trust, restart: restartReport, watcher };
  }

  async function list_simulator_apps(args = {}) {
    if (!args.udid) {
      const listed = await listSimulators({ scope: 'booted' });
      return { devices: listed.simulators, preflight: listed.preflight };
    }
    return listSimulatorApplications(args);
  }

  async function start_app_capture(args = {}, context = {}) {
    await guardGlobal(args, context);
    if (engine.isRunning() && appScope?.bundle_id === args.bundle_id && appScope?.device_id === args.udid) {
      const state = await readState();
      let routing = null;
      if (!state?.routing_active || args.duration_seconds !== undefined) {
        const applyRouting = () => applyPacRouting({ domains: ['*'], allowBroad: true,
          networkService: args.network_service ?? state?.network_service,
          pacPort: args.pac_port ?? state?.pac_port ?? PAC_PORT_DEFAULT,
          proxyPort: appGateway.port, pacServer, durationSeconds: args.duration_seconds ?? 3600 });
        if (state?.routing_active) routing = await applyRouting();
        else ({ routing } = await setupSimulatorRouting({
          certPath: await activeCaCertificate(), keyPath: engine.caKeyPath,
          trust: (certPath) => trustCaOnSimulators(certPath, { device_ids: [args.udid] }), applyRouting,
        }));
      }
      return { status: 'capturing_app', scope: appScope, port: appGateway.port, reused: true,
        session: await engine.sessionStore.getSession(engine.sessionId),
        routing, routing_expires_at: routing?.expires_at ?? state?.routing_expires_at ?? null,
        next_actions: ['Existing capture was reused without restarting the app. Routing is renewed only when expired or duration_seconds is supplied. Inspect get_flows to verify the target request.'] };
    }
    if (engine.isRunning()) throw Object.assign(new Error('Stop the current capture before starting app-only capture.'), {
      code: 'CAPTURE_ALREADY_RUNNING', details: { capture_scope: appScope ?? { mode: 'domains' }, active_session_id: engine.sessionId },
      recovery: ['Reuse the running capture with get_flows/get_flow_detail.', 'Only stop and replace capture when the shared change is intended.'],
    });
    const publicPort = args.port ?? 8083;
    const daemonPort = (await readState())?.daemon_proxy_port ?? PROXY_PORT_DEFAULT;
    if (publicPort === daemonPort) throw Object.assign(new Error('App capture needs a separate gateway port so daemon recovery cannot turn cached app routing into broad capture.'), {
      code: 'APP_PROXY_PORT_CONFLICT', recovery: ['Use the default app gateway port or choose a port different from the daemon proxy port.'],
    });
    const app = await resolveSimulatorApplication(args);
    const session = await create_capture_session({
      name: `${args.bundle_id} on ${app.device.name}`, activate: true,
      metadata: { capture_scope: 'app', bundle_id: args.bundle_id, device_id: args.udid },
    });
    let routing;
    let trust;
    try {
      await start_proxy({ port: 0, auto_setup: false, tls_passthrough: args.tls_passthrough });
      ({ trust, routing } = await setupSimulatorRouting({
        certPath: await activeCaCertificate(), keyPath: engine.caKeyPath,
        trust: (certPath) => trustCaOnSimulators(certPath, { device_ids: [args.udid] }),
        applyRouting: async () => {
          appGateway = new AppProxyGateway({ proxyPort: engine.port, classify: createAppClassifier({
            appPath: app.appPath, resolveAppPath: () => refreshSimulatorApplicationPath(app), verifyProcess: simulatorProcessVerifier(app),
          }) });
          await appGateway.start(publicPort);
          return applyPacRouting({ domains: ['*'], allowBroad: true,
            networkService: args.network_service, pacPort: args.pac_port ?? PAC_PORT_DEFAULT,
            proxyPort: appGateway.port, pacServer, durationSeconds: args.duration_seconds ?? 3600,
          });
        },
      }));
      appScope = { mode: 'app', bundle_id: args.bundle_id, device_id: args.udid,
        simulator: app.device.name, mac_keychain_changed: false,
        coverage: 'Only connections attributed to the selected app process are inspected. Background helpers and unknown owners pass through without capture.' };
      await patchState({ proxy_port: appGateway.port, capture_scope: appScope });
      const restart = args.restart_app === false ? null
        : await restartSimApps({ udid: args.udid, bundle_id: args.bundle_id, developer_dir: app.developerDir });
      if (restart?.failed?.length) throw Object.assign(new Error('The selected app could not be launched.'), { code: 'APP_LAUNCH_FAILED' });
      return { status: 'capturing_app', scope: appScope, port: appGateway.port, trust, routing, restart, session: session.session,
        network_scope: 'Mac proxy routing uses a local gateway; other apps are forwarded without inspection or storage.' };
    } catch (error) {
      await stop_proxy();
      throw error;
    }
  }

  async function stop_proxy(_args = {}, { routingOnly = false, skipRouting = false, timeoutCapMs, graceMs } = {}) {
    // Only the symbol-addressed daemon path supplies these internal options.
    if (routingOnly) {
      try { return await clearPacRouting({ pacServer, timeoutCapMs }); }
      finally { await patchState({ routing_suspended: { reason: 'daemon_shutdown', at: new Date().toISOString() } }); }
    }
    if (skipRouting) {
      // Drain gateway and engine together; a failed auxiliary stop must not
      // prevent the proxy from closing or capture persistence from flushing.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => appGateway?.stop({ graceMs })),
        Promise.resolve().then(() => engine.stop({ graceMs })),
        Promise.resolve().then(() => stop_sim_watcher()),
        Promise.resolve().then(() => onboardingPortal.stop()),
        Promise.resolve().then(() => reverseProxies.stopAll()),
      ]);
      appGateway = null; appScope = null;
      await patchState({ proxy_port: null, capture_scope: null, stopped_at: new Date().toISOString() });
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      return results[1].value;
    }
    let routingCleanupError = null;
    try { await clearPacRouting({ pacServer }); }
    catch (error) { routingCleanupError = error?.message ?? String(error); }
    await appGateway?.stop();
    appGateway = null;
    appScope = null;
    const out = await engine.stop();
    await stop_sim_watcher();
    await onboardingPortal.stop();
    await reverseProxies.stopAll();
    await patchState({
      proxy_port: null,
      capture_scope: null,
      stopped_at: new Date().toISOString(),
      ...(routingCleanupError ? { cleanup_error: routingCleanupError } : {}),
    });
    return routingCleanupError
      ? { ...out, status: 'stopped_with_routing_warning', routing_cleanup_error: routingCleanupError }
      : out;
  }

  async function set_proxy_routing(args = {}, context = {}) {
    await ensureProxyRunning();
    if (appGateway) throw Object.assign(new Error('Stop app-only capture before selecting domain or Mac-wide capture.'), { code: 'APP_CAPTURE_ACTIVE' });
    const hostTrust = await hostCertificateStatus(await activeCaCertificate());
    if (!hostTrust.trusted) throw Object.assign(new Error('Trust the active CA with setup_host_certificate before changing Mac routing. No routing settings were changed.'), {
      code: 'HOST_CA_UNTRUSTED', retryable: false, recovery: ['Call setup_host_certificate, then retry the scoped routing request.'],
    });
    const { domains } = args;
    if (!Array.isArray(domains) || domains.length === 0) {
      throw new Error('domains must be a non-empty array.');
    }
    const routing = await applyClaim(args, context);
    return { status: 'routing_on', ...routing };
  }

  async function clear_proxy_routing(args = {}, context = {}) {
    if (args.scope !== undefined && !['mine', 'all'].includes(args.scope)) throw new Error('scope must be mine or all');
    const before = await routingSnapshot(true);
    const removed = before.claims.filter(c => args.scope === 'all' || owned(c, context));
    const state = await readState();
    let status = before;
    // A no-claim clear must not disturb unclaimed legacy/app routing.
    if (removed.length) status = await routingController().clear({ ...owner(context), all: args.scope === 'all' });
    else if (state?.routing_active && !before.claims.length && (args.scope === 'all' || owner(context).client_id === LEGACY_CLIENT_ID)) {
      await clearPacRouting({ pacServer, networkService: args.network_service, run });
      status = await routingStatus();
    }
    for (const c of removed) {
      claimDetails.delete(c.claim_id);
      if (c.state === 'expired') await recordRuntimeEvent('routing_claim_cleared', { details: {
        claim_id: c.claim_id, client_id: c.client_id, task_id: c.task_id } });
    }
    invalidateRouting();
    return { status: status.active ? 'routing_on' : 'routing_off', ...await routingResult(status, context),
      removed_claims: removed, removed_other_claims: removed.filter(c => c.client_id !== owner(context).client_id) };
  }

  async function trust_ca_on_simulators_tool() {
    return await trustCaOnSimulators(await activeCaCertificate());
  }

  async function setup_simulator_certificate(args = {}, context = {}) {
    if (args.restart_apps !== false) await guardGlobal(args, context);
    const devices = args.device_ids ?? await claimedDevices(context);
    return setupSimulatorCertificates({
      cert_path: await activeCaCertificate(),
      scope: args.scope ?? 'booted',
      device_ids: devices.length ? devices : undefined,
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
      verification: 'Use verify_simulator_certificate with a booted device UDID to check native URLSession trust. Import success alone is not end-to-end verification.',
    };
  }

  async function verify_simulator_certificate(args = {}, context = {}) {
    const certPath = await activeCaCertificate();
    const { verifySimulatorCertificate } = await import('./simulator-probe.mjs');
    return verifySimulatorCertificate({ udid: args.udid, certPath, keyPath: engine.caKeyPath,
      developer_dir: args.developer_dir, signal: context.signal });
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
    const actualPac = state?.network_service ? await getAutoProxyState(state.network_service) : null;
    const gateway = appGateway?.status() ?? null;
    const checks = {
      proxy_running: engine.isRunning(),
      recording: engine.recording,
      routing_active: state?.routing_active ?? false,
      routing_matches_system: Boolean(state?.routing_active && actualPac?.enabled && actualPac.url === state.pac_url),
      host_ca_trusted: certificate.host?.trusted ?? false,
      host_ca_required: appScope?.mode !== 'app' && args.routing_mode !== 'explicit',
      app_capture_coverage_degraded: gateway?.coverage_degraded ?? false,
      simulator_tooling_ready: certificate.xcode?.ok ?? false,
      booted_simulators: certificate.booted_simulators?.length ?? 0,
      captured_flows: engine.flows.size,
    };
    const diagnostics = engine.diagnostics.slice(-30);
    const tlsFailures = diagnostics.filter((item) => item.kind === 'tls-client-error');
    const passthroughs = diagnostics.filter((item) => item.kind === 'tls-passthrough-opened');
    const findings = [];
    if (checks.routing_active && !checks.routing_matches_system) findings.push(finding('ROUTING_CHANGED_EXTERNALLY', 'The recorded PAC no longer matches macOS. Check the active network service, VPN or other proxy, then explicitly reapply routing if appropriate.', 'warning'));
    if (!checks.proxy_running) findings.push(finding('PROXY_NOT_RUNNING', 'Start capture before diagnosing an iOS client.', 'error'));
    if (!checks.recording) findings.push(finding('RECORDING_PAUSED', 'Proxying is active but flows are not being recorded.', 'warning'));
    if (!checks.routing_active) findings.push(finding('ROUTING_INACTIVE', 'Automatic PAC routing is not active. Confirm the Simulator/device proxy configuration.', 'warning'));
    if (checks.host_ca_required && !checks.host_ca_trusted) findings.push(finding('HOST_CA_UNTRUSTED', 'The proxy CA is not trusted in the current macOS login keychain.', 'warning'));
    if (checks.app_capture_coverage_degraded) findings.push(finding('APP_ATTRIBUTION_DEGRADED',
      'Some socket owners could not be verified and passed through without capture. Inspect attribution reasons; zero persistence drops does not establish complete app coverage.', 'warning', gateway.attribution));
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
      ok: !findings.some((item) => item.severity === 'error') && checks.proxy_running && checks.recording
        && (args.routing_mode === 'explicit' || checks.routing_matches_system),
      readiness: {
        service: checks.proxy_running ? 'ready' : 'stopped', recording: checks.recording ? 'ready' : 'paused',
        routing: args.routing_mode === 'explicit' ? 'explicit_client_configuration_required'
          : checks.routing_matches_system ? 'configured' : 'not_ready',
        native_tls: 'use_verify_simulator_certificate',
        app_traffic: checks.app_capture_coverage_degraded ? 'capture_coverage_degraded'
          : checks.captured_flows > 0 ? 'observed_not_verified_for_target_request' : 'not_observed',
      },
      checks,
      app_gateway: gateway,
      hostname: args.hostname ?? null,
      findings,
      verification: 'This diagnostic distinguishes observed proxy/TLS failures. Call verify_simulator_certificate to test native URLSession trust.',
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

  async function restart_sim_apps_tool(args = {}, context = {}) {
    await guardGlobal(args, context);
    return restartForCaller(args, context);
  }

  async function presenceLost(client) {
    if (client.client_id === LEGACY_CLIENT_ID) return;
    const rows = (await claims.listClaims({ includeExpired: true })).filter(c => c.client_id === client.client_id);
    for (const c of rows) {
      await routingController().clear({ claim_id: c.claim_id });
      claimDetails.delete(c.claim_id);
    }
    invalidateRouting();
    const details = { client_id: client.client_id, task_id: client.task_id, claims_removed: rows.length };
    await recordRuntimeEvent('client_presence_lost', { details });
    logLine('daemon', 'client presence lost', details);
  }
  function clientsStatus(context) {
    const rows = clientRegistry?.list() ?? [];
    const me = rows.find(c => c.client_id === context.client_id);
    return { count: rows.length, alive: rows.filter(c => c.alive).length,
      me: me ? { client_id: me.client_id, task_id: me.task_id, last_seen: me.last_seen } : null };
  }
  async function get_proxy_status(_args = {}, context = {}) {
    const [state, pid, storage, runtime, events, guardianEvents, routingStatus] = await Promise.all([
      readState(), readPidFile(), engine.sessionStore.storageStatus(), runtimeIdentity(), readRuntimeEvents(), readRuntimeEvents('guardian'), routingSnapshot(true),
    ]);
    return {
      running: engine.isRunning(),
      clients: clientsStatus(context),
      capture_lease: captureLease.status(state),
      active_session_id: engine.sessionId,
      connection_attempt_timeout_ms: activeConnectionAttemptTimeout(),
      port: appGateway?.port ?? engine.port,
      capture_scope: appScope ?? { mode: 'domains' },
      app_gateway: appGateway?.status() ?? null,
      allow_remote: engine.allowRemote,
      socks_enabled: engine.socksEnabled ?? false,
      remote_access: engine.remoteAccessStatus(),
      mode,
      runtime,
      ...(mode === 'daemon' && context.bridge_version !== SERVER_VERSION ? { client_compatibility: {
        reported_bridge_version: context.bridge_version ?? null,
        action: 'reconnect_mcp_client', capture_restart_required: false,
        message: 'Refresh only the MCP client for compact output, JSON queries and task cleanup; shared capture continues.',
      } } : {}),
      recent_runtime_events: events.slice(-10),
      recent_guardian_events: guardianEvents.slice(-10),
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
      routing_expires_at: state?.routing_expires_at ?? null,
      routing_fail_open: true,
      routing_claims: routingStatus.claims.map(c => ({ ...c, mine: owned(c, context) })),
      routing_union: routingStatus.union_domains,
      routing_lost_reason: routingStatus.routing_lost_reason,
      routing_lost_at: routingStatus.routing_lost_at,
      tls_passthrough: engine.tlsPassthrough,
      simulator_watcher: simWatchStop ? 'running' : 'stopped',
      recent_simulator_events: simWatcherEvents.slice(-10),
      breakpoints: engine.breakpoints.getStatus(),
      storage,
      capture_storage_policy: engine.captureBodyMode,
      persistence_queue_depth: engine.flowPersistence.size,
      capture_queue_depth: engine.captureWork.size,
      capture_dropped_events: engine.captureDropped,
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
    return { name: 'proxy-mate', version: SERVER_VERSION, node: process.version, mode };
  }

  async function get_started(args = {}, context = {}) { return gettingStarted(args, await get_proxy_status({}, context)); }
  async function search_docs(args = {}) { return searchHelp(args.query, args.limit); }
  async function list_setup_workflows() { return setupWorkflows(); }

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

  async function toggle_recording(args = {}, context = {}) {
    await guardGlobal(args, context);
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

  async function enable_ssl_proxying(args = {}, context = {}) {
    await ensureProxyRunning();
    if (!args.domain) throw new Error('domain is required');
    if (appGateway) throw Object.assign(new Error('Stop app-only capture first.'), { code: 'APP_CAPTURE_ACTIVE' });
    const hostTrust = await hostCertificateStatus(await activeCaCertificate());
    if (!hostTrust.trusted) throw Object.assign(new Error('Trust the active CA first.'), { code: 'HOST_CA_UNTRUSTED' });
    const previous = (await routingController().status()).claims.find(c => owned(c, context));
    const domains = [...new Set([...(previous?.domains ?? []), args.domain])];
    const state = await readState();
    const routing = await applyClaim({ domains, network_service: state?.network_service,
      allow_broad_routing: previous?.domains.includes('*') }, context, true);
    return { status: 'enabled', domain: args.domain, de_duplicated: domains.length === (previous?.domains.length ?? 0), routing };
  }

  async function removeScopedEvidence(args, context, { clear = false } = {}) {
    const sessionId = args.session_id ?? engine.sessionId;
    const scope = await resolveScope(context, args.scope);
    if (scope.mode === 'all') await requireSharedConfirmation(args, context, sessionId);
    await Promise.allSettled([...(engine.flowPersistence?.values() ?? [])]);
    const count = await engine.sessionStore.countScopedFlows({ sessionId, scope });
    const result = await engine.purgeScopedFlows({ sessionId, scope,
      before_sequence: args.before_sequence, older_than_ms: args.older_than_ms, all: clear || args.delete_session === true });
    let websocket_connections_cleared = 0;
    if (sessionId === engine.sessionId) {
      const snapshot = engine.webSocketStore.exportSnapshot();
      const kept = snapshot.connections.filter(c => !scope.predicate(c));
      websocket_connections_cleared = snapshot.connections.length - kept.length;
      if (websocket_connections_cleared) engine.webSocketStore.importSnapshot({ ...snapshot, connections: kept });
    }
    if ((args.delete_session || (clear && sessionId !== engine.sessionId)) && scope.mode === 'all') {
      await engine.sessionStore.purgeSession(sessionId);
    }
    return { status: args.delete_session && scope.mode === 'all' ? 'deleted' : 'cleared', session_id: sessionId,
      ...result, removed_count: result.purged, kept_other_clients_count: count.hidden, websocket_connections_cleared };
  }

  async function clear_session(args = {}, context = {}) {
    return removeScopedEvidence(args, context, { clear: true });
  }

  async function create_capture_session(args = {}) {
    if (args.activate && engine.isRunning()) throw Object.assign(new Error('Capture is running; use the active session or rename it without stopping capture.'), {
      code: 'SESSION_SWITCH_REQUIRES_STOPPED_PROXY', details: { active_session_id: engine.sessionId },
      recovery: ['Use get_flows with the existing session.', 'Use update_capture_session to rename the active session.', 'Create an inactive archive with activate=false.'],
    });
    const session = await engine.sessionStore.createSession({
      id: args.session_id,
      name: args.name,
      retention: args.retention,
      metadata: args.metadata,
    });
    if (args.activate) await engine.setActiveSession(session.id, { create: false });
    if (args.activate) await patchState({ active_session_id: session.id });
    return { session, active: engine.sessionId === session.id };
  }

  async function list_capture_sessions() {
    return { active_session_id: engine.sessionId, sessions: await engine.sessionStore.listSessions() };
  }

  async function select_capture_session(args = {}) {
    const session = await engine.setActiveSession(args.session_id, { name: args.name, create: args.create ?? true });
    await patchState({ active_session_id: session.id });
    return { status: 'selected', session };
  }

  async function update_capture_session(args = {}, context = {}) {
    const sessionId = args.session_id ?? engine.sessionId;
    const mine = await resolveScope(context, 'mine');
    const counts = await engine.sessionStore.countScopedFlows({ sessionId, scope: { ...mine, devices: [], domains: [] } });
    if (args.retention && counts.hidden > 0) {
      if (args.scope !== 'all') throw Object.assign(new Error('Shared retention requires scope: all and confirm_shared: true.'), { code: 'CONFIRM_SHARED_REQUIRED', details: { removed_count: counts.total, kept_other_clients_count: counts.hidden }, recovery: 'Pass scope: all and confirm_shared: true.' });
      await requireSharedConfirmation(args, context, sessionId);
    } else if (args.retention && args.scope === 'all') await requireSharedConfirmation(args, context, sessionId);
    const result = await engine.sessionStore.updateSession({
      sessionId,
      name: args.name,
      retention: args.retention,
      metadata: args.metadata,
      mergeMetadata: args.merge_metadata ?? true,
    });
    if (sessionId === engine.sessionId) engine.forgetPurgedFlows(result.retention?.removed_flow_ids ?? []);
    await Promise.all((result.retention?.removed_flow_ids ?? []).map((id) => deleteFlowBodies(id)));
    return { status: 'updated', ...result, removed_count: result.retention?.removed_flow_ids?.length ?? 0, kept_other_clients_count: args.retention ? (await engine.sessionStore.countScopedFlows({ sessionId, scope: { ...mine, devices: [], domains: [] } })).hidden : counts.hidden };
  }

  async function export_capture_session(args = {}, context = {}) {
    const sessionId = args.session_id ?? engine.sessionId;
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const scope = await resolveScope(context, args.scope);
    const counts = scope.mode === 'all' ? { hidden: 0 } : await engine.sessionStore.countScopedFlows({ sessionId, scope });
    const visible = scope.mode === 'all' ? null : new Set((await allSessionFlows(sessionId, scope)).map(f => f.id));
    const document = await engine.sessionStore.exportSession(sessionId);
    if (visible) document.session.flows = document.session.flows.filter(f => visible.has(f.id));
    let remainingBytes = MAX_EXPORTED_BODY_BYTES;
    let omittedBodies = 0;
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
        const body = await bodyForExport(stored, { includeSensitive, maxBytes: remainingBytes });
        delete exported.body_inline;
        delete exported.body_base64;
        if (body.omitted) {
          omittedBodies += 1;
          exported.body_omitted = true;
          exported.body_omission_reason = body.reason;
        } else {
          remainingBytes -= body.bytes;
          exported.body_omitted = false;
          delete exported.body_omission_reason;
          if (includeSensitive) {
            exported.body_base64 = body.buffer.toString('base64');
            exported.body_encoding = 'base64';
          } else {
            exported.body_inline = body.text;
            exported.body_encoding = 'utf8';
          }
        }
      }
    }
    document.redacted = !includeSensitive;
    const out = args.path
      ? await authorizeWritePath(args.path)
      : path.join(HAR_EXPORT_DIR, `${sessionId}-${Date.now()}.proxy-mate-session.json`);
    await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
    await fs.writeFile(out, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    return { ...scopeMeta(scope, counts.hidden), path: out, session_id: sessionId, flow_count: document.session.flows.length,
      omitted_body_count: omittedBodies, redacted: !includeSensitive };
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

  async function purge_capture_session(args = {}, context = {}) {
    if (args.delete_session && (args.session_id ?? engine.sessionId) === engine.sessionId && engine.isRunning()) throw new Error('Stop the proxy before deleting the active session.');
    return removeScopedEvidence(args, context);
  }

  async function allSessionFlows(sessionId, scope = null) {
    if (!await engine.sessionStore.getSession(sessionId)) return [];
    const flows = [];
    let cursor = null;
    do {
      const page = scope ? await scopedPage({ session_id: sessionId, cursor, limit: 1000 }, scope)
        : await engine.sessionStore.listFlows({ sessionId, cursor, limit: 1000 });
      flows.push(...page.flows);
      cursor = page.next_cursor;
    } while (cursor);
    return flows;
  }

  async function wait_for_flow(args = {}, context = {}) {
    const scope = await resolveScope(context, args.scope);
    let hidden = 0;
    const timeoutMs = args.timeout_ms ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    let cursor = args.cursor ?? null;
    let sinceFlowId = args.since_flow_id ?? null;
    if (!cursor && !sinceFlowId && !args.include_existing) sinceFlowId = engine.flowOrder.at(-1) ?? null;
    do {
      throwIfAborted(context.signal);
      const page = await scopedPage({
        session_id: args.session_id,
        cursor,
        since_flow_id: cursor ? undefined : sinceFlowId,
        limit: Math.min(args.limit ?? 100, 1000),
        filters: args,
      }, scope);
      hidden = page.hidden_count;
      const flow = page.flows.find((item) =>
        matchHost(item, args) && matchUrl(item, args) && matchMethod(item, args) && matchStatus(item, args));
      if (flow) return {
        ...scopeMeta(scope, hidden), matched: true,
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
    return { ...scopeMeta(scope, hidden), matched: false, timed_out: true, timeout_ms: timeoutMs, next_cursor: cursor };
  }

  async function get_diagnostics() {
    return {
      diagnostics: engine.diagnostics.slice(),
      memory: process.memoryUsage(),
      capture_queue_bytes: engine.captureQueuedBytes,
      capture_queue_limit_bytes: engine.maxCaptureQueuedBytes,
      capture_dropped_events: engine.captureDropped,
      flow_cache_bytes: engine.flowCacheBytes,
      flow_cache_limit_bytes: engine.maxFlowCacheBytes,
      log_retention: { max_file_bytes: 5 * 1024 * 1024, archives_per_stream: 3, interval_ms: 30000 },
      storage: await engine.sessionStore.storageStatus(),
      capture_storage_policy: engine.captureBodyMode,
      persistence_queue_depth: engine.flowPersistence.size,
      persistence_queue_limit: engine.maxPendingPersistence,
      persistence_queue_high_water_mark: engine.persistenceHighWaterMark,
      persistence_backpressure_waits: engine.persistenceBackpressureWaits,
      persistence_health: engine.persistenceHealth(),
    };
  }

  async function list_websocket_connections(args = {}, context = {}) {
    const scope = await resolveScope(context, args.scope);
    const store = engine.webSocketStore;
    const matching = store.connectionOrder.map(id => store.connections.get(id)).filter(Boolean)
      .filter(c => !args.state || c.state === args.state)
      .filter(c => !args.url_contains || (c.request?.url ?? '').toLowerCase().includes(args.url_contains.toLowerCase()));
    const visible = matching.filter(scope.predicate);
    const limit = args.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    return { ...scopeMeta(scope, matching.length - visible.length), total: visible.length,
      connections: visible.slice(-Math.min(limit, 1000)).reverse().map(c => store.getConnection({ connectionId: c.id,
        includeSensitive })) };
  }

  async function get_websocket_connection(args = {}) {
    const connection = engine.webSocketStore.getConnection({
      connectionId: args.connection_id,
      includeSensitive: requireSensitiveAccess(args.include_sensitive ?? false),
    });
    if (!connection) throw new Error(`WebSocket connection not found: ${args.connection_id}`);
    return connection;
  }

  async function get_websocket_messages(args = {}, context = {}) {
    const scope = await resolveScope(context, args.scope);
    const connection = engine.webSocketStore.getConnection({ connectionId: args.connection_id });
    if (connection && !scope.predicate(connection)) return { ...scopeMeta(scope, 1), messages: [], has_more: false, next_cursor: null };
    return { ...scopeMeta(scope), ...engine.webSocketStore.listMessages({
      connectionId: args.connection_id,
      cursor: args.cursor,
      limit: args.limit,
      direction: args.direction,
      contains: args.contains,
      includeSensitive: requireSensitiveAccess(args.include_sensitive ?? false),
    }) };
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
    error.recovery = [`Set ${TRANSFORM_PLUGIN_GRANT_ENV}=1 only for a trusted local proxy-mate deployment, then restart the server.`];
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

  async function mock_json_response(args = {}) {
    return create_map_local({ rule_id: args.rule_id, url: args.url, method: args.method ?? 'GET',
      status: args.status ?? 200, priority: args.priority, headers: args.headers,
      owner: args.owner, match_scope: args.match_scope, match_headers: args.match_headers,
      body: encodeAgentJson(args.json), content_type: 'application/json; charset=utf-8' });
  }

  async function patch_mock_json(args = {}) {
    const current = engine.listRuleConfigs().find((rule) => rule.rule_id === args.rule_id);
    if (!current || current.type !== 'map_local' || current.directory) throw new Error('Select an existing non-directory Map Local rule.');
    // Existing caller-provided fixture values are not captured credentials.
    // Preserve them while editing; ordinary tool output redaction still applies.
    const body = await readBodyBytes({ body_path: current.body_file, body_inline: current.body_inline });
    let json;
    try { json = JSON.parse(body.toString('utf8')); } catch { throw Object.assign(new Error('The mock body is not valid JSON.'), { code: 'INVALID_JSON_BODY' }); }
    return update_rule({ rule_id: args.rule_id, patch: { body: encodeAgentJson(mergeJsonPatch(json, args.patch)), content_type: 'application/json; charset=utf-8' } });
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

  async function create_breakpoint(args = {}, context = {}) {
    const scope = args.scope ?? (owner(context).client_id === LEGACY_CLIENT_ID ? 'all' : 'mine');
    if (!['mine', 'all'].includes(scope)) throw new Error('scope must be mine or all');
    await ensureProxyRunning();
    const url = args.url ?? args.url_pattern;
    if (!url) throw new Error('url or url_pattern is required');
    const rule = await engine.registerRule({
      ...args,
      type: 'breakpoint',
      owner: owner(context), scope,
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

  function publicRule(rule, context) {
    const mine = !!rule.owner && owned(rule.owner, context);
    return { ...rule, owner: mine ? rule.owner : rule.owner ? { mine: false } : null, mine };
  }

  async function assertRuleOwner(rule, args, context) {
    if (!rule?.owner || owned(rule.owner, context) || args.force === true) return;
    await captureLease.summary(context);
    const liveLease = Object.values(captureLease.snapshot.leases).some(l => owned(l, rule.owner));
    const liveClaim = (await claims.listClaims()).some(c => owned(c, rule.owner));
    if (liveLease || liveClaim || clientRegistry?.isAlive(rule.owner.client_id)) {
      throw Object.assign(new Error('Rule belongs to another live owner. Choose another rule_id or wait for its owner to finish.'), {
        code: 'RULE_CONFLICT', recovery: ['Choose a different rule_id. For an intentional mutation, use force: true.'],
      });
    }
  }

  async function list_rules(args = {}, context = {}) {
    return { rules: engine.listRuleConfigs().map(r => publicRule(r, context)) };
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

  async function reorder_rules(args = {}, context = {}) {
    const previous = engine.listRuleConfigs();
    const requested = args.rule_ids ?? [];
    const ordered = [...requested.map(id => previous.find(r => r.rule_id === id)), ...previous.filter(r => !requested.includes(r.rule_id))];
    for (const [order, rule] of ordered.entries()) {
      if (rule && (rule.order !== order || requested.includes(rule.rule_id))) await assertRuleOwner(rule, args, context);
    }
    const rules = await engine.reorderRules(args.rule_ids);
    await persistRules();
    return { status: 'reordered', rules };
  }

  async function test_rule(args = {}) {
    if (args.rule_id) return engine.testRuleMatch(args.rule_id, args.request ?? {});
    return engine.explainRuleMatch(args.request ?? {});
  }

  async function clear_rules_tool(args = {}, context = {}) {
    const rules = engine.listRuleConfigs();
    if (args.scope === 'all' && args.confirm_shared !== true) {
      throw Object.assign(new Error('Clearing all rules requires confirm_shared: true.'), {
        code: 'CONFIRM_SHARED_REQUIRED', details: { total: rules.length,
          mine: rules.filter(r => r.owner && owned(r.owner, context)).length,
          foreign: rules.filter(r => r.owner && !owned(r.owner, context)).length,
          unowned: rules.filter(r => !r.owner).length },
      });
    }
    if (args.scope === 'all') await engine.clearRules();
    else for (const r of rules) if (!r.owner || owned(r.owner, context)) await engine.removeRule(r.rule_id);
    await persistRules();
    return { status: 'cleared' };
  }

  async function export_rules(args = {}, context = {}) {
    const outputPath = args.path ? await authorizeWritePath(args.path) : undefined;
    const dest = await exportRulesTo(engine.listRuleConfigs().map(r => publicRule(r, context)), outputPath);
    return { path: dest, count: engine.listRuleConfigs().length };
  }

  async function import_rules(args = {}, context = {}) {
    await ensureProxyRunning();
    if (!args.path) throw new Error('path is required');
    const sourcePath = await authorizeReadPath(args.path);
    const rules = await importRulesFrom(sourcePath);
    // Validate all collisions before removing any existing definitions.
    for (const r of rules) await assertRuleOwner(engine.listRuleConfigs().find(x => x.rule_id === r.rule_id), {}, context);
    if (args.replace) await clear_rules_tool(args, context);
    const registered = [];
    const failed = [];
    for (const r of rules) {
      try { registered.push(await engine.registerRule(await authorizeRulePaths({ ...r, owner: owner(context), match_scope: args.match_scope ?? r.match_scope ?? 'all' }))); }
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

  async function get_flows(args = {}, context = {}) {
    const scope = await resolveScope(context, args.scope);
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const limit = args.limit ?? 10;
    const offset = args.offset ?? 0;
    if (args.cursor || args.since_flow_id || args.session_id) {
      const page = await scopedPage({
        session_id: args.session_id,
        cursor: args.cursor,
        since_flow_id: args.since_flow_id,
        limit,
        filters: args,
      }, scope);
      const filtered = page.flows
        .filter((flow) => matchHost(flow, args) && matchUrl(flow, args) && matchMethod(flow, args) && matchStatus(flow, args))
        .map((flow) => flowSummary(flow, { includeSensitive, view: args.view ?? 'compact' }));
      return {
        ...scopeMeta(scope, page.hidden_count), flows: filtered, view: args.view ?? 'compact',
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
    const hidden = matching.filter(f => !scope.predicate(f)).length;
    const visible = matching.filter(scope.predicate);
    const items = visible.slice(offset, offset + limit)
      .map((flow) => flowSummary(flow, { includeSensitive, view: args.view ?? 'compact' }));
    return { ...scopeMeta(scope, hidden), flows: items, view: args.view ?? 'compact', offset, limit, total: visible.length, has_more: visible.length > offset + items.length };
  }

  async function get_flow_detail(args = {}, context = {}) {
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const f = await engine.getDurableFlow(args.flow_id, args.session_id);
    if (!f) throw new Error(`flow not found: ${args.flow_id}`);
    const scope = await resolveScope(context, args.scope);
    if (!scope.predicate(f)) throw Object.assign(new Error('Flow belongs to another client; pass scope: all to read it.'), { code: 'FLOW_OUT_OF_SCOPE', recovery: 'pass scope: all' });
    const bodyMode = args.body_mode ?? (args.full_body ? 'full' : 'preview');
    const detail = flowDetailForReturn(f, {
      full: bodyMode === 'full', includeSensitive,
      previewBytes: args.preview_bytes ?? 2048,
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
    return { ...detail, ...scopeMeta(scope) };
  }

  async function filter_flows(args = {}, context = {}) {
    const scope = await resolveScope(context, args.scope);
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const conditions = Array.isArray(args.conditions) ? args.conditions : [];
    const combination = (args.combination ?? 'AND').toUpperCase();
    if (conditions.length === 0) throw new Error('conditions must be a non-empty array');
    const pageSize = args.limit ?? 10;
    let sourceFlows;
    let page = null;
    if (args.session_id || args.cursor || args.since_flow_id) {
      page = await scopedPage({
        session_id: args.session_id,
        cursor: args.cursor,
        since_flow_id: args.since_flow_id,
        limit: pageSize,
      }, scope);
      sourceFlows = page.flows;
    } else {
      sourceFlows = engine.flowOrder.slice().reverse().map((id) => engine.flows.get(id)).filter(Boolean);
    }
    const hidden = page?.hidden_count ?? sourceFlows.filter(f => !scope.predicate(f)).length;
    sourceFlows = sourceFlows.filter(scope.predicate);
    const results = [];
    for (const flow of sourceFlows) {
      if (results.length >= pageSize) break;
      const checks = conditions.map((condition) => matchFlowCondition(flow, condition));
      const matches = combination === 'OR' ? checks.some(Boolean) : checks.every(Boolean);
      if (matches) results.push(flowSummary(flow, { includeSensitive, view: args.view ?? 'compact' }));
    }
    return {
      ...scopeMeta(scope, hidden), flows: results, view: args.view ?? 'compact',
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
      headers: replayHeaders(flow.request.headers, includeSensitive),
      body: ['GET', 'HEAD'].includes(flow.request.method?.toUpperCase()) ? undefined : await capturedBody(flow.request, includeSensitive),
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
        ...replayHeaders(flow.request.headers, includeSensitive),
        ...(args.json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(args.headers ?? {}),
      },
      body: args.body ?? (args.json !== undefined || args.form !== undefined || ['GET', 'HEAD'].includes((args.method ?? flow.request.method)?.toUpperCase()) ? undefined : await capturedBody(flow.request, includeSensitive)),
      json: args.json,
      form: args.form,
      timeout_ms: args.timeout_ms,
      signal: context.signal,
    });
  }

  async function compare_flows(args = {}, context = {}) {
    const left = await engine.getDurableFlow(args.left_flow_id, args.session_id);
    const right = await engine.getDurableFlow(args.right_flow_id, args.session_id);
    if (!left) throw flowNotFound(args.left_flow_id);
    if (!right) throw flowNotFound(args.right_flow_id);
    const scope = await resolveScope(context, args.scope);
    if (![left, right].every(scope.predicate)) throw Object.assign(new Error("Flow out of scope; pass scope: all"), { code: "FLOW_OUT_OF_SCOPE" });
    return {
      ...scopeMeta(scope), left_flow_id: left.id,
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

  async function analyze_capture(args = {}, context = {}) {
    const sessionId = args.session_id ?? engine.sessionId;
    const scope = await resolveScope(context, args.scope);
    const counts = await engine.sessionStore.countScopedFlows({ sessionId, scope });
    const flows = await allSessionFlows(sessionId, scope);
    return {
      ...scopeMeta(scope, counts.hidden), session_id: sessionId,
      ...analyzeFlows(flows, {
        slow_limit: args.slow_limit,
        group_limit: args.group_limit,
        include_successes: args.include_successes,
      }),
    };
  }

  async function assert_capture(args = {}, context = {}) {
    const analysis = await analyze_capture(args, context);
    return { scope_applied: analysis.scope_applied, hidden_count: analysis.hidden_count, analysis, assertions: evaluateCaptureAssertions(analysis, args.assertions ?? {}) };
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

  // Flow bodies may have been spilled to proxy-mate's private state directory.
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
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const { flow_id, kind = 'res', path: destPath } = args;
    const f = await engine.getDurableFlow(flow_id, args.session_id);
    if (!f) throw new Error(`flow not found: ${flow_id}`);
    const part = kind === 'req' ? f.request : f.response;
    if (!part) throw new Error(`flow has no ${kind}`);
    const body = await bodyForExport(part, { includeSensitive });
    if (body.omitted) throw Object.assign(new Error(`Cannot export body: ${body.reason}`), {
      code: 'BODY_UNAVAILABLE', recovery: ['Use get_flow_detail for capture metadata and omission details.'],
    });
    let dest = destPath ? await authorizeWritePath(destPath) : null;
    if (!dest) {
      const dir = path.join(STATE_DIR, 'exports');
      await fs.mkdir(dir, { recursive: true });
      const safeId = String(f.id ?? flow_id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
      dest = path.join(dir, `${safeId}.${kind}.${includeSensitive ? 'bin' : 'txt'}`);
    }
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await fs.writeFile(dest, body.buffer, { mode: 0o600 });
    await fs.chmod(dest, 0o600);
    return { path: dest, size: body.bytes, sha: crypto.createHash('sha256').update(body.buffer).digest('hex'),
      captured_size: part.body_size, captured_sha: part.body_sha, redacted: !includeSensitive };
  }

  async function query_flow_json(args = {}) {
    const flow = await engine.getDurableFlow(args.flow_id, args.session_id);
    if (!flow) throw flowNotFound(args.flow_id);
    const part = args.kind === 'req' ? flow.request : flow.response;
    const body = await bodyForExport(part);
    if (body.omitted) throw Object.assign(new Error(`JSON query unavailable: ${body.reason}`), { code: 'BODY_UNAVAILABLE' });
    let document;
    try { document = JSON.parse(body.text); }
    catch { throw Object.assign(new Error('The captured body is not a complete JSON document.'), {
      code: 'BODY_NOT_JSON', recovery: ['Inspect Content-Type/omission metadata or use save_body_to_file.'],
    }); }
    return { flow_id: flow.id, kind: args.kind ?? 'res', redacted: true,
      ...inspectJson(document, args) };
  }

  async function finish_capture_task(args = {}, context = {}) {
    const lease = await captureLease.assert(args.capture_lease_id, context, [], args.task_id);
    if (!lease) throw Object.assign(new Error('Acquire the task lease before using task cleanup. Legacy fixtures must be removed by their explicit IDs.'), {
      code: 'TASK_LEASE_REQUIRED', recovery: ['Use acquire_capture_lease for new task resources; never infer ownership from a broad ID prefix.'],
    });
    const removed = [], retained = [];
    let storedRules = engine.isRunning() ? null : await loadRules();
    let storedChanged = false;
    for (const resource of lease.resources ?? []) {
      const config = resource.kind === 'rule'
        ? (storedRules ?? engine.listRuleConfigs()).find((rule) => rule.rule_id === resource.id)
        : reverseProxies.list().find((proxy) => proxy.id === resource.id);
      if (!config) continue;
      if (args.keep_resources || resourceRevision(config) !== resource.revision) { retained.push({ kind: resource.kind, id: resource.id }); continue; }
      if (resource.kind === 'rule' && storedRules) {
        storedRules = storedRules.filter((rule) => rule.rule_id !== resource.id);
        await saveRules(storedRules);
        storedChanged = true;
        if (!storedRules.some((rule) => rule.body_file === config.body_file)) await removeOwnedMockBody(config.body_file);
      } else if (resource.kind === 'rule') await remove_rule({ rule_id: resource.id });
      else await reverseProxies.remove(resource.id);
      removed.push({ kind: resource.kind, id: resource.id });
    }
    const lease_status = await captureLease.finish(lease.lease_id, retained, context);
    return { kept: retained, orphaned: lease_status.orphaned_resources, lease_status, status: 'finished', task_id: lease.task_id, removed, retained, lease_released: true,
      capture_continues: engine.isRunning(), evidence_preserved: true, stored_rules_updated: storedChanged,
      next_actions: retained.length ? ['Retained resources were explicitly kept or changed since this task owned them. Inspect before removing them.'] : [] };
  }

  // Capture-to-mock — the Proxyman killer feature.
  async function capture_to_mock(args = {}) {
    await ensureProxyRunning();
    const { flow_id, rule_id, method, url_pattern, status, content_type } = args;
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const f = await engine.getDurableFlow(flow_id, args.session_id);
    if (!f) throw new Error(`flow not found: ${flow_id}`);
    if (!f.response) throw new Error('flow has no response yet');
    if (f.response.body_omitted) {
      throw Object.assign(new Error(`Cannot create a mock from an omitted response: ${f.response.body_omitted}`), { code: 'BODY_UNAVAILABLE' });
    }
    const id = rule_id ?? `capture-${flow_id}`;
    let captured = await capturedBody(f.response, includeSensitive);
    if (Object.hasOwn(args, 'json_merge_patch')) {
      let json;
      try { json = JSON.parse(captured.toString('utf8')); } catch { throw Object.assign(new Error('The captured response is not valid JSON.'), { code: 'INVALID_JSON_BODY' }); }
      captured = Buffer.from(encodeAgentJson(mergeJsonPatch(json, args.json_merge_patch)));
    }
    const bodyFile = await flowBodyToMockBody({
      ruleId: id,
      inlineText: captured,
    });
    // The captured URL goes through the same builder every other rule uses, so
    // the mock is anchored on the endpoint it was captured from. The old
    // escapeRegex(pathname) was unanchored and host-less, so a mock of
    // GET /v1/users also answered http://evil.test/x/v1/users/extra — and when
    // the URL failed to parse it fell back to the whole URL, query included.
    const rule = await engine.registerRule({
      rule_id: id, owner: args.owner, match_scope: args.match_scope,
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
  async function export_har(args = {}, context = {}) {
    const scope = await resolveScope(context, args.scope);
    let hidden = 0;
    const includeSensitive = requireSensitiveAccess(args.include_sensitive ?? false);
    const limit = args.limit ?? 200;
    let sourceFlows;
    if (args.session_id || args.since_flow_id || args.cursor) {
      sourceFlows = [];
      let cursor = args.cursor ?? null;
      let sinceFlowId = args.since_flow_id ?? null;
      do {
        const page = await scopedPage({
          session_id: args.session_id,
          cursor,
          since_flow_id: cursor ? undefined : sinceFlowId,
          limit: Math.min(1000, limit - sourceFlows.length),
        }, scope);
        hidden += page.hidden_count;
        sourceFlows.push(...page.flows);
        cursor = page.next_cursor;
        sinceFlowId = null;
      } while (cursor && sourceFlows.length < limit);
    } else {
      const all = engine.flowOrder.map(id => engine.flows.get(id)).filter(Boolean);
      hidden = all.filter(f => !scope.predicate(f)).length;
      sourceFlows = all.filter(scope.predicate).slice(-limit);
    }
    const entries = [];
    let remainingBytes = MAX_EXPORTED_BODY_BYTES;
    let omittedBodies = 0;
    const exportPart = async (part) => {
      const body = await bodyForExport(part, { includeSensitive, maxBytes: remainingBytes });
      if (body.omitted) omittedBodies += 1;
      else remainingBytes -= body.bytes;
      return body;
    };
    for (const f of sourceFlows) {
      const requestBody = f.request ? await exportPart(f.request) : null;
      const responseBody = f.response ? await exportPart(f.response) : null;
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
          postData: f.request?.body_size || f.request?.body_inline || f.request?.body_path || f.request?.body_base64 ? {
            mimeType: f.request?.headers?.['content-type'] ?? 'application/octet-stream',
            text: requestBody?.omitted ? '' : requestBody.text ?? requestBody.buffer.toString('base64'),
            ...(requestBody?.omitted ? { _proxy_mate_omitted: true, _proxy_mate_omission_reason: requestBody.reason } : {}),
            ...(includeSensitive && !requestBody?.omitted && requestBody.text === undefined ? { _encoding: 'base64' } : {}),
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
            text: responseBody.omitted ? '' : responseBody.text ?? responseBody.buffer.toString('base64'),
            encoding: !responseBody.omitted && responseBody.text === undefined ? 'base64' : undefined,
            ...(responseBody.omitted
              ? { _proxy_mate_omitted: true, _proxy_mate_omission_reason: responseBody.reason }
              : {}),
          },
          redirectURL: includeSensitive ? f.response.headers?.location ?? '' : redactUrl(f.response.headers?.location ?? ''),
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
        creator: { name: 'proxy-mate', version: SERVER_VERSION },
        entries,
      },
    };
    await fs.writeFile(out, JSON.stringify(har, null, 2), { mode: 0o600 });
    return { ...scopeMeta(scope, hidden), path: out, entry_count: entries.length, omitted_body_count: omittedBodies, redacted: !includeSensitive };
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
      onResult: async (result) => {
        simWatcherEvents.push({ ...result, timestamp: new Date().toISOString() });
        if (simWatcherEvents.length > 50) simWatcherEvents.splice(0, simWatcherEvents.length - 50);
      },
    });
    return { status: 'started', developer_dir: preflight.developer_dir, xcode_version: preflight.xcode_version };
  }
  async function stop_sim_watcher() {
    if (simWatchStop) { const stop = simWatchStop; simWatchStop = null; await stop(); return { status: 'stopped' }; }
    return { status: 'not_running' };
  }

  const tools = {
    // lifecycle
    start_proxy, start_app_capture, list_simulator_apps,
    stop_proxy: async (args = {}, context = {}) => { await guardGlobal(args, context); return stop_proxy(args); }, set_proxy_routing, clear_proxy_routing,
    start_operator_ui, stop_operator_ui, get_operator_ui_status,
    trust_ca_on_simulators: trust_ca_on_simulators_tool,
    setup_simulator_certificate, setup_xcode_preview_certificate,
    verify_simulator_certificate,
    setup_host_certificate, remove_host_certificate, rotate_certificate_authority, get_certificate_status,
    start_device_onboarding, stop_device_onboarding, diagnose_ios_capture,
    create_reverse_proxy, list_reverse_proxies, remove_reverse_proxy,
    restart_sim_apps: restart_sim_apps_tool,
    get_version, get_proxy_status, toggle_recording, get_started, search_docs, list_setup_workflows,
    get_ssl_proxying_list, enable_ssl_proxying,
    clear_session, get_diagnostics, wait_for_flow,
    list_websocket_connections, get_websocket_connection, get_websocket_messages,
    export_websocket_transcript, import_websocket_transcript, plan_websocket_replay,
    transform_websocket_transcript,
    create_capture_session, list_capture_sessions, select_capture_session, update_capture_session,
    export_capture_session, import_capture_session, purge_capture_session,
    // rules
    create_map_local, create_map_remote, create_blacklist, create_breakpoint,
    mock_json_response, patch_mock_json,
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
    save_body_to_file, query_flow_json, get_ca_cert_path,
    // safety
    kill_orphan_proxy, reconcile_state, export_har, import_har,
    // sim
    start_sim_watcher, stop_sim_watcher,
    acquire_capture_lease: (args, context) => captureLease.acquire(args, context),
    release_capture_lease: (args, context) => captureLease.release(args, context),
    finish_capture_task,
  };
  // Also serialize direct/in-process callers, which do not use control.mjs's
  // mutation queue. SSL read/merge and claim writes must remain one operation.
  let routingMutation = Promise.resolve();
  for (const name of ['start_proxy', 'set_proxy_routing', 'clear_proxy_routing', 'enable_ssl_proxying']) {
    const fn = tools[name];
    tools[name] = (...args) => {
      const result = routingMutation.then(() => fn(...args));
      routingMutation = result.catch(() => {});
      return result;
    };
  }
  let resourceMutation = Promise.resolve();
  for (const name of LEASE_PROTECTED_TOOLS) {
    const fn = tools[name];
    if (!fn) continue;
    const mutateResource = async (args = {}, context = {}) => {
      // Only resource mutations participate; global controls belong to their own policy.
      if (['finish_capture_task', 'resolve_breakpoint', 'cancel_breakpoint'].includes(name)) return fn(args, context);
      const defaults = {
        create_map_local: () => stableRuleId('map-local', args.url_pattern ?? args.url),
        mock_json_response: () => stableRuleId('map-local', args.url),
        create_map_remote: () => stableRuleId('map-remote', `${args.from_url ?? args.url}->${args.to_url}`),
        create_blacklist: () => stableRuleId('blacklist', args.url ?? args.url_pattern),
        create_network_condition: () => stableRuleId('network', `${args.url ?? '*'}:${args.profile ?? args.delay_ms ?? args.fault}`),
        create_no_cache_rule: () => stableRuleId('no-cache', args.url ?? '*'),
        create_breakpoint: () => stableRuleId('breakpoint', `${args.url ?? args.url_pattern}:${args.direction ?? 'request'}`),
        capture_to_mock: () => `capture-${args.flow_id}`,
        create_transform_plugin_rule: () => stableRuleId('plugin', `${args.plugin_id}:${args.url ?? args.url_pattern}`),
      };
      if (defaults[name] && !args.rule_id) {
        const namespace = crypto.createHash('sha256').update(JSON.stringify(owner(context))).digest('hex').slice(0, 20);
        args = { ...args, rule_id: name === 'create_breakpoint' ? defaults[name]() : `${namespace}-${defaults[name]()}` };
      }
      const ownedRuleTools = new Set(['create_map_local', 'mock_json_response', 'create_map_remote', 'create_blacklist',
        'create_network_condition', 'create_no_cache_rule', 'capture_to_mock', 'create_transform_plugin_rule']);
      const ruleMutations = new Set([...ownedRuleTools, 'patch_mock_json', 'update_rule', 'set_rule_enabled',
        'set_rule_priority', 'remove_rule', 'reorder_rules']);
      if (ownedRuleTools.has(name)) {
        args = { ...args, owner: owner(context), match_scope: args.match_scope ?? 'all' };
      }
      if (ruleMutations.has(name)) {
        for (const id of args.rule_ids ?? [args.rule_id]) {
          await assertRuleOwner(engine.listRuleConfigs().find(r => r.rule_id === id),
            ownedRuleTools.has(name) ? {} : args, context);
        }
        if (name === 'update_rule' && ('owner' in (args.patch ?? {}))) throw new Error('Rule owner cannot be patched');
      }
      const resources = [];
      if (args.rule_id) resources.push({ kind: 'rule', id: args.rule_id });
      if (name === 'reorder_rules') for (const id of args.rule_ids ?? []) resources.push({ kind: 'rule', id });
      if (name === 'import_rules' && args.path) {
        const imported = await importRulesFrom(await authorizeReadPath(args.path));
        for (const rule of imported) await assertRuleOwner(engine.listRuleConfigs().find(r => r.rule_id === rule.rule_id), {}, context);
        if (args.replace) for (const rule of engine.listRuleConfigs()) resources.push({ kind: 'rule', id: rule.rule_id });
      }
      if (['create_reverse_proxy', 'remove_reverse_proxy'].includes(name) && args.id) resources.push({ kind: 'reverse_proxy', id: args.id });
      if (!resources.length && !RULE_CREATORS.has(name) && !['create_reverse_proxy', 'import_rules'].includes(name)) return fn(args, context);
      const lease = await captureLease.assert(args.capture_lease_id, context, resources.filter(resource => {
        if (!ruleMutations.has(name) && name !== 'import_rules') return true;
        const rule = engine.listRuleConfigs().find(r => r.rule_id === resource.id);
        return !rule?.owner || owned(rule.owner, context);
      }));
      const priorRules = lease && (RULE_CREATORS.has(name) || name === 'import_rules') ? new Set(engine.mockRules.keys()) : null;
      const result = await fn(args, context);
      if (lease && name !== 'finish_capture_task') {
        if (name === 'import_rules') for (const config of engine.listRuleConfigs()) {
          if (owned(config.owner ?? {}, context) && (!priorRules.has(config.rule_id)
            || lease.resources?.some(r => r.kind === 'rule' && r.id === config.rule_id))) {
            await captureLease.trackResource(lease.lease_id, { kind: 'rule', id: config.rule_id, revision: resourceRevision(config) });
          }
        }
        const ruleId = result?.rule_id ?? result?.rule?.rule_id ?? args.rule_id;
        const ownedRule = ruleId && lease.resources?.some((resource) => resource.kind === 'rule' && resource.id === ruleId);
        if (ruleId && (priorRules && !priorRules.has(ruleId) || ownedRule)) {
          const config = engine.listRuleConfigs().find((rule) => rule.rule_id === ruleId);
          if (config) await captureLease.trackResource(lease.lease_id, { kind: 'rule', id: ruleId, revision: resourceRevision(config) });
        }
        if (name === 'create_reverse_proxy') await captureLease.trackResource(lease.lease_id,
          { kind: 'reverse_proxy', id: result.id, revision: resourceRevision(result) });
      }
      if (ruleMutations.has(name) && result?.rule) return { ...result, rule: publicRule(result.rule, context) };
      if (name === 'reorder_rules') return { ...result, rules: result.rules.map(r => publicRule(r, context)) };
      return result;
    };
    tools[name] = (args = {}, context = {}) => {
      const result = resourceMutation.then(() => mutateResource(args, context));
      resourceMutation = result.catch(() => {});
      return result;
    };
  }
  // The daemon must still release sockets/routing on SIGTERM while a task
  // holds a lease. Symbols are never addressable through JSON-RPC tool names.
  Object.defineProperty(tools, INTERNAL_CAPTURE_CONTROL, { value: { stop_proxy, start_sim_watcher } });
  Object.defineProperty(tools, INTERNAL_PRESENCE_LOST, { value: presenceLost });
  Object.defineProperty(tools, INTERNAL_ROUTING_CONTROL, { get: routingController });
  if (mode === 'daemon') for (const [name, fn] of Object.entries(tools)) {
    tools[name] = async (args = {}, context = {}) => {
      const result = await fn(args, context);
      const status = await routingSnapshot();
      const claim = status.claims.find(c => owned(c, context));
      if (!claim || claim.state === 'active' || !result || typeof result !== 'object') return result;
      return { ...result, routing_warning: { state: claim.state,
        reason: claim.state === 'expired' ? 'lease_expired' : status.routing_lost_reason ?? 'daemon_restart',
        claim_id: claim.claim_id, recovery: 'Re-arm your routing with set_proxy_routing; call clear_proxy_routing when done.' } };
    };
  }
  return tools;
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
  return Object.fromEntries(Object.entries(redactHeaders(headers)).filter(([name]) =>
    !/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|host|content-length|content-encoding|transfer-encoding)$/i.test(name)));
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
