import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
if (pkg.name !== '@othmansh0/proxy-mcp' || pkg.publishConfig?.registry !== 'https://npm.pkg.github.com'
  || pkg.publishConfig?.access !== 'restricted' || process.env.npm_config_access === 'public') {
  throw new Error('This package may only publish to private GitHub Packages with restricted access.');
}
if (pkg.private || !Array.isArray(pkg.bundleDependencies)
  || [...Object.keys(pkg.dependencies), ...Object.keys(pkg.optionalDependencies ?? {})].some((name) => !pkg.bundleDependencies.includes(name)) || pkg.version !== lock.version
  || pkg.name !== lock.name || pkg.version !== lock.packages?.['']?.version) {
  throw new Error('Package identity, lockfile and bundled dependencies must be prepared before publishing.');
}
for (const file of ['src/index.mjs', 'src/index.d.ts', 'src/client.mjs', 'src/server.mjs', 'README.md']) {
  await fs.access(path.join(root, file));
}
for (const dependency of Object.keys(pkg.dependencies)) {
  const installed = JSON.parse(await fs.readFile(path.join(root, 'node_modules', dependency, 'package.json'), 'utf8'));
  if (installed.version !== lock.packages?.[`node_modules/${dependency}`]?.version) {
    throw new Error(`Run npm ci before publishing: ${dependency} differs from the audited lockfile.`);
  }
}
console.log(`Verified ${pkg.name}@${pkg.version}: GitHub Packages, restricted access, bundled runtime dependencies.`);
