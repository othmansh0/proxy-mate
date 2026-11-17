# Privacy

`proxy-mate` runs locally. It does not include analytics, telemetry, advertising, crash upload, or a hosted control service.

Per-agent evidence scopes, routing claims and task leases coordinate processes running as the same macOS user. They are not a security boundary. Client IDs and task IDs are not authentication; daemon access still requires the local bearer token. Clients can explicitly read shared evidence with `scope: "all"`. Unknown or ambiguous traffic on shared claimed hosts may be visible to multiple agents.

First-time interactive setup defaults to one Simulator app. This mode attributes local connections before inspection and does not store unselected or unknown clients' traffic. HTTP proxy forwarding necessarily handles routing metadata; unselected HTTPS remains an opaque tunnel. App mode imports the CA only into the selected Simulator and does not change Mac Keychain trust. Capture across domains/apps and Mac trust require an explicit broader choice. Existing certificate trust is not automatically removed when switching modes.

Mac certificate setup displays a native explanation before requesting system authentication. The operation installs the debugging CA and reads certificate metadata to identify its trust status; it does not request saved Keychain passwords. Trust persists until removed and is broader than the selected capture scope. Captured traffic may be returned to connected MCP clients, whose handling of that data is separate from this local service.

Captured traffic can contain personal data and credentials. Flow metadata, bounded body content, rules, sessions, certificates, and daemon state are stored under `~/.proxy-mate` by default. Sessions use a private SQLite/WAL database with per-flow row updates. Set `PROXY_MATE_HOME` to use a separate location. Secret-bearing runtime files use owner-only permissions.

Text credentials are redacted before persistence and again in MCP responses/exports. Binary bodies are size/hash metadata only under the default `text` policy; `metadata_only` omits every body. Durable WebSocket snapshots follow the same storage grant and are redacted unless raw persistence is explicitly enabled. Raw persistence and raw reads are separate explicit opt-ins. Because redaction is defensive rather than a substitute for data governance, developers should avoid capturing production accounts, purge sessions when finished, and review artifacts before sharing them.

Network access occurs only as directed by the developer: intercepted application traffic, explicit compose/repeat calls, configured Map Remote or reverse-proxy targets, PAC routing, and the temporary physical-device onboarding portal.
