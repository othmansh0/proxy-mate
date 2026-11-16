import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('npm version creates a matching commit/tag/changelog without editing a runtime constant', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-version-workflow-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  for (const file of ['scripts/release.mjs', 'scripts/check-package.mjs', 'scripts/lib/release-policy.mjs', 'src/lib/config.mjs', 'src/lib/environment.mjs']) {
    await fs.mkdir(path.dirname(path.join(temporary, file)), { recursive: true });
    await fs.copyFile(path.resolve(import.meta.dirname, '..', file), path.join(temporary, file));
  }
  for (const file of ['src/index.mjs', 'src/index.d.ts', 'src/client.mjs', 'src/server.mjs', 'README.md']) await fs.writeFile(path.join(temporary, file), '');
  const pkg = { name: '@othmansh0/proxy-mate', version: '0.9.0', type: 'module',
    publishConfig: { registry: 'https://registry.npmjs.org', access: 'public' }, dependencies: {}, bundleDependencies: [],
    scripts: { preversion: 'node scripts/release.mjs preversion', version: 'node scripts/release.mjs version' } };
  await fs.writeFile(path.join(temporary, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(path.join(temporary, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3,
    packages: { '': { name: pkg.name, version: pkg.version } } }));
  await fs.writeFile(path.join(temporary, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- A verified version bump.\n\n## 0.9.0 — 2026-11-12\n\n- Initial release.\n');
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    GIT_AUTHOR_NAME: 'Release test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Release test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const execute = promisify(execFile);
  const run = (command, args, overrides = {}) => execute(command, args, { cwd: temporary, env, timeout: 30_000, ...overrides });
  await run('git', ['init', '-q']);
  await run('git', ['config', 'commit.gpgsign', 'false']);
  await run('git', ['config', 'tag.gpgsign', 'false']);
  await run('git', ['config', 'core.hooksPath', '/dev/null']);
  await run('git', ['add', '.']);
  await run('git', ['commit', '-qm', 'Version fixture']);
  const npmArgs = ['version', 'patch', '-m', 'Release %s'];
  if (process.env.npm_execpath) await run(process.execPath, [process.env.npm_execpath, ...npmArgs]);
  else await run('npm', npmArgs);
  assert.equal(JSON.parse(await fs.readFile(path.join(temporary, 'package.json'))).version, '0.9.1');
  assert.equal((await run('git', ['rev-parse', 'HEAD'])).stdout, (await run('git', ['rev-parse', 'refs/tags/v0.9.1^{commit}'])).stdout);
  assert.equal((await run('git', ['status', '--porcelain'])).stdout, '');
  assert.match(await fs.readFile(path.join(temporary, 'CHANGELOG.md'), 'utf8'), /## 0\.9\.1 .*\n\n- A verified version bump/);
  await run(process.execPath, ['scripts/release.mjs', 'validate'], { env: { ...env, RELEASE_TAG: 'v0.9.1' } });
  await assert.rejects(run(process.execPath, ['scripts/release.mjs', 'validate'], { env: { ...env, RELEASE_TAG: 'v0.9.0' } }), /does not match/);
  const version = await run(process.execPath, ['--input-type=module', '-e', "import {SERVER_VERSION} from './src/lib/config.mjs'; console.log(SERVER_VERSION)"]);
  assert.equal(version.stdout.trim(), '0.9.1');
  await fs.mkdir(path.join(temporary, 'external-modules'));
  await fs.symlink(path.join(temporary, 'external-modules'), path.join(temporary, 'node_modules'));
  await assert.rejects(run(process.execPath, ['scripts/check-package.mjs']), /symlinked node_modules cannot be bundled reliably/);
});
