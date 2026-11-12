# Proxy MCP

**Give your coding agent access to your app's network traffic.**

Inspect backend requests, responses and headers from the iOS Simulator. Ask your agent to mock an API, pause a response, reproduce a failure, or check what changed—without adding debugging code to your app.

Works with Claude Code, Codex, Cursor, Claude Desktop, and other local stdio MCP clients. Distributed as the private npm package **`@othmansh0/proxy-mcp`** through GitHub Packages.

## Quick start

You need **macOS**, **Node.js 22+** (Node 24 recommended), **Xcode with an iOS Simulator**, and read access to the private package. A maintainer must grant your GitHub account package access.

**1. Sign in once.** Use your GitHub username and a personal access token (classic) with `read:packages` as the password. Enter it in npm's prompt, not in chat or a command argument. [GitHub authentication guide →](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages)

```bash
npm login --scope=@othmansh0 --registry=https://npm.pkg.github.com --auth-type=legacy
```

**2. Install and connect your agent.** This example configures Claude Code:

```bash
npx --yes @othmansh0/proxy-mcp@latest init --client claude
```

That's the installation. The command installs the background service, backs up an existing client configuration before updating only its `proxy-mcp` entry, and uses a stable local entry point. It reuses a healthy installed service. Your agent does not need npm authentication or another package download every time it connects.

Reconnect your MCP client, boot a Simulator, then ask:

> Set up network capture for my app in this Simulator for 30 minutes. Help me select the app, then show me the API requests when I open the home screen.

The agent guides you through app selection and the selected Simulator's HTTPS certificate setup. Installation itself leaves routing and certificate trust unchanged. App-only capture is the default; broader Mac/domain capture requires an explicit choice.

### Use another client

Run the same `init` command with your client name:

| Client | Option |
| --- | --- |
| Claude Code | `--client claude` |
| Codex CLI / IDE | `--client codex` (requires the `codex` CLI) |
| Cursor | `--client cursor` |
| Claude Desktop | `--client claude-desktop` |
| Any other stdio client | `--client json` prints the configuration to copy |

Use `init --dry-run --client claude` to preview setup. Registration uses your user configuration, so the server is available across projects. See [client setup details](docs/CLIENT_SETUP.md) for configuration paths and manual setup.

## What you can ask your agent

You do not need to memorize tool names. Describe what you want to inspect or test:

**Inspect and explain traffic**

> Show the request and response headers for the latest login request. Explain why it failed without exposing tokens.

> Find the search response and list the distinct provider values. Return just the fields we need, not the entire JSON body.

**Mock responses and test edge cases**

> Mock the orders endpoint with an empty list, then with three orders. Keep the rest of the response unchanged and help me check both UI states.

> Make this endpoint return HTTP 500, then add a two-second delay. Help me verify the error and loading states.

**Pause requests or responses**

> Pause the next checkout response. Change the total to zero, resume it, and help me verify what the app does.

> Pause the outgoing profile request so we can inspect its headers and edit the test payload before forwarding it.

**Reproduce and compare**

> Replay this captured request and export a redacted curl command for the developer.

> Compare these two requests. Highlight changes to status, headers and JSON fields.

**Check contracts and keep evidence**

> Validate this capture against our OpenAPI document and report the failing endpoints.

> Save a redacted HAR of this session, then remove only the mocks and breakpoints created for this task. Keep the captured evidence.

The agent can also inspect captured WebSocket messages, use captured local reverse proxies for localhost backends, and generate request code. The [capability reference](docs/CAPABILITIES.md) describes the full surface and its limits.

## How it works

A local background service owns capture, rules and durable sessions. MCP clients connect through a small stdio bridge and share that service. Closing an agent does not stop capture. Temporary routing expires, and task leases coordinate agents changing shared rules.

Agents finish tasks with `finish_capture_task`: it removes their tracked, unchanged mocks and reverse listeners and releases the lease. Other tasks' fixtures, saved captures and exports remain. Ask the agent to keep fixtures explicitly when QA needs to reuse them.

## Privacy and limits

- Text credentials are redacted by default. Raw access requires a separate explicit grant.
- Captures stay on your Mac under `~/.proxy-mcp`. Returned evidence is visible to your connected agent and subject to that provider's data handling.
- App-only mode inspects connections attributed to the selected Simulator app. Unknown/background-helper connections pass through without capture; attribution is not universal.
- Certificate pinning and clients bypassing proxy settings can prevent inspection. This tool does not bypass pinning.
- Localhost APIs use a captured reverse proxy and its returned local URL. Setup does not silently redirect your app's localhost backend.
- Capture automation targets macOS and iOS Simulators. Physical Apple devices need additional manual setup; Android, Windows, Linux and HTTP/3 capture are not supported.

See [Security](SECURITY.md), [Privacy](PRIVACY.md), and [advanced configuration](docs/ADVANCED_CONFIGURATION.md) for grants, routing and storage controls. Never share your local CA private key.

## Use from Node.js

After the one-time registry login, add the private package to a QA script or developer tool:

```bash
npm install @othmansh0/proxy-mcp
```

```js
import { createProxyClient } from '@othmansh0/proxy-mcp';

const proxy = createProxyClient();
const { flows } = await proxy.callTool('get_flows', {
  host_equals: 'api.example.com',
  limit: 5,
});
console.log(flows);
```

The library talks to an already installed daemon and returns tool data directly. Importing it starts no capture, changes no networking and installs no service. TypeScript declarations are included. See [Node.js API](docs/NODE_API.md) for task cleanup, errors and cancellation.

## Update or remove

Ask your agent to stop capture and finish its task, then install the latest package into the service:

```bash
npx --yes @othmansh0/proxy-mcp@latest init --upgrade --client claude
```

Updates preserve durable evidence and the local CA. Upgrade refuses to replace a capture using routing, an app gateway, a task lease, pending breakpoints or reverse listeners. Reconnect MCP after updating to load the new tools.

To remove the service while keeping the CA:

```bash
npx --yes @othmansh0/proxy-mcp@latest uninstall --keep-ca
```

Remove the `proxy-mcp` entry from your client's MCP settings if you no longer want to connect. Uninstall does not delete saved captures. Omitting `--keep-ca` also removes managed CA trust.

## Troubleshooting

| Problem | Next step |
| --- | --- |
| npm returns `401`, `403` or `404` | Check package access, token scope and the `@othmansh0` registry login. `404` can mean no access or an unpublished version. |
| MCP is missing after setup | Reconnect the client. Run `npx --yes @othmansh0/proxy-mcp@latest status` to inspect the service. |
| Setup cannot parse an existing config | Fix that file or use `--client json`. Setup preserves invalid files. |
| No requests appear | Ask the agent to diagnose capture for the selected app and Simulator. Trigger a new app request. |
| One endpoint fails HTTPS | Check certificate pinning/custom trust and use an authorized debug build. |
| Upgrade says capture is in use | Stop capture and finish its task first. Plain `init` connects the client without restarting a healthy service. |

More help: [Simulator setup and recovery](docs/IOS_SIMULATOR_SETUP.md).

## Development

```bash
npm ci
npm run check
```

For a source checkout, run `node src/server.mjs init --client claude`. See [Contributing](CONTRIBUTING.md), [private package releases](docs/PACKAGING.md), [agent workflows](docs/AGENT_NETWORK_WORKFLOW.md), and the [reliability audit](docs/RELIABILITY_AUDIT.md).

MIT licensed. Independent project; not affiliated with Proxyman.
