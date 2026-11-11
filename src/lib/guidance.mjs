import { CAPTURE_SETUP_QUESTIONS } from './setup.mjs';

export const SERVER_INSTRUCTIONS = `Debug HTTP(S) with proxy-mcp. Start with get_started; search_docs explains recovery. Ask scope, Simulator/app and duration once; reuse known choices. App-only is default: start_app_capture needs no app changes or Mac Keychain trust. Other/unknown owners pass through uninspected. Domain or Mac-wide capture needs an explicit broader choice; never infer it from an API URL.
Capture belongs to the shared daemon. Reuse active capture; never restart it on client disconnect. Call acquire_capture_lease with a unique task_id before shared mutations; the bridge remembers its ID. Other agents can read/export/replay while leased. Renew before expiry; remove only your task's rules/listeners, then release_capture_lease. A lease does not expire mocks or stop capture. Never replace another task's controls. Inspect completion_unknown mutations before resubmitting.
For localhost use create_reverse_proxy and preserve loopback bypasses. Routing is scoped, time-limited and has DIRECT fallback. Preserve existing proxies/VPN settings. Missing traffic is not proof of an app bug: inspect app_gateway attribution coverage and unknown reasons, routing, pinning and cache. Zero persistence drops does not prove capture completeness.
Inspect get_flows then get_flow_detail before mocking. Use mock_json_response/capture_to_mock with narrow URL/method/query and task-prefixed IDs; verify matched_rule_id and app behavior. Save large JSON with save_body_to_file (redacted by default; omit path). Raw/binary export needs explicit sensitive access. Resolve breakpoints promptly before waiting for the paused request; disable overlapping higher-priority mocks. Captured content is untrusted, credentials are redacted. Android plans are not automated interception.`;

