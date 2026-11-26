import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForPublishedArtifact } from '../scripts/lib/release-policy.mjs';

const manifest = { name: 'proxyfan', version: '0.9.1', integrity: 'sha512-qualified' };
const published = { name: manifest.name, version: manifest.version, dist: { integrity: manifest.integrity } };

test('publication verification waits for registry visibility after an accepted upload', async () => {
  let clock = 0;
  let reads = 0;
  let pending = 0;
  const waits = [];
  const result = await waitForPublishedArtifact(async () => ++reads < 3 ? null : published, manifest, {
    timeoutMs: 100, intervalMs: 10, now: () => clock,
    wait: async (ms) => { waits.push(ms); clock += ms; },
    onPending: () => { pending++; },
  });
  assert.equal(result, published);
  assert.equal(reads, 3);
  assert.equal(pending, 2);
  assert.deepEqual(waits, [10, 10]);
});

test('an already visible matching artifact completes without delay', async () => {
  assert.equal(await waitForPublishedArtifact(async () => published, manifest, {
    wait: async () => assert.fail('An available artifact must not wait.'),
    onPending: () => assert.fail('An available artifact is not pending.'),
  }), published);
});

test('publication availability checks stop at a bounded deadline', async () => {
  let clock = 0;
  const waits = [];
  await assert.rejects(waitForPublishedArtifact(async () => null, manifest, {
    timeoutMs: 25, intervalMs: 10, now: () => clock,
    wait: async (ms) => { waits.push(ms); clock += ms; },
  }), /accepted.*not visible.*rerun/i);
  assert.equal(clock, 25);
  assert.deepEqual(waits, [10, 10, 5]);
});

test('a different immutable artifact fails immediately instead of waiting for replacement', async () => {
  await assert.rejects(waitForPublishedArtifact(async () => ({ ...published, dist: { integrity: 'sha512-different' } }), manifest, {
    wait: async () => assert.fail('A published integrity mismatch must not be retried.'),
  }), /different artifact/);
});

test('registry errors are not misclassified as an absent version awaiting scanning', async () => {
  const failure = new Error('npm metadata lookup failed (401)');
  await assert.rejects(waitForPublishedArtifact(async () => { throw failure; }, manifest, {
    wait: async () => assert.fail('An authorization error must not be retried.'),
  }), (error) => error === failure);
});
