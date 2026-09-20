import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { STATE_DIR } from './config.mjs';

const markerName = '.proxy-runtime.json';

// launchd does not inherit an interactive terminal's Documents/Desktop privacy
// grants. Install an independent snapshot, including dependencies, under state.
// Never point a background service at a mutable developer worktree or symlink.
export async function stageDaemonRuntime({ serverPath, runtimeRoot = path.join(STATE_DIR, 'runtime') }) {
  const sourceRoot = path.dirname(path.dirname(path.resolve(serverPath)));
  await fs.access(path.join(sourceRoot, 'node_modules'));
  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(runtimeRoot, 'build-'));
  try {
    for (const name of ['src', 'scripts', 'node_modules', 'package.json']) {
      await fs.cp(path.join(sourceRoot, name), path.join(directory, name), { recursive: true, dereference: true });
    }
    await fs.access(path.join(directory, 'src/server.mjs'));
    await fs.writeFile(path.join(directory, markerName), JSON.stringify({ managed_by: 'proxy-mcp', version: 1, source: sourceRoot }), { mode: 0o600, flag: 'wx' });
    return { directory, serverPath: path.join(directory, 'src/server.mjs'), sourceRoot };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// Call only after the new service is healthy. Keep one prior snapshot for
// rollback; ignore symlinks and unmarked directories even under our own root.
export async function pruneDaemonRuntimes(currentDirectory) {
  const runtimeRoot = path.dirname(currentDirectory);
  const prior = [];
  for (const entry of await fs.readdir(runtimeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^build-[\w-]+$/.test(entry.name)) continue;
    const directory = path.join(runtimeRoot, entry.name);
    if (directory === currentDirectory) continue;
    try {
      const marker = JSON.parse(await fs.readFile(path.join(directory, markerName), 'utf8'));
      if (marker.managed_by !== 'proxy-mcp' || marker.version !== 1) continue;
      prior.push({ directory, modified: (await fs.stat(directory)).mtimeMs });
    } catch { /* not one of our completed snapshots */ }
  }
  prior.sort((a, b) => b.modified - a.modified);
  for (const entry of prior.slice(1)) await fs.rm(entry.directory, { recursive: true, force: true });
}

export async function publishDaemonRuntime(directory) {
  const current = path.join(path.dirname(directory), 'current');
  const existing = await fs.lstat(current).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing && !existing.isSymbolicLink()) throw new Error(`Refusing to replace unmanaged runtime path: ${current}`);
  const temporary = `${current}.${randomUUID()}.tmp`;
  try {
    await fs.symlink(path.basename(directory), temporary);
    await fs.rename(temporary, current);
  } finally { await fs.rm(temporary, { force: true }); }
  return path.join(current, 'src/server.mjs');
}
