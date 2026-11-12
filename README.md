# proxy-mcp

`proxy-mcp` is a local MCP server for capturing, inspecting, replaying, and mocking HTTP(S) traffic from macOS, Xcode Simulators, and trusted Apple devices. It is built for agent workflows: durable sessions, small structured results, headless breakpoints, safe defaults, and no required GUI.

Requires macOS and Node.js 22 or newer. Use a maintained LTS release; Node 24 is the recommended local runtime.

## Install

```bash
npm ci
node src/server.mjs install --no-routing --no-trust-ca
```

`install` creates a shared capture LaunchAgent and an independent recovery guardian, prepares a machine-local CA, and waits for authenticated readiness without `sudo`. This example keeps system routing and automatic Simulator imports off. Add a specific Simulator through the MCP setup tools. Omitting `--domains` leaves routing off; all-host routing requires both `--domains '*'` and `--allow-broad-routing`.

Mac Keychain trust and automatic Simulator certificate imports are off by default. To set up capture, boot a Simulator and run `node src/server.mjs setup`, or select the `set-up-capture` MCP prompt in chat. Both guide you through scope, simulator, app and routing duration, with app-only capture selected by default. App mode needs no app code changes or API-host list: it attributes local proxy connections to the selected app and Simulator before allowing inspection. Other and unidentified connections bypass interception and storage. It imports/verifies the CA only on the selected Simulator, without changing Mac Keychain trust. System proxy routing still uses a local gateway; this is not a per-app VPN.

Background networking helpers that cannot be attributed are left uninspected, and certificate pinning can prevent HTTPS inspection. Localhost APIs use the separate reverse-proxy workflow. Selected-domain and Mac-wide capture are advanced choices; Mac trust, when needed, requires explicit approval and a native explanation before the system password dialog. Use `--trust-host-ca` only when deliberately enabling Mac certificate trust.

Use a stable checkout path (not a temporary directory), an actively supported Node.js LTS release, and a full Xcode installation. Installation snapshots the runtime and dependencies under `~/.proxy-mcp/runtime`, so launchd does not need to read a protected Documents/Desktop checkout. Re-run `install` after code/dependency upgrades; the daemon does not run directly from your edited source. See the [iOS Simulator setup and recovery guide](docs/IOS_SIMULATOR_SETUP.md) for the complete, Proxyman-style workflow.

Add the server to your MCP client:

```json
{
  "mcpServers": {
    "proxy-mcp": {
      "command": "/opt/homebrew/opt/node@24/bin/node",
      "args": ["/Users/YOUR_USER/.proxy-mcp/runtime/current/src/client.mjs"]
    }
  }
}
```

Use the absolute Node executable and the `mcp_client_path` reported by install. The thin bridge never owns capture or changes network settings. Both `proxy-mcp` and the legacy `--require-daemon` invocation now use this mode by default. `--in-process` explicitly opts into the single-client development engine.

The daemon survives client exits. A restart gets a bounded 15-second authenticated readiness wait; a longer outage returns a tool error while the MCP connection stays open. `get_started`, `search_docs`, and `list_setup_workflows` work even during an outage. Submitted mutations are never replayed automatically.

## First capture

Ask your MCP client to:

1. Call `get_started` with a unique `task_id` and follow its exact next-call arguments. Reuse an existing capture and its active session.
2. Acquire `acquire_capture_lease` before changing shared capture, routing or mock rules. The thin bridge remembers the returned ID; direct RPC callers pass `capture_lease_id`. Other agents can still read, export and replay. Leases default to 15 minutes, can be renewed, and persist across reconnects/restarts until expiry.
3. For a new Simulator capture, select one device/app with `list_simulator_apps`, then `start_app_capture`. It imports/verifies that Simulator's CA before routing. Repeating the same target reuses capture; supply `duration_seconds` to renew routing. Broader domain/Mac capture remains an explicit choice.
4. For localhost use `create_reverse_proxy` and its returned `local_url`. Trigger the actual app request, then use `wait_for_flow` and `get_flow_detail` to inspect it.
5. For large JSON use `save_body_to_file` without `path`; read the returned private file. It exports complete redacted text without a sensitive grant. HAR/session exports also retain spilled text, with explicit omission reasons/counts for binary, missing or over-budget bodies. Body export is bounded to 50 MiB per file/archive.
6. Remove only your task's rules/listeners and release its capture lease. Release/expiry does not stop capture or expire mocks. Legacy calls remain compatible when no task holds a lease.

