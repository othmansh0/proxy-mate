# Changelog

## Unreleased

- Give guardian-initiated shutdowns 25 seconds before escalation, record shutdown intent and load-aware diagnostics, and retry failed recovery steps without blocking ticks.
- Add an isolated daemon load harness with real bridge and guardian probes, optional CPU starvation and background scheduling, JSON evidence, and owned-process cleanup.
- Keep authenticated health probes available under agent load, isolate bridge rate and long-call budgets, expose control metrics, and reduce bridge readiness and subscription polling.

## 0.9.1 — 2026-11-16

- Wait for npm's publish-time scanning and registry availability before completing a release. Keep verification bounded and reject integrity mismatches or registry errors without retrying the upload.

## 0.9.0 — 2026-11-12

- Rename the project to Proxy Mate, the npm package to @othmansh01/proxy-mate, the CLI to proxy-mate and the GitHub repository to othmansh0/proxy-mate.
- Reuse existing state and CA certificates in place; accept legacy environment variables, cached resource URIs, runtime markers and exported data. Retire old background service labels transactionally and migrate owned agent registrations with backups. Keep proxy-mcp as a CLI compatibility alias.
- Prepare the first public npm release of @othmansh01/proxy-mate with a one-command npx setup and no package authentication for users. This is a pre-1.0 release.
- Add version-tagged GitHub releases, audited package artifacts, checksum files, clean-consumer smoke tests and tokenless npm trusted publishing with provenance. Keep prereleases on the next npm channel.
- Read the runtime version from package.json and use npm version hooks to update the changelog, package version, lockfile and annotated Git tag together.

## 0.8.3 — 2026-11-12

- Rewrite the README around a two-command private install and natural-language QA/developer workflows; move advanced operational detail into focused guides.
- Add init for stable client registration, private configuration backups, preview mode, safe service reuse and guarded idle upgrades. Support Claude Code, Codex, Cursor, Claude Desktop and manual JSON configuration.
- Package as @othmansh0/proxy-mcp on private GitHub Packages with restricted publishing and bundled audited dependencies. Add an ESM client API and TypeScript declarations that connect to an existing daemon without import-time capture/service side effects.

## 0.8.2 — 2026-11-12

- Upgrade the optional SQLite driver to 13.0.3. Preserve corruption diagnostics during fallback initialization and close failed native handles.

- Add compact canonical envelopes on refreshed bridges, with opt-in legacy aliases; smaller discovery defaults/metadata and 2 KiB body previews reduce context use. Preserve exact URLs, rule/error evidence, explicit limits and paging.
- Add bounded redacted JSON Pointer/wildcard queries for scalar values/counts and structural summaries, avoiding full body/file dumps. Expose scan/output truncation explicitly.
- Promote next actions, flag repeated unchanged reads without caching traffic, and return deterministic export-path/sensitive-scope recovery guidance. Report old/unreported bridge metadata without restarting capture.
- Track resources created under task leases and add finish_capture_task for safe one-call cleanup/release, including stopped-proxy persistence. Retain evidence, preexisting/changed fixtures and explicitly kept QA resources; preserve mock assets still referenced by another rule.


## 0.8.1 — 2026-11-11

- Batch fresh app socket ownership checks, share process verification only within a batch, refresh verified app bundle paths after reinstall, and expose attribution omissions/overload separately from persistence health.
- Reuse app capture for repeated setup and renew routing only when expired or explicitly requested. Reuse/rename active sessions; reject active-session creation before persisting an orphan and restore the selected durable session after daemon recovery.
- Export complete redacted text/JSON to private files and HAR/session archives, including spilled bodies, without sensitive access. Bound body export to 50 MiB and report binary/missing/over-budget omissions. Redact HAR redirect URLs and enforce private file permissions.
- Add bounded persistent task leases for shared capture/routing/rule mutations. Thin bridges remember an explicitly acquired lease; reads, exports and replay remain available to other agents. Keep breakpoint resolution concurrent and preserve trusted daemon shutdown/recovery.
- Improve startup guidance, distinguish slow status from an unreachable daemon, and report app attribution degradation without recommending unnecessary Mac trust in app mode. Give long diagnostics progress/deadline metadata.


## 0.8.0 — 2026-11-08 (local release)

