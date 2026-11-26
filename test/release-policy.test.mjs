import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseVersion, checkManifest, checkReleaseToolchain, notesForVersion, promoteUnreleased, publishedArtifactMatches } from '../scripts/lib/release-policy.mjs';

test('release builds require the publisher compression toolchain as well as matching version numbers', () => {
  const official = { node: '24.22.2', zlib: '1.3.2.1-motley-285e94b' };
  assert.doesNotThrow(() => checkReleaseToolchain(official, '11.19.1'));
  for (const [versions, npm] of [
    [{ ...official, node: '22.23.4' }, '11.19.1'],
    [{ ...official, zlib: '1.2.12' }, '11.19.1'],
    [{ node: official.node }, '11.19.1'],
    [official, '11.19.0'],
  ]) assert.throws(() => checkReleaseToolchain(versions, npm), /official Node 24.22.2/);
});

function manifests(version = '0.9.0') {
  const pkg = { name: 'proxyfan', version, publishConfig: { registry: 'https://registry.npmjs.org', access: 'public' },
    dependencies: { required: '1.0.0' }, optionalDependencies: { optional: '1.0.0' }, bundleDependencies: ['required', 'optional'] };
  const lock = { name: pkg.name, version, packages: { '': { name: pkg.name, version } } };
  return { pkg, lock };
}

test('canonical release versions route prereleases away from latest and reject unsafe tags', () => {
  assert.deepEqual(releaseVersion('0.9.0'), { version: '0.9.0', gitTag: 'v0.9.0', npmTag: 'latest', prerelease: false });
  assert.equal(releaseVersion('0.10.0-rc.1').npmTag, 'next');
  for (const version of ['v0.9.0', '01.0.0', '0.9.0-rc.01', '0.9.0+build', '0.9.0;echo secret', '../0.9.0']) {
    assert.throws(() => releaseVersion(version));
  }
  const { pkg, lock } = manifests('0.10.0-rc.1');
  assert.throws(() => checkManifest(pkg, lock), /Prereleases/);
  assert.equal(checkManifest(pkg, lock, { tag: 'next' }).prerelease, true);
});

test('public releases cannot silently switch registry, access, lock or dependency bundle', () => {
  const { pkg, lock } = manifests();
  assert.equal(checkManifest(pkg, lock).npmTag, 'latest');
  assert.throws(() => checkManifest({ ...pkg, name: '@othmansh01/proxyfan' }, lock), /public npm/);
  assert.throws(() => checkManifest(pkg, lock, { registry: 'https://npm.pkg.github.com' }), /public npm/);
  assert.throws(() => checkManifest(pkg, lock, { access: 'restricted' }), /public npm/);
  assert.throws(() => checkManifest({ ...pkg, bundleDependencies: ['required'] }, lock), /bundled dependencies/);
  assert.throws(() => checkManifest(pkg, { ...lock, version: '0.8.3' }), /synchronize/);
  assert.throws(() => checkManifest(pkg, { ...lock, packages: { '': { ...lock.packages[''], name: '@othmansh01/proxyfan' } } }), /synchronize/);
});

test('version hooks promote committed Unreleased notes and preserve historical entries', () => {
  const old = '# Changelog\n\n## Unreleased\n\n- New capability.\n\n## 0.9.0 — 2026-11-12\n\n- Existing release.\n';
  const updated = promoteUnreleased(old, '0.9.1', '2026-11-13');
  assert.match(updated, /## Unreleased\n\n## 0\.9\.1 — 2026-11-13/);
  assert.equal(notesForVersion(updated, '0.9.1'), '- New capability.\n');
  assert.equal(notesForVersion(updated, '0.9.0'), '- Existing release.\n');
  assert.throws(() => promoteUnreleased(updated, '0.9.2', '2026-11-14'), /Add and commit/);
  assert.throws(() => promoteUnreleased(updated, '0.9.1', '2026-11-13'), /already/);
  assert.throws(() => notesForVersion(updated, '1.0.0'), /Missing/);
});

test('retrying a release accepts only the identical already-published npm artifact', () => {
  const manifest = { name: 'proxyfan', version: '0.9.0', integrity: 'sha512-fixture' };
  assert.equal(publishedArtifactMatches({ ...manifest, dist: { integrity: manifest.integrity } }, manifest), true);
  assert.throws(() => publishedArtifactMatches({ ...manifest, dist: { integrity: 'sha512-different' } }, manifest), /different artifact/);
});