App attribution batches fresh socket lookups and re-resolves the selected bundle after reinstall. `app_gateway.attribution` and `coverage_degraded` expose unknown ownership and overload. Unknown connections remain uninspected; zero persistence drops does not prove full capture coverage. App/background helpers that bypass attribution or proxy settings and certificate pinning remain coverage limits.

`update_capture_session` can rename the active session without interrupting capture. Selecting another active session still requires stopping capture, and rejected activation no longer leaves an empty session behind. The daemon restores the selected durable session after recovery; app routing still requires explicit restart.

Certificate verification uses a native URLSession request through an explicit test proxy. It does **not** claim to verify your app's automatic PAC routing or certificate-pinning policy.

If nothing appears, use the `diagnose-capture` prompt or call `diagnose_ios_capture`. Certificate-pinned apps still need a debug build that disables pinning or a TLS passthrough rule.

## Common workflows

- Inspect traffic: `get_flows` → `get_flow_detail` → `compare_flows`.
- Reproduce a request: `export_flow_curl`, `export_flow_code`, or `repeat_flow`.
- Mock an API: `capture_to_mock` (anchored on the captured URL and its query, so a flow captured from `/v1/orders?page=2` mocks `page=2` only), `create_map_local`, or `create_map_remote`.
- Mock/edit JSON without files: `mock_json_response` → `patch_mock_json`, or pass `json_merge_patch` to `capture_to_mock`.
- Pause traffic: `create_breakpoint` → `list_pending_breakpoints` → `resolve_breakpoint`.
- Check an API contract: `validate_flow_openapi` or `validate_capture_openapi`.
- Gate CI captures: `npm run analyze:capture -- --input capture.har --assertions assertions.json`.
- Work with WebSockets: list connections, page messages, and import/export transcripts.
- Transform traffic safely: `upsert_transform_plugin` → `test_transform_plugin` → `create_transform_plugin_rule`.
- Set up a new capture target: `list_capture_adapters` → `preflight_capture_adapter` → `build_capture_setup_plan`.
- Watch traffic locally: `start_operator_ui` for a read-only loopback dashboard.

The MCP server also provides guided prompts, typed result envelopes, status/flow resources, progress notifications, and resource-update subscriptions. Captured content is marked as untrusted.

See [capabilities and limits](docs/CAPABILITIES.md) for the complete surface.

For coding agents, use the `debug-ios-api` MCP prompt or follow the [agent playbook](docs/AGENT_NETWORK_WORKFLOW.md). It includes copyable tool arguments, breakpoint JSON editing, rule precedence, and multi-agent cleanup rules.

## Efficient agent tasks

Refreshed bridges return the canonical `schema_version`/`data` envelope without repeating its payload in top-level compatibility aliases. Read `result.structuredContent.data`. Set `PROXY_MCP_LEGACY_OUTPUT=1` on a bridge if an older integration needs the aliases; the schema version remains 1.0. Existing unrefreshed bridges retain their loaded formatter, but receive the daemon's smaller discovery results, previews and recovery guidance.

`get_flows` and `filter_flows` default to 10 compact summaries. Exact URLs, status, size, capture time, matched rule IDs and proxy-error markers remain available; `view:"full"` adds protocol/timing metadata and list resource links. Explicit limits and cursor ordering are unchanged. Use URL/host filters or `wait_for_flow`, rather than dumping a large page repeatedly. Three identical reads on one refreshed bridge return a next-step hint; reads still go to the live daemon.

