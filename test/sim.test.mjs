import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PROXYFAN_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'proxyfan-sim-'));
const { ensureCA, CA_CERT } = await import('../src/lib/proxy.mjs');
const { inspectCertificate, simulatorPreflight } = await import('../src/lib/sim.mjs');

test('generated CA is valid, stable, inspectable, and staged as DER', async () => {
  const first = await ensureCA();
  const second = await ensureCA();
  assert.equal(first.certPath, second.certPath);
  const status = await inspectCertificate(CA_CERT);
  assert.equal(status.ok, true);
  assert.equal(status.fingerprint_sha256.length, 64);
  assert.deepEqual(Buffer.from(await fs.readFile(status.der_path)), Buffer.from((await import('node:crypto')).X509Certificate ? new (await import('node:crypto')).X509Certificate(await fs.readFile(CA_CERT)).raw : []));
});

test('Xcode preflight always returns an actionable structured result', async () => {
  const result = await simulatorPreflight({ developer_dir: '/definitely/missing/Xcode.app/Contents/Developer' });
  assert.equal(typeof result.ok, 'boolean');
  if (!result.ok) {
    assert.match(result.code, /XCODE|SIMCTL/);
    assert.ok(result.recovery);
  }
});

