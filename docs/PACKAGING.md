# Public releases and versioning

Package: **`@othmansh01/proxy-mate`** on **npm**, with source and release assets at `othmansh0/proxy-mate`. GitHub Packages is no longer required. People install a published version with:

```bash
npx --yes @othmansh01/proxy-mate@latest init --client claude
```

The first public release is **0.9.0**, published on 16 November 2026. It is pre-1.0 software; keep the documented platform and capture limits visible. Building a checkout does not publish it; new releases use the version-tagged workflow below.

## One-time owner setup

### 1. Make the source repository public

The repository is public, including Git history and Actions history/logs. The local readiness audit found no detected credentials across available Git history; that is a scanner result, not a guarantee about all past external logs or artifacts.

Private vulnerability reporting is enabled; see the [security policy](../SECURITY.md). Hosted Actions now run successfully after the earlier account restriction. The default branch is `develop`; promotion to `main` is not required for version-tagged releases.

### 2. Own the matching npm scope

Sign into the verified npm account **othmansh01**. The npm scope is `@othmansh01`; the GitHub repository owner remains `othmansh0`. Two-factor authentication is enabled for authentication and writes. Complete npm's passkey/security-key approval for owner operations when requested.

```bash
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
```

The identity must have publish access to `@othmansh01`. No GitHub package token is needed. If a previous private setup mapped this scope to GitHub, change it once:

```bash
npm config set @othmansh01:registry https://registry.npmjs.org --location=user
```

### 3. Bootstrap the npm package once

The manual **0.9.0** bootstrap is complete. Its registry integrity matches the qualified artifact, and installation from npm without credentials passed. To reproduce a qualified artifact, use a clean checkout with a physical node_modules directory (not npm-linked dependencies) and the **official Node 24.22.2 distribution** with npm 11.19.1, matching the pinned release publisher. Homebrew builds can ship a different compression library despite the same Node version. The builder also checks the publisher's zlib version and discards npm's regenerable hidden dependency-metadata cache so warm and cold installs include the same dependency files. Consumer installs continue to support Node 22+.

```bash
npm ci
npm run release:pack
npm run release:smoke
```

Review `manifest.json`, `SHA256SUMS` and the tarball before releasing. The prepack hook removes regenerable node-gyp output containing absolute build paths; registry-provided Darwin prebuilds remain and are tested in the installed consumer. Do not upload capture files, local CA material, configuration backups or credentials. `release:pack` excludes those paths and bundles the audited runtime dependencies.

The manual bootstrap does not claim CI provenance. Subsequent OIDC publications generate provenance from the public repository. npm versions are immutable: never replace an uploaded version with different bytes.

npm can accept an upload before the version becomes installable while [publish-time malware scanning](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/) runs. The release publisher waits up to 15 minutes for version metadata and then verifies the exact name, version and integrity. It retries metadata reads only. Registry errors and integrity mismatches fail immediately. Scanning can exceed that deadline; rerun the existing tagged workflow after the version becomes available rather than uploading different bytes.

### 4. Configure tokenless npm trusted publishing

The production trusted publisher is configured and was validated by the 0.9.1 publication. Its settings in **Packages → @othmansh01/proxy-mate → Settings → Trusted publishing → GitHub Actions** are:

| Field | Value |
| --- | --- |
| Organization or user | `othmansh0` |
| Repository | `proxy-mate` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed actions | Allow direct `npm publish` |

If a new configuration is needed, the same grant can be created with npm CLI 11.19.1, followed by its interactive 2FA approval:

```bash
npm trust github @othmansh01/proxy-mate --file=release.yml --repo=othmansh0/proxy-mate --env=npm --allow-publish --yes --registry=https://registry.npmjs.org/
```

The public repository already has the **npm** GitHub environment and an active `v*` tag ruleset restricting tag creation, updates and deletion to repository administrators (verified 16 November 2026). Private vulnerability reporting is enabled. Add a required environment reviewer if owner approval before uploads is desired. Do not add an `NPM_TOKEN` secret: the workflow uses GitHub OIDC and `id-token: write`.

A new npm trusted-publisher configuration must complete a successful OIDC publish within two days. An identical-version retry that skips npm upload does not test that authentication. Verify it with the next actual version publication before the configuration expires; if it expires, recreate it.

### 5. Create the first GitHub release

The annotated `v0.9.0` tag points to the accepted bootstrap commit `aebc999`. Preserve it. Create later version tags with `npm version` as described below.

The `Public release` workflow runs the complete suite on Node 22/24/26 on Apple Silicon plus Node 24 on Intel. It audits dependencies, validates the tag/checkout/version, builds the package and smoke-tests an offline consumer. After qualification and the `npm` environment gate, it publishes via OIDC and creates a GitHub release with the tarball, `SHA256SUMS`, manifest and changelog notes.

For the manually bootstrapped 0.9.0 version, it skipped npm upload only when the registry's integrity exactly matched the built artifact. A mismatch fails instead of overwriting anything; investigate and release a new version. That initial skip did not validate OIDC; version 0.9.1 performed the first successful OIDC publication.

If a later step fails after npm publication, rerun `release.yml` with its existing tag. It accepts only the identical uploaded npm artifact and completes the GitHub release. Published GitHub releases are preserved; draft assets can be completed before publication. GitHub immutable releases may be enabled after this flow is verified.

## Future releases

1. Add a useful note under `## Unreleased` while making changes, then commit/merge them.
2. From a clean checkout of the accepted release commit, choose a SemVer bump:

```bash
npm version patch -m "Release %s"
git push origin HEAD --follow-tags
```

`npm version` updates `package.json` and `package-lock.json`. Its version hook promotes the committed Unreleased notes and includes the changelog in the version commit; npm creates an annotated `vX.Y.Z` tag. The runtime reads its version from the package manifest, so no source constant needs editing.

Use `minor` for new capability. Before 1.0, use a minor bump for incompatible API changes; publish a major bump for breaking changes from 1.0 onward. Never move a released tag. A new npm version is required for every changed artifact.

For a candidate release:

```bash
npm version prerelease --preid=rc -m "Release %s"
git push origin HEAD --follow-tags
```

Each bump requires committed Unreleased notes. A version such as `0.10.0-rc.1` gets npm's **next** tag and a GitHub prerelease; a version without a prerelease suffix gets **latest**. Prereleases cannot silently replace latest. Test a candidate explicitly with `npx --yes @othmansh01/proxy-mate@next init --client claude`.

## What is automated, and what is not

Release qualification and publishing are implemented in `.github/workflows/release.yml`. First account login, repository visibility, npm scope ownership, trusted-publisher configuration, environment review and release-tag creation are owner actions. A local test run is not a hosted CI result, and a local tarball is not proof of registry publication.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm scope/public publication](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/), [GitHub repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).
