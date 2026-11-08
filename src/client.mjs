#!/usr/bin/env node
// A thin stdio bridge: no proxy engine, system routing or runtime ownership.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { callDaemon } from './lib/control.mjs';
import { waitForReadyDaemon } from './lib/daemon-connection.mjs';
import { startResourceSubscriptionMonitor } from './lib/resource-monitor.mjs';
import { SERVER_NAME, SERVER_VERSION } from './lib/config.mjs';
import { SERVER_INSTRUCTIONS, gettingStarted, searchHelp, setupWorkflows } from './lib/guidance.mjs';
import { registerMcpTools, registerMcpResources, registerMcpPrompts,
  registerMcpResourceSubscriptions } from './lib/mcp-contract.mjs';

const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
  capabilities: { tools: {}, logging: {} }, instructions: SERVER_INSTRUCTIONS,
});
let closing = false;
let stopMonitor = () => {};
const subscriptions = registerMcpResourceSubscriptions(mcp);
const dispatch = async (tool, args, context = {}) => {
  if (tool === 'search_docs') return searchHelp(args.query, args.limit);
  if (tool === 'list_setup_workflows') return setupWorkflows();
  const handshake = await waitForReadyDaemon({ timeoutMs: tool === 'get_started' ? 0 : 15_000, signal: context.signal });
  if (tool === 'get_started') {
    let status = null;
    if (handshake) try { status = await callDaemon({ ...handshake, tool: 'get_proxy_status', timeoutMs: 1500, signal: context.signal }); } catch { /* actionable offline help */ }
    return gettingStarted(args, status);
  }
  if (!handshake) throw Object.assign(new Error('The shared daemon is unavailable. This MCP bridge remains connected; use get_started or search_docs for recovery.'), {
    code: 'DAEMON_UNAVAILABLE', retryable: true, recovery: ['Run proxy-mcp status and inspect its daemon log.', 'Retry after recovery; no MCP restart is needed.'],
  });
  const result = await callDaemon({ ...handshake, tool, args, signal: context.signal });
  if (!/^get_|^list_|^search_|^wait_/.test(tool)) void subscriptions.notifyStatus().catch(() => {});
  const flowId = result?.flow?.id ?? result?.flow_id ?? result?.id;
  if (flowId && /flow|request|curl/.test(tool)) void subscriptions.notifyLiveFlow(flowId).catch(() => {});
  return result;
};
registerMcpTools(mcp, dispatch);
registerMcpResources(mcp, dispatch);
registerMcpPrompts(mcp);

const close = async (code = 0) => {
  if (closing) return;
  closing = true;
  stopMonitor();
  const deadline = setTimeout(() => process.exit(code), 2000);
  try { await mcp.close(); } finally { clearTimeout(deadline); process.exit(code); }
};
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
process.stdin.once('end', () => void close());
process.stdin.once('close', () => void close());
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') process.stderr.write(`[proxy-mcp client] output failed: ${error.message}\n`);
  void close(error.code === 'EPIPE' ? 0 : 1);
});
await mcp.connect(new StdioServerTransport());

stopMonitor = startResourceSubscriptionMonitor(dispatch, subscriptions);
