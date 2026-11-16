import { promises as fs, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import { STATE_DIR, SERVER_NAME } from './config.mjs';
import { stableNodePath } from './launchagent.mjs';

const execute = promisify(execFile);
export const SETUP_CLIENTS = Object.freeze(['claude', 'codex', 'cursor', 'claude-desktop', 'json']);

export async function clientRegistrationPlan({ client = 'claude', home = os.homedir(), stateDir = STATE_DIR,
  nodeBin = process.execPath, env = process.env } = {}) {
  if (!SETUP_CLIENTS.includes(client)) throw new Error(`Choose --client ${SETUP_CLIENTS.join('|')}.`);
  const entry = { command: await stableNodePath(nodeBin), args: [path.join(stateDir, 'runtime/current/src/client.mjs')],
    env: { PROXY_MATE_HOME: stateDir } };
  const files = {
    claude: path.join(env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : home, '.claude.json'),
    cursor: path.join(home, '.cursor/mcp.json'),
    'claude-desktop': path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json'),
    codex: path.join(env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex'), 'config.toml'),
  };
  return { client, config_path: files[client] ?? null, backup_dir: path.join(stateDir, 'setup-backups'), entry,
    ...(client === 'codex' ? { executable: await findExecutable('codex', env),
      arguments: ['mcp', 'add', SERVER_NAME, '--env', `PROXY_MATE_HOME=${stateDir}`, '--', entry.command, ...entry.args] } : {}) };
}

export async function validateClientRegistration(plan) {
  if (!plan.config_path || plan.client === 'codex') return;
  await readJsonConfig(await resolveConfigPath(plan.config_path));
}

export async function registerClient(plan, { run = execute } = {}) {
  if (plan.client === 'json') return { status: 'manual', config: { mcpServers: { [SERVER_NAME]: plan.entry } } };
  const target = await resolveConfigPath(plan.config_path);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(`${target}.proxy-mate-registration`, { realpath: false, retries: 0 });
  try {
    const original = await readOptional(target);
    if (plan.client === 'codex') {
      const options = { timeout: 30_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, CODEX_HOME: path.dirname(plan.config_path) } };
      let legacy;
      try {
        const { stdout } = await run(plan.executable, ['mcp', 'get', 'proxy-mcp', '--json'], options);
        legacy = JSON.parse(stdout).transport;
      } catch (error) {
        if (!/No MCP server named/.test(error.stderr ?? error.message)) throw error;
      }
      const backup = await backupConfig(plan, original);
      try {
        await run(plan.executable, plan.arguments, options);
        if (isManagedLegacyEntry(legacy, plan.entry)) await run(plan.executable, ['mcp', 'remove', 'proxy-mcp'], options);
      }
      catch { throw new Error(`Codex registration failed. The service is installed; retry init --client codex. Configuration backup: ${backup ?? 'no previous file'}.`); }
      return { status: 'registered', config_path: target, backup_path: backup };
    }
    const config = parseJsonConfig(original, target);
    const migrateLegacy = isManagedLegacyEntry(config.mcpServers?.['proxy-mcp'], plan.entry);
    if (!migrateLegacy && JSON.stringify(config.mcpServers?.[SERVER_NAME]) === JSON.stringify(plan.entry)) {
      return { status: 'unchanged', config_path: target, backup_path: null };
    }
    const next = { ...config, mcpServers: { ...config.mcpServers, [SERVER_NAME]: plan.entry } };
    if (migrateLegacy) delete next.mcpServers['proxy-mcp'];
    const backup = await backupConfig(plan, original);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      if (await readOptional(target) !== original) throw new Error('MCP configuration changed during setup. Retry init; no configuration was replaced.');
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
    return { status: 'registered', config_path: target, backup_path: backup };
  } finally { await release(); }
}

function isManagedLegacyEntry(entry, replacement) {
  // Only retire our own stable bridge, never an unrelated custom server that
  // happens to use the former name. Installations keep their existing root.
  return Boolean(entry && entry.command === replacement.command
    && Array.isArray(entry.args) && entry.args.length === 1
    && entry.args[0] === replacement.args[0]);
}

async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readJsonConfig(file) { return parseJsonConfig(await readOptional(file), file); }

function parseJsonConfig(text, file) {
  let config;
  try { config = text === null ? {} : JSON.parse(text); }
  catch { throw new Error(`Cannot parse ${file}. Fix its JSON or use --client json; setup will not overwrite it.`); }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || config.mcpServers != null && (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
    throw new Error(`Invalid MCP configuration in ${file}. Use --client json for a manual configuration.`);
  }
  return config;
}

async function resolveConfigPath(file) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) { if (error.code === 'ENOENT') return file; throw error; }
  if (stat.isSymbolicLink()) return fs.realpath(file);
  if (!stat.isFile()) throw new Error(`MCP configuration is not a regular file: ${file}`);
  return file;
}

async function backupConfig(plan, text) {
  if (text === null) return null;
  await fs.mkdir(plan.backup_dir, { recursive: true, mode: 0o700 });
  await fs.chmod(plan.backup_dir, 0o700);
  const backup = path.join(plan.backup_dir, `${plan.client}-${randomUUID()}.bak`);
  await fs.writeFile(backup, text, { mode: 0o600, flag: 'wx' });
  return backup;
}

async function findExecutable(name, env) {
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const file = path.resolve(directory, name);
    try { await fs.access(file, constants.X_OK); return file; } catch { /* next directory */ }
  }
  throw new Error(`Install the ${name} CLI first, or use --client json to print the MCP configuration.`);
}
