import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Run in a fresh process: src modules capture PROXYFAN_HOME at import time.
let qualification;
const qualify = () => qualification ??= runQualification();
async function runQualification() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'multi-test-'));
  const child = spawn(process.execPath, ['scripts/qualify-multi-agent.mjs', '--seconds', '1', '--cpu-factor', '1'], { env: { ...process.env, PROXYFAN_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 85000);
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, output);
    const report = JSON.parse(output.trim());
    assert.equal(report.passed, true);
    return report;
  } finally { clearTimeout(timer); await rm(home, { recursive: true, force: true }); }
}

test('three real MCP bridges isolate evidence and survive daemon restarts', { timeout: 90000 }, async () => {
  await qualify();
});

import { fakeHostTrust, networksetupBinary, testTiming } from '../src/lib/test-hooks.mjs';
test('test-only overrides are inert without their explicit gate', () => {
  const env = { PROXYFAN_FAKE_HOST_TRUST: 'trusted', PROXYFAN_FAKE_NETWORKSETUP: '/fake', PROXYFAN_TEST_HEARTBEAT_MS: '1000' };
  assert.equal(fakeHostTrust(env), false);
  assert.equal(networksetupBinary(env), '/usr/sbin/networksetup');
  assert.equal(testTiming('PROXYFAN_TEST_HEARTBEAT_MS', 30000, env), 30000);
  for (const gate of [{ NODE_TEST_CONTEXT: 'child' }, { PROXYFAN_ALLOW_FAKE_NETWORKSETUP: '1' }]) {
    assert.equal(fakeHostTrust({ ...env, ...gate }), true);
    assert.equal(networksetupBinary({ ...env, ...gate }), '/fake');
  }
});

test('union PAC, per-client routing clear, restart re-arm and routing presence cleanup', { timeout: 90000 }, async () => {
  const report = await qualify();
  for (const name of ['union PAC and ownership', 'per-client routing clear', 'hard restart and routing re-arm',
    'external PAC preserved and routing warning', 'presence and guardian']) {
    assert.ok(report.phases.some(p => p.name === name), name);
  }
  assert.deepEqual(report.routing, { claims_survived_restart: 2, vpn_preserved: true, presence_remaining: 1 });
  assert.deepEqual(report.policy_decisions, []);
});

import { failsQualification } from '../scripts/lib/load-support.mjs';
test('a guardian termination decision fails qualification even when ownership prevents signalling', () => {
  assert.equal(failsQualification({ requests: { total: 10, failures: 0 }, guardian: {
    timeline: [{ action: 'unverified_owner_preserved' }], terminations: [],
    policy_decisions: [{ decision: 'would_terminate', reason: 'hung' }],
  } }), true);
});
