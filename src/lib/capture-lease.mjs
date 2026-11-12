import crypto from 'node:crypto';
import { readState, patchState } from './state.mjs';

export const INTERNAL_CAPTURE_CONTROL = Symbol('trusted capture lifecycle');

// Observation, file exports and request replay remain available to every
// client. A task can lease shared mutations without taking capture ownership
// away when its stdio connection closes. This is coordination, not a security
// boundary between processes running as the same macOS user.
export const LEASE_PROTECTED_TOOLS = new Set([
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

export class CaptureLease {
  constructor({ read = readState, patch = patchState, clock = Date.now } = {}) {
    this.read = read;
    this.patch = patch;
    this.clock = clock;
    this.queue = Promise.resolve();
  }

  current(state) {
    const lease = state?.capture_lease;
    return lease && typeof lease.lease_id === 'string' && Date.parse(lease.expires_at) > this.clock() ? lease : null;
  }

  status(state) {
    const lease = this.current(state);
    return lease ? { active: true, task_id: lease.task_id, expires_at: lease.expires_at }
      : { active: false, task_id: null, expires_at: null };
  }

  async assert(leaseId) {
    const state = await this.read();
    const lease = this.current(state);
    if (leaseId && !lease) throw leaseError('CAPTURE_LEASE_EXPIRED', 'The capture lease is no longer active.', this.status(state));
    if (lease && lease.lease_id !== leaseId) throw leaseError('CAPTURE_OWNED', 'Another task holds the shared capture controls.', this.status(state));
    return lease;
  }

  acquire({ task_id, capture_lease_id, ttl_seconds = 900 } = {}) {
    return this.mutate(async () => {
      if (typeof task_id !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(task_id)
        || !Number.isInteger(ttl_seconds) || ttl_seconds < 30 || ttl_seconds > 3600) {
        throw Object.assign(new Error('Use a task_id of 1–96 safe characters and a lease TTL of 30–3600 seconds.'), { code: 'INVALID_CAPTURE_LEASE' });
      }
      const state = await this.read();
      const current = this.current(state);
      if (current && (current.lease_id !== capture_lease_id || current.task_id !== task_id)) {
        throw leaseError('CAPTURE_OWNED', 'Another task holds the shared capture controls.', this.status(state));
      }
      const lease = { lease_id: current?.lease_id ?? crypto.randomUUID(), task_id,
        expires_at: new Date(this.clock() + ttl_seconds * 1000).toISOString() };
      await this.patch({ capture_lease: lease });
      return { status: current ? 'renewed' : 'acquired', capture_lease_id: lease.lease_id,
        task_id, expires_at: lease.expires_at,
        next_actions: ['Pass capture_lease_id on shared mutations; the thin bridge remembers it for this connection.',
          'Remove your own rules and reverse proxies before release_capture_lease. Releasing does not stop capture.'] };
    });
  }

  release({ capture_lease_id } = {}) {
    return this.mutate(async () => {
      const lease = await this.assert(capture_lease_id);
      if (!lease) return { status: 'not_held' };
      await this.patch({ capture_lease: null });
      return { status: 'released', task_id: lease.task_id, capture_continues: true };
    });
  }

  mutate(fn) {
    const operation = this.queue.then(fn);
    this.queue = operation.catch(() => {});
    return operation;
  }
}

// Each stdio connection remembers only the lease it explicitly acquired. No
// caller identity is inferred from a shared auth token or an MCP session ID.
export function rememberCaptureLease(dispatch) {
  let leaseId = null;
  return async (tool, args = {}, context = {}) => {
    if (leaseId && !args.capture_lease_id && (LEASE_PROTECTED_TOOLS.has(tool)
      || tool === 'acquire_capture_lease' || tool === 'release_capture_lease')) {
      args = { ...args, capture_lease_id: leaseId };
    }
    try {
      const result = await dispatch(tool, args, context);
      if (tool === 'acquire_capture_lease') leaseId = result.capture_lease_id;
      if (tool === 'release_capture_lease') leaseId = null;
      return result;
    } catch (error) {
      if (error.code === 'CAPTURE_LEASE_EXPIRED') leaseId = null;
      throw error;
    }
  };
}

function leaseError(code, message, status) {
  return Object.assign(new Error(message), { code, retryable: false, details: status,
    recovery: ['Read get_proxy_status and inspect existing flows without changing capture.',
      'Use the current lease ID, or acquire a new lease after its owner releases it or it expires.'] });
}
