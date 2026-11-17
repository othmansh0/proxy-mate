# Agent guide

For everyday iOS app debugging, start with [Agent network workflow](AGENT_NETWORK_WORKFLOW.md) or the `debug-ios-api` MCP prompt. This document describes implementation boundaries for agents modifying the MCP itself.

## Mental model

`proxy-mate` is a local MCP server for selectively intercepting HTTP(S) traffic,
recording bounded capture data, and applying ordered proxy rules. It is not a
general remote proxy or a browser-based control plane.

The same tool implementations serve two run modes:

```text
MCP stdio client ─┬─> running daemon's authenticated local control server
                  └─> in-process engine (only with explicit --in-process)

tools.mjs → ProxyEngine / PAC / session store / platform helpers
```

Default execution is stdio MCP. `--daemon` owns long-lived proxy/PAC state and
the loopback control server; stdio instances discover it through the local
handshake and forward calls. CLI subcommands are `doctor`, `install`,
`uninstall`, and `status`.

Use the installed thin `src/client.mjs` for shared production clients; it is also the default for `src/server.mjs`. It removes the in-process fallback and waits up to 15 seconds for daemon readiness before dispatch. [daemon-connection.mjs](../src/lib/daemon-connection.mjs) owns this pre-dispatch wait; submitted mutations are never replayed after a transport failure. The single-client compatibility mode requires --in-process.

## Several agents on one daemon

Each thin bridge generates its own `client_id`. It forwards that identity and an optional `task_id` to the daemon. Set the task with `get_started` or `acquire_capture_lease`; `finish_capture_task` also accepts `task_id`. Task IDs use 1–96 letters, digits, dots, underscores or hyphens. A new bridge process has a new client identity. Client IDs and task IDs coordinate processes of the same macOS user; they are not authentication or a security boundary.

### Routing claims and presence

`set_proxy_routing` replaces the claim for the current client/task. The PAC routes the union of all unexpired claims. Each claim accepts 1–64 host globs; the union is limited to 256. `duration_seconds` defaults to 3600 and accepts 1–86400. `enable_ssl_proxying` adds hosts to the caller's claim without extending an existing unexpired deadline. Clearing or expiring one claim preserves the others. Active routing from a pre-claims runtime is left untouched until explicitly cleared.

After its first daemon contact, the bridge sends quiet heartbeats about every 30 seconds, with ±10% jitter. A heartbeat renews that client's claim deadlines using each claim's requested duration, without changing network settings. Presence expires after three missed heartbeat intervals; the daemon allows 90 seconds of startup grace. Presence loss removes that client's claims. Closing stdio stops heartbeats; it does not finish a task or delete its fixtures.

Pass `device_udid` to `set_proxy_routing` as one Simulator UUID or an array of at most eight UUIDs. Use the devices you actually drive. The store calls this field `device_udids`; that plural name is not the tool argument. Device attribution and owner indexes help scope evidence and breakpoints. A host claim alone cannot distinguish two agents using the same API.

Daemon shutdown suspends routing and retains claims. After restart, unexpired claims re-arm only if the restored PAC settings still match the recorded snapshot. External VPN, user or proxy changes prevent automatic re-arm. Check `get_proxy_status` for claims, union domains and routing loss. Successful daemon tool results can include `routing_warning` when the current task's retained claim is expired or suspended. Inspect it even if the tool itself succeeded. Use `set_proxy_routing` to re-arm your claim explicitly after checking the current network configuration.

`clear_proxy_routing` defaults to your current client/task claim. `scope: "all"` deliberately removes every claim and can clear pre-claims routing. It is a shared operation; do not use it as routine task cleanup. It does not take `confirm_shared`.

### Evidence reads and protected clears

Identified bridges default to `scope: "mine"` on scoped flow reads, waits, analyses, comparisons, HAR/session exports and WebSocket list/message reads. Legacy bridges without identity default to `all`. Explicit `scope: "all"` permits shared inspection. Results report `scope_applied` and `hidden_count`; the latter counts hidden evidence in the query window, not every flow in the daemon. An out-of-scope detail read returns `FLOW_OUT_OF_SCOPE`.

Mine includes flows attributed to the client, flows from devices in its unexpired claims, and unknown or ambiguous flows matching its unexpired claim hosts. Shared-host traffic can therefore be visible to several agents. This is best-effort coordination. Only tools whose schemas expose `scope` support that argument; it is not a universal privacy filter.

