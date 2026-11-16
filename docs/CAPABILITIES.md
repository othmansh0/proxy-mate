# Capabilities and limits

The MCP tool registry is the source of truth. Every tool has an input schema, output schema, behavior annotations, a readable title, and a stable `1.0` result envelope.

## What is included

| Area | Capabilities |
|---|---|
| Capture | HTTP/HTTPS interception, optional SOCKS clients, custom CA pairs, HTTP/2 fallback, recording control, metadata-first flow lists, exact/substring/safe-regex filters, cursors, and live waiting. |
| Sessions | Named SQLite/WAL sessions, atomic metadata and retention updates, import/export, quotas, migration diagnostics, and capture analysis/assertions. |
| Bodies | `none`, `preview`, and `full` reads; hashes, byte sizes, explicit omission reasons, spill files, and MCP body resources. |
| Rules | Map Local/Remote, JSON mocks and RFC 7396 merge patches, blacklist, request/response transforms, delay/fault profiles, no-cache, priority/order, dry-run matching, portable import/export, and atomic HTTP-rule replacement. |
| Breakpoints | Bounded request/response pauses with continue, modify, synthetic response, abort, close, reset, deadline fallback, and redacted history. |
| Requests | Safe cURL parsing, cURL/JavaScript/Python/Go/Swift export, compose, repeat/edit-and-repeat, and semantic flow comparison. |
| Protocols | GraphQL operation parsing and batch matching, gRPC/grpc-web frame metadata, authorized Protobuf decode, and OpenAPI 3.x single-flow/session validation. |
| WebSockets | Durable bounded connection/message capture, paging, hashes, close state, transcript/snapshot import-export, and offline replay plans. |
| Apple setup | Host CA trust, Simulator and feature-detected Xcode Preview setup, app restart, watcher, diagnostics, and expiring physical-device onboarding. |
| App capture | CLI/chat setup defaults to one unmodified Simulator app. Socket owner, bundle path and Simulator process identity gate inspection; other and unknown connections pass through without capture. Mac trust and automatic Simulator imports are opt-in. |
| Operations | Authenticated local daemon, exact PAC restoration, reverse proxies, structured diagnostics, persistence health/fail-closed mode, CI, and a headless assertion CLI. |
| Transform plugins | QuickJS-sandboxed request/response/websocket_offline transforms with a bounded JSON-only manifest, disabled by default, no imports or host APIs. |
| Capture adapters | Preflight and setup plans for Apple Simulator, physical Apple devices, Android (ADB), Docker, and terminal/environment clients; read-only detection plus inert, human-executed setup plans — no adapter executes a mutation itself. |
| Upstream proxy | Chained HTTP, HTTPS, and SOCKS4/4a/5/5h upstream proxies with per-setting `noProxy` lists, optional additional trusted CAs, and redacted public output. |
| Operator UI | Optional, explicitly started, read-only local dashboard projecting health, status, and redacted flow/rule summaries. |
| MCP UX | Typed structured results, prompts, resources, subscriptions, cancellation, progress, logs, and actionable error recovery. |

Use `get_protocol_capabilities` when a client needs a machine-readable statement of protocol support.

## Important limits

