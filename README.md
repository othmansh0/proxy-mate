# ProxyFan

<img src="https://raw.githubusercontent.com/othmansh0/proxyfan/develop/src/assets/proxyfan.png" alt="ProxyFan icon" width="116" height="116">

[![npm version](https://img.shields.io/npm/v/@othmansh01/proxyfan.svg)](https://www.npmjs.com/package/@othmansh01/proxyfan) [![CI](https://github.com/othmansh0/proxyfan/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/othmansh0/proxyfan/actions/workflows/ci.yml) [![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/othmansh0/proxyfan/blob/develop/LICENSE)

A local MCP server for debugging mobile HTTP and HTTPS traffic with your coding agent. Inspect requests, mock APIs, pause responses, and export redacted evidence.

## Quick start

**Host requirements** · macOS and Node.js 22+. For iOS Simulator, install full Xcode and a Simulator runtime.

```sh
npx --yes @othmansh01/proxyfan@latest init --client claude
```

- Available clients: `claude`, `codex`, `cursor`, `claude-desktop`, or `json` for manual stdio registration.
- Reconnect your client after setup. The installer registers a local service. Start capture separately.
- Boot an iOS Simulator and ask: “Capture this app for 10 minutes. When I tap Refresh, show the failed request and its status.”

[Client setup](https://github.com/othmansh0/proxyfan/blob/develop/docs/CLIENT_SETUP.md) · [iOS Simulator setup](https://github.com/othmansh0/proxyfan/blob/develop/docs/IOS_SIMULATOR_SETUP.md)

## Capture options

| Target | Setup |
| --- | --- |
| iOS Simulator | Guided app-only capture, or explicit routing for selected domains. |
| Android emulator or device | ADB preflight and a manual setup plan. Ask for `preflight_capture_adapter` and `build_capture_setup_plan` with `adapter_id: "android-adb"`. Apply proxy and certificate settings yourself. |
| Physical Apple device, Docker, or terminal | Manual setup plans through `list_capture_adapters`. |
| Local backend | Point the app at a capture-enabled reverse proxy for that backend. |

- App-only capture covers eligible connections from the selected app across hosts. Domain routing can also capture other proxy-aware apps using those hosts.
- Agent filters for URLs, methods, and statuses narrow what it reads from the capture.
- HTTPS inspection requires certificate trust. Pinned TLS and proxy-bypassing clients can leave gaps. HTTP/3 inspection is unsupported.

[Capabilities and limits](https://github.com/othmansh0/proxyfan/blob/develop/docs/CAPABILITIES.md) · [Agent workflows](https://github.com/othmansh0/proxyfan/blob/develop/docs/AGENT_NETWORK_WORKFLOW.md) · [Node.js API](https://github.com/othmansh0/proxyfan/blob/develop/docs/NODE_API.md)

## Operate and contribute

| Task | Command |
| --- | --- |
| Check the service | `npx --yes @othmansh01/proxyfan@latest status` |
| Upgrade after stopping capture | `npx --yes @othmansh01/proxyfan@latest init --upgrade --client claude` |
| Remove the service and keep the CA | `npx --yes @othmansh01/proxyfan@latest uninstall --keep-ca` |

- Captures stay under `~/.proxyfan` by default. ProxyFan redacts recognized credentials before storage and when returning evidence. Review exports before sharing.
- From a source checkout on macOS, run `npm ci` and `npm run check`.

[Privacy](https://github.com/othmansh0/proxyfan/blob/develop/PRIVACY.md) · [Security](https://github.com/othmansh0/proxyfan/blob/develop/SECURITY.md) · [Contributing](https://github.com/othmansh0/proxyfan/blob/develop/CONTRIBUTING.md) · [Releases and checksums](https://github.com/othmansh0/proxyfan/releases)
