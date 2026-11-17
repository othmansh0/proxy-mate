import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readState, atomicWriteJson, STATE_DIR } from './state.mjs';
import { recordRuntimeEvent } from './runtime-identity.mjs';

export const INTERNAL_CAPTURE_CONTROL = Symbol('trusted capture lifecycle');

// This set keeps bridge lease propagation and MCP input compatibility. The
// tools wrapper checks only explicit resource targets; global-control policy
// is separate. Breakpoint tools retain their legacy lease input, but bypass
// enforcement so paused requests remain resolvable by every client.
export const LEASE_PROTECTED_TOOLS = new Set([
  'finish_capture_task',
  'start_proxy', 'start_app_capture', 'stop_proxy', 'set_proxy_routing', 'clear_proxy_routing',
  'toggle_recording', 'clear_session', 'create_capture_session', 'select_capture_session',
  'update_capture_session', 'import_capture_session', 'purge_capture_session', 'import_har',
  'setup_host_certificate', 'remove_host_certificate', 'rotate_certificate_authority',
  'setup_simulator_certificate', 'setup_xcode_preview_certificate', 'trust_ca_on_simulators',
  'restart_sim_apps', 'start_sim_watcher', 'stop_sim_watcher',
  'start_device_onboarding', 'stop_device_onboarding', 'enable_ssl_proxying',
  'create_reverse_proxy', 'remove_reverse_proxy', 'kill_orphan_proxy', 'reconcile_state',
  'create_map_local', 'create_map_remote', 'create_blacklist', 'create_breakpoint',
  'mock_json_response', 'patch_mock_json', 'create_network_condition', 'create_no_cache_rule',
  'capture_to_mock', 'update_rule', 'set_rule_enabled', 'set_rule_priority', 'reorder_rules',
  'remove_rule', 'clear_rules', 'import_rules', 'resolve_breakpoint', 'cancel_breakpoint',
  'upsert_transform_plugin', 'remove_transform_plugin', 'set_transform_plugin_enabled',
  'create_transform_plugin_rule', 'import_websocket_transcript',
]);

const queues = new Map();
const emptyStore = () => ({ leases: {}, orphaned_resources: [] });
const key = (client, task) => JSON.stringify([client, task]);

export class CaptureLease {
  constructor({ read = readState, clock = Date.now, directory = STATE_DIR,
    registry, recordEvent = recordRuntimeEvent } = {}) {
    Object.assign(this, { read, clock, registry, recordEvent });
    this.file = path.join(directory, 'leases.json');
    this.snapshot = emptyStore();
    if (registry) {
      const touch = registry.touch.bind(registry), sweep = registry.sweep.bind(registry);
      registry.touch = (client) => {
        const result = touch(client), at = this.clock();
        // Queue immediately: a subsequent mutation observes the renewal first.
        this.renew(client?.client_id, at).catch(error => console.error('Lease renewal failed:', error.code ?? error.message));
        return result;
      };
      registry.sweep = async () => { await sweep(); await this.summary(); };
    }
  }

