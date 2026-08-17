# Changelog

## 0.7.0 - 2026-08-17

- Added bounded QuickJS-sandboxed transform plugins with source/input/output size caps, a timeout, and memory/stack limits; new plugins default disabled, and registering a live `request`/`response` rule for one — by tool call, rule import, or startup replay — requires `PROXY_MCP_ENABLE_TRANSFORM_PLUGINS=1`, enforced once at the engine's rule-registration choke point so no path can bypass it. `websocket_offline` plugins fail with `PLUGIN_STAGE_MISMATCH` before the grant is even consulted, since they are never a valid live rule stage regardless of the grant; an ungranted `request`/`response` plugin still fails with `TRANSFORM_PLUGINS_NOT_ENABLED`.
- Added `list_transform_plugins`, `get_transform_plugin`, `upsert_transform_plugin`, `remove_transform_plugin`, `set_transform_plugin_enabled`, `test_transform_plugin`, and `create_transform_plugin_rule`.
- Added five read-only capture adapters (apple-simulator, apple-device-manual, android-adb, docker, terminal-env) with safe preflight checks and inert, non-executing setup plans via `list_capture_adapters`, `get_capture_adapter`, `preflight_capture_adapter`, and `build_capture_setup_plan`.
- Added upstream HTTP(S)/SOCKS proxy chaining on `start_proxy` with credential redaction in every status and public config view.
- Added an optional, opt-in, loopback-only read-only operator dashboard (`start_operator_ui`, `stop_operator_ui`, `get_operator_ui_status`) with a per-run bearer token and no mutation endpoints.
- Added `get_extended_capabilities` and the `proxy-mcp://capabilities` resource describing adapter, upstream proxy, transform sandbox, and protocol boundaries.
- Documented that live WebSocket frame mutation and injection remain unsupported by Mockttp 4.6.0's public API; only observational message events and handshake transforms are exposed.
- **Behaviour change**: rule `url` no longer treats `?` as a single-character wildcard. The first `?` in `url` is always the query separator — the query is parsed and moved into `match_query`, mirroring mockttp's own URL matching — and `'*'` remains the only glob character. Pass `url_pattern` for full control instead; it is a **regular expression**, not a glob, so translate a single-character wildcard to `.` and a multi-character one to `.*` (the glob `http://h/v?/users` becomes the pattern `^http://h/v./users$`, not the verbatim string, which would match `http://h/users`). Rule creation (`tools.mjs`) and the live proxy's URL normalization (`evaluateRule` in `proxy.mjs`) now share one implementation, `src/lib/url-match.mjs`, for splitting a `url` into its base and derived `match_query` — the part that previously drifted. The dry-run (`evaluateRule`) and live (mockttp `withQuery`) matchers still evaluate `match_query` itself with separate implementations and can differ in edge-case semantics.
- **Behaviour change**: `capture_to_mock` now anchors its rule on the captured URL and derives `match_query` from the captured query. A mock captured from `/v1/orders?page=2` answers that request only; `page=3` still reaches upstream. Previously the pattern was unanchored and host-less, so a mock of `GET /v1/users` also answered `http://any-host/x/v1/users/extra`. Pass `url_pattern` (a regular expression) to widen the mock, or re-create it with `create_map_local` and no `match_query`.
- **Behaviour change**: every `match_query` — caller-supplied or derived from a `url` query — is now validated on every registration path (tool call, `import_rules`, startup replay, `update_rule` patch). New coded, non-retryable errors: `MATCH_QUERY_INVALID` (not an object of query parameters), `MATCH_QUERY_EMPTY` (no parameters; `withQuery({})` matches every request), `MATCH_QUERY_EMPTY_VALUE` (a parameter whose value is `[]`, which lodash `isMatch` treats as a vacuous subset of any value), and `QUERY_TOO_LARGE` (over 1,000 wire pairs, mockttp's own `url.parse` parser cap, or over 8,192 bytes of `key=value&` text). The size bound is new: moving the query out of `url_pattern` removed the 500-character cap it used to inherit, and rules are persisted and replayed on every start.
- **Upgrade note**: a rule persisted by 0.6.0 or earlier that carries `match_query: {}` (or a `[]` parameter value) now fails startup replay under those guards, drops out of the active rule set, and disappears from `rules.json` at the next persist. This is deliberate — such a rule matched every request on its path rather than the one query it named — and it is observable: the replay loop records a `rule-replay-failures` diagnostic (visible via `get_diagnostics`) listing the `rule_id` and the reason, `match_query has no parameters, and an empty query matcher matches every request`. Re-create the affected rule without `match_query`, or with the parameters it actually meant to constrain.
- Fixed a prototype-pollution edge case in derived `match_query`: a `url` containing a literal `__proto__` query key now survives as an own property instead of silently writing the object's prototype slot and collapsing the constraint to "match everything".
- Fixed `test_rule`'s dry-run evaluation to match the live proxy's URL normalization exactly (query/fragment stripped, default port dropped, path-only comparison for method-specific rules), so a dry run no longer reports matches the live proxy would miss or misses matches it would make.

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
