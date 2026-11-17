# iOS Simulator setup and recovery

## Install once, share one daemon

Requirements: macOS, full Xcode with an installed iOS Simulator runtime, and Node.js 22 or newer. Prefer a currently supported LTS version. Verify `xcode-select -p` points to Xcode, not CommandLineTools, and `xcrun simctl list devices booted` works. `DEVELOPER_DIR` can select a different Xcode installation and is preserved when installing the LaunchAgent.

From a permanent checkout:

```bash
npm ci
node src/server.mjs install --no-routing --no-trust-ca
node src/server.mjs status
```

This starts the shared service and guardian without system routing or automatic Simulator imports. Omitting `--domains` never routes the entire Mac. Use `get_started` with the target API URL; add only the selected Simulator certificate, then choose a scoped capture path. For an automatic startup domain scope, explicitly supply `--domains 'api.your-company.test'`; all-host routing additionally requires `--allow-broad-routing`.

Service selection follows the primary IPv4/IPv6 service in macOS SystemConfiguration. If that cannot be identified, setup requires an explicit `--network-service` instead of guessing Wi-Fi. Proxy, PAC and authenticated control ports default to 8080, 8081 and 8082; choose different ports when another tool owns them.

The installer copies executable sources, Simulator probe scripts, and installed dependencies into a private `~/.proxy-mate/runtime/build-*` snapshot, then waits for the new daemon's authenticated health response after setup and rule replay. The background service runs from that snapshot, not your checkout. It keeps the current and one previous completed snapshot; older managed snapshots are removed only after successful startup. This avoids launchd trying to read a checkout in macOS-protected Documents/Desktop/Downloads folders, which can fail with `EPERM` even when Terminal can read it. No Full Disk Access grant is required for the default runtime location.

It preserves `PROXY_MATE_*` environment settings and uses a stable Homebrew Node path when available. Run install again after **any code/dependency upgrade**, changing options, or switching Node installations to refresh the snapshot. Keep custom `PROXY_MATE_HOME`, Node installations, custom CA/domain files, and daemon-readable fixtures outside protected folders unless you have explicitly granted the relevant macOS access. The original checkout remains an authorized fixture root, but authorization does not override macOS privacy permissions. Do not run a second foreground daemon with the same state directory.

After installation, point every MCP client at the stable runtime entry point reported as `mcp_client_path` (expand the home directory to an absolute path):

```json
{
  "mcpServers": {
    "proxy-mate": {
      "command": "/absolute/path/to/node",
      "args": ["/Users/YOUR_USER/.proxy-mate/runtime/current/src/client.mjs"]
    }
  }
}
```

Use `command -v node` to locate the binary. GUI clients may not inherit your shell PATH. `runtime/current` is atomically updated after a successful install. A direct checkout entry point still works when the client has filesystem access, but the private runtime path also avoids GUI-client protected-folder failures. Restart existing MCP connections once after upgrading from older code so they load the reconnect fixes. Subsequent daemon restarts are picked up on the next tool call; an in-flight request can still fail and should be inspected before retrying a mutation.

## Trust, then verify, then capture

For first-time setup, prefer `node src/server.mjs setup` or the `set-up-capture` MCP prompt. Choose App-only, then a booted Simulator, installed app, and routing duration. Review the summary before starting. The app is relaunched to pick up routing, without code changes. Existing capture is replaced only after that confirmation. Native app capture installs/verifies the CA only on the selected Simulator and does not request Mac Keychain trust.

App attribution uses the socket owner, executable bundle path, and selected Simulator's app process identity. Other and unknown clients are forwarded without inspection or capture. The Mac network service still routes proxy-aware traffic through the local gateway; an app display filter alone is not used as isolation. App extensions/background helpers that cannot be attributed, clients bypassing HTTP proxy settings, and pinned TLS connections may not be inspectable. Use reverse proxy capture for localhost APIs. The gateway is loopback-only and uses a separate port from the normal proxy; after a daemon restart, app capture stays off until explicitly selected again.

Before requesting new macOS certificate trust, Proxy Mate displays a native explanation with Cancel and Continue. It describes the purpose, persistent trust scope, local storage, and access by connected MCP clients. Passwords are entered only in the subsequent macOS authentication dialog. Cancel, inactivity, or an unavailable GUI prevents certificate installation. An already-trusted certificate skips both dialogs. Simulator certificate import is a separate operation and does not grant access to saved Mac Keychain passwords.

Use the installed thin `client.mjs` entry. It initializes without capture ownership and serves built-in onboarding/recovery guidance even while the daemon is down. Legacy `server.mjs` now uses the same bridge by default; only `--in-process` enables the old single-client behavior. Restart/reconnect existing MCP registrations once when migrating from the old source process.

