import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Keep the registry-provided N-API prebuilds for both supported Mac CPUs.
// Discard node-gyp output: it can embed build paths/compiler differences and
// is unnecessary when those portable, lockfile-verified prebuilds are present.
const driver = path.join(root, 'node_modules/better-sqlite3');
for (const cpu of ['arm64', 'x64']) await fs.access(path.join(driver, 'prebuilds', `darwin-${cpu}.node`));
await fs.rm(path.join(driver, 'build'), { recursive: true, force: true });