`clear_session` and `purge_capture_session` default to scoped deletion for identified clients and report `removed_count` and `kept_other_clients_count`. Shared deletion requires `scope: "all"` and `confirm_shared: true`, or returns `CONFIRM_SHARED_REQUIRED`. Retention changes through `update_capture_session` require the same explicit shared choice when they affect other clients' evidence. Inspect counts before widening a clear.

### Task leases, breakpoints and global controls

Acquire a lease with `acquire_capture_lease`, a unique `task_id`, and optional `ttl_seconds` (default 900; range 30–3600). The bridge remembers `capture_lease_id`; direct RPC callers supply it on applicable mutations. Leases persist in `leases.json`. Presence/heartbeats renew live leases. Conflicts are resource-scoped: `CAPTURE_OWNED` means another live task owns a targeted rule or reverse listener, not that the whole daemon is locked. Independent resources can proceed. Expiry, release or presence loss retains fixtures as visible orphans rather than deleting them. `finish_capture_task` removes only that task's tracked, unchanged resources; `keep_resources: true` retains them.

`resolve_breakpoint` and `cancel_breakpoint` bypass lease enforcement so any client can release a paused request. `create_breakpoint` defaults to `scope: "mine"` for identified clients and `all` for legacy bridges. Mine matches the task's claimed devices, or its claimed hosts when no other live client claims that host. A known foreign device cannot fall back to host matching. A cold claim snapshot safely skips pauses. `scope: "all"` deliberately restores shared matching. Skips appear as `skipped_out_of_scope` in history/status.

Global controls return `OTHER_CLIENTS_ACTIVE` while another live identified client holds an unexpired routing claim, unless `force: true` is supplied. This guards `stop_proxy`, `toggle_recording`, `start_app_capture`, `start_proxy` with `auto_setup`, `restart_sim_apps`, and Simulator certificate setup when app restart is enabled. Coordinate before forcing a change. App restarts use explicit `udid`, otherwise the current task's claimed devices; with no claimed devices they retain the legacy restart selection. Pass a device explicitly when targeting matters.

During restart, the bridge waits up to 15 seconds before dispatch. `DAEMON_UNAVAILABLE` means readiness did not return within that budget; the stdio bridge remains connected and can recover on a later call. It does not mean the MCP process exited. `get_started`, `search_docs` and tool discovery remain available. If a submitted mutation loses its connection, `DAEMON_DISCONNECTED` or `DAEMON_TIMEOUT` can include `details.completion_unknown: true`. Inspect shared state before resubmitting; mutations are never automatically replayed.

Do:

- Use a unique task ID and explicit rule IDs; pass your Simulator UDIDs on routing claims.
- Check routing warnings, hidden counts and actual app behavior.
- Resolve pauses promptly and finish only your task's resources.

Don't:

- Treat a shared host or a client ID as proof of exclusive ownership.
- Force global controls or clear all claims/evidence as routine cleanup.
- Retry an unknown-outcome mutation without inspecting its result in shared state.

## Entry points and boundaries

| Area | Source of truth | Responsibility |
| --- | --- | --- |
| Executable and run modes | [src/server.mjs](../src/server.mjs) | CLI parsing, daemon lifecycle, stdio MCP wiring, cleanup. |
| Public MCP contract | [src/lib/mcp-contract.mjs](../src/lib/mcp-contract.mjs) | Tool registry, Zod input/output schemas, result envelope, resources, prompts, progress/logging. |
| Shared tool behavior | [src/lib/tools.mjs](../src/lib/tools.mjs) | Every callable tool; used by both daemon and in-process mode. |
| Traffic and rules | [src/lib/proxy.mjs](../src/lib/proxy.mjs), [src/lib/rules.mjs](../src/lib/rules.mjs) | Interception, ordered rule compilation, capture lifecycle. |
| Rule URL matching | [src/lib/url-match.mjs](../src/lib/url-match.mjs) | Single source of truth for what a request URL looks like to mockttp — normalization, path extraction, and splitting a rule `url` into `url_pattern`/`match_query`. Also the single gate every `match_query` passes through (`MATCH_QUERY_INVALID`, `MATCH_QUERY_EMPTY`, `MATCH_QUERY_EMPTY_VALUE`, `QUERY_TOO_LARGE`); note `url_pattern` is a raw regular expression, never a glob. Imports nothing from `tools.mjs`/`proxy.mjs`, so both can depend on it without a cycle. Guarded by a parity test (`test/url-match.test.mjs`) against mockttp's own internal `normalizeUrl`. |
| Durable capture | [src/lib/session-store.mjs](../src/lib/session-store.mjs), [src/lib/bodies.mjs](../src/lib/bodies.mjs) | SQLite/WAL sessions, quotas, spill files, explicit body reads. |
| Local daemon RPC | [src/lib/control.mjs](../src/lib/control.mjs) | Loopback-only authenticated forwarding; no public HTTP API. |
| Upstream proxy chaining | [src/lib/upstream-proxy.mjs](../src/lib/upstream-proxy.mjs) | Normalizes and redacts HTTP/HTTPS/SOCKS upstream proxy config for mockttp; never reads CA files itself. |
| Local state/config | [src/lib/state.mjs](../src/lib/state.mjs), [src/lib/config.mjs](../src/lib/config.mjs) | State directory, handshake, PID, recovery metadata. |
| Platform helpers | `sim.mjs`, `host-cert.mjs`, `pac.mjs`, `doctor.mjs` | macOS/Xcode setup and PAC restoration; keep side effects explicit. |