- OpenAPI input is JSON. Local and caller-provided external JSON references are supported; remote reference fetching and YAML parsing are not.
- OpenAPI validation covers common operation, parameter, media type, response, and bounded schema checks. Unsupported schema constructs are reported explicitly.
- Protobuf decoding requires an authorized local descriptor and `protoc`; automatic reflection is not performed.
- WebSocket transcripts can be analyzed and turned into offline replay plans, but live frame injection is not claimed.
- Network profiles apply HTTP-level delay and faults; they are not packet loss, bandwidth, radio, jitter, or DNS simulation.
- HTTP rule changes compile off-server and atomically replace the ordered rules without resetting capture subscriptions, WebSocket rules, or existing breakpoint pauses. Rules remain ordered alternatives rather than a middleware chain; clients share the same rules and active session.
- Simulator CA import can be verified, but Apple does not provide a safe targeted command to remove one Simulator root. The destructive keychain-reset command is intentionally absent.
- Physical-device CA installation and full-trust confirmation remain manual Apple Settings actions.
- Transform plugins run in a fresh QuickJS runtime per execution, JSON-in/JSON-out only, with no module imports, no `require`/`process`/`Buffer`/`fetch`/`WebSocket`/host APIs. Registering a live `request`/`response` rule for one — by tool call, rule import, or startup replay — requires `PROXY_MATE_ENABLE_TRANSFORM_PLUGINS=1` on the server; storing, upserting, or test-executing a plugin does not.
- Capture adapters describe Apple Simulator, physical Apple device (manual), Android ADB, Docker, and terminal/environment clients. No shipped tool executes a setup step: `list_capture_adapters`, `get_capture_adapter`, and `preflight_capture_adapter` are read-only, and `build_capture_setup_plan` returns an inert plan (`mutates_target: false`, `executes_automatically: false`) for a human to run. Android ADB's `automatable_with_confirmation` proxy/CA metadata describes what a future confirmed automation could cover, not a path this codebase executes today. None automate certificate-pinning bypass or require root.
- Upstream proxy chaining supports `http:`, `https:`, and `socks:`/`socks4:`/`socks4a:`/`socks5:`/`socks5h:` scheme URLs only; PAC URLs, proxy callbacks, rule-parameter references, and replacing the default trusted-CA set are not supported.
- Live WebSocket frame mutation and injection are unsupported by mockttp 4.6.0's public API: `PassThroughWebSocketStepImpl` privately pipes message/close/ping/pong events between downstream and upstream sockets, and the public `websocket-message-received`/`websocket-message-sent` events and `transformRequest` handshake option are observational only, exposing no socket handle or reply/mutation callback.
- The operator UI is a read-only projection: it binds only `127.0.0.1`, requires a random bearer access code, enforces strict Host/Origin checks, sends `no-store` and a restrictive CSP with no external assets, and exposes only projected health, status, and redacted flow/rule summaries—never headers, bodies, or a mutation endpoint.
- Rule `url` matching: the first `?` in `url` is always the query separator, never a single-character wildcard — `'*'` is the only glob character. Everything after that `?` (up to a `#` fragment, which is dropped) is parsed and merged into `match_query`; a caller-supplied `match_query` wins per key over one derived from `url`. Every rule-creating tool (`create_map_local`, `create_map_remote`, `create_blacklist`, `create_network_condition`, `create_no_cache_rule`, `create_breakpoint`, `create_transform_plugin_rule`) accepts `url_pattern` and `match_query`; a supplied `url_pattern` (and its accompanying `match_query`) always overrides anything derived from `url`.
- `url_pattern` is a **regular expression**, not a glob. It is compiled as a raw `RegExp` (bounded to 500 characters and a ReDoS-safe subset: no backreferences, no nested unbounded quantifiers), so `?` means "the previous atom is optional" and `*` means "zero or more of the previous atom" — neither is a wildcard. Translating a glob: write `.` for one character and `.*` for many, so the glob `http://h/v?/users` becomes `^http://h/v./users$` and `*/v1/users` becomes `^.*/v1/users$`. Anchor (`^…$`) and escape literal dots (`\.`) yourself: a pattern derived from `url` is anchored and escaped for you, but a hand-written `url_pattern` is used exactly as given.
- `match_query` bounds, enforced on every path that can register a rule — tool call, `import_rules`, startup replay, and an `update_rule` patch — for both a caller-supplied `match_query` and one derived from a `url` query:
  - `MATCH_QUERY_INVALID` — `match_query` is not an object of query parameters (a string, number, or array).
  - `MATCH_QUERY_EMPTY` — `match_query` has no parameters. mockttp's `withQuery({})` runs `_.isMatch(query, {})`, which is unconditionally true, so an empty matcher is not a weak constraint but the absence of one: a blacklist meant for one query would block the whole path. `match_query` keeps a `__proto__` key (it is validated and rebuilt by hand onto a null-prototype object, not parsed with a plain `z.record`, and never dropped), so nothing is lost on the way in any more and an empty object is the one the caller or the stored rule actually holds — typically a rule written, imported, or stored before this guard that carried `match_query: {}` meaning "any query". Re-create it with the parameters it meant to constrain, or without `match_query`.
  - `MATCH_QUERY_EMPTY_VALUE` — a parameter's value is an empty array. `_.isMatch` treats `[]` as a vacuous subset of an array actual, so it matches whatever values a repeated parameter arrives with, while a single-valued one does not match at all. Name the value, or drop the key.
  - `QUERY_TOO_LARGE` — more than 1,000 wire pairs (a repeated key counts once per value; mockttp parses incoming requests with `url.parse(url, true)`, whose parser stops at 1,000 pairs, so a larger matcher can never fire) or more than 8,192 bytes measured as the `key=value&` string it must match. The byte cap bounds what a rule persists to `rules.json` and replays on every `start_proxy`; it is not a statement about what any client, server, or proxy accepts on the wire.

  These four codes are enforced on every path that can register a rule, including the query `capture_to_mock` derives from a captured flow; on that derived path the recovery hints point at the capture (a shorter query, or `url_pattern`) rather than a `match_query` the caller never supplied.
