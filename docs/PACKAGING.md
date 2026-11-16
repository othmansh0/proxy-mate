# Public releases and versioning

Package: **`@othmansh01/proxy-mate`** on **npm**, with source and release assets at `othmansh0/proxy-mate`. GitHub Packages is no longer required. People install a published version with:

```bash
npx --yes @othmansh01/proxy-mate@latest init --client claude
```

The first public release candidate in this checkout is **0.9.0**. It is pre-1.0 software; keep the documented platform and capture limits visible. Preparing this checkout does not itself publish anything, change repository visibility or push a release tag.

## One-time owner setup

### 1. Make the source repository public

In GitHub, open this repository's **Settings → General → Danger Zone → Change repository visibility → Public**. This exposes Git history and Actions history/logs as well as the current files. Review those before confirming. The local readiness audit found no credentials with Gitleaks 8.30.1 across available Git history; that is a scanner result, not a guarantee about all past external logs or artifacts.

Enable private vulnerability reporting and review the existing [security policy](../SECURITY.md). Resolve or retest the account's Actions billing/spending restriction: hosted jobs previously could not start. The default branch is currently `develop`; a branch rename or promotion to `main` is not required for version-tagged releases.

### 2. Own the matching npm scope

Sign into the verified npm account **othmansh01**. The npm scope is `@othmansh01`; the GitHub repository owner remains `othmansh0`. Two-factor authentication was deferred by the owner on 16 November 2026. Complete any email or security verification npm requires for login or publication.

```bash
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
```

The identity must have publish access to `@othmansh01`. No GitHub package token is needed. If a previous private setup mapped this scope to GitHub, change it once:

```bash
npm config set @othmansh01:registry https://registry.npmjs.org --location=user
```

### 3. Bootstrap the npm package once

npm trusted publishing is configured on an existing package, so first publish the tested **0.9.0** artifact manually using your npm login and interactive npm verification. Use a clean checkout with a physical node_modules directory (not npm-linked dependencies) of the merged release-preparation commit and the **official Node 24.22.2 distribution** with npm 11.19.1, matching the pinned release publisher. Homebrew builds can ship a different compression library despite the same Node version. The builder also checks the publisher's zlib version and discards npm's regenerable hidden dependency-metadata cache so warm and cold installs include the same dependency files. Consumer installs continue to support Node 22+.

```bash
npm ci
npm run release:pack
npm run release:smoke
npm publish ./artifacts/release/othmansh01-proxy-mate-0.9.0.tgz --registry=https://registry.npmjs.org --access=public --tag=latest
```

This is the first public upload. Review `manifest.json`, `SHA256SUMS` and the tarball before publishing. The prepack hook removes regenerable node-gyp output containing absolute build paths; registry-provided Darwin prebuilds remain and are tested in the installed consumer. Do not upload capture files, local CA material, configuration backups or credentials. `release:pack` excludes those paths and bundles the audited runtime dependencies. A checked and already-built artifact may be published directly instead of rebuilding it.

The manual bootstrap does not claim CI provenance. Subsequent OIDC publications generate provenance from the public repository. npm versions are immutable: never replace an uploaded version with different bytes.

### 4. Configure tokenless npm trusted publishing

In npm: **Packages → @othmansh01/proxy-mate → Settings → Trusted publishing → GitHub Actions**. Set:

| Field | Value |
| --- | --- |
| Organization or user | `othmansh0` |
| Repository | `proxy-mate` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed actions | Allow direct `npm publish` |

The public repository already has the **npm** GitHub environment and an active `v*` tag ruleset restricting tag creation, updates and deletion to repository administrators (verified 16 November 2026). Private vulnerability reporting is enabled. Add a required environment reviewer if owner approval before uploads is desired. Do not add an `NPM_TOKEN` secret: the workflow uses GitHub OIDC and `id-token: write`.

A new npm trusted-publisher configuration must complete a successful OIDC publish within two days. An identical-version retry that skips npm upload does not test that authentication. Verify it with the next actual version publication before the configuration expires; if it expires, recreate it.

### 5. Create the first GitHub release

Tag the exact merged commit whose package and changelog are version 0.9.0:

```bash
git tag -a v0.9.0 -m "Release 0.9.0"
git push origin v0.9.0
```

The `Public release` workflow runs the complete suite on Node 22/24/26 on Apple Silicon plus Node 24 on Intel. It audits dependencies, validates the tag/checkout/version, builds the package and smoke-tests an offline consumer. After qualification and the `npm` environment gate, it publishes via OIDC and creates a GitHub release with the tarball, `SHA256SUMS`, manifest and changelog notes.

For the manually bootstrapped 0.9.0 version, it skips npm upload only when the registry's integrity exactly matches the built artifact. A mismatch fails instead of overwriting anything; investigate and release a new version. This initial skip does not validate OIDC. The next new version must be published successfully to validate the trusted publisher.

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
