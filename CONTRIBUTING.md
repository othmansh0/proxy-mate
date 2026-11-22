# Contributing

Contributions are welcome. Use macOS with a maintained Node.js 22, 24 or 26 LTS release and full Xcode for Simulator-specific tests.

```bash
npm ci
npm run check
```

Keep changes production-safe: preserve redaction defaults, avoid shell command construction, authorize filesystem paths, bind control services to loopback unless the user explicitly requests LAN access, and never add Simulator-erasing or keychain-reset behavior. New MCP tools must be added to the central registry with an input schema, output schema, all four behavior annotations, structured errors, and focused tests. Public response changes must retain the `schema_version: "1.0"` envelope. Refreshed bridges use compact canonical data; compatibility aliases remain available with `PROXYFAN_LEGACY_OUTPUT=1` throughout the 1.x contract period.

When a change depends on Mockttp, the MCP TypeScript SDK, Xcode, or `simctl`, verify the current upstream documentation. Include tests for success, invalid input, sensitive-data handling, and cleanup. Run the full suite before submitting a pull request.

## Branches and releases

`main` is the release baseline. `develop` is the integration branch used for local qualification and owner testing. Start short-lived `feature/`, `fix/` or `chore/` branches from `develop`, use isolated worktrees for concurrent work, and merge reviewed changes back into `develop` after checks pass. Push integration work to `develop`; promote `develop` into `main` only after Othman accepts the test build. Never force-push shared branch history.

The 8 November setup preserves the previous local main tip as `archive/local-main-before-develop-20261108`. Earlier unpushed hardening commits are reachable from `develop`; remote `main` stays at its existing baseline until testing is accepted. A local runtime install is separate from Git publication: reinstall after executable/dependency changes and compare the runtime fingerprint. MCP clients use the stable installed `src/client.mjs` entry.

## Public npm releases

Distribution uses `@othmansh01/proxyfan` on npm. Follow [Releases and versioning](docs/PACKAGING.md). Add a concise note under `## Unreleased` for user-facing changes. After merging and committing those notes, `npm version patch`, `minor` or an explicit prerelease updates the package/lock, promotes the changelog notes and creates the version commit/tag. Runtime version comes from package.json. Push the commit and annotated tag to run release qualification and OIDC publishing.

Keep runtime dependencies bundled from the audited lockfile and smoke-test the actual tarball in a clean consumer. Publishing requires the configured npm trusted publisher and GitHub environment; do not add an npm automation token to repository secrets. Merging to develop alone does not publish a package or promote main.
