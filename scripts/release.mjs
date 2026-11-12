import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { checkManifest, releaseVersion, notesForVersion, promoteUnreleased, publishedArtifactMatches } from './lib/release-policy.mjs';

const execute = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'artifacts/release');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const pkg = await readJson(path.join(root, 'package.json'));
const lock = await readJson(path.join(root, 'package-lock.json'));
const release = checkManifest(pkg, lock, { tag: releaseVersion(pkg.version).npmTag });
const changelog = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');

async function artifactManifest() {
  const manifest = await readJson(path.join(output, 'manifest.json'));
  if (manifest.name !== pkg.name || manifest.version !== pkg.version || manifest.npmTag !== release.npmTag
    || !manifest.filename || path.basename(manifest.filename) !== manifest.filename) {
    throw new Error('Artifact manifest does not match this package release. Run release:pack again.');
  }
  return manifest;
}

async function run(command, args, options = {}) {
  return execute(command, args, { cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options });
}

async function npm(args, options = {}) {
  return process.env.npm_execpath
    ? run(process.execPath, [process.env.npm_execpath, ...args], options)
    : run('npm', args, options);
}

async function validate() {
  await run(process.execPath, ['scripts/check-package.mjs'], { env: { ...process.env, npm_config_tag: release.npmTag } });
  notesForVersion(changelog, pkg.version);
  const tag = process.env.RELEASE_TAG;
  if (tag) {
    if (tag !== release.gitTag) throw new Error(`Tag ${tag} does not match package version ${release.gitTag}.`);
    const tagged = (await run('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`])).stdout.trim();
    const current = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
    if (tagged !== current) throw new Error('Release checkout must be the exact tagged commit.');
    await run('git', ['diff', '--exit-code', 'HEAD', '--']);
  }
}

async function pack() {
  if (process.versions.node !== '24.22.2' || (await npm(['--version'])).stdout.trim() !== '11.19.1') {
    throw new Error('Reproducible release builds require Node 24.22.2 and npm 11.19.1. Consumer installs still support Node 22+.');
  }
  await validate();
  await fs.mkdir(output, { recursive: true });
  const packed = JSON.parse((await npm(['pack', '--json', '--pack-destination', output])).stdout)[0];
  if (path.basename(packed.filename) !== packed.filename) throw new Error('Unexpected tarball filename.');
  const tarball = path.join(output, packed.filename);
  const bytes = await fs.readFile(tarball);
  const contents = (await run('/usr/bin/tar', ['-tzf', tarball])).stdout.split('\n');
  if (contents.some((name) => /^package\/(?:\.git\/|\.env(?:[./]|$)|\.proxy-mcp\/|test\/|artifacts\/|\.npmrc$)/.test(name)
    || /\.(?:bak|key|pem|har|jsonl)$/.test(name) && !name.startsWith('package/node_modules/'))) {
    throw new Error('The package contains excluded development or capture data.');
  }
  if (!contents.includes('package/src/index.d.ts') || !packed.bundled?.includes('better-sqlite3')) throw new Error('Missing API types or bundled SQLite driver.');
  const manifest = { name: pkg.name, version: pkg.version, filename: packed.filename, npmTag: release.npmTag,
    integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  if (manifest.integrity !== packed.integrity) throw new Error('Packed integrity mismatch.');
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'SHA256SUMS'), `${manifest.sha256}  ${manifest.filename}\n`);
  await fs.writeFile(path.join(output, 'release-notes.md'), notesForVersion(changelog, pkg.version));
  console.log(JSON.stringify(manifest));
}

async function smoke() {
  const manifest = await artifactManifest();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-package-smoke-'));
  try {
    await fs.writeFile(path.join(temporary, 'package.json'), JSON.stringify({ name: 'proxy-package-smoke', version: '1.0.0', type: 'module', private: true }));
    await npm(['install', '--offline', '--ignore-scripts', '--no-fund', '--no-audit', path.join(output, manifest.filename)], { cwd: temporary });
    const packageRoot = path.join(temporary, 'node_modules/@othmansh0/proxy-mcp');
    const installed = await readJson(path.join(packageRoot, 'package.json'));
    if (installed.version !== manifest.version) throw new Error('Consumer installed a different package version.');
    await fs.access(path.join(packageRoot, 'src/index.d.ts'));
    const probe = `import assert from 'node:assert/strict'; import {createProxyClient} from '@othmansh0/proxy-mcp'; const c=createProxyClient({home:process.env.PROXY_MCP_HOME,readyTimeoutMs:0}); await assert.rejects(c.callTool('get_proxy_status'),{code:'DAEMON_UNAVAILABLE'});`;
    const env = { ...process.env, PROXY_MCP_HOME: path.join(temporary, 'unused-state') };
    await run(process.execPath, ['--input-type=module', '-e', probe], { cwd: temporary, env });
    const nativeProbe = `import {createRequire} from 'node:module'; const require=createRequire(process.env.PROXY_PACKAGE_MANIFEST); const Database=require('better-sqlite3'); const db=new Database(':memory:'); if(db.prepare('SELECT 1 AS ok').get().ok!==1)throw new Error('Native binding failed'); db.close();`;
    await run(process.execPath, ['--input-type=module', '-e', nativeProbe], {
      cwd: temporary, env: { ...env, PROXY_PACKAGE_MANIFEST: path.join(packageRoot, 'package.json') },
    });
    const preview = JSON.parse((await run(process.execPath, [path.join(packageRoot, 'src/server.mjs'), 'init', '--dry-run', '--client', 'json'], { cwd: temporary, env })).stdout);
    if (preview.status !== 'preview') throw new Error('Installed CLI preview failed.');
    try { await fs.access(env.PROXY_MCP_HOME); throw new Error('Preview created capture state.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    console.log('Packed CLI, ESM API, declarations, native SQLite and offline installation passed; no capture state created.');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

async function registryVersion() {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm metadata lookup failed (${response.status}); do not assume the version is absent.`);
  return response.json();
}

async function publish() {
  await validate();
  const manifest = await artifactManifest();
  const bytes = await fs.readFile(path.join(output, manifest.filename));
  if (`sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` !== manifest.integrity) throw new Error('Release tarball changed after verification.');
  const existing = await registryVersion();
  if (existing) {
    publishedArtifactMatches(existing, manifest);
    console.log('This exact artifact is already on npm; continuing the interrupted release.');
  } else {
    await npm(['publish', path.join(output, manifest.filename), '--registry=https://registry.npmjs.org', '--access=public', '--tag', release.npmTag, '--provenance'], { timeout: 180_000 });
    const published = await registryVersion();
    if (!published) throw new Error('npm publication returned but is not visible yet; retry the workflow to verify it.');
    publishedArtifactMatches(published, manifest);
  }
}

async function githubRelease() {
  await validate();
  const manifest = await artifactManifest();
  publishedArtifactMatches(await registryVersion() ?? {}, manifest);
  let existing;
  try { existing = JSON.parse((await run('gh', ['release', 'view', release.gitTag, '--json', 'isDraft,assets'])).stdout); }
  catch {
    await run('gh', ['release', 'create', release.gitTag, '--draft', '--verify-tag', '--title', release.gitTag,
      '--notes-file', path.join(output, 'release-notes.md'), ...(release.prerelease ? ['--prerelease'] : [])]);
    existing = { isDraft: true };
  }
  if (!existing.isDraft) {
    const names = new Set((existing.assets ?? []).map((asset) => asset.name));
    if (![manifest.filename, 'SHA256SUMS', 'manifest.json'].every((name) => names.has(name))) {
      throw new Error('The published GitHub release is missing expected assets. Preserve it and inspect manually; no published assets were replaced.');
    }
    console.log('Published GitHub release is preserved.'); return;
  }
  await run('gh', ['release', 'upload', release.gitTag, path.join(output, manifest.filename), path.join(output, 'SHA256SUMS'), path.join(output, 'manifest.json'), '--clobber']);
  await run('gh', ['release', 'edit', release.gitTag, '--draft=false', ...(release.prerelease ? ['--prerelease'] : [])]);
}

const command = process.argv[2];
if (command === 'validate') { await validate(); console.log(`Release ${release.gitTag} validated (${release.npmTag}).`); }
else if (command === 'pack') await pack();
else if (command === 'smoke') await smoke();
else if (command === 'publish') await publish();
else if (command === 'github') await githubRelease();
else if (command === 'preversion') promoteUnreleased(changelog, '9999.0.0', new Date().toISOString().slice(0, 10));
else if (command === 'version') {
  await fs.writeFile(path.join(root, 'CHANGELOG.md'), promoteUnreleased(changelog, pkg.version, new Date().toISOString().slice(0, 10)));
  await run('git', ['add', 'CHANGELOG.md']);
} else throw new Error('Use validate, pack, smoke, publish, github, preversion or version.');
