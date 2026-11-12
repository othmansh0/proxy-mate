import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkManifest } from './lib/release-policy.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const release = checkManifest(pkg, lock, { access: process.env.npm_config_access, registry: process.env.npm_config_registry, tag: process.env.npm_config_tag });
let modules;
try { modules = await fs.lstat(path.join(root, 'node_modules')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (modules?.isSymbolicLink()) throw new Error('Run npm ci in this checkout before publishing: symlinked node_modules cannot be bundled reliably.');
for (const file of ['src/index.mjs', 'src/index.d.ts', 'src/client.mjs', 'src/server.mjs', 'README.md']) await fs.access(path.join(root, file));
for (const name of [...Object.keys(pkg.dependencies), ...Object.keys(pkg.optionalDependencies ?? {})]) {
  if ((await fs.lstat(path.join(root, 'node_modules', name))).isSymbolicLink()) throw new Error(`Run npm ci: linked dependency ${name} cannot be bundled reliably.`);
  const installed = JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
  if (installed.version !== lock.packages?.[`node_modules/${name}`]?.version) throw new Error(`Run npm ci: ${name} differs from the audited lockfile.`);
}
console.log(`Verified ${pkg.name}@${release.version}: public npm, bundled audited dependencies, ${release.npmTag} channel.`);
