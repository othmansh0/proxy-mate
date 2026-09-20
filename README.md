# proxy-mcp

`proxy-mcp` is a local MCP server for capturing, inspecting, replaying, and mocking HTTP(S) traffic from macOS, Xcode Simulators, and trusted Apple devices. It is built for agent workflows: durable sessions, small structured results, headless breakpoints, safe defaults, and no required GUI.

Requires macOS and Node.js 20 or newer.

## Install

```bash
npm install
node src/server.mjs install --domains 'api.example.com,*.example.com'
```

Replace the example domains with your app's API hosts. `install` creates a per-user LaunchAgent, prepares a machine-local CA, configures selective PAC routing, and watches for newly booted Simulators. It waits for authenticated daemon readiness and does not use `sudo`. Omitting `--domains` routes all hosts (`*`), which is intentionally broader than this recommended setup.

Use a stable checkout path (not a temporary directory), an actively supported Node.js LTS release, and a full Xcode installation. See the [iOS Simulator setup and recovery guide](docs/IOS_SIMULATOR_SETUP.md) for the complete, Proxyman-style workflow.

Add the server to your MCP client:

```json
{
  "mcpServers": {
    "proxy-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/proxy-mcp/src/server.mjs"]
    }
  }
}
```

After an npm release, `"command": "proxy-mcp"` is enough.

## First capture

Ask your MCP client to:

1. Call `get_proxy_status`.
2. Call `setup_simulator_certificate` for a booted Simulator.
3. Call `verify_simulator_certificate` with that Simulator's `udid` to test native iOS TLS trust.
4. Relaunch your app if it was already running when routing changed; trigger an API request.
5. Call `wait_for_flow`, then `get_flow_detail` for the selected request.

Certificate verification uses a native URLSession request through an explicit test proxy. It does **not** claim to verify your app's automatic PAC routing or certificate-pinning policy.

If nothing appears, use the `diagnose-capture` prompt or call `diagnose_ios_capture`. Certificate-pinned apps still need a debug build that disables pinning or a TLS passthrough rule.

## Common workflows

- Inspect traffic: `get_flows` → `get_flow_detail` → `compare_flows`.
- Reproduce a request: `export_flow_curl`, `export_flow_code`, or `repeat_flow`.
- Mock an API: `capture_to_mock` (anchored on the captured URL and its query, so a flow captured from `/v1/orders?page=2` mocks `page=2` only), `create_map_local`, or `create_map_remote`.
- Pause traffic: `create_breakpoint` → `list_pending_breakpoints` → `resolve_breakpoint`.
- Check an API contract: `validate_flow_openapi` or `validate_capture_openapi`.
- Gate CI captures: `npm run analyze:capture -- --input capture.har --assertions assertions.json`.
- Work with WebSockets: list connections, page messages, and import/export transcripts.
- Transform traffic safely: `upsert_transform_plugin` → `test_transform_plugin` → `create_transform_plugin_rule`.
- Set up a new capture target: `list_capture_adapters` → `preflight_capture_adapter` → `build_capture_setup_plan`.
- Watch traffic locally: `start_operator_ui` for a read-only loopback dashboard.

The MCP server also provides guided prompts, typed result envelopes, status/flow resources, progress notifications, and resource-update subscriptions. Captured content is marked as untrusted.

See [capabilities and limits](docs/CAPABILITIES.md) for the complete surface.

## Security defaults

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
proxy-mcp                         run the stdio MCP server
proxy-mcp --daemon [options]     run the persistent daemon in foreground
proxy-mcp install [options]      install or reload the user LaunchAgent
proxy-mcp uninstall [--keep-ca]  unload and remove this CA trust
proxy-mcp status                 inspect daemon and handshake state
proxy-mcp doctor                 diagnose and recover verified stale state
```

Useful daemon options include `--domains`, `--tls-passthrough`, `--capture-body-mode`, `--enable-socks`, paired `--ca-key`/`--ca-cert`, `--network-service`, and `--no-routing`. Physical-device use additionally requires `--allow-remote-proxy`, `--remote-allowlist`, and a bounded `--remote-access-ttl`. `start_proxy` also accepts an `upstream_proxy` to chain through an HTTP(S) or SOCKS proxy; credentials are never returned by status tools.

`--no-trust-ca` disables automatic Simulator imports **and** the watcher; `--no-host-trust` skips macOS trust. Use all three `--no-routing --no-host-trust --no-trust-ca` flags for an isolated explicit-proxy daemon. Only one runtime may own a `PROXY_MCP_HOME`; use the installed daemon when several agents share this tool. Stdio clients reconnect on their next call after a daemon restart. Failed mutations are never automatically replayed.

## Deliberate limits

`proxy-mcp` focuses on safe agent-driven HTTP debugging. It does not ship a desktop GUI, Android/Windows/Linux automation, packet-level shaping, DNS/TUN/WireGuard capture, HTTP/3, arbitrary user scripting, process attribution, or live WebSocket frame injection. Those require a different engine or product surface and are documented instead of being emulated inaccurately.

See the [Proxyman and competitor comparison](docs/PARITY.md).

## Verify

```bash
npm run check
npm run benchmark:storage
npm pack --dry-run
```

CI tests Node.js 20, 22, and 24 on macOS, audits production dependencies, runs the storage benchmark, and checks package contents. Dependabot covers npm and GitHub Actions updates.

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