- `match_headers` bounds, enforced on the same four paths, through the same shared matcher gate as `match_query` (`validateMatcherObject` in `src/lib/url-match.mjs`), because mockttp's `withHeaders` runs `_.isMatch(request.headers, match_headers)` exactly as `withQuery` runs it against the query:
  - `MATCH_HEADERS_INVALID` — `match_headers` is not an object of header names and values.
  - `MATCH_HEADERS_EMPTY` — `match_headers` has no headers, and `_.isMatch(headers, {})` is unconditionally true, so the rule would match every request on its path instead of the one it names.
  - `MATCH_HEADERS_EMPTY_VALUE` — a header's expected value is an empty array, which `_.isMatch` treats as a vacuous subset of the array a repeated header (`set-cookie` and friends) arrives as.

  `match_headers` keeps a `__proto__` key through the same hand-written null-prototype schema as `match_query`, and the advertised JSON Schema is unchanged (an object of strings). Names are matched lower-cased and values by exact equality. `match_headers` is deliberately **not** bounded by pair count or byte size: the 1,000-pair cap exists only because mockttp parses an incoming query with a parser that stops at 1,000 pairs, which has no header equivalent, and the 8,192-byte cap replaced the 500-character bound the query lost when it moved out of `url_pattern` — `match_headers` never had such a bound, and it sits alongside the other unbounded rule fields (`headers`, `match_json_body_including`, `body_inline`).
- `match_json_body_including` is guarded the same way **at the top level**: it uses the same null-prototype schema, so a root `__proto__` key survives, and a root `{}` or a non-object is refused with `MATCH_JSON_BODY_EMPTY` / `MATCH_JSON_BODY_INVALID`. The advertised JSON Schema is unchanged. mockttp compiles this matcher to `_.isMatch(jsonBody, expected)`, so a root `{}` would otherwise match every request whose body parses as JSON.
  Known limitation: the guard is **top level only**. A *nested* `{}` or `[]` still matches any value at that key (`_.isMatch({outer:{a:1}}, {outer:{}})` is `true`, as is the array form), so a rule can still be broader than intended below the root. Nested keys themselves are safe — a nested `__proto__` survives `JSON.parse`, `structuredClone`, and the JSON round-trip through `rules.json` as an ordinary own property. Tightening nested empties needs a semantics decision at arbitrary depth, so it is recorded here rather than half-fixed.
- `match_query` is a subset match, not an exact match: mockttp's `withQuery` only requires the rule's query parameters to be present with matching values, so a rule built from `http://h/a?b=1` also matches a request to `http://h/a?b=1&c=2`. Add `match_query` keys explicitly, or use `url_pattern`/`match_body_regex`, to constrain the query more tightly.
- `capture_to_mock` builds its rule through the same URL splitter, but literally, not as a glob: every metacharacter in the captured **path** is escaped, `*` included, so a flow captured from `/v1/a*b` mocks that literal path and nothing else — it does not also answer `/v1/aXXXb`, as a glob would. The captured **query** is never regex-matched at all: the splitter cuts everything from the first `?` before the pattern is built, and those parameters become `match_query`, which mockttp compares by exact value. The mock is anchored on the captured URL (`^…$`, host included) and constrained to that query, so a flow captured from `/v1/orders?page=2` answers `page=2` only and `page=3` still reaches upstream. Pass `url_pattern` (a regular expression) to widen it, or re-create the rule with `create_map_local` and no `match_query`.

## Sandbox limits (transform plugins)

- Source: 64 KiB max.
- Input: 256 KiB max.
- Output: 256 KiB max.
- Memory: 16 MiB max.
- Stack: 512 KiB max.
- Execution time: 50 ms max.
- JSON complexity: 64 levels deep, 100,000 nodes max.

## Result and data limits

- Flow lists are bounded and metadata-only; request large bodies explicitly.
- Session OpenAPI validation defaults to 100 flows and caps at 1,000.
- WebSocket connection/message stores and breakpoint queues are bounded.
- Flow-cache and queued-body estimates are each capped at 32 MiB; session hydration pages 50 flows at a time, composed responses retain at most 64 KiB, and sustained process RSS above 1 GiB triggers graceful shutdown by default. These are layered safeguards, not a hard OS memory guarantee.
- Managed CA writes have a private durable recovery journal. Daemon logs rotate at 5 MiB (three archives per stream), checked every 30 seconds.
- The control plane limits request bytes, concurrent work, rate, headers, connections, and socket reuse.
- File access is limited to the state directory, current working directory, and explicit `PROXY_MATE_ALLOWED_PATHS` roots with symlink containment.

Canonical clients should read `structuredContent.data`. Top-level result properties are compatibility aliases during the 1.x contract window.
