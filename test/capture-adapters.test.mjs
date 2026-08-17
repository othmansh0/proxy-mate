import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPTURE_ADAPTER_ERROR_CODES,
  buildCaptureSetupPlan,
  captureAdapterCapabilitySummary,
  createCaptureAdapterRegistry,
  listCaptureAdapters,
} from '../src/lib/capture-adapters.mjs';

test('registry exposes stable machine-readable descriptors and boundaries', () => {
  const adapters = listCaptureAdapters();
  assert.deepEqual(adapters.map(({ id }) => id), [
    'apple-simulator',
    'apple-device-manual',
    'android-adb',
    'docker',
    'terminal-env',
  ]);
  for (const adapter of adapters) {
    assert.equal(adapter.schema_version, 1);
    assert.equal(adapter.capabilities.certificate_pinning_bypass, false);
  }
  const summary = captureAdapterCapabilitySummary();
  assert.equal(summary.automatic_mutation, false);
  assert.equal(summary.command_representation, 'exec_file_argv');
  assert.equal(summary.boundaries.root_escalation, false);
});

test('Android setup is an inert argv plan with explicit CA and pinning boundaries', () => {
  const plan = buildCaptureSetupPlan('android-adb', {
    proxy_host: '127.0.0.1',
    proxy_port: 8080,
    serial: 'emulator-5554',
    ca: { cert_path: '/authorized/ca.pem' },
  });
  const proxyStep = plan.steps.find(({ id }) => id === 'configure-proxy');
  assert.equal(plan.executes_automatically, false);
  assert.equal(proxyStep.execution, 'automatable_requires_confirmation');
  assert.equal(proxyStep.action.executable, 'adb');
  assert.deepEqual(proxyStep.action.args, [
    '-s', 'emulator-5554', 'shell', 'settings', 'put', 'global', 'http_proxy', '127.0.0.1:8080',
  ]);
  assert(plan.unsupported.some((item) => item.includes('rooted')));
  assert(plan.unsupported.some((item) => item.includes('pinning')));
});

test('terminal and Docker plans contain structured environment and argument data, not command strings', () => {
  const terminal = buildCaptureSetupPlan('terminal', { proxy_port: 9000, ca: '/safe/ca.pem' });
  assert.deepEqual(terminal.steps[0].action.set.HTTP_PROXY, 'http://127.0.0.1:9000');
  assert.deepEqual(
    terminal.steps.find(({ id }) => id === 'configure-ca').action.options[2].argv_append,
    ['--cacert', '/safe/ca.pem'],
  );

  const docker = buildCaptureSetupPlan('docker', { proxy_port: 9000, container: 'api-1' });
  const env = docker.steps.find(({ id }) => id === 'configure-environment').action.set;
  assert.equal(env.HTTP_PROXY, 'http://host.docker.internal:9000');
  assert.equal(docker.mutates_target, false);
  assert.equal(docker.steps.some(({ action }) => typeof action.command === 'string'), false);
});

test('preflight uses bounded execFile-style calls and reports missing tools stably', async () => {
  const calls = [];
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const registry = createCaptureAdapterRegistry({
    platform: 'linux',
    runCommand: async (...args) => { calls.push(args); throw missing; },
  });
  const result = await registry.preflight('android-adb', { timeout_ms: 321 });
  assert.equal(result.ok, false);
  assert.equal(result.code, CAPTURE_ADAPTER_ERROR_CODES.TOOL_MISSING);
  assert.deepEqual(calls[0][0], 'adb');
  assert.deepEqual(calls[0][1], ['version']);
  assert.equal(calls[0][2].timeout, 321);
  assert.equal(calls[0][2].maxBuffer, 1024 * 1024);
});

test('ADB preflight parses devices without mutating them', async () => {
  const calls = [];
  const registry = createCaptureAdapterRegistry({
    runCommand: async (file, args) => {
      calls.push([file, args]);
      return args[0] === 'version'
        ? { stdout: 'Android Debug Bridge version 1.0.41' }
        : { stdout: 'List of devices attached\nemulator-5554 device product:sdk model:Pixel_9\n' };
    },
  });
  const result = await registry.preflight('adb');
  assert.equal(result.ok, true);
  assert.deepEqual(result.devices[0], {
    serial: 'emulator-5554', state: 'device', details: ['product:sdk', 'model:Pixel_9'],
  });
  assert.deepEqual(calls, [['adb', ['version']], ['adb', ['devices', '-l']]]);
  assert.equal(result.mutates_target, false);
});

test('adapter inputs reject control characters and shell-like identifiers', () => {
  assert.throws(
    () => buildCaptureSetupPlan('android-adb', { proxy_port: 8080, serial: 'device;touch-owned' }),
    { code: CAPTURE_ADAPTER_ERROR_CODES.INVALID_OPTIONS },
  );
  assert.throws(
    () => buildCaptureSetupPlan('docker', { proxy_port: 8080, proxy_host_for_container: 'host\n--privileged' }),
    { code: CAPTURE_ADAPTER_ERROR_CODES.INVALID_OPTIONS },
  );
});

