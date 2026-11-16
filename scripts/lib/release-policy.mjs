export function releaseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version ?? '');
  if (!match || match[4]?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error('Use a canonical SemVer release such as 0.9.0 or 0.10.0-rc.1, without build metadata.');
  }
  return { version, gitTag: `v${version}`, npmTag: match[4] ? 'next' : 'latest', prerelease: Boolean(match[4]) };
}

export function checkReleaseToolchain(versions, npmVersion) {
  if (versions.node !== '24.22.2' || versions.zlib !== '1.3.2.1-motley-285e94b' || npmVersion !== '11.19.1') {
    throw new Error('Reproducible release builds require official Node 24.22.2 (zlib 1.3.2.1-motley-285e94b) and npm 11.19.1, matching GitHub Actions. Consumer installs still support Node 22+.');
  }
}

export function checkManifest(pkg, lock, { access, registry, tag } = {}) {
  if (pkg.name !== '@othmansh01/proxy-mate' || pkg.publishConfig?.registry !== 'https://registry.npmjs.org'
    || pkg.publishConfig?.access !== 'public' || pkg.private
    || access && access !== 'public' || registry && registry.replace(/\/$/, '') !== 'https://registry.npmjs.org') {
    throw new Error('Publish @othmansh01/proxy-mate only to public npm with --access public.');
  }
  const release = releaseVersion(pkg.version);
  if (release.prerelease && (tag ?? pkg.publishConfig.tag ?? 'latest') === 'latest') {
    throw new Error('Prereleases must use --tag next; never replace latest with a prerelease.');
  }
  if (pkg.name !== lock.name || pkg.version !== lock.version || pkg.version !== lock.packages?.['']?.version
    || !Array.isArray(pkg.bundleDependencies)
    || [...Object.keys(pkg.dependencies), ...Object.keys(pkg.optionalDependencies ?? {})].some((name) => !pkg.bundleDependencies.includes(name))) {
    throw new Error('Run npm ci and synchronize the manifest, lockfile and bundled dependencies before release.');
  }
  return release;
}

export function notesForVersion(changelog, version) {
  const heading = `## ${version} `;
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) throw new Error(`Missing changelog section for ${version}.`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const notes = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  if (!notes) throw new Error(`Changelog notes for ${version} are empty.`);
  return notes + '\n';
}

export function promoteUnreleased(changelog, version, date) {
  releaseVersion(version);
  if (changelog.split('\n').some((line) => line.startsWith(`## ${version} `))) throw new Error(`Version ${version} already has release notes.`);
  const match = /^## Unreleased\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(changelog);
  if (!match || !match[1].trim()) throw new Error('Add and commit changelog notes under ## Unreleased before npm version.');
  return changelog.slice(0, match.index) + `## Unreleased\n\n## ${version} — ${date}\n\n${match[1].trim()}\n\n` + changelog.slice(match.index + match[0].length);
}

export function publishedArtifactMatches(metadata, manifest) {
  if (metadata.name !== manifest.name || metadata.version !== manifest.version || metadata.dist?.integrity !== manifest.integrity) {
    throw new Error('This npm version already exists with a different artifact. Never overwrite or move its tag; publish a new version.');
  }
  return true;
}

export async function waitForPublishedArtifact(readVersion, manifest, {
  timeoutMs = 15 * 60_000, intervalMs = 10_000, now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onPending = () => {},
} = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const metadata = await readVersion();
    if (metadata) {
      publishedArtifactMatches(metadata, manifest);
      return metadata;
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`npm accepted the upload but ${manifest.name}@${manifest.version} is not visible by the verification deadline. Rerun this tagged workflow after the version becomes available; never overwrite an uploaded version.`);
    onPending();
    await wait(Math.min(intervalMs, remaining));
  }
}
