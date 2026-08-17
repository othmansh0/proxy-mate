# Proxyman and competitor comparison

This is a product-boundary comparison based on public documentation, not undocumented wire compatibility.

| Product | Strongest fit | Advantage over proxy-mcp | proxy-mcp advantage |
|---|---|---|---|
| Proxyman | Polished Apple-first desktop debugging | Native GUI, scripting, workspace tools, broader desktop/device support, mature visual viewers. | Headless MCP-first workflows, durable SQLite sessions, typed contracts, prompts/resources/subscriptions, CI assertions, and explicit sensitive-data controls. |
| Charles | Mature cross-platform desktop proxy | Windows/Linux GUI, DNS spoofing, true bandwidth throttling, and long-established rewrite tooling. | Automated Simulator setup, optional SOCKS clients, agent-native flow/rule workflows, structured errors, and safer local-daemon authorization. |
| HTTP Toolkit | Broad automatic client interception | Android VPN/ADB flows, browser/terminal/Docker integrations, polished UI, and richer WebSocket rule behavior. | Apple Simulator automation, MCP-native controls, named durable sessions, headless breakpoints, and local CI analysis. |
| mitmproxy | Extensible proxy engine and advanced network modes | Python addons, local/transparent/TUN/WireGuard/SOCKS/upstream/DNS modes, TCP/UDP, HTTP/3, and WebSocket injection through addons. | Smaller secure-by-default Apple-focused surface, no scripting sandbox to secure, automatic PAC/CA recovery, and versioned MCP UX. |

## One-line audit findings

- Keep the agent-first niche: competing with mature GUIs would dilute the project’s clearest advantage.
- Treat custom scripting as a separate sandboxed plugin design, not an `eval` feature inside the daemon.
- Add Android, Docker, or process interception only with a new capture adapter boundary; the current Apple/PAC engine should stay honest.
- Add DNS, upstream-proxy chaining, TUN/WireGuard, TCP/UDP, and HTTP/3 only by adopting or integrating an engine that supports them natively.
- Preserve redaction-by-default and separate raw-read/raw-persistence grants; this is stronger than a single “show secrets” switch.
- Make persistence failure visible and optionally fail closed; silent capture loss is worse than an explicit stopped session.
- Keep session-level OpenAPI checks and capture assertions because repeatable CI evidence is a practical differentiator.
- Keep WebSocket transcript durability, but label replay plans offline until the engine can inject live frames safely.
- Prefer constrained rule transforms over arbitrary code until isolation, time/memory limits, imports, and secret access are designed.
- Add a GUI only as an optional consumer of the same MCP/control contracts, never as a second source of truth.

## Implemented parity with public Proxyman MCP intent

Status/version, recording, session clear, flow list/detail/filter, cURL export, Map Local/Remote, blacklist, headless breakpoints, rule management, SSL routing, certificate status/setup, and capture control are implemented. `proxy-mcp` additionally exposes durable sessions, pagination, protocol tools, WebSocket transcripts, request code generation, reverse proxies, capture assertions, guided prompts, and MCP resources/subscriptions.

The public Proxyman MCP documentation does not define every JSON schema, body limit, pagination rule, or error code. `proxy-mcp` therefore publishes its own versioned contract instead of claiming byte-for-byte compatibility.

## Deliberate backlog

1. Sandboxed custom transforms with explicit capabilities and deterministic resource limits.
2. Adapter architecture for Android, Docker, terminal, or per-process capture.
3. An engine-backed DNS/upstream/TUN/WireGuard/HTTP3 option.
4. Live WebSocket frame mutation only when the underlying engine can do it without unsafe emulation.
5. Optional visual client and team sharing built on redacted exports—not a remotely exposed control daemon.

References: [Proxyman overview](https://docs.proxyman.com/), [Proxyman MCP](https://docs.proxyman.com/mcp), [Charles Rewrite](https://www.charlesproxy.com/documentation/tools/rewrite/), [HTTP Toolkit interception](https://httptoolkit.com/docs/getting-started/intercepting/), [HTTP Toolkit WebSocket rules](https://httptoolkit.com/docs/reference/modify-page/), [mitmproxy features](https://docs.mitmproxy.org/stable/), and [mitmproxy modes](https://docs.mitmproxy.org/stable/concepts/modes/).
