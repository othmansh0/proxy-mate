import { MCP_RESOURCE_URIS } from './mcp-contract.mjs';

export function startResourceSubscriptionMonitor(dispatch, subscriptions, intervalMs = 3000) {
  const fingerprints = new Map();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    // Poll one canonical resource even when a pre-rename bridge subscribed to an alias.
    // The subscription registry delivers updates to the exact URI each client requested.
    const uris = subscriptions.subscriptions().map(uri => uri.replace(/^proxy-(?:mate|mcp):/, 'proxyfan:'));
    if (uris.length === 0) return;
    busy = true;
    try {
      if (uris.includes(MCP_RESOURCE_URIS.status)) {
        const status = await dispatch('get_proxy_status', {});
        const next = JSON.stringify(status);
        if (fingerprints.has(MCP_RESOURCE_URIS.status) && fingerprints.get(MCP_RESOURCE_URIS.status) !== next) {
          await subscriptions.notifyStatus();
        }
        fingerprints.set(MCP_RESOURCE_URIS.status, next);
      }
      const flowIds = new Set(uris.flatMap(resourceFlowId));
      for (const flowId of flowIds) {
        try {
          const detail = await dispatch('get_flow_detail', { flow_id: flowId, body_mode: 'none', include_sensitive: false });
          const key = `${MCP_RESOURCE_URIS.liveFlowPrefix}${encodeURIComponent(flowId)}`;
          const next = JSON.stringify(detail);
          if (fingerprints.has(key) && fingerprints.get(key) !== next) await subscriptions.notifyLiveFlow(flowId);
          fingerprints.set(key, next);
        } catch { /* A removed or expired flow simply stops producing updates. */ }
      }
    } catch { /* Resource update notifications are advisory. */ }
    finally { busy = false; }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function resourceFlowId(uri) {
  if (!uri.startsWith(MCP_RESOURCE_URIS.liveFlowPrefix)) return [];
  const remainder = uri.slice(MCP_RESOURCE_URIS.liveFlowPrefix.length);
  const encoded = remainder.split('/bodies/')[0];
  try { return encoded ? [decodeURIComponent(encoded)] : []; }
  catch { return []; }
}

