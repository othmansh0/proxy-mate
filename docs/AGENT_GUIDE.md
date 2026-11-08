# Agent guide

For everyday iOS app debugging, start with [Agent network workflow](AGENT_NETWORK_WORKFLOW.md) or the `debug-ios-api` MCP prompt. This document describes implementation boundaries for agents modifying the MCP itself.

## Mental model

`proxy-mcp` is a local MCP server for selectively intercepting HTTP(S) traffic,
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

The `PROXY_MCP_*` variables are the security model: each unlocks one narrow,
explicit capability that defaults off or safe. None are read from caller
input; only the server process's own environment.

| Variable | Unlocks |
| --- | --- |
| `PROXY_MCP_HOME` | Overrides the state directory (default `~/.proxy-mcp`) holding config, sessions, and PID/handshake files. |
| `PROXY_MCP_ALLOWED_PATHS` | Extra filesystem roots (colon/OS-separated) callers may reference, beyond the state directory and CWD; still symlink-contained. |
| `PROXY_MCP_ALLOW_SENSITIVE` | Grants the `sensitive` control-plane scope and permits `include_sensitive=true` reads of unredacted flow data; set only for a trusted, temporary debugging session. |
| `PROXY_MCP_STORE_SENSITIVE` | Permits `capture_body_mode=all`, i.e. persisting unredacted bodies to a session at all. |
| `PROXY_MCP_PERSISTENCE_FAIL_CLOSED` | Stops capture instead of silently continuing when session persistence fails. |
| `PROXY_MCP_ENABLE_TRANSFORM_PLUGINS` | Required to register a live `request`/`response` transform-plugin rule — by tool call, rule import, or startup replay of a persisted rule; without it, the registration attempt is rejected (`TRANSFORM_PLUGINS_NOT_ENABLED`) though the plugin itself can still be stored and test-executed offline. `websocket_offline` plugins are never live rules and are unaffected. |
| `PROXY_MCP_MAX_FLOWS` | Caps the in-memory flow list size (default 500). |
| `PROXY_MCP_REDACT_HEADERS`, `PROXY_MCP_REDACT_QUERY_FIELDS`, `PROXY_MCP_REDACT_BODY_FIELDS` | Additive safe-glob patterns appended to the default redaction lists for headers, query fields, and body fields; cannot remove a default pattern. |
| `PROXY_MCP_PREVIEW_DEVICE_SET` | Overrides the Xcode Preview simulator device set path used for CA trust setup. |

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
