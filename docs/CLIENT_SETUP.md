# MCP client setup

Start with the [README quick start](../README.md). `npx --yes proxyfan@latest init --client CLIENT` installs the shared service and connects a client.

## Automatic registration

- `claude`: updates the top-level `mcpServers.proxyfan` in `~/.claude.json`. With `CLAUDE_CONFIG_DIR`, uses `.claude.json` inside that directory. This is Claude Code's user scope.
- `cursor`: updates `~/.cursor/mcp.json`.
- `claude-desktop`: updates `~/Library/Application Support/Claude/claude_desktop_config.json`.
- `codex`: runs the installed Codex CLI's `mcp add` command. The CLI manages its own TOML format and supports its normal configuration directory.
- `json`: installs/reuses the service and prints a `mcpServers` object for manual registration.

Existing JSON files are validated before service installation. Setup replaces only the `proxyfan` entry, preserves other servers/settings, follows existing configuration-file symlinks, and stores private backups under `~/.proxyfan/setup-backups`. Invalid JSON is preserved. If a client uses JSON with comments, use `--client json` and edit its configuration through that client.

Registration affects future client connections. Reconnect an existing MCP session once; setup does not kill agent processes.

## Preview

```bash
npx --yes proxyfan@latest init --client claude --dry-run
```

Preview reads service/configuration metadata but writes no service, certificate, routing or client files. It shows whether setup would install, reuse or upgrade the service and the exact local command/configuration.

## Manual clients

```bash
npx --yes proxyfan@latest init --client json
```

Copy the returned `client.config.mcpServers` into your client's MCP settings. Both the Node executable and bridge path are absolute. No GitHub token belongs in the MCP configuration: public npm packages need no registry authentication. The installed runtime works independently of the source checkout or npm cache.

`PROXYFAN_HOME` can select a separate state directory before running setup. Registration records that absolute path so the daemon and client use the same state. Each state directory has one capture owner; ordinary agents should share the default installed service.

## Existing services and updates

Plain `init` reuses a healthy service, including one running an older version, without interrupting capture. If the package is newer, it prints an update instruction. After stopping capture and finishing its task, use `init --upgrade --client CLIENT` to replace the installed runtime. The upgrade acquires a task lease, checks active capture again and refuses active routing/app capture, pauses, foreign leases or reverse listeners.

Installation can succeed while client registration fails, for example if a client config is malformed or its CLI fails. Correct the client error and rerun `init`; the healthy service is reused. Backups are retained for manual recovery and are not uploaded.

Upstream configuration references: [Claude Code MCP](https://code.claude.com/docs/en/mcp-quickstart), [Codex MCP](https://developers.openai.com/codex/mcp/).

Automatic upgrades preserve proxy/control ports, textual capture policy and TLS passthrough. Services using custom CA files, upstream chaining, raw storage or remote access require the advanced `install` command with those explicit settings; `init` refuses to reset them to defaults.

## Migrate from private GitHub Packages

For the former package name, first read [Migrate from proxy-mcp](#migrate-from-proxy-mcp).

ProxyFan installs from the public npm registry under the unscoped name `proxyfan`. If your default npm registry points elsewhere, set the public registry for this command:

```bash
npm_config_registry=https://registry.npmjs.org npx --yes proxyfan@latest init --client claude
```



<a id="migrate-from-proxy-mcp"></a>

## Migrate from Proxy Mate

For any previous release, including `@othmansh01/proxyfan`, install ProxyFan during an idle capture window.

```bash
npx --yes proxyfan@latest init --upgrade --client claude
```

Finish active capture before upgrading. Repeat plain `init --client CLIENT` for each additional client, then reconnect it. Setup replaces owned `proxy-mate` and `proxy-mcp` bridge entries with `proxyfan` and backs up the original configuration. A custom server using the former key is preserved; remove it manually if it is an obsolete installation. New installs use `~/.proxyfan`; existing installs reuse `~/.proxy-mcp` or `~/.proxy-mate` in place, preserving the CA, SQLite sessions and absolute captured-body paths. Do not move or copy a live state directory. Backups remain under the selected state directory's `setup-backups`.

Use `PROXYFAN_*` environment variables for new configuration. Every former `PROXY_MATE_*` or `PROXY_MCP_*` variable remains accepted, with the new name taking precedence when both are set. Installed service environments use the new names. `PROXYFAN_HOME` explicitly selects a different root; it does not migrate existing data. The `proxy-mate` and `proxy-mcp` executables remain aliases within the new package.

Old `proxy-mate://` and `proxy-mcp://` resource links and subscriptions still work. New links use `proxyfan://`. Session exports, plugin catalogs and WebSocket snapshots/transcripts accept both prior names and write the new format identifiers. Existing certificates retain their original subject until you explicitly rotate the CA. The daemon accepts already connected pre-rename bridges; reconnect clients to get the new branding and compact tool results.

GitHub source and releases now live at [othmansh0/proxyfan](https://github.com/othmansh0/proxyfan). Update existing clones with `git remote set-url origin https://github.com/othmansh0/proxyfan.git`. The npm package is a new identity: an old package installation will not automatically update to the new name. Maintainers must configure npm trusted publishing for repository `proxyfan` as described in [packaging](PACKAGING.md).
