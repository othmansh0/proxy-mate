# Reliability audit — 2026-09-20

Scope: daemon/stdio lifecycle, network ownership and recovery, CA/Simulator setup, HTTP capture, WebSocket persistence, control-plane boundaries, installed service configuration, dependency security, and regression coverage. This is a tested hardening pass, not a claim that every possible bug is eliminated or a production soak certification.

## Evidence and fixes

The installed daemon's existing stderr log contained V8 heap-out-of-memory failures near a 4 GiB heap. No heap snapshot was available to attribute every allocation. Two independently demonstrable retention paths were fixed; they are plausible contributors, not a proven exclusive explanation of every historical crash.

| Severity | Defect | Change / regression evidence |
|---|---|---|
| High | Mockttp retains complete raw request history by default, independently of our bounded/redacted store. | `recordTraffic: false`; repeated real requests leave Mockttp endpoint history empty. [Mockttp options](https://httptoolkit.github.io/mockttp/interfaces/MockttpOptions.html). |
| High | Each WebSocket event queued a complete snapshot while disk lagged. | Coalesced dirty-state writes and an approximate 16 MiB global retained-message budget; burst, import and disk-failure tests. |
| High | Stdio clients permanently retained an old daemon address/token. | Re-read authenticated handshake per call, no silent local takeover after daemon use, no automatic mutation replay; persistent MCP connection test across token/port rotation. |
| High | Multiple runtimes could race state and routing ownership. | Heartbeat lock per state directory, lazy stdio initialization, guarded ownership; real duplicate-process and SIGKILL-recovery tests. |
| High | Async capture/watcher failures could become unhandled process failures. | Bounded per-flow capture queue, surfaced errors, recurring watcher rejection handling and awaited stop. |
| High | Cleanup could hang on sockets, race startup/mutations, or modify another proxy's settings. | Cancelled control requests, bounded process shutdown, serialized lifecycle, EOF cleanup, ownership-aware PAC restore; retain failed recovery metadata. |
| High | CA files were not validated as a pair; partial state could silently replace trusted identity. | Check CA type, lifetime, matching key, RSA strength and file bounds; serialize generation/rotation and preserve incomplete state unless explicitly rotated. |
| Medium | DER staging could overwrite a custom CA's adjacent file. | Private fingerprint-keyed public DER cache; custom-file preservation test. |
| Medium | Import success did not demonstrate native Simulator trust. | New native URLSession verifier with normal TLS validation and a nonce. Real untrusted/trusted controls passed on a disposable iOS 27.0 Simulator. |
| Medium | `--no-trust-ca` still enabled the Simulator watcher; repeated start rebuilt rules and discarded pauses. | Honor opt-out end to end, make already-running starts idempotent, remove automatic all-app restart on simulator discovery. |
| Medium | RPC null/array/inherited-method arguments and malformed result envelopes were unsafe. | Input shape + registry schema validation, own-property dispatch, response envelope guard, total deadlines, response-size bound and disconnect handling. |
| Medium | Fixed short RPC/socket deadlines interrupted long legitimate tools. | Tool-specific bounded deadlines and cancellation; no idle-socket timeout overriding supported long waits. |
| Medium | LaunchAgent pinned a removable Cellar binary, lacked a working directory, lost configuration and reported success too early. | Stable binary where resolvable, explicit working/state directories, environment propagation, restart policy, fresh authenticated readiness after initialization. |
| Medium | Unknown/malformed CLI arguments silently entered stdio or truncated numeric values. | Strict flags, numbers and absolute configured file paths. |
| Medium | gzip/deflate/Brotli JSON was stored as opaque binary or omitted; missing bodies became empty mocks. | Bounded decoding before redaction, explicit omission, reject omitted-body mocks; real compressed upstream and decompression-limit tests. |
| Medium | Explicit historical-session lookup could incorrectly return a live-session cached flow. | Consult the in-memory cache only for its own session. |
| High/Medium | Production audit reported advisories in fast-uri, Hono and qs. | Compatible patched pins: fast-uri 3.1.6, Hono 4.13.5, qs 6.16.0. See upstream [fast-uri](https://github.com/fastify/fast-uri/releases/tag/v3.1.6), [Hono](https://github.com/honojs/hono/releases/tag/v4.13.5), [qs](https://github.com/ljharb/qs/releases/tag/v6.16.0). |
| High | Rule edits reset the engine, released unrelated breakpoints and exposed a traffic gap. | Compile off-server and replace HTTP rules in one `setRequestRules` operation; retain subscriptions, WebSocket rules and existing pauses. Concurrent real traffic and request/response breakpoint tests. |
| High | Session hydration loaded all history before trimming; queues/cache were count-only; composed responses were buffered without a bound. | Hydrate in 50-flow pages; approximate 32 MiB live-cache and queued-body budgets; 128 proxy connections; streamed 64 KiB compose preview; sustained-RSS graceful shutdown guard (default 1 GiB). Child-process regression verifies cleanup precedes exit. |
| Medium | Spilled request replay lost bodies, and redacted spilled responses could not become mocks. | Authorized bounded spill-file reads, re-redaction, framing-header normalization, and explicit missing-body errors; real 80 KiB POST replay and 70 KiB captured JSON mock tests. |
| Medium | Empty captured chunked responses could silently become empty mocks after upstream capture discarded bytes. | Conservatively mark empty chunked captures unavailable; refuse automatic mocking rather than invent an empty payload. |
| Medium | CA replacement could be interrupted between the key and certificate writes. | Private fsynced intent journal; startup completes the intended pair under the CA lock; valid-pair rollback is journaled too. Interrupted-write and corrupt-journal regressions. |
| Medium | LaunchAgent logs grew indefinitely; routing diagnostics trusted stale state. | Rotate each log at 5 MiB with three bounded archives, preserving launchd's open inode; compare recorded PAC to the system's current setting. |
| Medium | Agent JSON editing required manual body/file management; unfinished flows failed MCP schema validation. | `mock_json_response`, `patch_mock_json`, `capture_to_mock.json_merge_patch`, and `debug-ios-api` prompt; real MCP transport regression covers the complete workflow, including null duration on pending flows. |
| High | Installed launchd job repeatedly exited before loading the server: `EPERM` opening the checkout under Documents (2,674 recorded launch attempts). | Install independent private runtime/dependency snapshots outside the protected checkout, serialize installs, and keep one previous snapshot. Tests start the snapshot after moving the original checkout and check dependency symlinks/owned cleanup. This failure is consistent with macOS [Documents-folder privacy protection](https://developer.apple.com/documentation/bundleresources/information-property-list/nsdocumentsfolderusagedescription); the observed error itself is recorded locally. |

## Verification

- 190 passing tests on Node 24 LTS, the installed Node 25 binary, and local Node 26. Coverage includes real stdio MCP workflows, memory-pressure cleanup, checkout-independent runtime installation, dependency symlinks and owned snapshot retention; the final stable-entry-point publication checks also passed on Node 25.
- Isolated daemon integration: readiness, competing owner refusal, SIGTERM cleanup, restart, SIGKILL, stale-lock recovery and new token. It does not change host trust or routing.
- Native Simulator probe: untrusted test CA failed with `NSURLErrorDomain -1202`; after targeted root import, the same URLSession check returned HTTP 200 with system trust verified. A dedicated test CA and disposable Simulator were used, not a developer app/device. Automatic app PAC routing is explicitly a separate check.
- 10,000-flow storage benchmark: append/update/pagination and durable row storage exercised.
- Five-minute isolated mixed-HTTP soak: 11,339 requests, 594 live JSON-rule updates, 150 breakpoint resolutions, zero failures and zero dropped capture events; peak process RSS 215,924,736 bytes (~206 MiB). Mix includes passthrough, mocks, gzip/spilled bodies, session retention and restart/hydration. This is not a real-app or multi-day certification. Repeat with `npm run test:soak -- 3600` (up to 86,400 seconds); CI runs 60 seconds on changes and 300 seconds weekly.
- Production dependency audit: zero reported vulnerabilities after updates. Package-content dry run includes the Swift probe, CLI verifier, and both new guides.

Run the complete suite after dependency changes. CI's Node 20/22/24 matrix remains important; a local run on one Node version does not establish all-version compatibility. The real Simulator probe is manual because hosted CI does not always provide a booted compatible runtime.

## Remaining limitations / follow-up validation

- No multi-day real-app soak or proof across every Xcode/iOS/VPN combination; pinning and proxy-bypassing app stacks still need app-specific debug configuration.
- Rules are ordered alternatives, not a middleware chain. Disable an overlapping mock before using a breakpoint on that endpoint. Clients share rule/session state; use task-specific rule IDs and clean up only your own rules.
- Bounds and the RSS restart guard are not a hard OS memory ceiling. A sudden spike can beat the sampler; inspect capture-drop/persistence diagnostics and prefer narrow API routing.
- Oversized/omitted bodies cannot be reconstructed. Empty chunked captures are conservatively unavailable, including legitimately empty chunked responses; supply explicit mock JSON when necessary.
- Captures are decoded/redacted HTTP representations, not byte-identical wire recordings. Spilled text replay works; stored binary replay requires sensitive-data authorization, and redacted replay deliberately omits real credentials.
- PAC drift is detected on the recorded macOS network service but never forcibly overridden. VPN/service changes may require explicit operator rerouting.
- Corrupt/unreadable CA journals or disk failure still require repair; automatic recovery does not bypass filesystem errors or grant trust to an app with certificate pinning.
- Log rotation checks every 30 seconds, so active logs can temporarily exceed 5 MiB; only the newest 5 MiB of an oversized stream is retained per archive.
- npm advisories remain time-sensitive; scheduled weekly audits help detect new reports but do not prove absence of vulnerabilities.

Setup details and recovery commands are in [iOS Simulator setup](IOS_SIMULATOR_SETUP.md); agent examples are in [Agent network workflow](AGENT_NETWORK_WORKFLOW.md). No public package was published by this hardening pass.
