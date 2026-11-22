# Proxyman and competitor comparison

This is a product-boundary comparison based on public documentation, not undocumented wire compatibility.

The [current replacement-readiness audit](RELIABILITY_AUDIT.md) supersedes feature count as a readiness signal. Local daemon/client deployment, supervised recovery, failed-upgrade rollback, native iOS 27 PAC capture and crash fallback are verified. Wider native-platform/VPN acceptance, owned Android setup/trust and multi-day real-app qualification remain open. Current Android support consists of preflight and setup plans.

| Product | Strongest fit | Advantage over proxyfan | proxyfan advantage |
|---|---|---|---|
| Proxyman | Polished Apple-first desktop debugging | Native full-featured GUI, richer JavaScript scripting surface, workspace tools, broader desktop/device support, mature visual viewers. | Headless MCP-first workflows, durable SQLite sessions, typed contracts, prompts/resources/subscriptions, CI assertions, a bounded QuickJS transform sandbox, and explicit sensitive-data controls. |
| Charles | Mature cross-platform desktop proxy | Windows/Linux GUI, DNS spoofing, true bandwidth throttling, and long-established rewrite tooling. | Automated Simulator setup, optional SOCKS clients, upstream proxy chaining, agent-native flow/rule workflows, structured errors, and safer local-daemon authorization. |
| HTTP Toolkit | Broad automatic client interception | Android VPN/ADB flows, browser/terminal/Docker integrations, polished UI, and richer WebSocket rule behavior. | Apple Simulator automation plus preflight for Android ADB/Docker/terminal adapters, MCP-native controls, named durable sessions, headless breakpoints, and local CI analysis. |
| mitmproxy | Extensible proxy engine and advanced network modes | Full Python addon API, local/transparent/TUN/WireGuard/SOCKS/upstream/DNS modes, TCP/UDP, HTTP/3, and WebSocket injection through addons. | Smaller secure-by-default Apple-focused surface, a bounded sandbox instead of a general scripting API, automatic PAC/CA recovery, upstream HTTP/HTTPS/SOCKS chaining, and versioned MCP UX. |

## One-line audit findings

- Keep the agent-first niche: competing with mature GUIs would dilute the project’s clearest advantage.
- Custom scripting shipped as a separate sandboxed QuickJS plugin design, not an `eval` feature inside the daemon; keep it deliberately narrower than mitmproxy addons or Proxyman scripting (JSON-only patches, no imports, no host APIs, bounded resources).
- Android, Docker, and process/terminal interception shipped as a capture adapter boundary that provides preflight and setup plans, not silent device/container mutation; the current Apple/PAC engine stays the only automated capture path.
- Upstream HTTP/HTTPS/SOCKS proxy chaining shipped. Add DNS, TUN/WireGuard, TCP/UDP, and HTTP/3 only by adopting or integrating an engine that supports them natively.
- Preserve redaction-by-default and separate raw-read/raw-persistence grants; this is stronger than a single “show secrets” switch.
- Make persistence failure visible and optionally fail closed; silent capture loss is worse than an explicit stopped session.
- Keep session-level OpenAPI checks and capture assertions because repeatable CI evidence is a practical differentiator.
- Keep WebSocket transcript durability, but label replay plans offline: mockttp 4.6.0's public API has no live frame mutation/injection hook.
- Keep rule transforms constrained rather than general code: the QuickJS sandbox enforces isolation, time/memory/stack limits, no imports, and no secret/host access by design.
- The optional read-only operator dashboard shipped as a consumer of the same MCP/control contracts, never as a second source of truth or a control plane.

## Implemented parity with public Proxyman MCP intent

Status/version, recording, session clear, flow list/detail/filter, cURL export, Map Local/Remote, blacklist, headless breakpoints, rule management, SSL routing, certificate status/setup, and capture control are implemented. `proxyfan` additionally exposes durable sessions, pagination, protocol tools, WebSocket transcripts, request code generation, reverse proxies, capture assertions, guided prompts, MCP resources/subscriptions, sandboxed transform plugins, upstream proxy chaining, capture adapter preflight, and an optional read-only operator dashboard.

The public Proxyman MCP documentation does not define every JSON schema, body limit, pagination rule, or error code. `proxyfan` therefore publishes its own versioned contract instead of claiming byte-for-byte compatibility.

## Deliberate backlog

Shipped since the original backlog was written:

- Sandboxed custom transforms with explicit capabilities and deterministic resource limits — QuickJS transform plugins (request/response/websocket_offline stages).
- Adapter architecture for Android, Docker, terminal, or per-process capture — capture adapter preflight/setup plans for Apple Simulator, physical Apple device, Android ADB, Docker, and terminal/environment clients.
- Optional visual client built on redacted exports — a loopback-only, read-only operator dashboard (no team sharing, no mutation endpoints; not a remotely exposed control daemon).

Still remaining:

1. An engine-backed DNS/TUN/WireGuard/HTTP3 option. (Upstream HTTP/HTTPS/SOCKS proxy chaining is shipped; DNS and TUN/WireGuard/HTTP3 remain out of scope.)
2. Live WebSocket frame mutation, only when the underlying engine can do it without unsafe emulation.
3. Team sharing for the operator dashboard; a real control-plane GUI remains out of scope.

References: [Proxyman overview](https://docs.proxyman.com/), [Proxyman MCP](https://docs.proxyman.com/mcp), [Charles Rewrite](https://www.charlesproxy.com/documentation/tools/rewrite/), [HTTP Toolkit interception](https://httptoolkit.com/docs/getting-started/intercepting/), [HTTP Toolkit WebSocket rules](https://httptoolkit.com/docs/reference/modify-page/), [mitmproxy features](https://docs.mitmproxy.org/stable/), and [mitmproxy modes](https://docs.mitmproxy.org/stable/concepts/modes/).
