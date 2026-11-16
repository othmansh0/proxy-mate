# MCP client setup

Start with the [README quick start](../README.md). `npx --yes @othmansh01/proxy-mate@latest init --client CLIENT` installs the shared service and connects a client.

## Automatic registration

- `claude`: updates the top-level `mcpServers.proxy-mate` in `~/.claude.json`. With `CLAUDE_CONFIG_DIR`, uses `.claude.json` inside that directory. This is Claude Code's user scope.
- `cursor`: updates `~/.cursor/mcp.json`.
- `claude-desktop`: updates `~/Library/Application Support/Claude/claude_desktop_config.json`.
- `codex`: runs the installed Codex CLI's `mcp add` command. The CLI manages its own TOML format and supports its normal configuration directory.
- `json`: installs/reuses the service and prints a `mcpServers` object for manual registration.

Existing JSON files are validated before service installation. Setup replaces only the `proxy-mate` entry, preserves other servers/settings, follows existing configuration-file symlinks, and stores private backups under `~/.proxy-mate/setup-backups`. Invalid JSON is preserved. If a client uses JSON with comments, use `--client json` and edit its configuration through that client.

Registration affects future client connections. Reconnect an existing MCP session once; setup does not kill agent processes.

## Preview

```bash
npx --yes @othmansh01/proxy-mate@latest init --client claude --dry-run
```

Preview reads service/configuration metadata but writes no service, certificate, routing or client files. It shows whether setup would install, reuse or upgrade the service and the exact local command/configuration.

## Manual clients

```bash
npx --yes @othmansh01/proxy-mate@latest init --client json
```

Copy the returned `client.config.mcpServers` into your client's MCP settings. Both the Node executable and bridge path are absolute. No GitHub token belongs in the MCP configuration: public npm packages need no registry authentication. The installed runtime works independently of the source checkout or npm cache.

`PROXY_MATE_HOME` can select a separate state directory before running setup. Registration records that absolute path so the daemon and client use the same state. Each state directory has one capture owner; ordinary agents should share the default installed service.

## Existing services and updates

Plain `init` reuses a healthy service, including one running an older version, without interrupting capture. If the package is newer, it prints an update instruction. After stopping capture and finishing its task, use `init --upgrade --client CLIENT` to replace the installed runtime. The upgrade acquires a task lease, checks active capture again and refuses active routing/app capture, pauses, foreign leases or reverse listeners.

Installation can succeed while client registration fails, for example if a client config is malformed or its CLI fails. Correct the client error and rerun `init`; the healthy service is reused. Backups are retained for manual recovery and are not uploaded.

Upstream configuration references: [Claude Code MCP](https://code.claude.com/docs/en/mcp-quickstart), [Codex MCP](https://developers.openai.com/codex/mcp/).

Automatic upgrades preserve proxy/control ports, textual capture policy and TLS passthrough. Services using custom CA files, upstream chaining, raw storage or remote access require the advanced `install` command with those explicit settings; `init` refuses to reset them to defaults.

## Migrate from private GitHub Packages

For the former package name, first read [Migrate from proxy-mcp](#migrate-from-proxy-mcp).

If you previously mapped this scope to GitHub Packages, point it at npm once:

```bash
npm config set @othmansh0:registry https://registry.npmjs.org --location=user
```

Then run the README init command. A GitHub Packages token is not needed for public releases.

## Migrate from proxy-mcp

After the first Proxy Mate release is published, use the new package name:

```bash
npx --yes @othmansh01/proxy-mate@latest init --upgrade --client claude
```

Finish active capture before upgrading. Repeat plain `init --client CLIENT` for each additional client, then reconnect it. Setup replaces an owned `proxy-mcp` bridge entry with `proxy-mate` and backs up the original configuration. A custom server using the former key is preserved; remove it manually if it is an obsolete installation. New installs use `~/.proxy-mate`; existing installs reuse `~/.proxy-mcp` in place, preserving the CA, SQLite sessions and absolute captured-body paths. Do not move or copy a live state directory. Backups remain under the selected state directory's `setup-backups`.

Use `PROXY_MATE_*` environment variables for new configuration. Every former `PROXY_MCP_*` variable remains accepted, with the new name taking precedence when both are set. Installed service environments use the new names. `PROXY_MATE_HOME` explicitly selects a different root; it does not migrate existing data. The `proxy-mcp` executable remains an alias within the new package.

Old `proxy-mcp://` resource links and subscriptions still work. New links use `proxy-mate://`. Session exports, plugin catalogs and WebSocket snapshots/transcripts accept both names and write the new format identifiers. Existing certificates retain their original subject until you explicitly rotate the CA. The daemon accepts already connected pre-rename bridges; reconnect clients to get the new branding and compact tool results.

GitHub source and releases now live at [othmansh0/proxy-mate](https://github.com/othmansh0/proxy-mate). Update existing clones with `git remote set-url origin https://github.com/othmansh0/proxy-mate.git`. The npm package is a new identity: an old package installation will not automatically update to the new name. Maintainers must configure npm trusted publishing for repository `proxy-mate` as described in [packaging](PACKAGING.md).