- Give capture-owner processes a configurable 2000 ms connection-attempt window while preserving address-family selection, TLS validation and single-shot HTTP forwarding. Expose the active setting in proxy status.
- Preserve safe upstream error tags and flow-correlated diagnostics for proxy-generated 502 responses, distinguishing them from real backend responses without storing raw error content.
- Add app-first CLI/chat setup and native Simulator app attribution before inspection. Other and unknown connections bypass capture; app mode changes only the selected Simulator's trust and uses a separate gateway port for recovery isolation.
- Make Mac Keychain trust and automatic Simulator imports opt-in with `--trust-host-ca` and `--trust-simulators`; retain explicit domain and Mac-wide capture as advanced choices.
- Explain new Mac certificate trust in a native dialog before system authentication; cancel and unavailable GUI sessions leave certificate trust unchanged, and existing trust skips both prompts.
- Verify native TLS trust on booted Simulators before automatic PAC routing in both daemon and MCP startup; leave new routing disabled when certificate setup or verification fails.
- Accept repeated captured header values in MCP flow output without widening request inputs or exposing sensitive headers.
- Added a thin default MCP bridge with offline onboarding/help, server instructions, and periodic progress for long tools. In-process capture now requires `--in-process`.
- Added independent supervised recovery, bounded event journals, runtime/dependency fingerprints and transactional install rollback.
- Made system routing opt-in, scoped, leased and fail-open in PAC-aware clients; use the actual primary service, protect other proxies and roll back partial setup failures. Fixed empty/null PAC URL parsing and preserve external changes.
- Routed local reverse proxies through capture/mocks, tracked loopback sockets for bounded cleanup, and preserved healthy daemons in doctor.
- Support maintained Node 22/24/26 lines; local deployment uses Node 24 LTS.

## Earlier unreleased hardening

- Added `--require-daemon` for shared production MCP clients, a cancellable 15-second authenticated readiness wait across daemon restarts, and actionable outage results without taking capture ownership.
- Mark interrupted mutation RPCs as having an unknown outcome and unsafe to retry; covered two persistent MCP clients, owner disconnect, daemon SIGKILL recovery and a response lost after mutation acceptance.
- Refreshed the MCP SDK, Mockttp, Zod and vulnerable transitive overrides; the 7 November production dependency audit reports zero advisories. Added the current replacement-readiness assessment to the reliability audit.

- Added agent-friendly `mock_json_response`, `patch_mock_json`, captured-response JSON merge patches, and the `debug-ios-api` workflow prompt/playbook.
- Replaced reset/rebuild with atomic HTTP-rule swaps that preserve pending breakpoints and WebSocket/capture subscriptions; tested concurrent traffic during edits.
- Fixed spilled-body replay/mocking, bounded outbound previews and session hydration, added cache/queue byte budgets and sustained-memory-pressure cleanup/restart handling.
- Added durable CA transaction recovery, bounded LaunchAgent log retention, live PAC-drift diagnostics, and scheduled audit/soak CI checks.
- Fixed launchd `EPERM` startup loops for checkouts under macOS-protected folders: install an independent private runtime/dependency snapshot, serialize installs, and retain one previous snapshot. Re-run `install` after source/dependency upgrades.
- Fixed unfinished-flow MCP schema validation; added real MCP workflow, CA recovery, memory-guard, replay and retention regressions plus an isolated configurable mixed-traffic soak runner.

- Hardened daemon/stdio ownership, reconnect, shutdown, control-plane validation and LaunchAgent readiness; preserved routing ownership and failed-recovery state.
- Disabled Mockttp's unbounded raw request history, coalesced WebSocket persistence with a global message budget, and bounded asynchronous capture work.
- Validated and serialized CA lifecycle operations, preserved custom certificate files, and added native `verify_simulator_certificate` / `npm run verify:simulator` trust checks.
- Made gzip/deflate/Brotli API bodies inspectable with bounded decoding and refused omitted-body mock creation.
- Updated vulnerable production dependency pins; added regression coverage and detailed Simulator setup/reliability documentation.

