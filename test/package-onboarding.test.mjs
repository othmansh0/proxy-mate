import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clientRegistrationPlan, registerClient, validateClientRegistration } from '../src/lib/client-registration.mjs';
import { initializePackage } from '../src/lib/onboarding.mjs';

async function fixture(t, client = 'claude') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-package-setup-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const plan = await clientRegistrationPlan({ client, home, stateDir: path.join(home, 'state'), env: {} });
  return { home, plan };
}

test('registration preserves unrelated settings, private backups, symlinks and repeat setup', async (t) => {
  const { home, plan } = await fixture(t);
  const original = JSON.stringify({ theme: 'dark', mcpServers: { another: { command: 'another' } } });
  const target = path.join(home, 'managed-config.json');
  await fs.writeFile(target, original);
  await fs.symlink(target, plan.config_path);
  const result = await registerClient(plan);
  const next = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.equal(next.theme, 'dark');
  assert.deepEqual(next.mcpServers.another, { command: 'another' });
  assert.deepEqual(next.mcpServers['proxy-mcp'], plan.entry);
  assert.equal((await fs.lstat(plan.config_path)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(result.backup_path, 'utf8'), original);
  assert.equal((await fs.stat(result.backup_path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(plan.backup_dir)).mode & 0o777, 0o700);
  assert.equal((await registerClient(plan)).status, 'unchanged');
  assert.equal((await fs.readdir(plan.backup_dir)).length, 1);
});

test('invalid client configuration fails before installing a service', async (t) => {
  const { plan } = await fixture(t);
  await fs.writeFile(plan.config_path, '{ invalid');
  let installed = false;
  await assert.rejects(initializePackage({}, { plan: async () => plan, install: async () => { installed = true; } }), /Cannot parse/);
  assert.equal(installed, false);
  assert.equal(await fs.readFile(plan.config_path, 'utf8'), '{ invalid');
});

test('plain init reuses a healthy busy capture; preview changes no files', async (t) => {
  const { home, plan } = await fixture(t);
  const dependencies = { plan: async () => plan, inspect: async () => ({ version: 'old', status: { routing_active: true } }),
    install: async () => { assert.fail('must not install'); }, checkEntry: async () => {},
    register: async () => ({ status: 'registered' }) };
  const preview = await initializePackage({ dryRun: true }, dependencies);
  assert.equal(preview.service, 'reuse');
  assert.deepEqual(await fs.readdir(home), []);
  const result = await initializePackage({}, dependencies);
  assert.equal(result.service.status, 'reused');
  assert.ok(result.update_available);
  await assert.rejects(initializePackage({ upgrade: true }, dependencies), /Capture is in use/);
});

test('new install registers only after success and upgrade releases its lease after failure', async (t) => {
  const { plan } = await fixture(t, 'json');
  let registered = false;
  const deps = { plan: async () => plan, inspect: async () => null,
    install: async () => { throw new Error('install failed'); }, register: async () => { registered = true; } };
  await assert.rejects(initializePackage({}, deps), /install failed/);
  assert.equal(registered, false);
  const calls = [];
  deps.inspect = async () => ({ version: 'old', status: {} });
  deps.call = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'acquire_capture_lease') return { capture_lease_id: 'owned' };
    if (tool === 'get_proxy_status') return {};
    if (tool === 'list_reverse_proxies') return { reverse_proxies: [] };
    return {};
  };
  await assert.rejects(initializePackage({ upgrade: true }, deps), /install failed/);
  assert.deepEqual(calls.map((item) => item.tool), ['acquire_capture_lease', 'get_proxy_status', 'list_reverse_proxies', 'release_capture_lease']);
  assert.equal(calls.at(-1).args.capture_lease_id, 'owned');
});

test('custom Claude directory and all JSON clients get stable absolute entries', async (t) => {
  const { home } = await fixture(t);
  for (const client of ['claude', 'cursor', 'claude-desktop', 'json']) {
    const plan = await clientRegistrationPlan({ client, home, stateDir: path.join(home, 'state'), env: { CLAUDE_CONFIG_DIR: path.join(home, 'custom') } });
    if (client === 'claude') assert.equal(plan.config_path, path.join(home, 'custom/.claude.json'));
    assert.equal(path.isAbsolute(plan.entry.command), true);
    assert.equal(path.isAbsolute(plan.entry.args[0]), true);
    assert.equal(plan.entry.env.PROXY_MCP_HOME, path.join(home, 'state'));
    await validateClientRegistration(plan);
    assert.ok(['registered', 'manual'].includes((await registerClient(plan)).status));
  }
});

test('upgrade preserves reverse listeners and explicit advanced configurations', async (t) => {
  const { plan } = await fixture(t, 'json');
  const calls = [];
  const deps = { plan: async () => plan, inspect: async () => ({ version: 'old', status: {} }),
    install: async () => assert.fail('must not replace this service'),
    call: async (tool) => {
      calls.push(tool);
      if (tool === 'acquire_capture_lease') return { capture_lease_id: 'owned' };
      if (tool === 'list_reverse_proxies') return { reverse_proxies: [{ id: 'another-task' }] };
      return {};
    } };
  await assert.rejects(initializePackage({ upgrade: true }, deps), /reverse proxies/);
  assert.equal(calls.at(-1), 'release_capture_lease');
  deps.inspect = async () => ({ version: 'old', status: { ca_cert: '/custom/cert.pem' } });
  await assert.rejects(initializePackage({ upgrade: true }, deps), /advanced/);
});

test('real CLI previews setup without creating daemon state and rejects restricted publishing', async (t) => {
  const { home } = await fixture(t);
  const state = path.join(home, 'not-created');
  const run = promisify(execFile);
  const root = path.resolve(import.meta.dirname, '..');
  const result = await run(process.execPath, ['src/server.mjs', 'init', '--client', 'json', '--dry-run'], {
    cwd: root, env: { ...process.env, PROXY_MCP_HOME: state },
  });
  assert.equal(JSON.parse(result.stdout).status, 'preview');
  await assert.rejects(fs.access(state), { code: 'ENOENT' });
  await assert.rejects(run(process.execPath, ['scripts/check-package.mjs'], {
    cwd: root, env: { ...process.env, npm_config_access: 'restricted' },
  }), /public npm/);
});
