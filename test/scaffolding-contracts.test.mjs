import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatLogLine, errorFields } from '../src/lib/log-line.mjs';
import { increment, registerGauge, snapshotMetrics, resetMetrics } from '../src/lib/metrics.mjs';
import { newClientId, normalizeClientId, normalizeTaskId, CLIENT_ID_HEADER } from '../src/lib/client-identity.mjs';
import { writeShutdownIntent, readShutdownIntent, clearShutdownIntent, INTENT_TTL_MS } from '../src/lib/shutdown-intent.mjs';

test('log lines are timestamped, single-line and keep only safe keys', () => {
  const line = formatLogLine('guardian', 'probe failed\nsecond', { step: 'probe', elapsed_ms: 1200, note: 'has space', 'Bad-Key': 'x', skipped: undefined },
    { now: () => new Date('2026-11-17T11:08:14.433Z'), pid: 42 });
  assert.equal(line, '2026-11-17T11:08:14.433Z [proxyfan guardian pid=42] probe failed second step=probe elapsed_ms=1200 note="has space"\n');
  assert.deepEqual(errorFields(Object.assign(new Error('timed out'), { code: null, killed: true, signal: 'SIGTERM' })),
    { error_code: null, error_name: 'Error', error_message: 'timed out', error_signal: 'SIGTERM', error_killed: true });
});

test('metrics count and read gauges lazily', () => {
  resetMetrics();
  increment('control.rate_limited');
  increment('control.rate_limited', 2);
  const unregister = registerGauge('loop.lag_p99_ms', () => 12.5);
  registerGauge('broken', () => { throw new Error('x'); });
  assert.deepEqual(snapshotMetrics(), { counters: { 'control.rate_limited': 3 }, gauges: { 'loop.lag_p99_ms': 12.5, broken: null } });
  unregister();
  assert.equal('loop.lag_p99_ms' in snapshotMetrics().gauges, false);
  resetMetrics();
});

test('client identity values are bounded and validated', () => {
  const id = newClientId();
  assert.equal(normalizeClientId(id), id);
  assert.equal(normalizeClientId('../../etc'), null);
  assert.equal(normalizeTaskId('recipe-jar:E1'), 'recipe-jar:E1');
  assert.equal(normalizeTaskId('bad task'), null);
  assert.equal(CLIENT_ID_HEADER, 'x-proxyfan-client-id');
});

test('shutdown intent is scoped to one pid and expires', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'intent-'));
  let clock = Date.parse('2026-11-17T11:08:09Z');
  await writeShutdownIntent({ targetPid: 1473, reason: 'guardian_health_timeout', by: 'guardian', directory, now: () => clock });
  assert.equal((await readShutdownIntent(1473, { directory, now: () => clock })).reason, 'guardian_health_timeout');
  assert.equal(await readShutdownIntent(91970, { directory, now: () => clock }), null);
  clock += INTENT_TTL_MS + 1;
  assert.equal(await readShutdownIntent(1473, { directory, now: () => clock }), null);
  await clearShutdownIntent({ directory });
  assert.equal(await readShutdownIntent(1473, { directory }), null);
});

test('runtime events keep only scalar, non-reserved details', async () => {
  const { eventDetails } = await import('../src/lib/runtime-identity.mjs');
  assert.deepEqual(eventDetails({ load1: 307.3, step: 'probe', pid: 1, nested: { a: 1 }, 'Bad': 1, ok: true, none: null }),
    { load1: 307.3, step: 'probe', ok: true, none: null });
});

test('custom CA validation names the path, errno and a fix', async () => {
  const { validateCustomCaPaths } = await import('../src/lib/ca-paths.mjs');
  assert.equal(await validateCustomCaPaths({}), null);
  await assert.rejects(validateCustomCaPaths({ keyPath: '/k' }), { code: 'CUSTOM_CA_INCOMPLETE' });
  const stat = async (p) => {
    if (p === '/Users/me/Documents/ca.key') throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return { isFile: () => p !== '/dir' };
  };
  await assert.rejects(validateCustomCaPaths({ keyPath: '/Users/me/Documents/ca.key', certPath: '/dir', stat }), (error) => {
    assert.equal(error.code, 'CUSTOM_CA_UNREADABLE');
    assert.equal(error.details.key_problem, 'permission_denied');
    assert.equal(error.details.key_errno, 'EPERM');
    assert.equal(error.details.cert_problem, 'not_regular_file');
    assert.match(error.recovery[0], /Full Disk Access/);
    return true;
  });
  assert.deepEqual(await validateCustomCaPaths({ keyPath: '/a', certPath: '/b', stat }), { keyPath: '/a', certPath: '/b' });
});