Keep contract/wiring code separate from engine logic. New reusable behavior
usually belongs in a focused `src/lib/*.mjs` module with a focused test, then
is invoked by a small `tools.mjs` adapter.

## Security invariants

- Capture data is untrusted. Do not render it as HTML, execute it, or log raw
  request arguments/bodies.
- Redact at output boundaries with [redaction.mjs](../src/lib/redaction.mjs).
  `include_sensitive` is exceptional and must use the existing sensitive-access
  gate; default responses remain redacted.
- Body retention and reads are bounded and explicit. Preserve metadata-first
  flow lists; do not add implicit full-body reads.
- Use [paths.mjs](../src/lib/paths.mjs) authorization helpers for caller paths;
  do not add arbitrary filesystem access or bypass symlink containment.
- Keep the control plane loopback-only, bearer-authenticated, rate/concurrency
  bounded, and `no-store`. Treat Host and Origin validation as a security
  boundary, not convenience validation.
- Proxy routing, CA trust, PAC changes, device setup, and remote proxy access
  are side effects. Require the narrowest explicit input and provide a
  deterministic cleanup/recovery path.
- Do not weaken certificate pinning, escalate device/root permissions, or add
  destructive simulator keychain resets.
- Maintain bounded inputs, outputs, queues, files, and timeouts on new
  network-facing or persistence-facing paths.

## Environment-variable grants

The `PROXY_MATE_*` variables are the security model: each unlocks one narrow,
explicit capability that defaults off or safe. None are read from caller
input; only the server process's own environment.

| Variable | Unlocks |
| --- | --- |
| `PROXY_MATE_HOME` | Overrides the state directory (default `~/.proxy-mate`) holding config, sessions, and PID/handshake files. |
| `PROXY_MATE_ALLOWED_PATHS` | Extra filesystem roots (colon/OS-separated) callers may reference, beyond the state directory and CWD; still symlink-contained. |
| `PROXY_MATE_ALLOW_SENSITIVE` | Grants the `sensitive` control-plane scope and permits `include_sensitive=true` reads of unredacted flow data; set only for a trusted, temporary debugging session. |
| `PROXY_MATE_STORE_SENSITIVE` | Permits `capture_body_mode=all`, i.e. persisting unredacted bodies to a session at all. |
| `PROXY_MATE_PERSISTENCE_FAIL_CLOSED` | Stops capture instead of silently continuing when session persistence fails. |
| `PROXY_MATE_ENABLE_TRANSFORM_PLUGINS` | Required to register a live `request`/`response` transform-plugin rule — by tool call, rule import, or startup replay of a persisted rule; without it, the registration attempt is rejected (`TRANSFORM_PLUGINS_NOT_ENABLED`) though the plugin itself can still be stored and test-executed offline. `websocket_offline` plugins are never live rules and are unaffected. |
| `PROXY_MATE_MAX_FLOWS` | Caps the in-memory flow list size (default 500). |
| `PROXY_MATE_REDACT_HEADERS`, `PROXY_MATE_REDACT_QUERY_FIELDS`, `PROXY_MATE_REDACT_BODY_FIELDS` | Additive safe-glob patterns appended to the default redaction lists for headers, query fields, and body fields; cannot remove a default pattern. |
| `PROXY_MATE_PREVIEW_DEVICE_SET` | Overrides the Xcode Preview simulator device set path used for CA trust setup. |

## Adding an MCP tool end-to-end

