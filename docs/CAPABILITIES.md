# Capabilities and limits

The MCP tool registry is the source of truth. Every tool has an input schema, output schema, behavior annotations, a readable title, and a stable `1.0` result envelope.

## What is included

| Area | Capabilities |
|---|---|
| Capture | HTTP/HTTPS interception, optional SOCKS clients, custom CA pairs, HTTP/2 fallback, recording control, metadata-first flow lists, exact/substring/safe-regex filters, cursors, and live waiting. |
| Sessions | Named SQLite/WAL sessions, atomic metadata and retention updates, import/export, quotas, migration diagnostics, and capture analysis/assertions. |
| Bodies | `none`, `preview`, and `full` reads; hashes, byte sizes, explicit omission reasons, spill files, and MCP body resources. |
| Rules | Map Local/Remote, blacklist, request/response transforms, delay/fault profiles, no-cache, priority/order, dry-run matching, and portable import/export. |
| Breakpoints | Bounded request/response pauses with continue, modify, synthetic response, abort, close, reset, deadline fallback, and redacted history. |
| Requests | Safe cURL parsing, cURL/JavaScript/Python/Go/Swift export, compose, repeat/edit-and-repeat, and semantic flow comparison. |
| Protocols | GraphQL operation parsing and batch matching, gRPC/grpc-web frame metadata, authorized Protobuf decode, and OpenAPI 3.x single-flow/session validation. |
| WebSockets | Durable bounded connection/message capture, paging, hashes, close state, transcript/snapshot import-export, and offline replay plans. |
| Apple setup | Host CA trust, Simulator and feature-detected Xcode Preview setup, app restart, watcher, diagnostics, and expiring physical-device onboarding. |
| Operations | Authenticated local daemon, exact PAC restoration, reverse proxies, structured diagnostics, persistence health/fail-closed mode, CI, and a headless assertion CLI. |
| MCP UX | Typed structured results, prompts, resources, subscriptions, cancellation, progress, logs, and actionable error recovery. |

Use `get_protocol_capabilities` when a client needs a machine-readable statement of protocol support.

## Important limits

- OpenAPI input is JSON. Local and caller-provided external JSON references are supported; remote reference fetching and YAML parsing are not.
- OpenAPI validation covers common operation, parameter, media type, response, and bounded schema checks. Unsupported schema constructs are reported explicitly.
- Protobuf decoding requires an authorized local descriptor and `protoc`; automatic reflection is not performed.
- WebSocket transcripts can be analyzed and turned into offline replay plans, but live frame injection is not claimed.
- Network profiles apply HTTP-level delay and faults; they are not packet loss, bandwidth, radio, jitter, or DNS simulation.
- Mockttp rule changes rebuild the ordered rule set because the engine has no per-endpoint removal API; a rebuild can briefly affect in-flight requests.
- Simulator CA import can be verified, but Apple does not provide a safe targeted command to remove one Simulator root. The destructive keychain-reset command is intentionally absent.
- Physical-device CA installation and full-trust confirmation remain manual Apple Settings actions.

## Result and data limits

- Flow lists are bounded and metadata-only; request large bodies explicitly.
- Session OpenAPI validation defaults to 100 flows and caps at 1,000.
- WebSocket connection/message stores and breakpoint queues are bounded.
- The control plane limits request bytes, concurrent work, rate, headers, connections, and socket reuse.
- File access is limited to the state directory, current working directory, and explicit `PROXY_MCP_ALLOWED_PATHS` roots with symlink containment.

Canonical clients should read `structuredContent.data`. Top-level result properties are compatibility aliases during the 1.x contract window.