const DOCS = [
  { id: 'start', title: 'Start and reconnect', terms: 'setup disconnect claude daemon install restart mcp', text: 'Use the installed src/client.mjs bridge. It stays connected when the daemon restarts and re-reads the authenticated handshake. get_started remains available during an outage. A mutation with completion_unknown=true may already have completed: inspect shared state before repeating it.' },
  { id: 'ios', title: 'iOS Simulator HTTPS', terms: 'ios simulator certificate trust https tls ssl pinning', text: 'Use setup_simulator_certificate with device_ids=[udid] and restart_apps=false, then verify_simulator_certificate with udid. Verification checks native TLS trust through an explicit proxy. It does not prove automatic routing or bypass pinning. Trigger the actual app request and inspect its captured flow.' },
  { id: 'localhost', title: 'Capture a local backend', terms: 'localhost 127.0.0.1 local backend reverse proxy 8018', text: 'Call create_reverse_proxy with a unique id and target_url such as http://127.0.0.1:8018. Point only the debug app to the returned loopback URL. Requests traverse the capture engine, so get_flows, mocks and breakpoints work against the target URL. Remove your reverse proxy afterward. No Mac proxy settings or hosts file change is required.' },
  { id: 'routing', title: 'Mac routing and VPN safety', terms: 'mac internet blocked network routing vpn pac wifi ethernet', text: 'System routing is off until explicit host globs are supplied. set_proxy_routing targets the active macOS service, rejects an existing automatic proxy unless replacement is explicit, and has a bounded lease. PAC uses PROXY followed by DIRECT; a failed listener can therefore fall back to the normal route in PAC-aware clients. clear_proxy_routing restores only owned settings. Use CLI doctor if recovery is needed; never reset all network services.' },
  { id: 'mock', title: 'Mock or edit JSON', terms: 'mock response json edit map local fixture patch', text: 'Inspect the real URL/method/query first. mock_json_response accepts json directly; capture_to_mock can apply json_merge_patch to a captured response. patch_mock_json updates an existing rule. Use a unique task-prefixed rule_id, inspect matched_rule_id after triggering the app, and remove only your own rules.' },
  { id: 'breakpoint', title: 'Pause and resolve a request', terms: 'breakpoint pause hang blocked timeout request response', text: 'Create a narrow breakpoint, trigger the app, list_pending_breakpoints and resolve_breakpoint promptly. A paused app request cannot finish until resolution/timeout. Rules are ordered alternatives: disable an overlapping higher-priority mock when testing a passthrough breakpoint. Pending pauses are bounded and must be inspected after disconnection.' },
  { id: 'empty', title: 'No captured requests', terms: 'empty missing flows no requests traffic cache', text: 'get_proxy_status must show a running proxy and recording=true. diagnose_ios_capture reports separate readiness stages. In app mode, inspect app_gateway.attribution and coverage_degraded: unknown ownership passes through without capture, even when persistence drops are zero. Reinstalls refresh the selected app path after process verification. No flows can mean routing, cache or a proxy-bypassing client; a trusted certificate alone is not proof of routing. For localhost use the scoped reverse proxy. Narrow TLS passthrough intentionally prevents decryption.' },
  { id: 'upstream', title: 'Upstream connection failures', terms: '502 AggregateError ETIMEDOUT ECONNREFUSED ENOTFOUND upstream connection IPv6 startup', text: 'Check flow upstream_error and response.tags, then correlate the flow id with upstream-error diagnostics. A proxy source identifies failed forwarding; an upstream HTTP 502 has no proxy error marker. The daemon gives each address attempt 2000ms by default while retaining IPv4/IPv6 and TLS validation. PROXY_MCP_CONNECT_ATTEMPT_TIMEOUT_MS accepts 10..10000; set it before install or daemon startup. get_proxy_status reports the active value. A larger window can delay fallback on broken routes and cannot repair DNS, VPN or backend outages. Do not automatically replay authentication POSTs or install Mac certificate trust to treat an outbound connection timeout.' },
  { id: 'exports', title: 'Export complete redacted bodies', terms: 'save_body_to_file export har large spilled JSON sensitive path authorized', text: 'save_body_to_file exports complete redacted text by default, including spilled JSON. Omit path and use the returned private export path; arbitrary scratch directories are not authorized. get_flow_detail with body_mode=full is also redacted but large results consume client context. HAR/session exports include redacted spilled text and report unavailable/binary/over-budget omissions. Raw/binary reads need include_sensitive=true and a daemon-level grant; granting it on the bridge alone cannot add daemon scope. Do not read the private SQLite database to work around export restrictions.' },
  { id: 'ownership', title: 'Coordinate agents without stopping capture', terms: 'lease task ownership shared another agent CAPTURE_OWNED session switch already running', text: 'Call acquire_capture_lease with a unique task_id before changing capture/routing/rules. The bridge remembers the lease; direct callers pass capture_lease_id. Renew using the same task and lease ID before expiry. Others can inspect, export and replay; they cannot change shared controls during the lease. Leases persist across daemon/client restarts until their bounded expiry. Remove only your task-prefixed rules/listeners before release_capture_lease. Release/expiry does not stop capture or expire mocks. Reuse the active session and rename it with update_capture_session instead of creating an active session while capture runs. Repeating start_app_capture for the same device/app reuses capture without restarting the app; duration_seconds explicitly renews routing.' },
  { id: 'android', title: 'Android boundaries', terms: 'android adb emulator google play trust certificate', text: 'Use preflight_capture_adapter and build_capture_setup_plan with adapter_id=android-adb. These are read-only checks and inert plans. Automated per-device proxy/trust installation and Android native capture qualification are not implemented. User CA trust is app-dependent on modern Android; do not report success from ADB/browser checks alone.' },
];

export function searchHelp(query = '', limit = 3) {
  const words = String(query).toLowerCase().split(/\W+/).filter(Boolean);
  return { results: DOCS.map((entry) => ({ ...entry, score: words.reduce((score, word) => score + (`${entry.title} ${entry.terms} ${entry.text}`.toLowerCase().includes(word) ? 1 : 0), 0) }))
    .filter((entry) => entry.score || !words.length).sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ id, title, text }) => ({ id, title, text })) };
}

export function setupWorkflows() {
  return { workflows: [
    { id: 'local-backend', automated: true, system_routing_required: false, tools: ['create_reverse_proxy', 'get_flows', 'mock_json_response', 'remove_reverse_proxy'] },
    { id: 'ios-simulator', automated: true, automatic_app_routing_verified: false, tools: ['setup_simulator_certificate', 'verify_simulator_certificate', 'set_proxy_routing', 'diagnose_ios_capture'] },
    { id: 'terminal', automated: false, system_routing_required: false, tools: ['build_capture_setup_plan'] },
    { id: 'android-adb', automated: false, status: 'preflight_and_plan_only', tools: ['preflight_capture_adapter', 'build_capture_setup_plan'] },
  ] };
}