- Fixed the daemon crashing on the first captured body: `proxy.mjs` called `crypto.createHash` and `crypto.X509Certificate` without importing `node:crypto`, so it resolved the Web Crypto global, which has neither. `storeCapturedBody` threw `TypeError: crypto.createHash is not a function` on the first response body and took the whole daemon down; launchd then respawned it into the same crash on the next request. `rotateCA` had the same latent failure.
- Fixed the control plane turning a serialization failure into a daemon crash. On a tool result that `JSON.stringify` refuses, the success path had already committed headers, so the `catch` called `writeHead` a second time and threw `ERR_HTTP_HEADERS_SENT` inside an async `'end'` handler where nothing could catch it. The result is now serialized before headers are committed, and the error path no longer writes to a committed response.
- Fixed every certificate tool failing on an ordinary RSA CA. `inspectCertificate` spread `publicKey.asymmetricKeyDetails` into its result, and Node reports `publicExponent` as a BigInt, which `JSON.stringify` refuses — so `setup_simulator_certificate` and its siblings failed with `Do not know how to serialize a BigInt` for the CA the server generates by default.
- Fixed host CA install and uninstall being unable to find their own certificate. The keychain lookup filtered on the common name `proxy-mate CA`, which never matched: `ensureCA` passed `commonName`/`organizationName` at the top level of `generateCACertificate`, but mockttp 4.x reads them from a nested `subject`, so the CA was issued with mockttp's default subject — `Mockttp Testing CA - DO NOT TRUST - TESTING ONLY`. `install` therefore aborted with "trust could not be verified" *after* trusting the certificate, and `uninstall` reported it "not installed" and left a trusted root behind. The CA is now generated with the intended subject, and the certificate is identified by SHA-256 fingerprint rather than by name.
- Fixed `get_flow_detail` failing MCP output validation whenever a body was captured. The flow serializers emit `null` as the explicit "absent" marker (`body_omitted: false` with `body_omission_reason: null`), but the contract declared those fields optional-only, so the SDK rejected the tool's own well-formed output with `Invalid structured content`.

## 0.7.0 - 2026-08-17

