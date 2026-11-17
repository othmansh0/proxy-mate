import crypto from 'node:crypto';

// Contract shared by the bridge, the control plane and tools.
//
// - Every bridge process generates one random client id at startup.
// - It sends the id on every control request in CLIENT_ID_HEADER, and inside
//   the RPC envelope: { tool, args, client: { bridge_version, client_id, task_id } }.
// - The control plane passes { client_id, task_id } into the tool context
//   (second argument to every tool), next to signal and bridge_version.
// - Older bridges send neither; the daemon then treats the caller as
//   LEGACY_CLIENT_ID and keys rate limits by remote address.
//
// The id is coordination metadata, not authentication: every local process
// running as this user can read the control token.

export const CLIENT_ID_HEADER = 'x-proxy-mate-client-id';
export const LEGACY_CLIENT_ID = 'legacy';
const CLIENT_ID = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function newClientId() {
  return `c-${crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0')}`;
}

export function normalizeClientId(value) {
  return typeof value === 'string' && CLIENT_ID.test(value) ? value : null;
}

export function normalizeTaskId(value) {
  return typeof value === 'string' && TASK_ID.test(value) ? value : null;
}
