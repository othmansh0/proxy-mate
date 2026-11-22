import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PluginStore, PluginStoreError } from '../src/lib/plugin-store.mjs';

function hasCode(code) {
  return (error) => error instanceof PluginStoreError && error.code === code;
}

test('persists private atomic manifests and source across restart with redacted list metadata', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'proxyfan-plugins-'));
  const clock = () => new Date('2026-08-17T10:00:00.000Z');
  const first = new PluginStore({ directory, clock });
  const saved = await first.upsert({
    id: 'add-header',
    name: 'Add header',
    description: 'Adds a safe test header',
    stage: 'request',
    enabled: true,
    source: '(request) => ({ ...request, headers: { ...request.headers, "x-plugin": "yes" } })',
  });
  assert.equal(saved.source_redacted, true);
  assert.equal(saved.source, undefined);
  assert.equal((await first.list()).plugins[0].source, undefined);
  assert.equal(await first.execute({ id: 'add-header', stage: 'request', input: { headers: {} } }).then((value) => value.headers['x-plugin']), 'yes');

  const catalog = JSON.parse(await readFile(path.join(directory, 'plugins.json'), 'utf8'));
  const sourcePath = path.join(directory, 'sources', catalog.plugins[0].source_file);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, 'sources'))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, 'plugins.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(sourcePath)).mode & 0o777, 0o600);
  first.dispose();

  const restarted = new PluginStore({ directory, clock });
  assert.equal((await restarted.init()).restored, 1);
  const metadata = await restarted.get('add-header');
  assert.equal(metadata.source_redacted, true);
  assert.equal(metadata.source, undefined);
  const disclosed = await restarted.get('add-header', { includeSource: true });
  assert.match(disclosed.source, /x-plugin/);
  assert.equal(disclosed.source_redacted, false);
  assert.equal((await restarted.execute({ id: 'add-header', stage: 'request', input: { headers: {} } })).headers['x-plugin'], 'yes');
  restarted.dispose();
});

test('enforces safe ids, declared stages, and enablement', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'proxyfan-plugin-stage-'));
  const store = new PluginStore({ directory });
  await assert.rejects(store.upsert({ id: '../escape', stage: 'request', source: '(value) => value' }), hasCode('PLUGIN_INVALID_ID'));
  await assert.rejects(store.upsert({ id: 'wrong-stage', stage: 'live_websocket', source: '(value) => value' }), hasCode('PLUGIN_INVALID_STAGE'));
  await store.upsert({ id: 'response-only', stage: 'response', enabled: true, source: '(value) => ({ ...value, changed: true })' });
  await assert.rejects(store.execute({ id: 'response-only', stage: 'request', input: {} }), hasCode('PLUGIN_STAGE_MISMATCH'));
  assert.equal((await store.execute({ id: 'response-only', stage: 'response', input: {} })).changed, true);
  await store.enable('response-only', false);
  await assert.rejects(store.execute({ id: 'response-only', stage: 'response', input: {} }), hasCode('PLUGIN_DISABLED'));
  assert.equal((await store.list({ stage: 'response', enabled: false })).total, 1);
  store.dispose();
});

test('upserts content-addressed source, removes plugins, and verifies stored integrity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'proxyfan-plugin-update-'));
  const store = new PluginStore({ directory });
  const first = await store.upsert({ id: 'mutable', stage: 'websocket_offline', enabled: true, source: '(value) => ({ ...value, version: 1 })' });
  const second = await store.upsert({ id: 'mutable', stage: 'websocket_offline', enabled: true, source: '(value) => ({ ...value, version: 2 })' });
  assert.notEqual(first.source_sha256, second.source_sha256);
  assert.equal((await store.execute({ id: 'mutable', stage: 'websocket_offline', input: {} })).version, 2);
  assert.deepEqual(await store.remove('mutable'), { removed: true, id: 'mutable' });
  assert.deepEqual(await store.remove('mutable'), { removed: false, id: 'mutable' });
  assert.equal(await store.get('mutable'), null);
  await assert.rejects(store.execute({ id: 'mutable', stage: 'websocket_offline', input: {} }), hasCode('PLUGIN_NOT_FOUND'));
  store.dispose();
});