- Added bounded QuickJS-sandboxed transform plugins with source/input/output size caps, a timeout, and memory/stack limits; new plugins default disabled, and registering a live `request`/`response` rule for one — by tool call, rule import, or startup replay — requires `PROXY_MATE_ENABLE_TRANSFORM_PLUGINS=1`, enforced once at the engine's rule-registration choke point so no path can bypass it. `websocket_offline` plugins fail with `PLUGIN_STAGE_MISMATCH` before the grant is even consulted, since they are never a valid live rule stage regardless of the grant; an ungranted `request`/`response` plugin still fails with `TRANSFORM_PLUGINS_NOT_ENABLED`.
- Added `list_transform_plugins`, `get_transform_plugin`, `upsert_transform_plugin`, `remove_transform_plugin`, `set_transform_plugin_enabled`, `test_transform_plugin`, and `create_transform_plugin_rule`.
- Added five read-only capture adapters (apple-simulator, apple-device-manual, android-adb, docker, terminal-env) with safe preflight checks and inert, non-executing setup plans via `list_capture_adapters`, `get_capture_adapter`, `preflight_capture_adapter`, and `build_capture_setup_plan`.
- Added upstream HTTP(S)/SOCKS proxy chaining on `start_proxy` with credential redaction in every status and public config view.
- Added an optional, opt-in, loopback-only read-only operator dashboard (`start_operator_ui`, `stop_operator_ui`, `get_operator_ui_status`) with a per-run bearer token and no mutation endpoints.
- Added `get_extended_capabilities` and the `proxy-mate://capabilities` resource describing adapter, upstream proxy, transform sandbox, and protocol boundaries.
- Documented that live WebSocket frame mutation and injection remain unsupported by Mockttp 4.6.0's public API; only observational message events and handshake transforms are exposed.
- **Behaviour change**: rule `url` no longer treats `?` as a single-character wildcard. The first `?` in `url` is always the query separator — the query is parsed and moved into `match_query`, mirroring mockttp's own URL matching — and `'*'` remains the only glob character. Pass `url_pattern` for full control instead; it is a **regular expression**, not a glob, so translate a single-character wildcard to `.` and a multi-character one to `.*` (the glob `http://h/v?/users` becomes the pattern `^http://h/v./users$`, not the verbatim string, which would match `http://h/users`). Rule creation (`tools.mjs`) and the live proxy's URL normalization (`evaluateRule` in `proxy.mjs`) now share one implementation, `src/lib/url-match.mjs`, for splitting a `url` into its base and derived `match_query` — the part that previously drifted. The dry-run (`evaluateRule`) and live (mockttp `withQuery`) matchers still evaluate `match_query` itself with separate implementations and can differ in edge-case semantics.
- **Behaviour change**: `capture_to_mock` now anchors its rule on the captured URL and derives `match_query` from the captured query. A mock captured from `/v1/orders?page=2` answers that request only; `page=3` still reaches upstream. Previously the pattern was unanchored and host-less, so a mock of `GET /v1/users` also answered `http://any-host/x/v1/users/extra`. Pass `url_pattern` (a regular expression) to widen the mock, or re-create it with `create_map_local` and no `match_query`.
- **Behaviour change**: every `match_query` — caller-supplied or derived from a `url` query — is now validated on every registration path (tool call, `import_rules`, startup replay, `update_rule` patch). New coded, non-retryable errors: `MATCH_QUERY_INVALID` (not an object of query parameters), `MATCH_QUERY_EMPTY` (no parameters; `withQuery({})` matches every request), `MATCH_QUERY_EMPTY_VALUE` (a parameter whose value is `[]`, which lodash `isMatch` treats as a vacuous subset of the array a repeated parameter arrives as), and `QUERY_TOO_LARGE` (over 1,000 wire pairs, mockttp's own `url.parse` parser cap, or over 8,192 bytes of `key=value&` text). The size bound is new: moving the query out of `url_pattern` removed the 500-character cap it used to inherit, and rules are persisted and replayed on every start.
- **Upgrade note**: a rule persisted by 0.6.0 or earlier that carries `match_query: {}` (or a `[]` parameter value) now fails startup replay under those guards, drops out of the active rule set, and disappears from `rules.json` at the next persist. This is deliberate — such a rule matched every request on its path rather than the one query it named — and it is observable: the replay loop records a `rule-replay-failures` diagnostic (visible via `get_diagnostics`) listing the `rule_id` and the reason, `match_query has no parameters, and an empty query matcher matches every request`. Re-create the affected rule without `match_query`, or with the parameters it actually meant to constrain.
- **Behaviour change**: `match_headers` now passes the same gate as `match_query`, on the same four registration paths, because mockttp's `withHeaders` runs the same lodash `isMatch`. New coded, non-retryable errors: `MATCH_HEADERS_INVALID` (not an object of header names and values), `MATCH_HEADERS_EMPTY` (no headers; `withHeaders({})` matches every request on the path), and `MATCH_HEADERS_EMPTY_VALUE` (a header whose expected value is `[]`, which `isMatch` treats as a vacuous subset of a repeated header's values). The empty/non-object check is one shared helper (`validateMatcherObject`) used by both matchers rather than a second copy of the same logic. `match_headers` is deliberately not bounded by pair count or byte size: the pair cap exists only because mockttp's own query parser stops at 1,000 pairs, which headers have no equivalent of, and the byte cap replaced the 500-character bound the query lost when it left `url_pattern`, which `match_headers` never had.
- Fixed a `'__proto__'` key in `match_headers` being dropped by zod's `z.record` before the rule was ever built — the same hole already closed for `match_query`, with the same consequence: the surviving `match_headers` was `{}`, so a rule meant for one caller matched every request on its path. `match_headers` is now validated by hand and rebuilt onto a null-prototype object; the advertised JSON Schema (an object of strings) is unchanged.
- **Upgrade note**: a rule persisted before this release that carries `match_headers: {}` (or a `[]` header value) now fails startup replay exactly as an empty `match_query` does, with the reason recorded in the `rule-replay-failures` diagnostic. Re-create it with the headers it meant to constrain, or without `match_headers`.
- Closed the same hole in `match_json_body_including` at the top level: it now uses the null-prototype schema, so a root `__proto__` key survives, and a root `{}` or non-object is refused with `MATCH_JSON_BODY_EMPTY` / `MATCH_JSON_BODY_INVALID` instead of matching every request with a parseable JSON body. A *nested* `{}` or `[]` still matches any value at that key; tightening that needs a semantics decision at arbitrary depth and is recorded in `docs/CAPABILITIES.md`.
- Fixed a prototype-pollution edge case in derived `match_query`: a `url` containing a literal `__proto__` query key now survives as an own property instead of silently writing the object's prototype slot and collapsing the constraint to "match everything".
- Fixed `test_rule`'s dry-run evaluation to match the live proxy's URL normalization exactly (query/fragment stripped, default port dropped, path-only comparison for method-specific rules), so a dry run no longer reports matches the live proxy would miss or misses matches it would make.
- Fixed a `'__proto__'` key in `match_query` being dropped by zod's `z.record` before the rule was ever built, silently widening the rule to match every value of that parameter. `match_query` is now validated by hand and rebuilt onto a null-prototype object, so the key survives; the advertised JSON Schema and `required` list are unchanged.
- **Behaviour change**: a non-object `match_query` (a string, array, or number) reaching `ruleUrlMatchers` outside the MCP schema — `import_rules`, a hand-written `rules.json`, or a direct `registerRule` — used to spread into an index-keyed object (e.g. `{0:'a',1:'b'}`) and register as a real constraint. It now raises `MATCH_QUERY_INVALID` on every such path, matching what the MCP schema already rejected.
- Fixed `test_rule`'s dry-run query parsing to agree with the live proxy past 1,000 query parameters: it now parses the query the same way mockttp does (`url.parse(url, true)`, which stops at 1,000 pairs) instead of via `URLSearchParams`, which has no cap.
- **Behaviour change**: `capture_to_mock`'s pattern now escapes every metacharacter in the captured path, including `'*'`, instead of building it as a glob. A flow captured from `/v1/a*b` now mocks that literal path only; it previously also matched `/v1/aXXXb`.
- Corrected the `MAX_QUERY_BYTES`/`QUERY_TOO_LARGE` rationale, in code and in `docs/CAPABILITIES.md`: the 8 KiB bound is a cap on what a rule persists to `rules.json` and replays on every `start_proxy`, and nothing more. Two earlier attempts to justify the number claimed more than that — first that a longer query could not reach the proxy, then that 8 KiB sits under the request-line limits other servers enforce — and both claims are gone rather than replaced. `capture_to_mock`'s size-limit recovery hints now point at the capture (shorten it, or pass `url_pattern`) instead of a `match_query` the tool never accepts.
- Corrected the `MATCH_QUERY_EMPTY` recovery hints: they told the caller to build the object with JSON rather than a `'{}'` literal, which no caller who can see the error is able to act on — MCP arguments arrive through `JSON.parse`, `rules.json` is JSON, and `import_rules` reads JSON. Now that a `__proto__` key is never dropped, the hints name the cause that remains: a rule written, imported, or stored before the guard carrying `match_query: {}` to mean "any query".
- Corrected the `capture_to_mock` documentation example, which illustrated literal escaping with a query parameter (`/v1/orders?tag=a*b`). The splitter cuts everything from the first `?` before the pattern is built, so that `*` was never regex-matched at all; the example now uses a path metacharacter, and the captured query is described separately as `match_query` compared by exact value.
- Fixed `redactBoundaryValue` rebuilding tool results with plain key assignment, which sent a `'__proto__'` key to the result object's prototype slot instead of keeping it as an own property — a rule correctly constrained on that key was reported back without it, and an object-valued `'__proto__'` key would have reparented the result object.