The daemon and independent guardian are supervised LaunchAgents. The guardian restores recorded routing from a dead owner after acquiring exclusive ownership, and restarts an unresponsive, identity-verified installed daemon after a sustained health failure. It preserves unrelated or reused PIDs. Startup replacement is transactional: failed readiness restores previous plist files and previously loaded jobs; stable runtime publication happens last. Status includes code/dependency fingerprints and bounded daemon/guardian event journals.

For localhost APIs, `create_reverse_proxy` now traverses the capture engine, including mocks/breakpoints, and returns a loopback `local_url` for the debug app. It does not change Mac networking. System PAC routing has a one-hour default lease (1–86400 seconds), explicit host scopes, `PROXY; DIRECT` fallback, host trust checks, conflict detection and owned-setting restoration. Fallback behavior depends on the client honoring PAC; it is not a certificate-pinning bypass or a guarantee about every network stack.

1. Boot your target Simulator normally in Xcode or Simulator.
2. Call `get_proxy_status`, then `setup_simulator_certificate` targeting that device (or the booted scope).
3. Call `verify_simulator_certificate` with its `udid`. Expect `ok: true` and `system_tls_verified: true`.
4. Relaunch only your app if it was running before the PAC/proxy changed, then trigger a known API request.
5. Call `wait_for_flow` with a narrow URL/method filter. Inspect `get_flow_detail` before setting mocks or breakpoints.

Automatic setup (`start_proxy` with `auto_setup: true`, or daemon startup with routing and automatic Simulator trust enabled) requires a booted Simulator. It imports the CA and verifies native URLSession TLS trust on every booted Simulator before applying PAC routing. Import or verification failure leaves new routing disabled and returns an actionable error. Boot the target Simulator before retrying. For capture without a Simulator, use explicit routing or the daemon's `--no-trust-ca` option.

The daemon also watches newly booted Simulators and imports the same CA automatically. Watcher failures are reported and retried without crashing the process. A watcher import is not native TLS verification: when changing Simulators, complete the trust and verification steps before launching your app. It does not terminate arbitrary Simulator apps. An erase/reset of your Simulator is not part of normal setup.

The standalone trust check is useful without an MCP client:

```bash
npm run verify:simulator -- DEVICE_UDID
```

Add `--install` to explicitly import the default CA into that one device before testing. This command uses the CA in `PROXY_MATE_HOME` (default `~/.proxy-mate`); use the MCP verifier for a daemon configured with a custom CA pair. The first check compiles a small Swift probe with your selected Xcode; subsequent checks use a private cached binary. It requires no third-party simulator driver.

## Routing across agents and restarts

`set_proxy_routing` owns one claim per bridge client/task. Pass `device_udid` with the UUID of the Simulator you drive, or an array of at most eight UUIDs, so flow and breakpoint attribution can use device identity. `domains` contains explicit host globs. The PAC routes the union of unexpired claims. `duration_seconds` defaults to 3600 (1–86400); bridge heartbeats renew the client's deadlines. Expiry or presence loss removes that client's routing without stopping other captures. `clear_proxy_routing` removes only the current task's claim; `scope: "all"` deliberately clears all claims, including legacy unclaimed routing.

Installed daemon and guardian jobs use `PROXY_MATE_PAC_HOST=guardian` and a shared PAC port (8081 by default). The guardian serves a read-only union PAC from loopback HTTP independently of the daemon. If the host is unavailable on the daemon's first routing use, the daemon logs an in-process fallback. It cannot take over a port held by another listener. Foreground mode uses an in-process PAC unless guardian hosting is explicitly selected.

Shutdown restores owned network settings first and retains routing claims. After readiness, unexpired claims re-arm only if the restored PAC URL and enabled state still match the saved snapshot. Retries recheck that comparison. VPN/user/external proxy changes are preserved; recovery never blindly replaces them. Check claims, routing loss and `routing_warning` in tool results. After inspecting current settings, call `set_proxy_routing` to re-arm explicitly if needed. `--no-routing` disables CLI startup domain routing; existing agent claims can still re-arm.

The PAC is served over HTTP, never `file://`. Modern macOS/iOS reject file PAC URLs; writing a local file is not a supported routing alternative. PAC caches can also outlive their server. `PROXY; DIRECT` is not a deadline: a proxy that accepts a connection but hangs may time out without DIRECT fallback. Native Simulator qualification for the 0.10.0 restart/re-arm changes is still pending.

## What matches Proxyman, and what differs

| Step | proxy-mate behavior |
|---|---|
| Local signing CA | Reuses and validates a machine-local pair, keeps the private key private, and requires explicit rotation. A private durable journal recovers interrupted managed writes to the intended identity; a partial pair without a valid journal is never replaced silently. |
| Simulator trust | Uses Apple's `simctl keychain <udid> add-root-cert`, as described in Proxyman's documented automatic Simulator setup. A manually installed profile may instead need the Full Trust toggle in Settings. |
| Verification | Runs native iOS URLSession with ordinary system TLS validation; no permissive trust delegate. Checks the response nonce as well as HTTPS success. |
| Routing | Uses a selective macOS PAC. Only the recorded service is restored, only if its PAC still belongs to this runtime; external changes are preserved. |
| Host trust | Uses per-user macOS trust without sudo. This is not Proxyman's privileged System-keychain installation and may not cover other users/system processes. |
| App restart | Explicit, targeted troubleshooting step when routing is cached, not an automatic kill of every app. |