  async load() {
    try { return JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const data = emptyStore(), old = (await this.read())?.capture_lease;
    if (old?.lease_id) {
      const lease = { ...old, client_id: old.client_id ?? 'legacy',
        created_at: old.created_at ?? new Date(this.clock()).toISOString(), ttl_seconds: old.ttl_seconds ?? 900 };
      data.leases[key(lease.client_id, lease.task_id)] = lease;
    }
    // The existence of leases.json is the durable one-time migration marker.
    await atomicWriteJson(this.file, data);
    return data;
  }

  alive(lease) {
    const presence = this.registry?.list().find(c => c.client_id === lease.client_id);
    return !presence || this.registry.isAlive(lease.client_id);
  }

  orphan(data, lease) {
    for (const resource of lease.resources ?? []) data.orphaned_resources.push({ ...resource,
      last_owner_client: lease.client_id, last_owner_task: lease.task_id,
      orphaned_at: new Date(this.clock()).toISOString() });
    delete data.leases[key(lease.client_id, lease.task_id)];
  }

  async expire(data) {
    for (const lease of Object.values(data.leases)) {
      const lost = !this.alive(lease);
      if (lost || Date.parse(lease.expires_at) <= this.clock()) {
        this.orphan(data, lease);
        if (lost) await this.recordEvent('lease_released_presence_lost', { details: { client_id: lease.client_id } });
      }
    }
  }

  mutate(fn, { expire = true } = {}) {
    const operation = (queues.get(this.file) ?? Promise.resolve()).then(async () => {
      const data = await this.load();
      if (expire) await this.expire(data);
      // Persist expiry even when the requested mutation subsequently fails.
      await atomicWriteJson(this.file, data);
      this.snapshot = data;
      const result = await fn(data);
      await atomicWriteJson(this.file, data);
      this.snapshot = data;
      return result;
    });
    queues.set(this.file, operation.catch(() => {}));
    return operation;
  }

  find(data, args = {}, context = {}) {
    const client = context.client_id ?? 'legacy';
    const task = args.task_id ?? context.task_id;
    if (task) return data.leases[key(client, task)] ?? null;
    return Object.values(data.leases).find(l => l.client_id === client && l.lease_id === args.capture_lease_id) ?? null;
  }

  status(_state, context = {}, data = this.snapshot) {
    const lease = this.find(data, {}, context);
    const client = context.client_id ?? 'legacy';
    return { active: !!lease, task_id: lease?.task_id ?? null, expires_at: lease?.expires_at ?? null,
      owned_resource_count: lease?.resources.length ?? 0,
      other_lease_count: Object.values(data.leases).filter(l => l !== lease).length,
      orphaned_resource_count: data.orphaned_resources.length,
      orphaned_resources: data.orphaned_resources.filter(r => r.last_owner_client === client) };
  }

  summary(context = {}) { return this.mutate(data => this.status(null, context, data)); }

  assert(leaseId, context = {}, resources = [], taskId) {
    return this.mutate(data => {
      const lease = this.find(data, { capture_lease_id: leaseId, task_id: taskId }, context);
      if (leaseId && !lease && !taskId) throw leaseError('CAPTURE_LEASE_EXPIRED', 'The task lease expired; acquire a new task lease.', this.status(null, context, data));
      for (const other of Object.values(data.leases)) {
        if (other === lease) continue;
        if (resources.some(r => other.resources.some(o => o.kind === r.kind && o.id === r.id))) {
          throw leaseError('CAPTURE_OWNED', 'This resource belongs to another live task. Wait for release or presence expiry, or use a different resource ID.', this.status(null, context, data));
        }
      }
      return lease;
    });
  }

  acquire({ task_id, ttl_seconds = 900, capture_lease_id } = {}, context = {}) {
    return this.mutate(data => {
      if (typeof task_id !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(task_id)
        || !Number.isInteger(ttl_seconds) || ttl_seconds < 30 || ttl_seconds > 3600) {
        throw Object.assign(new Error('Use a task_id of 1–96 safe characters and a lease TTL of 30–3600 seconds.'), { code: 'INVALID_CAPTURE_LEASE' });
      }
      const client_id = context.client_id ?? 'legacy', id = key(client_id, task_id);
      let current = data.leases[id];
      // A pre-identity bridge may resume its migrated lease with its explicit token.
      const migrated = data.leases[key('legacy', task_id)];
      if (!current && migrated?.lease_id === capture_lease_id) {
        current = migrated; delete data.leases[key('legacy', task_id)];
      }
      if (!current && Object.keys(data.leases).length >= 256) throw Object.assign(new Error('At most 256 task leases are allowed.'), { code: 'TASK_LEASE_LIMIT' });
      const lease = { lease_id: current?.lease_id ?? crypto.randomUUID(), client_id, task_id,
        created_at: current?.created_at ?? new Date(this.clock()).toISOString(), ttl_seconds,
        expires_at: new Date(this.clock() + ttl_seconds * 1000).toISOString(), resources: current?.resources ?? [] };
      data.leases[id] = lease;
      return { status: current ? 'renewed' : 'acquired', capture_lease_id: lease.lease_id, task_id,
        expires_at: lease.expires_at, lease_status: this.status(null, { client_id, task_id }, data),
        next_actions: ['Call finish_capture_task to remove unchanged task resources, or release_capture_lease to keep them as orphans.'] };
    });
  }

  release(args = {}, context = {}) {
    return this.mutate(data => {
      const lease = this.find(data, args, context);
      if (!lease) return { status: 'not_held', lease_status: this.status(null, context, data) };
      this.orphan(data, lease);
      return { status: 'released', task_id: lease.task_id, capture_continues: true, lease_status: this.status(null, context, data) };
    });
  }

  finish(leaseId, retained, context) {
    return this.mutate(data => {
      const lease = this.find(data, { capture_lease_id: leaseId }, { client_id: context.client_id });
      if (!lease) throw leaseError('CAPTURE_LEASE_EXPIRED', 'Task lease expired during cleanup.', this.status(null, context, data));
      lease.resources = lease.resources.filter(r => retained.some(k => k.kind === r.kind && k.id === r.id));
      this.orphan(data, lease);
      return this.status(null, context, data);
    });
  }

  renew(clientId, at) {
    return this.mutate(data => {
      for (const lease of Object.values(data.leases)) if (lease.client_id === clientId && Date.parse(lease.expires_at) > at) {
        lease.expires_at = new Date(at + lease.ttl_seconds * 1000).toISOString();
      }
      return this.expire(data);
    }, { expire: false });
  }

  trackResource(leaseId, resource) {
    return this.mutate(data => {
      const lease = Object.values(data.leases).find(l => l.lease_id === leaseId);
      if (!lease) throw leaseError('CAPTURE_LEASE_EXPIRED', 'Task lease expired during mutation.', {});
      const resources = lease.resources.filter(r => r.kind !== resource.kind || r.id !== resource.id);
      const orphans = data.orphaned_resources; // Retain former ownership evidence even after reuse.
      // Reserve orphan capacity for every live resource: losing all clients
      // must never overflow the bound or require throwing evidence away.
      const total = Object.values(data.leases).reduce((n, l) => n + (l === lease ? resources.length : l.resources.length), orphans.length);
      if (resources.length >= 512 || total >= 1024) throw Object.assign(new Error('Finish task resources before tracking more resources.'), { code: 'TASK_RESOURCE_LIMIT' });
      lease.resources = [...resources, resource];
    });
  }
}

// Each stdio connection remembers only the lease it explicitly acquired. No
// caller identity is inferred from a shared auth token or an MCP session ID.
export function rememberCaptureLease(dispatch) {
  let leaseId = null;
  let expiredLeaseId = null;
  return async (tool, args = {}, context = {}) => {
    // Retain expired ownership only for explicit reacquisition. Never attach
    // an expired lease to ordinary controls or silently retry a mutation.
    if (tool === 'acquire_capture_lease' && !args.capture_lease_id && !leaseId && expiredLeaseId) {
      args = { ...args, capture_lease_id: expiredLeaseId };
    }
    if (leaseId && !args.capture_lease_id && (LEASE_PROTECTED_TOOLS.has(tool)
      || tool === 'acquire_capture_lease' || tool === 'release_capture_lease')) {
      args = { ...args, capture_lease_id: leaseId };
    }
    try {
      const result = await dispatch(tool, args, context);
      if (tool === 'acquire_capture_lease') { leaseId = result.capture_lease_id; expiredLeaseId = null; }
      if (tool === 'release_capture_lease' || tool === 'finish_capture_task' && result.lease_released) { leaseId = null; expiredLeaseId = null; }
      return result;
    } catch (error) {
      if (error.code === 'CAPTURE_LEASE_EXPIRED') { expiredLeaseId = leaseId; leaseId = null; }
      throw error;
    }
  };
}

function leaseError(code, message, status) {
  return Object.assign(new Error(message), { code, retryable: false, details: status,
    recovery: ['Read get_proxy_status and inspect existing flows without changing capture.',
      'Use a different resource ID, or wait for its owning task to finish, expire, or lose presence.'] });
}
