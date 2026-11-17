# Security policy

`proxy-mate` can decrypt local HTTPS traffic and its generated CA private key is security-sensitive. Use it only on a trusted development Mac and never publish or share `~/.proxy-mate/ca/key.pem`.

Per-agent evidence scopes, routing claims and task leases coordinate processes running as the same macOS user. They are not a security boundary. Client IDs and task IDs are not authentication; daemon access still requires the local bearer token. Clients can explicitly read shared evidence with `scope: "all"`. Unknown or ambiguous traffic on shared claimed hosts may be visible to multiple agents.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the private security-advisory feature on the canonical source repository. If that is unavailable, contact the maintainer listed on the published npm package. Include affected versions, reproduction steps, impact, and any suggested mitigation. Please allow a reasonable remediation window before disclosure.

## Supported versions

Security fixes are made on the latest released minor version. Older pre-1.0 versions may require upgrading to receive a fix.

## Operational safeguards

- The daemon control plane binds to `127.0.0.1`, requires a random bearer token, enforces observe/control/sensitive scopes, and stores its handshake file with owner-only permissions.
- Sensitive headers, cookies, tokens, and common credential fields are redacted before persistence. Binary bodies are metadata-only by default. Unredacted reads and persistence use separate server-level grants and explicit per-operation choices.
- Organization-specific header, query, and body-field globs can be added with `PROXY_MATE_REDACT_HEADERS`, `PROXY_MATE_REDACT_QUERY_FIELDS`, and `PROXY_MATE_REDACT_BODY_FIELDS`; built-in patterns cannot be removed.
- File reads and writes are confined to the state directory, current working directory, and paths explicitly listed in `PROXY_MATE_ALLOWED_PATHS`.
- Persistence failures are reported in status/diagnostics. Set `PROXY_MATE_PERSISTENCE_FAIL_CLOSED=1` when continued proxying without durable evidence is unacceptable.
- The control plane validates local Host/Origin values and applies bounded request size, header, connection, concurrency, and rate limits in addition to capability-scoped authentication.
- Physical-device proxying requires an IP/CIDR allowlist and expires automatically; onboarding is separately time-limited, tokenized, and serves only the public CA certificate.
- CA rotation is explicit, requires the proxy to be stopped, archives the old public certificate, deletes the old private key by default, and reports the trust refresh required afterward.
- The project never uses `sudo`, erases a Simulator, resets a Simulator keychain, or changes global `xcode-select` state.
