import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STATE_DIR, SERVER_VERSION } from './config.mjs';
import { readHandshake } from './state.mjs';
import { callDaemon, probeDaemon } from './control.mjs';
import { clientRegistrationPlan, validateClientRegistration, registerClient } from './client-registration.mjs';

async function existingService() {
  const handshake = await readHandshake();
  if (!handshake || !await probeDaemon(handshake.controlUrl, handshake.token)) return null;
  const status = await callDaemon({ ...handshake, tool: 'get_proxy_status' });
  const version = await callDaemon({ ...handshake, tool: 'get_version' });
  return { status, version: version.version };
}

async function liveCall(tool, args = {}) {
  const handshake = await readHandshake();
  if (!handshake) throw new Error('The daemon is unavailable; retry init after recovery.');
  return callDaemon({ ...handshake, tool, args });
}

function captureBusy(status) {
  return status.routing_active || status.breakpoints?.pending_count || status.capture_scope?.mode === 'app';
}

export async function initializePackage({ client = 'claude', upgrade = false, dryRun = false } = {}, {
  plan = clientRegistrationPlan, validate = validateClientRegistration, register = registerClient,
  inspect = existingService, install, call = liveCall, checkEntry = (file) => fs.access(file),
} = {}) {
  // Validate the selected client before installing/reloading a service.
  const registration = await plan({ client });
  await validate(registration);
  const existing = await inspect();
  const replacing = Boolean(existing && upgrade);
  if (replacing) {
    const status = existing.status;
    if (captureBusy(status) || status.capture_lease?.active) {
      throw new Error('Capture is in use. Stop capture and finish its task before init --upgrade. Plain init reconnects the client without restarting capture.');
    }
    if (status.allow_remote || status.upstream_proxy || status.capture_storage_policy === 'all'
      || status.ca_cert && status.ca_cert !== path.join(STATE_DIR, 'ca/cert.pem')) {
      throw new Error('This service uses advanced remote, upstream, raw-storage or custom-CA options. Upgrade with install and those explicit options; init will not replace them with defaults.');
    }
  }
  if (dryRun) return { status: 'preview', package_version: SERVER_VERSION,
    service: !existing ? 'install' : upgrade ? 'upgrade' : 'reuse', registration };
  let service;
  if (existing && !upgrade) {
    await checkEntry(path.join(STATE_DIR, 'runtime/current/src/client.mjs'));
    service = { status: 'reused', version: existing.version };
  } else {
    if (typeof install !== 'function') throw new Error('The CLI installer is required to initialize a new service.');
    let lease;
    let installed;
    try {
      if (replacing) {
        lease = await call('acquire_capture_lease', { task_id: 'package-upgrade', ttl_seconds: 180 });
        const status = await call('get_proxy_status');
        if (captureBusy(status)) throw new Error('Capture started during setup. Finish the task before upgrading.');
        const reverse = await call('list_reverse_proxies');
        if (reverse.reverse_proxies.length) throw new Error('Remove or finish active reverse proxies before upgrading the service.');
      }
      installed = await install(existing?.status);
    } finally {
      if (lease) await call('release_capture_lease', { capture_lease_id: lease.capture_lease_id });
    }
    service = { status: existing ? 'upgraded' : 'installed', version: SERVER_VERSION, runtime_directory: installed.runtime_directory };
  }
  const connected = await register(registration);
  return { status: 'ready', package_version: SERVER_VERSION, service, client: connected,
    next_action: 'Reconnect your MCP client, then ask: "Set up capture for my app in the Simulator for 30 minutes."',
    ...(service.version !== SERVER_VERSION ? { update_available: 'Finish active capture, then run init --upgrade to install this package version.' } : {}) };
}
