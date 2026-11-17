import { LEGACY_CLIENT_ID, normalizeClientId, normalizeTaskId } from './client-identity.mjs';

// Presence is deliberately ephemeral. Durable resource ownership lives in its
// own stores; restart grace gives existing bridges time to introduce themselves.
export function createClientRegistry({ now = Date.now, intervalMs = 30000, missedBeats = 3,
  startupGraceMs = 90000, onPresenceLost = () => {},
} = {}) {
  const created = now(), clients = new Map();
  const alive = c => Boolean(c && now() - c.last_seen <= intervalMs * missedBeats);
  const publicClient = c => ({ client_id: c.client_id, task_id: c.task_id,
    bridge_version: c.bridge_version, first_seen: c.first_seen, last_seen: c.last_seen, alive: alive(c) });
  return {
    intervalMs,
    touch({ client_id, task_id, bridge_version } = {}) {
      if (client_id === LEGACY_CLIENT_ID || !normalizeClientId(client_id)) return {};
      let c = clients.get(client_id);
      const first = !c;
      if (!c) {
        if (clients.size >= 512) {
          const oldest = [...clients.values()].sort((a, b) => Number(alive(a)) - Number(alive(b)) || a.last_seen - b.last_seen)[0];
          clients.delete(oldest.client_id);
        }
        c = { client_id, first_seen: now() };
        clients.set(client_id, c);
      }
      Object.assign(c, { task_id: normalizeTaskId(task_id),
        bridge_version: typeof bridge_version === 'string' ? bridge_version.slice(0, 32) : null,
        last_seen: now(), lost: false });
      return first ? { first_seen: c.first_seen } : {};
    },
    isAlive: client_id => alive(clients.get(client_id)),
    list: () => [...clients.values()].map(publicClient),
    async sweep() {
      if (now() - created < startupGraceMs) return;
      const pending = [];
      for (const c of clients.values()) if (!c.lost && !alive(c)) {
        c.lost = true;
        pending.push(Promise.resolve().then(() => onPresenceLost(publicClient(c))));
      }
      await Promise.all(pending);
    },
  };
}
