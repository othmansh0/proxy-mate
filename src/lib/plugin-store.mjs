import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';
import { TransformSandbox } from './transform-sandbox.mjs';

export const PLUGIN_STAGES = Object.freeze(['request', 'response', 'websocket_offline']);
const PLUGIN_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SOURCE_HASH = /^[a-f0-9]{64}$/;
const CATALOG_FORMAT = 'proxy-mate.plugin-store/v1';
const MAX_PLUGINS = 1_000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 1_024;

export class PluginStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PluginStoreError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Durable transform plugin registry.
 *
 * The catalog is the commit point. Sources use content-addressed filenames and
 * are written first, so an interrupted update can create only an unreferenced
 * source file, never a catalog entry that silently resolves to partial source.
 */
export class PluginStore {
  constructor({
    directory = path.join(STATE_DIR, 'plugins'),
    sandbox = null,
    clock = () => new Date(),
  } = {}) {
    if (!directory || typeof directory !== 'string') throw new PluginStoreError('PLUGIN_INVALID_CONFIGURATION', 'Plugin directory is required');
    if (typeof clock !== 'function') throw new PluginStoreError('PLUGIN_INVALID_CONFIGURATION', 'Plugin clock must be a function');
    this.directory = path.resolve(directory);
    this.sourcesDirectory = path.join(this.directory, 'sources');
    this.catalogPath = path.join(this.directory, 'plugins.json');
    this.sandbox = sandbox ?? new TransformSandbox();
    this.ownsSandbox = sandbox == null;
    this.clock = clock;
    this.plugins = new Map();
    this.loadPromise = null;
    this.mutation = Promise.resolve();
    this.disposed = false;
  }

  async init() {
    this.#ensureActive();
    await this.#ensureLoaded();
    return { restored: this.plugins.size, directory: this.directory };
  }

  async list({ stage = null, enabled = null } = {}) {
    this.#ensureActive();
    await this.#ensureLoaded();
    if (stage != null) validateStage(stage);
    if (enabled != null && typeof enabled !== 'boolean') throw new PluginStoreError('PLUGIN_INVALID_ENABLED', 'enabled must be a boolean');
    const plugins = [...this.plugins.values()]
      .filter((plugin) => stage == null || plugin.stage === stage)
      .filter((plugin) => enabled == null || plugin.enabled === enabled)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((plugin) => publicPlugin(plugin));
    return { plugins, total: plugins.length };
  }

  async get(id, { includeSource = false } = {}) {
    this.#ensureActive();
    await this.#ensureLoaded();
    id = validateId(id);
    const plugin = this.plugins.get(id);
    if (!plugin) return null;
    const result = publicPlugin(plugin);
    if (includeSource) {
      result.source = await this.#readSource(plugin);
      result.source_redacted = false;
    }
    return result;
  }