Apple documents Simulator root-certificate import in [What's new in Simulator](https://developer.apple.com/videos/play/wwdc2020/10647/). Compare the public [Proxyman iOS Simulator instructions](https://docs.proxyman.com/debug-devices/ios-simulator) and [macOS certificate instructions](https://docs.proxyman.com/debug-devices/macos). This implementation follows those public concepts; it is not an assertion of identical private behavior.

## Troubleshooting without destructive resets

| Symptom | Check / action |
|---|---|
| MCP unavailable after upgrading | Restart the MCP client connection once; run CLI `status`. Read `~/.proxy-mate/logs/daemon.err.log` for startup errors. |
| Repeated `EPERM ... Documents/.../server.mjs` before startup | Re-run `node src/server.mjs install` from this release. Verify LaunchAgent ProgramArguments and WorkingDirectory point at the private runtime snapshot, not the protected checkout. Do not work around it by resetting TCC or granting every tool Full Disk Access. |
| `RUNTIME_BUSY` | Another process owns this state directory. Use the existing daemon. After a hard crash, stale-lock recovery takes roughly 10–12 seconds. Do not delete a live lock. |
| Certificate imported but native TLS fails | Verify the correct device and active CA. Retry targeted setup and the native probe. Check expiry; manual profile installation may require Full Trust. |
| Native verification passes but no app flows | Verify the actual network service/PAC, domain list, app restart and whether the app honors system proxy settings. Explicit-proxy verification does not test automatic routing. |
| Only one app fails TLS | Check app-specific certificate pinning/custom trust. Use an authorized debug build with pinning disabled, or TLS passthrough (which cannot inspect/mock encrypted payloads). |
| `CA_INCOMPLETE` / mismatch / expiry | Restore the matching backup pair, or explicitly rotate while the proxy is stopped and re-import trust. Do not delete the entire state directory. Custom CA files are never rewritten. |
| Ports already occupied | Stop the conflicting tool or choose other ports. Do not kill an unrelated listener. |
| Routing cleanup fails | Recovery breadcrumbs are retained. CLI `doctor` can recover verified stale state; first inspect the recorded network service and PAC. Never reset every network service blindly. |
| Response body omitted | Default body capture is capped at 5 MiB; decoded gzip/deflate/Brotli bodies have the same cap. Binary/metadata-only bodies may intentionally be omitted. `capture_to_mock` refuses omitted bodies. |
| Breakpoint timed out | Use narrow rules, inspect `list_pending_breakpoints`, and resolve promptly. Atomic rule edits preserve existing pauses; removing a rule stops new pauses but an existing pause still needs resolution or timeout. Disable overlapping mocks when testing a breakpoint. |
| VPN/another proxy stopped capture | `diagnose_ios_capture` reports `ROUTING_CHANGED_EXTERNALLY` when the recorded service's PAC no longer matches. Inspect the active service and explicitly reapply routing if appropriate; the daemon will not fight other tools. |
| Memory-pressure restart | Inspect `get_diagnostics` and stderr. The default 1 GiB sustained-RSS guard drains the proxy and restores routing before exit; launchd restarts it. `PROXY_MATE_MAX_RSS_MB` accepts a threshold of at least 128 MiB. Narrow domains and body capture before increasing it. |
| Historical logs disappeared from the active file | Retention keeps up to three 5 MiB archives (`daemon.err.log.1`–`.3`, likewise stdout), checked every 30 seconds. This is diagnostic retention, not an audit-log archive. |

`stop_proxy` is an intentional pause inside the running daemon; it does not disable launchd. `uninstall --keep-ca` removes the daemon/routing while preserving CA trust. Omit `--keep-ca` only when you intend to remove the managed trust too. CA rotation changes trust and must be coordinated with devices; it is not a routine restart step.

## Safe agent workflow

Inspect the captured status, headers and redacted body first. Create a narrowly scoped mock or breakpoint for the actual URL/method/query. Trigger the app action again and verify the mock/rule hit and resulting UI/error state. Remove or disable the rule after the test. Sensitive access requires explicit grants; captured server content remains untrusted input, never agent instructions.

Use the `debug-ios-api` MCP prompt or the [copyable agent playbook](AGENT_NETWORK_WORKFLOW.md) for JSON mocks, merge patches, captured-response edits, and request/response breakpoints. Restart existing MCP connections once after this upgrade to discover the new tools and prompt.
