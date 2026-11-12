import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stageDaemonRuntime, pruneDaemonRuntimes, publishDaemonRuntime } from '../src/lib/runtime-install.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-install-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'Documents/checkout');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.mkdir(path.join(source, 'scripts'));
  await fs.mkdir(path.join(source, 'node_modules/example'), { recursive: true });
  await fs.writeFile(path.join(source, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(source, 'node_modules/example/index.js'), 'module.exports = 42');
  await fs.writeFile(path.join(source, 'src/server.mjs'), 'import value from "example"; console.log(value);');
  return { root, source, runtimeRoot: path.join(root, 'state/runtime'), serverPath: path.join(source, 'src/server.mjs') };
}

test('installed runtime starts independently after the original checkout is moved', async (t) => {
  const fixturePaths = await fixture(t);
  const runtime = await stageDaemonRuntime(fixturePaths);
  await fs.rename(fixturePaths.source, `${fixturePaths.source}-moved`);
  assert.equal((await fs.lstat(runtime.directory)).mode & 0o777, 0o700);
  const result = await promisify(execFile)(process.execPath, [runtime.serverPath], { cwd: runtime.directory });
  assert.equal(result.stdout.trim(), '42');
});

test('runtime snapshots dereference dependency links instead of retaining protected source paths', async (t) => {
  const fixturePaths = await fixture(t);
  const target = path.join(fixturePaths.source, 'node_modules/example');
  const external = path.join(fixturePaths.root, 'linked-package');
  await fs.rename(target, external);
  await fs.symlink(external, target);
  const runtime = await stageDaemonRuntime(fixturePaths);
  assert.equal((await fs.lstat(path.join(runtime.directory, 'node_modules/example'))).isSymbolicLink(), false);
});

test('runtime pruning retains current and one prior snapshot without deleting foreign data', async (t) => {
  const fixturePaths = await fixture(t);
  const older = await stageDaemonRuntime(fixturePaths);
  await fs.utimes(older.directory, new Date(0), new Date(0));
  const previous = await stageDaemonRuntime(fixturePaths);
  const current = await stageDaemonRuntime(fixturePaths);
  const stablePath = await publishDaemonRuntime(previous.directory);
  assert.equal(await fs.realpath(stablePath), await fs.realpath(previous.serverPath));
  assert.equal(await publishDaemonRuntime(current.directory), stablePath);
  assert.equal(await fs.realpath(stablePath), await fs.realpath(current.serverPath));
  const foreign = path.join(fixturePaths.runtimeRoot, 'build-foreign');
  await fs.mkdir(foreign);
  await pruneDaemonRuntimes(current.directory);
  await assert.rejects(fs.access(older.directory), { code: 'ENOENT' });
  for (const directory of [previous.directory, current.directory, foreign]) await fs.access(directory);
  await fs.unlink(path.join(fixturePaths.runtimeRoot, 'current'));
  await fs.mkdir(path.join(fixturePaths.runtimeRoot, 'current'));
  await assert.rejects(publishDaemonRuntime(current.directory), /unmanaged/);
});