  async upsert(definition = {}) {
    this.#ensureActive();
    return this.#mutate(async () => {
      await this.#ensureLoaded();
      const id = validateId(definition.id ?? definition.plugin_id);
      const stage = validateStage(definition.stage);
      const source = definition.source;
      const { byte_size: sourceBytes } = this.sandbox.validateSource(source);
      const existing = this.plugins.get(id);
      if (!existing && this.plugins.size >= MAX_PLUGINS) throw new PluginStoreError('PLUGIN_LIMIT_REACHED', `Plugin store is limited to ${MAX_PLUGINS} plugins`);
      const name = boundedText(definition.name ?? existing?.name ?? id, 'name', MAX_NAME_LENGTH, false);
      const description = boundedText(definition.description ?? existing?.description ?? '', 'description', MAX_DESCRIPTION_LENGTH, true);
      // Persisting source does not authorize it to observe or modify traffic.
      // Callers must opt in to enablement explicitly.
      const enabled = definition.enabled ?? existing?.enabled ?? false;
      if (typeof enabled !== 'boolean') throw new PluginStoreError('PLUGIN_INVALID_ENABLED', 'enabled must be a boolean');
      const sourceSha256 = sha256(source);
      const sourceFile = sourceFilename(id, sourceSha256);
      const timestamp = nowIso(this.clock);
      const plugin = {
        id, name, description, stage, enabled,
        source_sha256: sourceSha256,
        source_bytes: sourceBytes,
        source_file: sourceFile,
        created_at: existing?.created_at ?? timestamp,
        updated_at: timestamp,
      };

      await this.#ensurePrivateDirectories();
      try { await atomicWritePrivate(path.join(this.sourcesDirectory, sourceFile), source); }
      catch (error) { throw persistenceError('PLUGIN_PERSISTENCE_WRITE_FAILED', `Unable to write source for plugin ${id}`, error); }
      const next = new Map(this.plugins);
      next.set(id, plugin);
      await this.#writeCatalog(next);
      this.plugins = next;
      if (existing?.source_file && existing.source_file !== sourceFile) {
        // Cleanup happens after the catalog commit; an orphan is preferable to
        // reporting a failed update that is already durable and active.
        await safeUnlink(path.join(this.sourcesDirectory, existing.source_file)).catch(() => undefined);
      }
      return publicPlugin(plugin);
    });
  }

  async remove(id) {
    this.#ensureActive();
    return this.#mutate(async () => {
      await this.#ensureLoaded();
      id = validateId(id);
      const existing = this.plugins.get(id);
      if (!existing) return { removed: false, id };
      const next = new Map(this.plugins);
      next.delete(id);
      await this.#writeCatalog(next);
      this.plugins = next;
      await safeUnlink(path.join(this.sourcesDirectory, existing.source_file)).catch(() => undefined);
      return { removed: true, id };
    });
  }

  async enable(id, enabled = true) {
    this.#ensureActive();
    if (typeof enabled !== 'boolean') throw new PluginStoreError('PLUGIN_INVALID_ENABLED', 'enabled must be a boolean');
    return this.#mutate(async () => {
      await this.#ensureLoaded();
      id = validateId(id);
      const existing = this.plugins.get(id);
      if (!existing) throw new PluginStoreError('PLUGIN_NOT_FOUND', `Plugin was not found: ${id}`);
      const plugin = { ...existing, enabled, updated_at: nowIso(this.clock) };
      const next = new Map(this.plugins);
      next.set(id, plugin);
      await this.#writeCatalog(next);
      this.plugins = next;
      return publicPlugin(plugin);
    });
  }

  /** Execute an enabled plugin only at the stage declared in its manifest. */
  async execute({ id, pluginId, plugin_id, stage, input } = {}) {
    this.#ensureActive();
    await this.#ensureLoaded();
    const resolvedId = validateId(id ?? pluginId ?? plugin_id);
    validateStage(stage);
    const plugin = this.plugins.get(resolvedId);
    if (!plugin) throw new PluginStoreError('PLUGIN_NOT_FOUND', `Plugin was not found: ${resolvedId}`);
    if (!plugin.enabled) throw new PluginStoreError('PLUGIN_DISABLED', `Plugin is disabled: ${resolvedId}`);
    if (plugin.stage !== stage) {
      throw new PluginStoreError('PLUGIN_STAGE_MISMATCH', `Plugin ${resolvedId} is registered for ${plugin.stage}, not ${stage}`, {
        plugin_id: resolvedId,
        expected_stage: plugin.stage,
        actual_stage: stage,
      });
    }
    const source = await this.#readSource(plugin);
    return this.sandbox.execute({ source, input });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ownsSandbox) this.sandbox.dispose();
  }

  #ensureActive() {
    if (this.disposed) throw new PluginStoreError('PLUGIN_STORE_DISPOSED', 'Plugin store has been disposed');
  }

  async #ensureLoaded() {
    this.loadPromise ??= this.#load();
    return this.loadPromise;
  }

  async #load() {
    await this.#ensurePrivateDirectories();
    let raw;
    try {
      const catalogStat = await statPrivateFile(this.catalogPath);
      if (catalogStat.size > MAX_CATALOG_BYTES) throw new PluginStoreError('PLUGIN_CATALOG_INVALID', 'Plugin catalog exceeds its size limit');
      raw = await readFile(this.catalogPath, 'utf8');
    }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw persistenceError('PLUGIN_PERSISTENCE_READ_FAILED', 'Unable to read plugin catalog', error);
    }
    let catalog;
    try { catalog = JSON.parse(raw); }
    catch { throw new PluginStoreError('PLUGIN_CATALOG_INVALID', 'Plugin catalog is not valid JSON'); }
    if (![CATALOG_FORMAT, 'proxy-mcp.plugin-store/v1'].includes(catalog?.format) || !Array.isArray(catalog.plugins) || catalog.plugins.length > MAX_PLUGINS) {
      throw new PluginStoreError('PLUGIN_CATALOG_INVALID', `Plugin catalog must use ${CATALOG_FORMAT}`);
    }
    const restored = new Map();
    for (const rawPlugin of catalog.plugins) {
      const plugin = validateStoredPlugin(rawPlugin);
      if (restored.has(plugin.id)) throw new PluginStoreError('PLUGIN_CATALOG_INVALID', `Plugin catalog contains duplicate id: ${plugin.id}`);
      // Verify source integrity during restart rather than failing much later at
      // the first intercepted request.
      await this.#readSource(plugin);
      restored.set(plugin.id, plugin);
    }
    this.plugins = restored;
    try { await chmod(this.catalogPath, 0o600); }
    catch (error) { throw persistenceError('PLUGIN_PERSISTENCE_READ_FAILED', 'Unable to secure plugin catalog permissions', error); }
  }

  async #readSource(plugin) {
    const sourcePath = path.join(this.sourcesDirectory, plugin.source_file);
    let handle;
    let source;
    try {
      handle = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const sourceStat = await handle.stat();
      if (!sourceStat.isFile() || sourceStat.size > this.sandbox.limits.maxSourceBytes) {
        throw new PluginStoreError('PLUGIN_SOURCE_INTEGRITY_FAILED', `Stored source failed integrity validation for plugin ${plugin.id}`);
      }
      source = await handle.readFile('utf8');
    } catch (error) {
      if (error instanceof PluginStoreError) throw error;
      throw persistenceError('PLUGIN_SOURCE_READ_FAILED', `Unable to read source for plugin ${plugin.id}`, error);
    } finally { await handle?.close(); }
    if (Buffer.byteLength(source, 'utf8') !== plugin.source_bytes || sha256(source) !== plugin.source_sha256) {
      throw new PluginStoreError('PLUGIN_SOURCE_INTEGRITY_FAILED', `Stored source failed integrity validation for plugin ${plugin.id}`);
    }
    return source;
  }

  async #writeCatalog(plugins) {
    await this.#ensurePrivateDirectories();
    const catalog = {
      format: CATALOG_FORMAT,
      plugins: [...plugins.values()].sort((left, right) => left.id.localeCompare(right.id)),
    };
    try { await atomicWritePrivate(this.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`); }
    catch (error) {
      if (error instanceof PluginStoreError) throw error;
      throw persistenceError('PLUGIN_PERSISTENCE_WRITE_FAILED', 'Unable to write plugin catalog', error);
    }
  }

  async #ensurePrivateDirectories() {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      await mkdir(this.sourcesDirectory, { recursive: true, mode: 0o700 });
      await chmod(this.sourcesDirectory, 0o700);
    } catch (error) { throw persistenceError('PLUGIN_PERSISTENCE_WRITE_FAILED', 'Unable to prepare private plugin storage', error); }
  }

  #mutate(operation) {
    const result = this.mutation.then(operation);
    this.mutation = result.catch(() => undefined);
    return result;
  }
}

function publicPlugin(plugin) {
  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    stage: plugin.stage,
    enabled: plugin.enabled,
    source_sha256: plugin.source_sha256,
    source_bytes: plugin.source_bytes,
    source_redacted: true,
    created_at: plugin.created_at,
    updated_at: plugin.updated_at,
  };
}

function validateStoredPlugin(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PluginStoreError('PLUGIN_CATALOG_INVALID', 'Plugin manifest must be an object');
  const id = validateId(raw.id, 'PLUGIN_CATALOG_INVALID');
  const stage = validateStage(raw.stage, 'PLUGIN_CATALOG_INVALID');
  const name = boundedText(raw.name, 'name', MAX_NAME_LENGTH, false, 'PLUGIN_CATALOG_INVALID');
  const description = boundedText(raw.description, 'description', MAX_DESCRIPTION_LENGTH, true, 'PLUGIN_CATALOG_INVALID');
  if (typeof raw.enabled !== 'boolean' || !SOURCE_HASH.test(raw.source_sha256 ?? '') || !Number.isSafeInteger(raw.source_bytes) || raw.source_bytes < 1) {
    throw new PluginStoreError('PLUGIN_CATALOG_INVALID', `Plugin manifest is invalid: ${id}`);
  }
  const expectedSourceFile = sourceFilename(id, raw.source_sha256);
  if (raw.source_file !== expectedSourceFile || !validIso(raw.created_at) || !validIso(raw.updated_at)) {
    throw new PluginStoreError('PLUGIN_CATALOG_INVALID', `Plugin manifest metadata is invalid: ${id}`);
  }
  return {
    id, name, description, stage, enabled: raw.enabled,
    source_sha256: raw.source_sha256,
    source_bytes: raw.source_bytes,
    source_file: expectedSourceFile,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

function validateId(value, code = 'PLUGIN_INVALID_ID') {
  if (typeof value !== 'string' || !PLUGIN_ID.test(value)) {
    throw new PluginStoreError(code, 'Plugin id must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens (maximum 64 characters)');
  }
  return value;
}

function validateStage(stage, code = 'PLUGIN_INVALID_STAGE') {
  if (!PLUGIN_STAGES.includes(stage)) throw new PluginStoreError(code, `Plugin stage must be one of: ${PLUGIN_STAGES.join(', ')}`);
  return stage;
}

function boundedText(value, name, maximum, allowEmpty, code = `PLUGIN_INVALID_${name.toUpperCase()}`) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '') || value.length > maximum) {
    throw new PluginStoreError(code, `Plugin ${name} must be ${allowEmpty ? 'a' : 'a non-empty'} string of at most ${maximum} characters`);
  }
  return value;
}

function sourceFilename(id, digest) { return `${id}.${digest}.js`; }
function sha256(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }
function validIso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PluginStoreError('PLUGIN_INVALID_CLOCK', 'Plugin clock returned an invalid date');
  return date.toISOString();
}

function persistenceError(code, message, cause) {
  if (cause instanceof PluginStoreError) return cause;
  return new PluginStoreError(code, message, { fs_code: typeof cause?.code === 'string' ? cause.code : undefined });
}

async function statPrivateFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const value = await handle.stat();
    if (!value.isFile()) throw Object.assign(new Error('Path is not a regular file'), { code: 'EINVAL' });
    return value;
  } finally { await handle?.close(); }
}

async function safeUnlink(filePath) {
  try { await unlink(filePath); }
  catch (error) { if (error?.code !== 'ENOENT') throw persistenceError('PLUGIN_PERSISTENCE_WRITE_FAILED', 'Unable to remove obsolete plugin source', error); }
}

async function atomicWritePrivate(filePath, content) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
    // fsync the directory so the rename itself is durable on filesystems that
    // implement directory synchronization.
    let directoryHandle;
    try {
      directoryHandle = await open(directory, fsConstants.O_RDONLY);
      await directoryHandle.sync();
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error;
    } finally { await directoryHandle?.close(); }
  } finally {
    await handle?.close();
    try { await unlink(temporary); } catch {}
  }
}
