import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PROXYFAN_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxyfan-bodies-'));
const bodies = await import('../src/lib/bodies.mjs');

test('small binary bodies are persisted instead of silently lost', async () => {
  const payload = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
  const stored = await bodies.storeFlowBody(payload, 'flow-1', 'res');
  assert.equal(stored.inline, null);
  assert.equal(stored.encoding, 'binary');
  assert.ok(stored.path);
  assert.deepEqual(await fs.readFile(stored.path), payload);
});

test('user-controlled identifiers cannot escape body directories', () => {
  assert.throws(() => bodies.mockBodyPath('../../outside'), /may only contain/);
  assert.throws(() => bodies.flowBodyPath('/tmp/outside', 'req'), /may only contain/);
  assert.match(bodies.mockBodyPath('safe.rule-1'), /safe\.rule-1\.bin$/);
});

