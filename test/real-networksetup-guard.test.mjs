import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRealNetworkCommandAllowed, targetedAutoProxyOff } from '../src/lib/state.mjs';
import { setAutoProxyOff } from '../src/lib/pac.mjs';

// A 17 Nov 2026 work package's first failing test reached the real binary.
test('real networksetup is refused inside test runs unless explicitly allowed', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test marks child processes');
  assert.throws(() => assertRealNetworkCommandAllowed(), { code: 'REAL_NETWORKSETUP_BLOCKED' });
  assert.doesNotThrow(() => assertRealNetworkCommandAllowed({ NODE_TEST_CONTEXT: 'child-v8', PROXYFAN_ALLOW_REAL_NETWORKSETUP: '1' }));
  assert.doesNotThrow(() => assertRealNetworkCommandAllowed({}));
  await assert.rejects(setAutoProxyOff('ProxyFan Guard Test Service'), { code: 'REAL_NETWORKSETUP_BLOCKED' });
  await assert.rejects(targetedAutoProxyOff('ProxyFan Guard Test Service'), { code: 'REAL_NETWORKSETUP_BLOCKED' });
  const calls = [];
  await setAutoProxyOff('Fake', async (...args) => { calls.push(args); return { stdout: '' }; });
  assert.equal(calls.length, 2, 'injected runners are unaffected');
});
