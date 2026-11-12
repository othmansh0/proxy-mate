# MCP client setup

Start with the [README quick start](../README.md). `npx --yes @othmansh0/proxy-mcp@latest init --client CLIENT` installs the shared service and connects a client.

## Automatic registration

- `claude`: updates the top-level `mcpServers.proxy-mcp` in `~/.claude.json`. With `CLAUDE_CONFIG_DIR`, uses `.claude.json` inside that directory. This is Claude Code's user scope.
- `cursor`: updates `~/.cursor/mcp.json`.
- `claude-desktop`: updates `~/Library/Application Support/Claude/claude_desktop_config.json`.
- `codex`: runs the installed Codex CLI's `mcp add` command. The CLI manages its own TOML format and supports its normal configuration directory.
- `json`: installs/reuses the service and prints a `mcpServers` object for manual registration.

Existing JSON files are validated before service installation. Setup replaces only the `proxy-mcp` entry, preserves other servers/settings, follows existing configuration-file symlinks, and stores private backups under `~/.proxy-mcp/setup-backups`. Invalid JSON is preserved. If a client uses JSON with comments, use `--client json` and edit its configuration through that client.

Registration affects future client connections. Reconnect an existing MCP session once; setup does not kill agent processes.

## Preview

```bash
npx --yes @othmansh0/proxy-mcp@latest init --client claude --dry-run
```

Preview reads service/configuration metadata but writes no service, certificate, routing or client files. It shows whether setup would install, reuse or upgrade the service and the exact local command/configuration.

## Manual clients

```bash
npx --yes @othmansh0/proxy-mcp@latest init --client json
```

Copy the returned `client.config.mcpServers` into your client's MCP settings. Both the Node executable and bridge path are absolute. No GitHub token belongs in the MCP configuration: public npm packages need no registry authentication. The installed runtime works independently of the source checkout or npm cache.

`PROXY_MCP_HOME` can select a separate state directory before running setup. Registration records that absolute path so the daemon and client use the same state. Each state directory has one capture owner; ordinary agents should share the default installed service.

## Existing services and updates

Plain `init` reuses a healthy service, including one running an older version, without interrupting capture. If the package is newer, it prints an update instruction. After stopping capture and finishing its task, use `init --upgrade --client CLIENT` to replace the installed runtime. The upgrade acquires a task lease, checks active capture again and refuses active routing/app capture, pauses, foreign leases or reverse listeners.

Installation can succeed while client registration fails, for example if a client config is malformed or its CLI fails. Correct the client error and rerun `init`; the healthy service is reused. Backups are retained for manual recovery and are not uploaded.

Upstream configuration references: [Claude Code MCP](https://code.claude.com/docs/en/mcp-quickstart), [Codex MCP](https://developers.openai.com/codex/mcp/).

Automatic upgrades preserve proxy/control ports, textual capture policy and TLS passthrough. Services using custom CA files, upstream chaining, raw storage or remote access require the advanced `install` command with those explicit settings; `init` refuses to reset them to defaults.

## Migrate from private GitHub Packages

If you previously mapped this scope to GitHub Packages, point it at npm once:

```bash
npm config set @othmansh0:registry https://registry.npmjs.org --location=user
```

Then run the README init command. A GitHub Packages token is not needed for public releases.