Use `get_flow_detail` with `body_mode:"none"` for headers. Default previews are limited to 2 KiB per part and may be incomplete JSON. Select fields instead of printing whole files:

```json
{"flow_id":"FLOW_ID","pointers":["/data/itineraries/*/vendor","/data/itineraries/*/attributes/isMixedCarrierTicketing"],"distinct":true}
```

Pass this to `query_flow_json`. It returns redacted, bounded scalar values/counts with example pointers. Arrays/objects are structural summaries, not complete values. Wildcards cover one segment; pointer escaping uses `~1` for `/` and `~0` for `~`. Inspect `truncated` and `match_count_complete` before concluding a field/value is absent. For complex offline analysis use `save_body_to_file`, omitting `path`, and read its returned private file.

After a leased task, call `finish_capture_task`. It removes only unchanged rules/reverse listeners created under that lease, deletes no-longer-referenced owned mock files, and releases the lease. It preserves captured evidence, exports, preexisting/modified fixtures, and shared capture. Use `keep_resources:true` to deliberately leave QA fixtures installed. Cleanup also handles a deliberately stopped proxy's persisted task rules. `release_capture_lease` alone retains fixtures. MCP disconnects never imply task completion or trigger cleanup. Legacy untracked fixtures must be removed by explicit IDs; ownership is never guessed from a prefix.

The daemon reports when a client has old/unreported bridge metadata: reconnect the MCP client to load the new tools/instructions; do not restart capture.

## Security defaults

- System routing is opt-in, scoped, leased (one hour by default), and uses PAC `PROXY; DIRECT` fallback. Existing proxies/VPN changes are preserved unless replacement is explicit.
- Proxy and control access are loopback-only unless a remote IP/CIDR allowlist and short TTL are explicitly supplied.
- Text credentials are redacted before persistence and again before MCP output.
- Raw reads need both `PROXY_MCP_ALLOW_SENSITIVE=1` and `include_sensitive: true` on that call.
- Raw body persistence separately needs `PROXY_MCP_STORE_SENSITIVE=1` and `capture_body_mode: "all"`.
- Persistence health is visible in status and diagnostics; `PROXY_MCP_PERSISTENCE_FAIL_CLOSED=1` stops capture after a storage failure.
- Runtime files are private under `~/.proxy-mcp`; never share `~/.proxy-mcp/ca/key.pem`.
- Storing or test-executing a transform plugin needs no grant; registering a live `request`/`response` rule for it — by tool call, rule import, or startup replay — needs `PROXY_MCP_ENABLE_TRANSFORM_PLUGINS=1`, enforced at the engine's rule-registration path.

Add organization-specific secret names with comma-separated safe globs:

```text
PROXY_MCP_REDACT_HEADERS=x-company-token
PROXY_MCP_REDACT_QUERY_FIELDS=private_*
PROXY_MCP_REDACT_BODY_FIELDS=credential_*
```

See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).

## CLI

```text
proxy-mcp                         run the thin shared-daemon stdio bridge
proxy-mcp --in-process            run the explicit single-client development engine
proxy-mcp --daemon [options]     run the persistent daemon in foreground
proxy-mcp install [options]      install or reload the user LaunchAgent
proxy-mcp uninstall [--keep-ca]  unload and remove this CA trust
proxy-mcp status                 inspect daemon and handshake state
proxy-mcp doctor                 diagnose and recover verified stale state
```

Useful daemon options include `--domains`, `--tls-passthrough`, `--capture-body-mode`, `--enable-socks`, paired `--ca-key`/`--ca-cert`, `--network-service`, and `--no-routing`. Physical-device use additionally requires `--allow-remote-proxy`, `--remote-allowlist`, and a bounded `--remote-access-ttl`. `start_proxy` also accepts an `upstream_proxy` to chain through an HTTP(S) or SOCKS proxy; credentials are never returned by status tools.

