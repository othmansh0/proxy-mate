# Advanced configuration

For the two-command install and first capture, start with the [README](../README.md). This guide covers optional configuration and operational details.

## Efficient agent tasks

Refreshed bridges return the canonical `schema_version`/`data` envelope without repeating its payload in top-level compatibility aliases. Read `result.structuredContent.data`. Set `PROXYFAN_LEGACY_OUTPUT=1` on a bridge if an older integration needs the aliases; the schema version remains 1.0. Existing unrefreshed bridges retain their loaded formatter, but receive the daemon's smaller discovery results, previews and recovery guidance.

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
- Raw reads need both `PROXYFAN_ALLOW_SENSITIVE=1` and `include_sensitive: true` on that call.
- Raw body persistence separately needs `PROXYFAN_STORE_SENSITIVE=1` and `capture_body_mode: "all"`.
- Persistence health is visible in status and diagnostics; `PROXYFAN_PERSISTENCE_FAIL_CLOSED=1` stops capture after a storage failure.
- Runtime files are private under `~/.proxyfan`; never share `~/.proxyfan/ca/key.pem`.
- Storing or test-executing a transform plugin needs no grant; registering a live `request`/`response` rule for it — by tool call, rule import, or startup replay — needs `PROXYFAN_ENABLE_TRANSFORM_PLUGINS=1`, enforced at the engine's rule-registration path.

Add organization-specific secret names with comma-separated safe globs:

```text
PROXYFAN_REDACT_HEADERS=x-company-token
PROXYFAN_REDACT_QUERY_FIELDS=private_*
PROXYFAN_REDACT_BODY_FIELDS=credential_*
```

See [SECURITY.md](../SECURITY.md) and [PRIVACY.md](../PRIVACY.md).

## CLI

```text
proxyfan                         run the thin shared-daemon stdio bridge
proxyfan --in-process            run the explicit single-client development engine
proxyfan --daemon [options]     run the persistent daemon in foreground
proxyfan install [options]      install or reload the user LaunchAgent
proxyfan uninstall [--keep-ca]  unload and remove this CA trust
proxyfan status                 inspect daemon and handshake state
proxyfan doctor                 diagnose and recover verified stale state
```

Useful daemon options include `--domains`, `--tls-passthrough`, `--capture-body-mode`, `--enable-socks`, paired `--ca-key`/`--ca-cert`, `--network-service`, and `--no-routing`. Physical-device use additionally requires `--allow-remote-proxy`, `--remote-allowlist`, and a bounded `--remote-access-ttl`. `start_proxy` also accepts an `upstream_proxy` to chain through an HTTP(S) or SOCKS proxy; credentials are never returned by status tools.

`--no-trust-ca` disables automatic Simulator imports **and** the watcher; `--no-host-trust` skips macOS trust. Use all three `--no-routing --no-host-trust --no-trust-ca` flags for an isolated explicit-proxy daemon. Only one runtime may own a `PROXYFAN_HOME`; use the installed daemon when several agents share this tool. Stdio clients reconnect on their next call after a daemon restart. Failed mutations are never automatically replayed.

App-only capture uses a separate loopback gateway (8083 by default) so cached app routing cannot become broad interception when the daemon recovers. The gateway reads local socket/process metadata using the current user's permissions; it does not install a privileged helper. An attribution failure means passthrough without capture, never broader inspection. App capture must be explicitly started again after a daemon restart.

The advanced `--trust-simulators` flag opts into automatic CA import on all booted Simulators and the watcher. Prefer selecting one device through setup instead.

The daemon and explicit in-process capture give each address-family connection attempt 2000 ms, avoiding Node's 250 ms default cutting off a viable slow connection during startup. IPv4/IPv6 selection and TLS certificate validation remain enabled. Set `PROXYFAN_CONNECT_ATTEMPT_TIMEOUT_MS` to a whole number from 10 to 10000 before installation or daemon startup to override this; installation retains the setting. `get_proxy_status.connection_attempt_timeout_ms` reports the active value. This is a per-address window, not an overall request deadline: larger values can slow fallback on broken routes, and network/DNS/VPN/backend outages can still fail. HTTP requests, including authentication POSTs, are not automatically replayed.

Proxy forwarding failures expose `upstream_error` in flow summaries and response details, plus bounded machine-readable `response.tags`. The marker's `source: "proxy"` distinguishes a locally generated 502 from an actual backend 502. `get_diagnostics` returns flow-correlated `upstream-error` records with safe codes and the active attempt window; raw error messages, stacks, headers and bodies are excluded. Error metadata is retained with durable flows, including after daemon recovery.

## Reliability settings

Set these on the daemon before startup or installation. Installation preserves `PROXYFAN_*` settings, but sets guardian PAC hosting and the selected PAC port explicitly in both LaunchAgents.

