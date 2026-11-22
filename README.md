# ProxyFan

[![npm version](https://img.shields.io/npm/v/@othmansh01/proxyfan.svg)](https://www.npmjs.com/package/@othmansh01/proxyfan) [![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/othmansh0/proxyfan/blob/develop/LICENSE)

A local Model Context Protocol (MCP) server for debugging HTTP and HTTPS traffic from iOS Simulator apps. Ask your coding agent to explain a failed request, mock a backend response, or compare what the app sent across two runs.

Install from npm using the full package name [@othmansh01/proxyfan](https://www.npmjs.com/package/@othmansh01/proxyfan).

Previously published as `@othmansh01/proxy-mate` and formerly called `proxy-mcp`. [Migrate an existing installation](https://github.com/othmansh0/proxyfan/blob/develop/docs/CLIENT_SETUP.md#migrate-from-proxy-mate)

## Get started

You need macOS, Node.js 22 or newer, and full Xcode with an installed iOS Simulator runtime.

**1. Connect your MCP client.** For Claude Code, run this once.

```sh
npx --yes @othmansh01/proxyfan@latest init --client claude
```

For another client, replace the last argument.

| Client | Argument |
| --- | --- |
| Codex CLI or IDE | `codex` (requires the Codex CLI) |
| Cursor | `cursor` |
| Claude Desktop | `claude-desktop` |
| Other stdio clients | `json` (prints the configuration to copy) |

The installer sets up a local background service and registers its stable entry point. Use `--dry-run` to preview setup. Capture starts separately. [Client setup guide](https://github.com/othmansh0/proxyfan/blob/develop/docs/CLIENT_SETUP.md)

**2. Capture a request.** Reconnect your MCP client and boot the Simulator with your app installed. Try this prompt.

> Start app-only capture for my app for 10 minutes. When I tap Refresh, show which request failed, its HTTP status, and the error message.

Select the Simulator and app when prompted. For HTTPS, setup verifies the debugging certificate on that Simulator. Trigger Refresh once capture is ready.

## Which requests can the agent see?

| Capture choice | What reaches the recording proxy |
| --- | --- |
| **App only** (guided setup default) | A local gateway checks which process opened each connection. It sends traffic it can attribute to the selected Simulator app to the recording proxy, across eligible hosts. Other apps and unidentified connections pass through without capture. |
| **Selected domains** (explicit choice) | The macOS proxy configuration routes matching hostnames or host patterns, such as `api.example.com`. Any proxy-aware app using that network service can match. With multiple agents, routing covers the combined set of active host claims. |
| **Local backend** | Point the app at the URL returned by a capture-enabled reverse proxy for that backend. Ordinary localhost traffic bypasses domain routing. |

**The prompt guides what the agent reads.** For example, “Show the last failed checkout request to `api.example.com`” can become a `get_flows` query filtered by host, URL, and status. The agent can then read headers or selected JSON fields from one matching flow. If the same app also sent an analytics request, that request may already be in the local session even when the agent returns only checkout results. App-only setup has no host allowlist. If hostname is the recording boundary you need, choose domain routing before reproducing the issue and account for other apps using the same host. A URL path such as `/checkout` is a query filter within that host.

Pinned TLS, clients that bypass proxy settings, and background helpers the gateway cannot attribute can leave gaps. New identified clients default to their own evidence on scoped tools. Explicit shared reads are available, and a shared host can be visible to several agents. [Multi-agent behavior](https://github.com/othmansh0/proxyfan/blob/develop/docs/AGENT_GUIDE.md#several-agents-on-one-daemon) · [Simulator troubleshooting](https://github.com/othmansh0/proxyfan/blob/develop/docs/IOS_SIMULATOR_SETUP.md)

## What you can ask

| Task | Example prompt |
| --- | --- |
| Inspect | “Show the status and request ID for the last failed login. Omit the body.” |
| Mock | “Return an empty list for the orders endpoint so I can check the empty state.” |
| Pause | “Pause the next checkout response so I can inspect it before the app continues.” |
| Compare | “Compare the last two search responses and list the JSON fields that changed.” |
| Share evidence | “Export a redacted HAR for this session and clean up the mocks you created.” |

The server also supports WebSocket inspection, OpenAPI checks, and a Node.js client for QA scripts. [Capabilities](https://github.com/othmansh0/proxyfan/blob/develop/docs/CAPABILITIES.md) · [Node.js API](https://github.com/othmansh0/proxyfan/blob/develop/docs/NODE_API.md) · [Agent workflows](https://github.com/othmansh0/proxyfan/blob/develop/docs/AGENT_NETWORK_WORKFLOW.md)

## Privacy and storage

Captures stay on the Mac, under `~/.proxyfan` by default. Existing installations may use `~/.proxy-mate` or `~/.proxy-mcp`. The service redacts recognized text credentials before storage and when returning evidence. Raw storage and raw reads each require an explicit grant. Your MCP client and its model provider can see the evidence the agent requests. Review exported captures before sharing. [Privacy](https://github.com/othmansh0/proxyfan/blob/develop/PRIVACY.md) · [Security](https://github.com/othmansh0/proxyfan/blob/develop/SECURITY.md)

## Troubleshooting and maintenance

- **Cannot find the package?** Use the [scoped npm listing](https://www.npmjs.com/package/@othmansh01/proxyfan). Use the full scoped name for installation. For an old GitHub Packages configuration, follow the [registry migration instructions](https://github.com/othmansh0/proxyfan/blob/develop/docs/CLIENT_SETUP.md#migrate-from-private-github-packages).
- **The client cannot connect?** Run `npx --yes @othmansh01/proxyfan@latest status`, then reconnect the client.
- **No requests appear?** Confirm the selected app and Simulator, trigger a new request, and ask the agent to diagnose capture and certificate trust. [Simulator setup and recovery](https://github.com/othmansh0/proxyfan/blob/develop/docs/IOS_SIMULATOR_SETUP.md)
- **Upgrading?** Stop capture and finish active tasks, then run `npx --yes @othmansh01/proxyfan@latest init --upgrade --client claude` with your client argument. Reconnect afterward.
- **Removing the service?** Run `npx --yes @othmansh01/proxyfan@latest uninstall --keep-ca` to retain the local CA. Remove the client entry manually. Saved captures persist.

Automation targets macOS and iOS Simulators. Physical Apple devices require manual setup. Capture on Android, Windows, or Linux and HTTP/3 inspection are unsupported. [Advanced configuration](https://github.com/othmansh0/proxyfan/blob/develop/docs/ADVANCED_CONFIGURATION.md)

## Contributing

On macOS, run `npm ci` followed by `npm run check` in a source checkout. Releases before 1.0 may change the API. [Contributing](https://github.com/othmansh0/proxyfan/blob/develop/CONTRIBUTING.md) · [Release notes and checksums](https://github.com/othmansh0/proxyfan/releases) · [Reliability audit](https://github.com/othmansh0/proxyfan/blob/develop/docs/RELIABILITY_AUDIT.md)

ProxyFan is an independent project distributed under the [MIT license](https://github.com/othmansh0/proxyfan/blob/develop/LICENSE).
