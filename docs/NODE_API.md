# Node.js API

Install `@othmansh0/proxy-mcp` after the [private registry login](../README.md#quick-start). Requires macOS and Node.js 22+. The package is ESM and includes TypeScript declarations.

```js
import { createProxyClient } from '@othmansh0/proxy-mcp';

const proxy = createProxyClient({
  // home: '/absolute/path/to/.proxy-mcp', // default: PROXY_MCP_HOME or ~/.proxy-mcp
  readyTimeoutMs: 15000,
});
const status = await proxy.callTool('get_proxy_status');
```

`callTool(name, arguments?, options?)` invokes the same tools and validation as MCP. It returns the data directly, without the MCP envelope or text summary. It refreshes the local authentication handshake before every call so a client survives daemon restarts. It never retries a submitted mutation after a transport failure.

Imports and client construction do not create state files, start services, register process shutdown handlers, or change capture/routing. Install the daemon using `init` first. Dropping a client is not task completion and never removes fixtures.

## Own a task and clean it up

```js
await proxy.callTool('acquire_capture_lease', { task_id: 'qa-empty-orders' });
try {
  await proxy.callTool('mock_json_response', {
    rule_id: 'qa-empty-orders',
    url: 'https://api.example.com/orders',
    json: { orders: [] },
  });
  // Trigger and verify the actual app action here.
} finally {
  await proxy.callTool('finish_capture_task');
}
```

Each client remembers only the lease it acquired and attaches it to shared mutations. Renew before expiry by acquiring the same task again. `finish_capture_task` removes tracked unchanged fixtures and releases the lease; `keep_resources: true` deliberately keeps QA fixtures. Captured evidence and exports remain. Different client instances do not share cached lease IDs.

## Cancellation and errors

```js
const controller = new AbortController();
const waiting = proxy.callTool('wait_for_flow', {
  url_contains: '/orders', timeout_ms: 10000,
}, { signal: controller.signal, timeoutMs: 15000 });
// controller.abort();
const result = await waiting;
```

`readyTimeoutMs` bounds daemon discovery (0–60000 ms). `options.timeoutMs` overrides the RPC deadline (1–300000 ms); omitted deadlines follow the tool's defaults. Errors reject with `code`, `retryable`, `recovery` and `details` when supplied by the daemon. Inspect an unknown mutation outcome before retrying. Redaction, path authorization and daemon capability scopes still apply.

TypeScript callers may supply an expected result type with `callTool<Result>(...)`. It is a compile-time annotation; it does not replace runtime tool schemas. See the [agent workflow](AGENT_NETWORK_WORKFLOW.md) for tool arguments and bounded JSON inspection.
