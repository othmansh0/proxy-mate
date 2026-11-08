import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSimulatorRouting } from '../src/lib/simulator-routing.mjs';

function trustReport(devices = ['sim-1', 'sim-2']) {
  const trusted = devices.map((udid) => ({
    udid, status: 'trusted_root_imported', system_tls_verified: false,
  }));
  return { ok: true, trusted, results: trusted, preflight: { developer_dir: '/Xcode.app/Contents/Developer' } };
}

function scenario(overrides = {}) {
  const events = [];
  return {
    events,
    options: {
      certPath: '/custom/cert.pem',
      keyPath: '/custom/key.pem',
      trust: async (certPath) => {
        assert.equal(certPath, '/custom/cert.pem');
        events.push('import');
        return trustReport();
      },
      verify: async ({ udid, keyPath, certPath, developer_dir }) => {
        assert.equal(keyPath, '/custom/key.pem');
        assert.equal(certPath, '/custom/cert.pem');
        assert.equal(developer_dir, '/Xcode.app/Contents/Developer');
        events.push(`verify:${udid}`);
        return { ok: true, system_tls_verified: true, device_id: udid, automatic_routing_verified: false };
      },
      applyRouting: async () => {
        events.push('route');
        return { status: 'routing_on' };
      },
      ...overrides,
    },
  };
}

test('routing waits until every booted Simulator passes native TLS verification', async () => {
  const { events, options } = scenario();
  const result = await setupSimulatorRouting(options);
  assert.deepEqual(events, ['import', 'verify:sim-1', 'verify:sim-2', 'route']);
  assert.equal(result.routing.status, 'routing_on');
  assert.equal(result.trust.trusted.every((sim) => sim.system_tls_verified), true);
  assert.equal(result.trust.results.every((sim) => sim.system_tls_verified), true);
  assert.equal(result.trust.verifications.every((item) => item.automatic_routing_verified === false), true);
});

test('failed or partial certificate import never enables routing', async () => {
  for (const report of [
    { ...trustReport(['sim-1']), ok: false, failed: [{ udid: 'sim-2', status: 'failed' }] },
    { ok: false, trusted: [], preflight: { ok: false, code: 'XCODE_NOT_FOUND' } },
  ]) {
    const { events, options } = scenario({ trust: async () => report });
    await assert.rejects(setupSimulatorRouting(options), { code: 'SIMULATOR_CA_SETUP_FAILED' });
    assert.deepEqual(events, []);
  }
});

test('no booted Simulator leaves automatic routing disabled', async () => {
  const { events, options } = scenario({ trust: async () => trustReport([]) });
  await assert.rejects(setupSimulatorRouting(options), { code: 'SIMULATOR_NOT_BOOTED' });
  assert.deepEqual(events, []);
});

test('an existing certificate still requires successful native TLS verification', async () => {
  const report = trustReport(['sim-1']);
  report.trusted[0].status = 'already_present_unverified';
  const { events, options } = scenario({
    trust: async () => report,
    verify: async () => ({ ok: true, system_tls_verified: false }),
  });
  await assert.rejects(setupSimulatorRouting(options), { code: 'SIMULATOR_TLS_VERIFICATION_FAILED' });
  assert.deepEqual(events, []);
});

test('a later Simulator verification failure never enables routing', async () => {
  const { events, options } = scenario();
  const verify = options.verify;
  options.verify = async (args) => {
    const result = await verify(args);
    return args.udid === 'sim-2' ? { ...result, ok: false } : result;
  };
  await assert.rejects(setupSimulatorRouting(options), { code: 'SIMULATOR_TLS_VERIFICATION_FAILED' });
  assert.deepEqual(events, ['import', 'verify:sim-1', 'verify:sim-2']);
});

test('verification exceptions provide device-specific recovery without enabling routing', async () => {
  const { events, options } = scenario({ verify: async () => { throw new Error('probe failed'); } });
  await assert.rejects(setupSimulatorRouting(options), (error) => {
    assert.equal(error.code, 'SIMULATOR_TLS_VERIFICATION_FAILED');
    assert.equal(error.details.device_id, 'sim-1');
    assert.match(error.details.verification.error, /probe failed/);
    assert.ok(error.recovery.length);
    return true;
  });
  assert.deepEqual(events, ['import']);
});

test('routing failures propagate to the caller for owned-setting cleanup', async () => {
  const failure = Object.assign(new Error('PAC conflict'), { code: 'EXISTING_PROXY_CONFLICT' });
  const { events, options } = scenario({ applyRouting: async () => { throw failure; } });
  await assert.rejects(setupSimulatorRouting(options), failure);
  assert.deepEqual(events, ['import', 'verify:sim-1', 'verify:sim-2']);
});

test('missing routing callback fails before certificate side effects', async () => {
  const { events, options } = scenario({ applyRouting: undefined });
  await assert.rejects(setupSimulatorRouting(options), TypeError);
  assert.deepEqual(events, []);
});
