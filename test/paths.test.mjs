import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('path authorization allows workspace files and rejects unrelated paths', async () => {
  const { authorizeReadPath, authorizeWritePath } = await import('../src/lib/paths.mjs');
  const local = path.join(process.cwd(), 'package.json');
  assert.equal(await authorizeReadPath(local), await fs.realpath(local));
  assert.equal(await authorizeWritePath(path.join(process.cwd(), '.tmp', 'result.har')), path.join(process.cwd(), '.tmp', 'result.har'));
  const outside = path.join(os.tmpdir(), `proxy-mate-outside-${process.pid}`, 'file');
  await assert.rejects(authorizeWritePath(outside), (error) => error.code === 'PATH_NOT_AUTHORIZED');
});

test('sensitive access requires an explicit server-level grant', async () => {
  const prior = process.env.PROXY_MATE_ALLOW_SENSITIVE;
  delete process.env.PROXY_MATE_ALLOW_SENSITIVE;
  const { requireSensitiveAccess } = await import('../src/lib/paths.mjs');
  assert.equal(requireSensitiveAccess(false), false);
  assert.throws(() => requireSensitiveAccess(true), (error) => error.code === 'SENSITIVE_ACCESS_DISABLED');
  process.env.PROXY_MATE_ALLOW_SENSITIVE = '1';
  assert.equal(requireSensitiveAccess(true), true);
  if (prior == null) delete process.env.PROXY_MATE_ALLOW_SENSITIVE;
  else process.env.PROXY_MATE_ALLOW_SENSITIVE = prior;
});

test('test runs never resolve the real state directory without an explicit home', async () => {
  const { resolveStateDirectory } = await import('../src/lib/config.mjs');
  const os = await import('node:os');
  const resolved = resolveStateDirectory({ home: '/Users/someone', env: { NODE_TEST_CONTEXT: 'child-v8' }, exists: () => true });
  assert.ok(resolved.startsWith(os.tmpdir()) && resolved.includes('proxy-mate-test-home-'), resolved);
  assert.equal(resolveStateDirectory({ home: '/Users/someone', env: {}, exists: () => true }), '/Users/someone/.proxy-mcp');
  assert.equal(resolveStateDirectory({ home: '/Users/someone', env: { NODE_TEST_CONTEXT: 'child-v8', PROXY_MATE_HOME: '/tmp/x' } }), '/tmp/x');
});