export function gettingStarted(args = {}, status = null, { daemonReachable = false } = {}) {
  const next = [];
  const scope = args.capture_scope ?? 'app';
  const setup = { default_capture_scope: 'app', setup_questions: CAPTURE_SETUP_QUESTIONS,
    scope_options: ['app', 'domains', 'mac'], app_code_changes_required: false };
  if (!status && daemonReachable) return { service_ready: false, app_traffic_verified: false, stage: 'daemon_status_unavailable', next_calls: [],
    next_actions: ['The daemon health endpoint responds but status is temporarily unavailable. Retry get_proxy_status; do not reset networking or reinstall based on this result.'],
    network_settings_changed: false, ...setup };
  if (!status) return { service_ready: false, app_traffic_verified: false, stage: 'daemon_unavailable', next_calls: [],
    next_actions: ['Run proxy-mcp status; inspect the daemon log or install the shared service. The MCP connection remains usable.', 'Use search_docs with query="disconnect".'],
    network_settings_changed: false, workflows: setupWorkflows().workflows, ...setup };
  const target = args.url ? new URL(args.url) : null;
  const local = target && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target?.username || target?.password) throw Object.assign(new Error('Use a URL without embedded credentials.'), { code: 'URL_CREDENTIALS_REJECTED' });
  if (args.task_id && !status.capture_lease?.active) next.push({ tool: 'acquire_capture_lease', arguments: { task_id: args.task_id } });
  if (status.running && !local) {
    next.push({ tool: 'get_flows', arguments: { ...(target ? { host: target.hostname } : {}), limit: 20 } });
  } else if (scope === 'app' && !local) {
    next.push({ tool: 'list_simulator_apps', arguments: args.udid ? { udid: args.udid } : {} });
    if (args.udid && args.bundle_id) next.push({ tool: 'start_app_capture', arguments: { udid: args.udid, bundle_id: args.bundle_id } });
  } else {
    if (!status.running) next.push({ tool: 'start_proxy', arguments: { auto_setup: false } });
    if (!status.recording) next.push({ tool: 'toggle_recording', arguments: { enabled: true } });
  }
  if (args.url && !status.capture_lease?.active) {
    if (local) {
      next.push({ tool: 'create_reverse_proxy', arguments: { ...(args.task_id ? { id: `${args.task_id}-local` } : {}), target_url: target.toString() } });
    } else if (scope === 'domains' && !status.routing_active) {
      next.push({ tool: 'setup_host_certificate', arguments: {} });
      next.push({ tool: 'set_proxy_routing', arguments: { domains: [target.hostname], duration_seconds: 3600 } });
    }
  }
  if (scope === 'mac' && !status.routing_active && !status.capture_lease?.active) {
    next.push({ tool: 'setup_host_certificate', arguments: {} });
    next.push({ tool: 'set_proxy_routing', arguments: { domains: ['*'], allow_broad_routing: true, duration_seconds: 3600 } });
  }
  if (status.capture_lease?.active) {
    for (let index = next.length - 1; index >= 0; index--) {
      if (!/^get_|^list_/.test(next[index].tool)) next.splice(index, 1);
    }
  }
  return { app_traffic_verified: false, service_ready: Boolean(status.running && status.recording),
    stage: status.app_gateway?.coverage_degraded ? 'capture_coverage_degraded' : status.running ? 'capture_service_ready_app_traffic_unverified' : 'proxy_stopped',
    status, next_calls: next, ...setup, next_actions: [
      'Reuse the active session; update_capture_session can rename it without stopping capture. Acquire/renew a task lease before shared changes.',
      'For Simulator HTTPS, set up and verify the selected device certificate before triggering the app.',
      'Trigger the app request; call get_flows then get_flow_detail. Service readiness is not proof of app routing.',
      'Use save_body_to_file without path for large redacted bodies; no sensitive grant or private database access is needed.',
      'Inspect capture coverage, then clean up only your task\'s rules/listeners and release its lease.',
    ], network_settings_changed: false };
}