| Variable | Default and behavior |
| --- | --- |
| `PROXYFAN_DRAIN_MS` | 8000 ms. A finite nonnegative number controls proxy/gateway connection drain; 0 forces immediate completion. Invalid or negative values fall back to 8000. Daemon shutdown caps this to the remaining cleanup budget. |
| `PROXYFAN_BODY_WORKER_THRESHOLD` | 262144 bytes (256 KiB). Bodies larger than this go to workers; bodies with Content-Encoding go to workers regardless of wire size. Unencoded bodies at or below the threshold stay inline. |
| `PROXYFAN_BODY_WORKERS` | 2 lazy workers; positive integers are capped at 8. |
| `PROXYFAN_BODY_WORKER_QUEUE` | 32 waiting jobs; positive integers are capped at 128. Active jobs are separate from this queue. |
| `PROXYFAN_BODY_WORKER_TIMEOUT_MS` | 5000 ms per job, including queue time; positive integers are capped at 30000. |
| `PROXYFAN_PAC_HOST` | Unset uses the daemon's in-process PAC. Exactly `guardian` selects the independent guardian host. Installed jobs set `guardian`. First-use host failure logs an in-process fallback; occupied ports still fail. |
| `PROXYFAN_PAC_PORT` | 8081 for the guardian host. Installation writes the selected PAC port into both jobs. For manual launches, keep this consistent with the daemon's `--pac-port`; this environment variable alone does not change the daemon's routing port. |

The body-worker options require positive integers; invalid values fall back to their defaults. The threshold is capped at JavaScript's maximum safe integer. Workers decode, redact, hash and store capture bodies off the event loop. Pool saturation, worker failure or timeout falls back inline only for bodies smaller than 1 MiB. Larger bodies are omitted with `omitted: "processing_overloaded"`; proxy forwarding continues. Metadata-only capture avoids body hashes. Status/diagnostics expose degradation counters; an omitted body is not a complete recording.

The daemon LaunchAgent uses `ProcessType=Interactive`; the guardian uses `Standard`. Background scheduling previously starved proxy traffic during builds. `ExitTimeOut` is 30 seconds for the daemon and 20 seconds for the guardian. Daemon shutdown has a 20-second deadline: cleanup reserves 19 seconds, leaving one second for the final journal flush. It restores routing first (up to 6 seconds), then stops control calls (up to 3 seconds), stops the operator UI, and drains capture within the remaining budget. Claims survive for conditional re-arm. The guardian allows 25 seconds after its SIGTERM before escalation and rechecks process ownership before SIGKILL. Its own stop waits up to 10 seconds for the current tick and PAC host.

Heartbeats default to 30 seconds with ±10% jitter; presence uses three missed intervals and 90 seconds of startup grace. These are code defaults, not environment options. Health probes bypass RPC rate/concurrency budgets after authentication. Normal control calls use per-client rate buckets; long calls have a separate concurrency pool.

### Testing

`PROXYFAN_ALLOW_REAL_NETWORKSETUP` is a test safety override, not a setup feature. Under Node's test runner, real network-setting commands are blocked unless this override is exactly `1`. Tests should inject fake commands and isolate state instead. Do not enable it for routine tests.

## Deliberate limits

`proxyfan` focuses on safe agent-driven HTTP debugging. It does not ship a desktop GUI, Android/Windows/Linux automation, packet-level shaping, DNS/TUN/WireGuard capture, HTTP/3, arbitrary user scripting, general Mac app attribution, or live WebSocket frame injection. Those require a different engine or product surface and are documented instead of being emulated inaccurately.

See the [Proxyman and competitor comparison](PARITY.md).

## Verify

Repository tests isolate themselves: under `node --test` each test process uses a private temporary state root unless `PROXYFAN_HOME` is set explicitly. Leave it unset for `npm run check`. For the benchmark and soak scripts, which run outside the test runner, use a scratch root.

```bash
npm run check
export PROXYFAN_HOME="$(mktemp -d /tmp/proxyfan-scratch.XXXXXX)"
npm run benchmark:storage
npm run test:soak -- 300
npm pack --dry-run
```

CI tests Node.js 22, 24, and 26 on macOS, audits production dependencies, runs the storage benchmark, and checks package contents. Dependabot covers npm and GitHub Actions updates.

CI also runs a short mixed-traffic soak, with a longer soak and dependency audit on a weekly schedule. Daemon logs rotate at 5 MiB with three archives per stream; sustained RSS above 1 GiB triggers graceful recovery/restart. Set `PROXYFAN_MAX_RSS_MB` (minimum 128) before reinstalling to adjust that guard; it is not an OS-enforced hard memory limit.

Public npm publishing and versioning are described in [Packaging and releases](PACKAGING.md).

