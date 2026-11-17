#!/usr/bin/env node
import { readEnvironment } from './lib/environment.mjs';
// A thin stdio bridge: no proxy engine, system routing or runtime ownership.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { callDaemon } from './lib/control.mjs';
import { createDaemonReadiness } from './lib/daemon-connection.mjs';
import { readHandshake } from './lib/state.mjs';
import { rememberCaptureLease } from './lib/capture-lease.mjs';
import { startResourceSubscriptionMonitor } from './lib/resource-monitor.mjs';
import { SERVER_NAME, SERVER_VERSION } from './lib/config.mjs';
import { SERVER_INSTRUCTIONS, gettingStarted, searchHelp, setupWorkflows } from './lib/guidance.mjs';
import { registerMcpTools, registerMcpResources, registerMcpPrompts,
  registerMcpResourceSubscriptions } from './lib/mcp-contract.mjs';

import { newClientId, normalizeTaskId } from './lib/client-identity.mjs';

const client = { client_id: newClientId(), task_id: null };
const readiness = createDaemonReadiness({ client });
const heartbeat = createBridgeHeartbeat({ client, readiness });
const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
  capabilities: { tools: {}, logging: {} }, instructions: SERVER_INSTRUCTIONS,
});
let closing = false;
let stopMonitor = () => {};
const subscriptions = registerMcpResourceSubscriptions(mcp);
const dispatch = rememberCaptureLease(async (tool, args, context = {}) => {
  if (['get_started', 'acquire_capture_lease', 'finish_capture_task'].includes(tool) && args?.task_id !== undefined) {
    client.task_id = normalizeTaskId(args.task_id);
  }
  if (tool === 'search_docs') return searchHelp(args.query, args.limit);
  if (tool === 'list_setup_workflows') return setupWorkflows();
  const handshake = await readiness.waitForReady({ timeoutMs: tool === 'get_started' ? (await readHandshake() ? 3000 : 0) : 15_000, signal: context.signal });
  if (handshake) heartbeat.contact(handshake);
  if (tool === 'get_started') {
    let status = null;
    if (handshake) try { status = await callDaemon({ ...handshake, client, tool: 'get_proxy_status', timeoutMs: 5000, signal: context.signal }); heartbeat.contact(handshake); } catch { /* actionable recovery help */ }
    return gettingStarted(args, status, { daemonReachable: Boolean(handshake) });
  }
  if (!handshake) throw Object.assign(new Error('The shared daemon is unavailable. This MCP bridge remains connected; use get_started or search_docs for recovery.'), {
    code: 'DAEMON_UNAVAILABLE', retryable: true, recovery: ['Run proxy-mate status and inspect its daemon log.', 'Retry after recovery; no MCP restart is needed.'],
  });
  const result = await callDaemon({ ...handshake, client, tool, args, signal: context.signal });
  heartbeat.contact(handshake);
  if (!/^get_|^list_|^search_|^wait_/.test(tool)) void subscriptions.notifyStatus().catch(() => {});
  const flowId = result?.flow?.id ?? result?.flow_id ?? result?.id;
  if (flowId && /flow|request|curl/.test(tool)) void subscriptions.notifyLiveFlow(flowId).catch(() => {});
  return result;
});
registerMcpTools(mcp, dispatch, { legacyAliases: readEnvironment('PROXY_MATE_LEGACY_OUTPUT') === '1' });
registerMcpResources(mcp, dispatch);
registerMcpPrompts(mcp);

const close = async (code = 0) => {
  if (closing) return;
  closing = true;
  stopMonitor();
  heartbeat.stop();
  const deadline = setTimeout(() => process.exit(code), 2000);
  try { await mcp.close(); } finally { clearTimeout(deadline); process.exit(code); }
};
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
process.stdin.once('end', () => void close());
process.stdin.once('close', () => void close());
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') process.stderr.write(`[proxy-mate client] output failed: ${error.message}\n`);
  void close(error.code === 'EPIPE' ? 0 : 1);
});
await mcp.connect(new StdioServerTransport());

stopMonitor = startResourceSubscriptionMonitor(dispatch, subscriptions);

// The timer never probes /health or shares a tool call's critical path. Re-read
// the handshake to pick up daemon restarts, retaining the successful readiness
// contact as a fallback. Only one heartbeat can be in flight at a time.
export function createBridgeHeartbeat({ client, readiness, read = readHandshake,
  stdin = process.stdin, setTimer = setTimeout, clearTimer = clearTimeout,
  random = Math.random,
  send = async (handshake, identity) => {
    const response = await fetch(new URL('/heartbeat', handshake.controlUrl), {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${handshake.token}`, 'content-type': 'application/json',
        'x-proxy-mate-client-id': identity.client_id },
      body: JSON.stringify({ ...identity, bridge_version: SERVER_VERSION }),
    });
    if (!response.ok) throw new Error('Heartbeat unavailable');
    return response.json();
  },
}) {
  let timer = null, stopped = false, cached = null, intervalMs = 30000, failures = 0, inFlight = false;
  const arm = () => {
    if (stopped || inFlight || timer !== null) return;
    timer = setTimer(async () => {
      timer = null;
      inFlight = true;
      try {
        const handshake = await read() ?? cached;
        if (stopped) return;
        if (handshake) {
          const result = await send(handshake, client);
          readiness.recordSuccess(handshake);
          cached = handshake;
          if (Number.isFinite(result?.interval_ms) && result.interval_ms >= 1000 && result.interval_ms <= 300000) intervalMs = result.interval_ms;
        }
      } catch { failures++; } // Debug counter only; never fail an MCP call.
      finally { inFlight = false; arm(); }
    }, intervalMs * (0.9 + random() * 0.2));
    timer?.unref?.();
  };
  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    stdin.removeListener('end', stop); stdin.removeListener('close', stop);
  };
  stdin.once('end', stop); stdin.once('close', stop);
  return {
    contact(handshake) { readiness.recordSuccess(handshake); cached = handshake; arm(); },
    stop,
    get failures() { return failures; },
  };
}
