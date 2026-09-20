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

## Verification

- 178 passing tests on Node 24 LTS and the local Node 26 runtime, including real localhost HTTP and MCP transport tests. The installed Node 25 binary also passed the 176-test suite before the last two focused regressions were added.
- Isolated daemon integration: readiness, competing owner refusal, SIGTERM cleanup, restart, SIGKILL, stale-lock recovery and new token. It does not change host trust or routing.
- Native Simulator probe: untrusted test CA failed with `NSURLErrorDomain -1202`; after targeted root import, the same URLSession check returned HTTP 200 with system trust verified. A dedicated test CA and disposable Simulator were used, not a developer app/device. Automatic app PAC routing is explicitly a separate check.
- 10,000-flow storage benchmark: append/update/pagination and durable row storage exercised.
- Production dependency audit: zero reported vulnerabilities after updates. Package-content dry run includes the Swift probe, CLI verifier, and both new guides.

Run the complete suite after dependency changes. CI's Node 20/22/24 matrix remains important; a local run on one Node version does not establish all-version compatibility. The real Simulator probe is manual because hosted CI does not always provide a booted compatible runtime.

## Remaining limitations / follow-up validation

- No long-duration mixed real-app load soak or proof across all Xcode/iOS/VPN/network-service combinations. Simulator system trust is tested, not every app's pinning/custom networking stack.
- Rule changes still use Mockttp reset/rebuild. Pending breakpoints are intentionally released, and a transient rule-update gap remains. Atomic rule replacement needs an engine-level implementation and dedicated concurrent-traffic tests.
- Bounds are layered, not a hard process-RSS ceiling. Very high concurrent upstream traffic can still pressure memory. Inspect capture-drop/persistence diagnostics and avoid broad `*` routing when only one API needs debugging.
- Mockttp can discard oversized bodies before events reach us. Declared nonempty bodies can be marked unavailable; a discarded chunked body with no size metadata may be indistinguishable from empty. Use explicit mock content for such flows.
- Capture decodes HTTP content encodings for inspection; it is not a byte-identical packet recorder. Raw/binary replay, large spilled-body workflows and arbitrary protocol fidelity should not be assumed. Redacted replay is intentionally not credential-complete.
- Launchd stderr/stdout files still need an operational retention policy for long-lived installations. Session retention does not rotate service logs.
- PAC settings are per macOS network service. Changes by a VPN or another proxy are preserved, not forcibly overridden; they can stop capture until the user resolves routing.
- CA updates are two filesystem replacements under an interprocess lock, with rollback on ordinary errors; an abrupt machine failure between replacements can leave a partial/mismatched pair, which now fails visibly instead of silently changing trust.
- npm advisories are time-sensitive. Keep dependency audit in CI; a clean result is not proof of absence of vulnerabilities.

Setup details and recovery commands are in [iOS Simulator setup](IOS_SIMULATOR_SETUP.md). No public package was published by this hardening pass.
