# Private package releases

Package: `@othmansh0/proxy-mcp` at `https://npm.pkg.github.com`, linked to `othmansh0/proxy-mcp`. Source remains MIT licensed; package access is managed separately in GitHub Packages. Do not publish this package to the public npm registry.

## What ships

The CLI, thin MCP bridge, ESM client API, TypeScript declarations, scripts and documentation ship together. Runtime dependencies are bundled from the audited lockfile. npm does not honor an installed library's root dependency overrides, so bundling preserves the tested dependency versions for consumers. There are no automatic install/postinstall hooks that start capture, install services or change certificate trust.

`init` explicitly installs a private immutable runtime snapshot and registers a client. That snapshot survives npm-cache eviction and source checkout changes.

## Prepare a release

1. Update the version in `package.json`, `package-lock.json` and `src/lib/config.mjs`, and record changes in the changelog.
2. Run `npm ci`, `npm run check`, the fallback storage check and `npm audit --omit=dev` on macOS. Run the Node 22/24/26 matrix when changing executable code.
3. Run `node scripts/check-private-package.mjs`, then `npm pack`. Test the actual tarball in an empty consumer project, including the import API and `proxy-mcp init --dry-run --client json`.
4. Review the packed contents. Local capture state, `.npmrc` credentials, tests, Git metadata and developer backups must be absent.

The publish guard enforces the package identity, restricted access, GitHub registry and audited bundled dependencies. `private: true` is deliberately absent: npm uses that flag to prohibit all publishing, including publishing to a private registry. Privacy comes from the restricted registry package and its GitHub access settings.

## Publish

The `Publish private package` workflow uses `GITHUB_TOKEN` with `packages: write`, after tests and an audit. It runs for `private-v*` tags and can be dispatched once the workflow is available on the repository's default branch. Merging into `develop` alone does not publish a package or promote `main`. GitHub account runner/billing restrictions can prevent this workflow from starting.

For a maintainer publishing locally, authenticate to the scoped registry with a personal access token (classic) containing `write:packages` (which includes package read permission), then run:

```bash
npm publish --registry=https://npm.pkg.github.com --access=restricted
```

Enter tokens through npm's password prompt or a private temporary npm configuration. Never commit tokens, pass them as command arguments, or put them in MCP client configuration. A normal GitHub CLI login with only repository permissions cannot publish packages.

GitHub Packages creates new npm packages as private by default. After the first publish, verify the package's visibility is **Private** and grant intended team members read access in GitHub package settings. Do not change visibility to Public. A repository link does not replace an explicit access review; package permissions and source visibility are distinct.

Verify the published version with `npm view @othmansh0/proxy-mcp version` under an authorized package reader, then test the README's exact `npx` command. A local tarball test is not proof of registry publication or another person's access.

Upstream references: [GitHub npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry), [package access and visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility), [npm bundled dependencies](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#bundledependencies).