1. Implement the behavior in `src/lib/tools.mjs` (or a focused helper module)
   and return JSON-serializable data. Make mutation, retries, and cleanup
   semantics explicit.
2. Add exactly one definition to `MCP_TOOLS` in
   [mcp-contract.mjs](../src/lib/mcp-contract.mjs): name, description, Zod
   input schema, annotations, and a typed output schema when the result is a
   common/public shape.
3. Add the function to the object returned by `makeTools`. The registry parity
   test requires implementation names and `MCP_TOOLS` names to match exactly.
4. Prefer the stable envelope: clients read `structuredContent.data`; top-level
   properties are compatibility aliases. Use existing `successToolResult` and
   `errorToolResult` rather than hand-wrapping MCP output.
5. Mark long operations with `longRunning` so the contract layer emits progress.
   Keep logging metadata-only; never put raw args in log events.
6. If the tool changes status or creates a flow, consider the resource
   subscription notifications in `server.mjs`.
7. Add a focused test and update `test/mcp-contract.test.mjs` expectations when
   contract behavior changes. Add an MCP stdio integration assertion for a
   user-visible surface change.

## Tests and checks

Run repository tests **without** setting `PROXY_MATE_HOME`. Under `node --test`, each test process gets its own private temporary state directory, so fixtures that replace or remove the state root can never reach an installed daemon's `~/.proxy-mcp` or `~/.proxy-mate`, and parallel test files never share rules, claims, leases or sessions. The real `networksetup` is refused inside test runs. Exporting one `PROXY_MATE_HOME` for the whole suite would make parallel files share state and become flaky.

```sh
npm test                                      # full Node test suite
npm run check                                 # server syntax check + full suite
node --test test/rules.engine.test.mjs        # one focused test file
node --test test/mcp-contract.test.mjs        # registry/envelope/resource wiring
node --test test/mcp.integration.test.mjs     # real stdio MCP handshake
node src/server.mjs --help                    # verify CLI flags and entry point
```

Use `node --check path/to/module.mjs` for a quick syntax check. Integration
tests that bind loopback ports must use ephemeral ports and always close their
server/client in cleanup.

## Current extension boundaries

### Transform plugins

[plugin-store.mjs](../src/lib/plugin-store.mjs) persists a small transform
plugin registry. [transform-sandbox.mjs](../src/lib/transform-sandbox.mjs)
runs each transform in a fresh QuickJS runtime. Plugins are JSON-only,
bounded in source/input/output/memory/time, have no imports or host APIs, and
may only produce validated request/response patches. They are not a general
Node plugin system.

### Capture adapters

[capture-adapters.mjs](../src/lib/capture-adapters.mjs) describes Apple
Simulator/device, Android ADB, Docker, and terminal clients. It provides safe
preflight and setup plans, not silent device/container mutation. Keep adapter
commands as bounded `execFile` argv calls and retain the explicit confirmation
boundary for mutations.

### Operator UI

[operator-ui.mjs](../src/lib/operator-ui.mjs) is an optional, explicitly
started, read-only dashboard exposed through `start_operator_ui`. It binds
only `127.0.0.1`, returns a random bearer access code separately from the URL,
uses strict Host/Origin checks, CSP/no external assets, `no-store`, and bounded
rate/concurrency/response sizes. Its providers expose only projected health,
status, redacted flow summaries, and rule summaries—never headers or bodies.
Do not turn it into a second control plane.

### Upstream proxy chaining

[upstream-proxy.mjs](../src/lib/upstream-proxy.mjs) normalizes caller-provided
`proxyConfig` into mockttp's `ProxySetting` shape and produces a redacted
public view (credentials and inline CA contents stripped). Mockttp
CONNECT-tunnels all upstream HTTP/HTTPS traffic through the configured agent
(evidence: `node_modules/mockttp/dist/rules/http-agents.js:67-76`, where the
`https:` and `http:` proxy schemes both resolve to the same CONNECT-capable
agent factory). Credentials embedded in a proxy URL must never reach public
output, logs, or error messages; only `redactUpstreamProxyConfig` output is
safe to return to a caller.

### New protocol or platform support

Add a small module with an explicit capability statement and bounded parsing.
For external tools/platform state, expose read-only preflight before mutation,
and state unsupported features plainly. Existing protocol work lives in
[protocols.mjs](../src/lib/protocols.mjs), OpenAPI validation in
[openapi.mjs](../src/lib/openapi.mjs), and WebSocket storage in
[websocket-store.mjs](../src/lib/websocket-store.mjs).