`--no-trust-ca` disables automatic Simulator imports **and** the watcher; `--no-host-trust` skips macOS trust. Use all three `--no-routing --no-host-trust --no-trust-ca` flags for an isolated explicit-proxy daemon. Only one runtime may own a `PROXY_MCP_HOME`; use the installed daemon when several agents share this tool. Stdio clients reconnect on their next call after a daemon restart. Failed mutations are never automatically replayed.

App-only capture uses a separate loopback gateway (8083 by default) so cached app routing cannot become broad interception when the daemon recovers. The gateway reads local socket/process metadata using the current user's permissions; it does not install a privileged helper. An attribution failure means passthrough without capture, never broader inspection. App capture must be explicitly started again after a daemon restart.

The advanced `--trust-simulators` flag opts into automatic CA import on all booted Simulators and the watcher. Prefer selecting one device through setup instead.

The daemon and explicit in-process capture give each address-family connection attempt 2000 ms, avoiding Node's 250 ms default cutting off a viable slow connection during startup. IPv4/IPv6 selection and TLS certificate validation remain enabled. Set `PROXY_MCP_CONNECT_ATTEMPT_TIMEOUT_MS` to a whole number from 10 to 10000 before installation or daemon startup to override this; installation retains the setting. `get_proxy_status.connection_attempt_timeout_ms` reports the active value. This is a per-address window, not an overall request deadline: larger values can slow fallback on broken routes, and network/DNS/VPN/backend outages can still fail. HTTP requests, including authentication POSTs, are not automatically replayed.

Proxy forwarding failures expose `upstream_error` in flow summaries and response details, plus bounded machine-readable `response.tags`. The marker's `source: "proxy"` distinguishes a locally generated 502 from an actual backend 502. `get_diagnostics` returns flow-correlated `upstream-error` records with safe codes and the active attempt window; raw error messages, stacks, headers and bodies are excluded. Error metadata is retained with durable flows, including after daemon recovery.

## Deliberate limits

`proxy-mcp` focuses on safe agent-driven HTTP debugging. It does not ship a desktop GUI, Android/Windows/Linux automation, packet-level shaping, DNS/TUN/WireGuard capture, HTTP/3, arbitrary user scripting, general Mac app attribution, or live WebSocket frame injection. Those require a different engine or product surface and are documented instead of being emulated inaccurately.

See the [Proxyman and competitor comparison](docs/PARITY.md).

## Verify

```bash
npm run check
npm run benchmark:storage
npm run test:soak -- 300
npm pack --dry-run
```

CI tests Node.js 22, 24, and 26 on macOS, audits production dependencies, runs the storage benchmark, and checks package contents. Dependabot covers npm and GitHub Actions updates.

CI also runs a short mixed-traffic soak, with a longer soak and dependency audit on a weekly schedule. Daemon logs rotate at 5 MiB with three archives per stream; sustained RSS above 1 GiB triggers graceful recovery/restart. Set `PROXY_MCP_MAX_RSS_MB` (minimum 128) before reinstalling to adjust that guard; it is not an OS-enforced hard memory limit.

Before public publishing, add the canonical repository, homepage, issue tracker, npm owner, and MCP Registry identity; these values are intentionally not guessed.

## Project docs

- [Capabilities and limits](docs/CAPABILITIES.md)
- [Competitor parity](docs/PARITY.md)
- [iOS Simulator setup and recovery](docs/IOS_SIMULATOR_SETUP.md)
- [Reliability audit and verification](docs/RELIABILITY_AUDIT.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Privacy](PRIVACY.md)

`proxy-mcp` is an independent project inspired by the public [Proxyman MCP](https://docs.proxyman.com/mcp) workflow. It does not claim compatibility with undocumented Proxyman internals.