## 0.6.0 - 2026-08-16

- Added MCP workflow prompts, typed high-traffic outputs, readable tool groups, and live status/flow resource subscriptions.
- Added capture analytics and CI assertions, safe cURL import, JavaScript/Python/Go/Swift request export, session updates, and bounded session-wide OpenAPI validation.
- Added durable WebSocket snapshots/transcripts, offline replay plans, GraphQL batch matching, gRPC-web metadata, descriptor caching, and local external OpenAPI references.
- Hardened breakpoint redaction, capture-time sensitive persistence, configurable secret patterns, safe regex handling, control-plane Host/Origin/rate/concurrency limits, and observable fail-closed persistence health.
- Added Dependabot coverage and documented deliberate GUI, scripting, platform, packet/DNS, HTTP/3, and live WebSocket injection boundaries.

## 0.5.0 - 2026-08-16

- Replaced whole-session JSON rewrites with private SQLite/WAL row storage, transactional v1 JSON migration, indexed flow search, corruption diagnostics, retention accounting, and a permanent 10k-flow benchmark.
- Added capture-time credential redaction, metadata-only binary storage by default, selectable body policies, sensitive-storage double opt-in, and scoped daemon control capabilities.
- Restricted LAN proxy access to explicit IP/CIDR allowlists with automatic TTL revocation and active-connection teardown.
- Added CA expiry guidance and safe stopped-proxy rotation with public-certificate archives and opt-in old-key retention.
- Upgraded MCP SDK and Mockttp, pinned patched transitive dependencies, and reached zero production npm advisories.
- Added MCP-to-daemon cancellation propagation, cancellable outbound requests, bounded persistence backpressure metrics, and Node 20/22/24 macOS CI.

## 0.4.0 - 2026-08-16

- Added durable named capture sessions, stable cursor pagination, retention controls, import/export, and live flow waiting.
- Added a versioned structured MCP response envelope, output schemas, tool annotations, resources, progress notifications, logging, and structured daemon errors.
- Expanded rules with enable/disable, update, priority/reordering, dry-run explanations, request/response transforms, directory Map Local, faults, delays, network profiles, and no-cache behavior.
- Added bounded WebSocket connection/message capture, HAR import/export improvements, GraphQL/gRPC/protobuf inspection, compose/repeat/edit/diff, Swift request export, reverse proxying, and OpenAPI flow validation.
- Added Xcode Preview certificate setup, iOS capture diagnostics, and a tokenized physical-device onboarding portal.
- Hardened sensitive-data access, filesystem authorization, CA status reads, daemon authentication, and safe `start_proxy` defaults.

## 0.3.0

- Added production-oriented control-plane, PAC-routing, certificate, Simulator, capture, rule, and diagnostic foundations.
