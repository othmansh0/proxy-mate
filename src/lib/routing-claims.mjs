// One store per daemon. Its queue serializes read/modify/write operations; the
// file survives routing suspension and runtime reconciliation.
import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { STATE_DIR, atomicWriteJson } from './state.mjs';
import { LEGACY_CLIENT_ID, normalizeTaskId } from './client-identity.mjs';
import { validateRoutingDomains } from './pac.mjs';

const fail = (code, message) => Object.assign(new Error(message), {
  code, retryable: false, recovery: 'Correct the routing claim and retry.',
});
const time = value => new Date(value).getTime();
const queues = new Map();
export const unionDomains = claims => [...new Set(claims.filter(c => !c.expired || (c.expired_at && c.expired_at !== c.expires_at)).flatMap(c => c.domains))].sort();
export const nextExpiry = claims => claims.length ? new Date(Math.min(...claims.map(c => time(c.expires_at)))).toISOString() : null;

export function createRoutingClaimsStore({ directory = STATE_DIR, now = Date.now, fs = nodeFs,
  writeJson = fs === nodeFs ? atomicWriteJson : undefined, retentionMs = 3600000,
} = {}) {
  const file = path.join(directory, 'routing-claims.json');
  function serialized(fn) {
    const result = (queues.get(file) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => {});
    queues.set(file, tail);
    void tail.then(() => { if (queues.get(file) === tail) queues.delete(file); });
    return result;
  }
  async function read() {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.claims)) throw new Error('Invalid claims document');
      const keys = new Set(), ids = new Set();
      for (const c of data.claims) {
        if (!c || typeof c.claim_id !== 'string' || !c.claim_id || typeof c.client_id !== 'string' || !c.client_id ||
            (c.task_id != null && !normalizeTaskId(c.task_id)) ||
            !Number.isInteger(c.requested_seconds) || c.requested_seconds < 1 || c.requested_seconds > 86400 ||
            !['created_at', 'renewed_at', 'expires_at'].every(k => typeof c[k] === 'string' && Number.isFinite(time(c[k])))) throw new Error('Invalid claim');
        validateRoutingDomains(c.domains, { allowBroad: true });
        const key = JSON.stringify([c.client_id, c.task_id ?? null]);
        if (keys.has(key) || ids.has(c.claim_id)) throw new Error('Duplicate claim');
        keys.add(key); ids.add(c.claim_id);
      }
      if (unionDomains(data.claims.filter(c => time(c.expires_at) > time(now()))).length > 256) throw new Error('Union limit exceeded');
      return data;
    } catch (e) { return { version: 1, claims: [], ...(e.code === 'ENOENT' ? {} : { corrupt: true }) }; }
  }
  async function write(data) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (data.corrupt) {
      // Copy before replacing: a failed backup must retain the original file.
      const backup = `${file}.corrupt-${time(now())}-${randomUUID()}`;
      await fs.copyFile(file, backup);
      await fs.chmod(backup, 0o600);
    }
    const value = { version: 1, claims: data.claims, ...(data.suspension ? { suspension: data.suspension } : {}) };
    if (writeJson) return writeJson(file, value, 0o600);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, file);
      await fs.chmod(file, 0o600);
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  const mutate = fn => serialized(async () => { const data = await read(); const result = fn(data); await write(data); return result; });
  return {
    getSuspension: () => serialized(async () => (await read()).suspension ?? null),
    setSuspension: suspension => mutate(data => { data.suspension = suspension; }),
    listClaims: ({ now: at = now(), includeExpired = false } = {}) => serialized(async () => {
      const data = await read();
      const rows = data.claims.filter(c => includeExpired || time(c.expires_at) > time(at)).map(c => {
        const row = { ...c };
        if (time(c.expires_at) <= time(at)) row.expired = true;
        else { delete row.expired; delete row.expired_at; }
        return row;
      });
      if (data.corrupt) rows.corrupt = true;
      return rows;
    }),
    upsertClaim: ({ client_id = LEGACY_CLIENT_ID, task_id, domains, durationSeconds, allowBroad = false, now: at = now() }) => mutate(data => {
      if (typeof client_id !== 'string' || !client_id.trim() || (task_id != null && !normalizeTaskId(task_id))) throw fail('ROUTING_ID_INVALID', 'Supply a client id and a valid optional task id.');
      if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86400) throw fail('ROUTING_LEASE_INVALID', 'Routing duration must be 1-86400 seconds.');
      domains = validateRoutingDomains(domains, { allowBroad });
      const previous = data.claims.find(c => c.client_id === client_id && (c.task_id ?? null) === (task_id ?? null));
      const stamp = new Date(at).toISOString();
      const claim = { claim_id: previous?.claim_id ?? randomUUID(), client_id, task_id: task_id ?? null, domains,
        requested_seconds: durationSeconds, created_at: previous?.created_at ?? stamp, renewed_at: stamp,
        expires_at: new Date(time(at) + durationSeconds * 1000).toISOString() };
      const updated = [...data.claims.filter(c => c !== previous), claim];
      if (unionDomains(updated.filter(c => time(c.expires_at) > time(at))).length > 256) throw fail('ROUTING_UNION_LIMIT', 'Routing union is limited to 256 host globs.');
      data.claims = updated;
      return claim;
    }),
    renewClaimsForClient: (client_id, { now: at = now() } = {}) => mutate(data => {
      const renewed = [];
      for (const c of data.claims) if (c.client_id === client_id) {
        c.renewed_at = new Date(at).toISOString();
        c.expires_at = new Date(time(at) + c.requested_seconds * 1000).toISOString(); renewed.push(c);
      }
      if (unionDomains(data.claims.filter(c => time(c.expires_at) > time(at))).length > 256) throw fail('ROUTING_UNION_LIMIT', 'Routing union is limited to 256 host globs.');
      return renewed;
    }),
    removeClaim: ({ client_id, task_id, claim_id }) => mutate(data => {
      const removed = data.claims.filter(c => claim_id ? c.claim_id === claim_id : c.client_id === client_id && (c.task_id ?? null) === (task_id ?? null));
      data.claims = data.claims.filter(c => !removed.includes(c)); return removed;
    }),
    removeAllClaims: () => mutate(data => { const removed = data.claims; data.claims = []; return removed; }),
    sweepExpired: ({ now: at = now() } = {}) => mutate(data => {
      const expired = data.claims.filter(c => time(c.expires_at) <= time(at) && c.expired_at !== c.expires_at);
      for (const c of expired) { c.expired = true; c.expired_at = c.expires_at; }
      const active = data.claims.filter(c => time(c.expires_at) > time(at));
      const retained = data.claims.filter(c => time(c.expires_at) <= time(at) && time(at) - time(c.expires_at) <= retentionMs)
        .sort((a, b) => time(b.expires_at) - time(a.expires_at)).slice(0, 256);
      data.claims = [...active, ...retained]; return { expired };
    }),
  };
}
