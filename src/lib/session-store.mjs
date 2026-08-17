// Durable SQLite capture-session storage.
//
// Flows are stored one row at a time in WAL mode. Appending or completing a
// flow therefore updates only that flow and the small parent-session row; it
// never reparses and rewrites an entire capture document. Existing v1 JSON
// snapshots are imported transactionally on first open and then moved into a
// private legacy-json directory for recovery.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './config.mjs';

const FORMAT = 'proxy-mcp.session/v1';
const SCHEMA_VERSION = 1;
const DATABASE_SCHEMA_VERSION = 2;
const DATABASE_FILE = 'sessions.sqlite3';
const DEFAULT_RETENTION = Object.freeze({
  max_flows: 10_000,
  max_bytes: 256 * 1024 * 1024,
  max_age_ms: 7 * 24 * 60 * 60 * 1000,
});
const MAX_PAGE_SIZE = 1_000;

export class SessionStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SessionStoreError';
    this.code = code;
    this.details = details;
  }
}

export class SessionStore {
  constructor({
    rootDir = path.join(STATE_DIR, 'sessions'),
    dbPath = null,
    retention = {},
    clock = () => Date.now(),
  } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.dbPath = path.resolve(dbPath ?? path.join(this.rootDir, DATABASE_FILE));
    this.retention = normalizeRetention(retention, DEFAULT_RETENTION);
    this.clock = clock;
    this.db = null;
    this.backend = null;
    this.initialized = false;
    this.initializing = null;
    this.mutation = Promise.resolve();
    this.migrationWarnings = [];
  }

  async init() {
    if (this.initialized) return this;
    if (this.initializing) return this.initializing;
    this.initializing = this.#initialize();
    try { return await this.initializing; }
    finally { this.initializing = null; }
  }

  async #initialize() {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700);
    const opened = await openSqlite(this.dbPath);
    this.db = opened.db;
    this.backend = opened.backend;
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA temp_store = MEMORY;
        PRAGMA wal_autocheckpoint = 1000;
        CREATE TABLE IF NOT EXISTS store_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          next_sequence INTEGER NOT NULL,
          retention_max_flows INTEGER NOT NULL,
          retention_max_bytes INTEGER NOT NULL,
          retention_max_age_ms INTEGER NOT NULL,
          metadata_json TEXT NOT NULL,
          flow_count INTEGER NOT NULL DEFAULT 0,
          total_bytes INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS flows (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          data_json TEXT NOT NULL,
          data_bytes INTEGER NOT NULL,
          spilled_body_bytes INTEGER NOT NULL DEFAULT 0,
          total_bytes INTEGER NOT NULL,
          method TEXT,
          url TEXT,
          hostname TEXT,
          status_code INTEGER,
          PRIMARY KEY (session_id, id),
          UNIQUE (session_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS flows_session_sequence
          ON flows(session_id, sequence);
        CREATE INDEX IF NOT EXISTS flows_session_created
          ON flows(session_id, created_at_ms, sequence);
      `);
      const version = this.db.prepare("SELECT value FROM store_meta WHERE key = 'schema_version'").get();
      if (version && Number(version.value) === 1) this.#migrateDatabaseV1ToV2();
      else if (version && Number(version.value) !== DATABASE_SCHEMA_VERSION) {
        throw new SessionStoreError(
          'UNSUPPORTED_DATABASE_SCHEMA',
          `Unsupported session database schema: ${version.value}`,
        );
      }
      this.db.prepare(`
        INSERT INTO store_meta(key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO NOTHING
      `).run(String(DATABASE_SCHEMA_VERSION));
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS flows_session_hostname_sequence
          ON flows(session_id, hostname, sequence);
        CREATE INDEX IF NOT EXISTS flows_session_method_sequence
          ON flows(session_id, method, sequence);
        CREATE INDEX IF NOT EXISTS flows_session_status_sequence
          ON flows(session_id, status_code, sequence);
      `);
      const check = this.db.prepare('PRAGMA quick_check').get();
      const checkValue = check?.quick_check ?? Object.values(check ?? {})[0];
      if (checkValue !== 'ok') throw new SessionStoreError('CORRUPT_DATABASE', `SQLite quick_check failed: ${checkValue}`);
      await fs.chmod(this.dbPath, 0o600);
      await this.#migrateLegacyJson();
      this.initialized = true;
      return this;
    } catch (error) {
      try { this.db?.close(); } catch { /* best effort */ }
      this.db = null;
      if (isSqliteCorruption(error) && !(error instanceof SessionStoreError)) {
        throw new SessionStoreError('CORRUPT_DATABASE', 'The capture database is corrupt or is not a SQLite database.', {
          database_path: this.dbPath,
          cause: error.message,
        });
      }
      throw error;
    }
  }

  async close() {
    if (this.initializing) await this.initializing;
    await this.mutation;
    if (!this.db) return;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    this.db.close();
    this.db = null;
    this.initialized = false;
  }

  async storageStatus() {
    await this.init();
    const pageCount = scalar(this.db.prepare('PRAGMA page_count').get());
    const pageSize = scalar(this.db.prepare('PRAGMA page_size').get());
    const sessions = this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
    const flows = this.db.prepare('SELECT COUNT(*) AS count FROM flows').get().count;
    return {
      backend: this.backend,
      database_path: this.dbPath,
      journal_mode: String(scalar(this.db.prepare('PRAGMA journal_mode').get())).toLowerCase(),
      database_bytes: Number(pageCount) * Number(pageSize),
      sessions: Number(sessions),
      flows: Number(flows),
      schema_version: DATABASE_SCHEMA_VERSION,
      migration_warnings: cloneJson(this.migrationWarnings, 'migration warnings'),
    };
  }

  async createSession({ id, name, retention = {}, metadata = {} } = {}) {
    await this.init();
    const sessionId = normalizeId(id ?? `session_${crypto.randomUUID()}`, 'session_id');
    const normalizedRetention = normalizeRetention(retention, this.retention);
    const now = iso(this.clock());
    return this.#mutate(() => {
      try {
        this.db.prepare(`
          INSERT INTO sessions(
            id, schema_version, name, created_at, updated_at, next_sequence,
            retention_max_flows, retention_max_bytes, retention_max_age_ms,
            metadata_json, flow_count, total_bytes
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, 0)
        `).run(
          sessionId, SCHEMA_VERSION, normalizeName(name ?? sessionId), now, now,
          normalizedRetention.max_flows, normalizedRetention.max_bytes, normalizedRetention.max_age_ms,
          jsonString(metadata, 'metadata'),
        );
      } catch (error) {
        if (isConstraint(error)) throw new SessionStoreError('SESSION_EXISTS', `Session already exists: ${sessionId}`);
        throw error;
      }
      return this.#getPublicSession(sessionId);
    });
  }

  async ensureSession(options = {}) {
    const id = options.id ?? options.sessionId;
    if (!id) return this.createSession(options);
    const existing = await this.getSession(id);
    return existing ?? this.createSession({ ...options, id });
  }

  async getSession(sessionId) {
    await this.init();
    const id = normalizeId(sessionId, 'session_id');
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? publicSessionRow(row) : null;
  }

  async listSessions() {
    await this.init();
    return this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC, id ASC').all().map(publicSessionRow);
  }

  async updateSession({ sessionId, name, retention, metadata, mergeMetadata = true } = {}) {
    await this.init();
    const id = normalizeId(sessionId, 'session_id');
    return this.#mutate(() => this.#transaction(() => {
      const current = this.#requireSessionRow(id);
      const nextRetention = retention === undefined
        ? retentionFromRow(current)
        : normalizeRetention(retention, retentionFromRow(current));
      const currentMetadata = parseJson(current.metadata_json, 'metadata');
      const nextMetadata = metadata === undefined
        ? currentMetadata
        : mergeMetadata ? { ...currentMetadata, ...cloneJson(metadata, 'metadata') } : cloneJson(metadata, 'metadata');
      const nextName = name === undefined ? current.name : normalizeName(name);
      const now = iso(this.clock());
      this.db.prepare(`
        UPDATE sessions SET name = ?, updated_at = ?,
          retention_max_flows = ?, retention_max_bytes = ?, retention_max_age_ms = ?, metadata_json = ?
        WHERE id = ?
      `).run(
        nextName, now, nextRetention.max_flows, nextRetention.max_bytes, nextRetention.max_age_ms,
        jsonString(nextMetadata, 'metadata'), id,
      );
      const applied = this.#applyRetention(id, nextRetention);
      return { session: this.#getPublicSession(id), retention: applied };
    }));
  }

  async appendFlow({ sessionId, flow }) {
    await this.init();
    const id = normalizeId(sessionId, 'session_id');
    const candidate = cloneJson(flow, 'flow');
    const flowId = normalizeId(candidate.id ?? candidate.flow_id ?? `flow_${crypto.randomUUID()}`, 'flow_id');
    return this.#mutate(() => this.#transaction(() => {
      const session = this.#requireSessionRow(id);
      const now = iso(this.clock());
      const entry = normalizeStoredFlow({
        ...candidate,
        id: flowId,
        sequence: Number(session.next_sequence),
        created_at: normalizeCaptureTimestamp(candidate.created_at ?? candidate.timestamp, now),
        updated_at: now,
      }, now, { stripPaths: false });
      try { this.#insertFlow(id, entry); }
      catch (error) {
        if (isConstraint(error)) throw new SessionStoreError('FLOW_EXISTS', `Flow already exists: ${flowId}`);
        throw error;
      }
      const sizes = flowSizes(entry);
      this.db.prepare(`
        UPDATE sessions SET next_sequence = ?, updated_at = ?,
          flow_count = flow_count + 1, total_bytes = total_bytes + ?
        WHERE id = ?
      `).run(Number(session.next_sequence) + 1, now, sizes.totalBytes, id);
      const retention = this.#applyRetention(id, retentionFromRow(session));
      return { flow: cloneJson(entry, 'flow'), retention };
    }));
  }

  async updateFlow({ sessionId, flowId, patch }) {
    await this.init();
    const id = normalizeId(sessionId, 'session_id');
    const targetId = normalizeId(flowId, 'flow_id');
    const update = cloneJson(patch, 'patch');
    for (const field of ['id', 'flow_id', 'sequence', 'created_at']) delete update[field];
    return this.#mutate(() => this.#transaction(() => {
      const session = this.#requireSessionRow(id);
      const currentRow = this.db.prepare('SELECT * FROM flows WHERE session_id = ? AND id = ?').get(id, targetId);
      if (!currentRow) throw new SessionStoreError('FLOW_NOT_FOUND', `Flow was not found: ${targetId}`);
      const current = flowRow(currentRow);
      const entry = normalizeStoredFlow({ ...current, ...update, updated_at: iso(this.clock()) }, current.updated_at, { stripPaths: false });
      const sizes = flowSizes(entry);
      const indexed = indexedFlowFields(entry);
      const sizeDelta = sizes.totalBytes - Number(currentRow.total_bytes);
      this.db.prepare(`
        UPDATE flows SET updated_at = ?, data_json = ?, data_bytes = ?,
          spilled_body_bytes = ?, total_bytes = ?, method = ?, url = ?, hostname = ?, status_code = ?
        WHERE session_id = ? AND id = ?
      `).run(
        entry.updated_at, sizes.json, sizes.dataBytes, sizes.spilledBytes, sizes.totalBytes,
        indexed.method, indexed.url, indexed.hostname, indexed.statusCode, id, targetId,
      );
      this.db.prepare('UPDATE sessions SET updated_at = ?, total_bytes = total_bytes + ? WHERE id = ?')
        .run(entry.updated_at, sizeDelta, id);
      const retention = this.#applyRetention(id, retentionFromRow(session));
      return { flow: cloneJson(entry, 'flow'), retention };
    }));
  }

  async getFlow({ sessionId, flowId }) {
    await this.init();
    const id = normalizeId(sessionId, 'session_id');
    this.#requireSessionRow(id);
    const row = this.db.prepare('SELECT * FROM flows WHERE session_id = ? AND id = ?').get(id, normalizeId(flowId, 'flow_id'));
    return row ? flowRow(row) : null;
  }

  async listFlows({ sessionId, cursor = null, since_flow_id = null, limit = 100, filters = {} } = {}) {
    await this.init();
    const id = normalizeId(sessionId, 'session_id');
    const session = this.#requireSessionRow(id);
    const pageSize = normalizeLimit(limit);
    const cursorValue = cursor ? decodeCursor(cursor, id) : 0;
    let sinceSequence = 0;
    if (since_flow_id) {
      const sinceId = normalizeId(since_flow_id, 'since_flow_id');
      const since = this.db.prepare('SELECT sequence FROM flows WHERE session_id = ? AND id = ?').get(id, sinceId);
      if (!since) throw new SessionStoreError('FLOW_NOT_FOUND', `since_flow_id was not found: ${sinceId}`);
      sinceSequence = Number(since.sequence);
    }
    const after = Math.max(cursorValue, sinceSequence);
    const sqlFilters = flowFilterSql(filters);
    const rows = this.db.prepare(`
      SELECT * FROM flows WHERE session_id = ? AND sequence > ? ${sqlFilters.sql}
      ORDER BY sequence ASC LIMIT ?
    `).all(id, after, ...sqlFilters.params, pageSize + 1);
    const hasMore = rows.length > pageSize;
    const flows = rows.slice(0, pageSize).map(flowRow);
    const lastSequence = flows.at(-1)?.sequence ?? after;
    return {
      session: publicSessionRow(session),
      flows,
      has_more: hasMore,
      next_cursor: hasMore ? encodeCursor(id, lastSequence) : null,
      snapshot_id: `${id}:${Number(session.next_sequence) - 1}`,
    };
  }

  async purgeFlows({ sessionId, before_sequence = null, older_than_ms = null } = {}) {
    const id = normalizeId(sessionId, 'session_id');
    if (before_sequence != null && (!Number.isInteger(before_sequence) || before_sequence < 1)) {
      throw new SessionStoreError('INVALID_PURGE', 'before_sequence must be a positive integer');
    }
    if (older_than_ms != null && (!Number.isFinite(older_than_ms) || older_than_ms < 0)) {
      throw new SessionStoreError('INVALID_PURGE', 'older_than_ms must be a non-negative number');
    }
    await this.init();
    return this.#mutate(() => this.#transaction(() => {
      this.#requireSessionRow(id);
      const cutoff = older_than_ms == null ? null : this.clock() - older_than_ms;
      const clauses = [];
      const params = [id];
      if (before_sequence != null) { clauses.push('sequence < ?'); params.push(before_sequence); }
      if (cutoff != null) { clauses.push('created_at_ms < ?'); params.push(cutoff); }
      if (clauses.length === 0) return { purged: 0, purged_flow_ids: [], remaining: this.#flowCount(id) };
      const where = `session_id = ? AND (${clauses.join(' OR ')})`;
      const purgedRows = this.db.prepare(`SELECT id, total_bytes FROM flows WHERE ${where} ORDER BY sequence`).all(...params);
      const purgedFlowIds = purgedRows.map((row) => row.id);
      this.db.prepare(`DELETE FROM flows WHERE ${where}`).run(...params);
      this.#adjustAggregates(id, -purgedRows.length, -sumRowBytes(purgedRows), iso(this.clock()));
      return { purged: purgedFlowIds.length, purged_flow_ids: purgedFlowIds, remaining: this.#flowCount(id) };
    }));
  }

  async purgeSession(sessionId) {
    await this.init();
    const id = normalizeId(sessionId, 'session_id');
    return this.#mutate(() => this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0);
  }

  async exportSession(sessionId) {
    await this.init();
    const id = normalizeId(sessionId, 'session_id');
    const session = this.#fullSession(id);
    return { format: FORMAT, exported_at: iso(this.clock()), session: sanitizeForExport(session) };
  }

  async importSession({ document, sessionId = null, name = null, replace = false } = {}) {
    const imported = validateImport(document);
    const id = normalizeId(sessionId ?? imported.id ?? `session_${crypto.randomUUID()}`, 'session_id');
    await this.init();
    return this.#mutate(() => this.#transaction(() => {
      if (!replace && this.#sessionRow(id)) throw new SessionStoreError('SESSION_EXISTS', `Session already exists: ${id}`);
      if (replace) this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      const now = iso(this.clock());
      const flows = normalizeFlows(imported.flows ?? [], now, { stripPaths: true });
      const retention = normalizeRetention(imported.retention, this.retention);
      const nextSequence = Math.max(0, ...flows.map((flow) => flow.sequence)) + 1;
      this.#insertSession({
        id,
        name: normalizeName(name ?? imported.name ?? id),
        created_at: normalizeCaptureTimestamp(imported.created_at, now),
        updated_at: now,
        next_sequence: nextSequence,
        retention,
        metadata: cloneJson(imported.metadata ?? {}, 'metadata'),
      });
      for (const flow of flows) this.#insertFlow(id, flow);
      this.#refreshAggregates(id);
      this.#applyRetention(id, retention);
      return this.#getPublicSession(id);
    }));
  }

  #sessionRow(sessionId) {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  }

  #requireSessionRow(sessionId) {
    const row = this.#sessionRow(sessionId);
    if (!row) throw new SessionStoreError('SESSION_NOT_FOUND', `Session was not found: ${sessionId}`);
    return row;
  }

  #getPublicSession(sessionId) { return publicSessionRow(this.#requireSessionRow(sessionId)); }

  #insertSession(session) {
    this.db.prepare(`
      INSERT INTO sessions(
        id, schema_version, name, created_at, updated_at, next_sequence,
        retention_max_flows, retention_max_bytes, retention_max_age_ms,
        metadata_json, flow_count, total_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).run(
      session.id, SCHEMA_VERSION, session.name, session.created_at, session.updated_at, session.next_sequence,
      session.retention.max_flows, session.retention.max_bytes, session.retention.max_age_ms,
      jsonString(session.metadata ?? {}, 'metadata'),
    );
  }

  #insertFlow(sessionId, entry) {
    const sizes = flowSizes(entry);
    const indexed = indexedFlowFields(entry);
    this.db.prepare(`
      INSERT INTO flows(
        session_id, id, sequence, created_at, created_at_ms, updated_at,
        data_json, data_bytes, spilled_body_bytes, total_bytes,
        method, url, hostname, status_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, entry.id, entry.sequence, entry.created_at, captureTime(entry), entry.updated_at,
      sizes.json, sizes.dataBytes, sizes.spilledBytes, sizes.totalBytes,
      indexed.method, indexed.url, indexed.hostname, indexed.statusCode,
    );
  }

  #migrateDatabaseV1ToV2() {
    this.#transaction(() => {
      this.db.exec(`
        ALTER TABLE flows ADD COLUMN method TEXT;
        ALTER TABLE flows ADD COLUMN url TEXT;
        ALTER TABLE flows ADD COLUMN hostname TEXT;
        ALTER TABLE flows ADD COLUMN status_code INTEGER;
      `);
      const update = this.db.prepare(`
        UPDATE flows SET method = ?, url = ?, hostname = ?, status_code = ?
        WHERE session_id = ? AND id = ?
      `);
      for (const row of this.db.prepare('SELECT session_id, id, data_json FROM flows').all()) {
        const indexed = indexedFlowFields(parseJson(row.data_json, 'flow'));
        update.run(indexed.method, indexed.url, indexed.hostname, indexed.statusCode, row.session_id, row.id);
      }
      this.db.prepare("UPDATE store_meta SET value = ? WHERE key = 'schema_version'")
        .run(String(DATABASE_SCHEMA_VERSION));
    });
  }

  #applyRetention(sessionId, retention) {
    const removed = { max_flows: 0, max_bytes: 0, max_age: 0 };
    const removedFlowIds = [];
    const removeRows = (rows, reason) => {
      const statement = this.db.prepare('DELETE FROM flows WHERE session_id = ? AND id = ?');
      const deleted = [];
      for (const row of rows) {
        if (statement.run(sessionId, row.id).changes > 0) {
          removedFlowIds.push(row.id);
          removed[reason] += 1;
          deleted.push(row);
        }
      }
      if (deleted.length) this.#adjustAggregates(sessionId, -deleted.length, -sumRowBytes(deleted));
    };

    const cutoff = this.clock() - retention.max_age_ms;
    removeRows(this.db.prepare(`
      SELECT id, total_bytes FROM flows WHERE session_id = ? AND created_at_ms < ? ORDER BY sequence ASC
    `).all(sessionId, cutoff), 'max_age');

    let session = this.#requireSessionRow(sessionId);
    const excess = Math.max(0, Number(session.flow_count) - retention.max_flows);
    if (excess > 0) {
      removeRows(this.db.prepare(`
        SELECT id, total_bytes FROM flows WHERE session_id = ? ORDER BY sequence ASC LIMIT ?
      `).all(sessionId, excess), 'max_flows');
    }

    session = this.#requireSessionRow(sessionId);
    if (Number(session.flow_count) > 1 && Number(session.total_bytes) > retention.max_bytes) {
      // The common path performs no flow scan. Only an over-budget session
      // reads the oldest prefix needed to return below its byte quota.
      const rows = this.db.prepare(`
        SELECT id, total_bytes FROM flows WHERE session_id = ? ORDER BY sequence ASC
      `).all(sessionId);
      let bytes = Number(session.total_bytes);
      const byteRows = [];
      for (const row of rows) {
        if (rows.length - byteRows.length <= 1 || bytes <= retention.max_bytes) break;
        byteRows.push(row);
        bytes -= Number(row.total_bytes);
      }
      removeRows(byteRows, 'max_bytes');
    }
    session = this.#requireSessionRow(sessionId);
    return {
      removed: removed.max_flows + removed.max_bytes + removed.max_age,
      removed_flow_ids: removedFlowIds,
      ...removed,
      retained: Number(session.flow_count),
      total_bytes: Number(session.total_bytes),
    };
  }

  #adjustAggregates(sessionId, flowDelta, byteDelta, updatedAt = null) {
    if (updatedAt) {
      this.db.prepare(`
        UPDATE sessions SET flow_count = flow_count + ?, total_bytes = total_bytes + ?, updated_at = ?
        WHERE id = ?
      `).run(flowDelta, byteDelta, updatedAt, sessionId);
    } else {
      this.db.prepare(`
        UPDATE sessions SET flow_count = flow_count + ?, total_bytes = total_bytes + ? WHERE id = ?
      `).run(flowDelta, byteDelta, sessionId);
    }
  }

  #refreshAggregates(sessionId) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS flow_count, COALESCE(SUM(total_bytes), 0) AS total_bytes
      FROM flows WHERE session_id = ?
    `).get(sessionId);
    this.db.prepare('UPDATE sessions SET flow_count = ?, total_bytes = ? WHERE id = ?')
      .run(Number(row.flow_count), Number(row.total_bytes), sessionId);
  }

  #flowCount(sessionId) {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM flows WHERE session_id = ?').get(sessionId).count);
  }

  #fullSession(sessionId) {
    const row = this.#requireSessionRow(sessionId);
    return {
      schema_version: SCHEMA_VERSION,
      id: row.id,
      name: row.name,
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_sequence: Number(row.next_sequence),
      retention: retentionFromRow(row),
      metadata: parseJson(row.metadata_json, 'metadata'),
      flows: this.db.prepare('SELECT * FROM flows WHERE session_id = ? ORDER BY sequence ASC').all(sessionId).map(flowRow),
      total_bytes: Number(row.total_bytes),
    };
  }

  #transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  #mutate(operation) {
    const next = this.mutation.then(operation);
    this.mutation = next.catch(() => {});
    return next;
  }

  async #migrateLegacyJson() {
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const legacy = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    if (legacy.length === 0) return;
    const archiveDir = path.join(this.rootDir, 'legacy-json');
    await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 });
    await fs.chmod(archiveDir, 0o700);
    for (const entry of legacy) {
      const source = path.join(this.rootDir, entry.name);
      const expectedId = entry.name.slice(0, -5);
      let session;
      try {
        session = normalizeLegacySession(JSON.parse(await fs.readFile(source, 'utf8')), expectedId, this.retention);
      } catch (error) {
        // Keep corrupt or foreign JSON in place so an operator can recover it.
        this.migrationWarnings.push({
          code: 'LEGACY_JSON_NOT_MIGRATED',
          file: entry.name,
          message: error?.message ?? 'Legacy JSON could not be parsed.',
        });
        continue;
      }
      if (!this.#sessionRow(session.id)) {
        this.#transaction(() => {
          this.#insertSession(session);
          for (const flow of session.flows) this.#insertFlow(session.id, flow);
          this.#refreshAggregates(session.id);
          this.#applyRetention(session.id, session.retention);
        });
      }
      const target = await availableArchivePath(archiveDir, entry.name);
      await fs.rename(source, target);
      await fs.chmod(target, 0o600);
    }
  }
}

async function openSqlite(file) {
  let builtInError;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return { db: new DatabaseSync(file), backend: 'node:sqlite' };
  } catch (error) { builtInError = error; }
  try {
    const imported = await import('better-sqlite3');
    const Database = imported.default ?? imported;
    const db = new Database(file, { timeout: 5000 });
    // Loading the module can succeed even when an optional native binding did
    // not install; force binding initialization before reporting success.
    db.prepare('SELECT 1').get();
    return { db, backend: 'better-sqlite3' };
  } catch (fallbackError) {
    throw new SessionStoreError(
      'SQLITE_BACKEND_UNAVAILABLE',
      'SQLite storage requires Node.js 22+ or the optional better-sqlite3 package on Node.js 20.',
      { built_in: builtInError?.message, fallback: fallbackError?.message },
    );
  }
}

function normalizeLegacySession(input, expectedId, defaults) {
  if (!input || typeof input !== 'object' || input.schema_version !== SCHEMA_VERSION) {
    throw new SessionStoreError('UNSUPPORTED_SESSION', `Unsupported session schema: ${expectedId}`);
  }
  const id = normalizeId(input.id, 'session_id');
  if (id !== expectedId) throw new SessionStoreError('CORRUPT_SESSION', `Session id does not match its file: ${expectedId}`);
  const now = iso(Date.now());
  const flows = normalizeFlows(input.flows ?? [], now, { stripPaths: false });
  return {
    schema_version: SCHEMA_VERSION,
    id,
    name: normalizeName(input.name ?? id),
    created_at: normalizeCaptureTimestamp(input.created_at, now),
    updated_at: normalizeCaptureTimestamp(input.updated_at ?? input.created_at, now),
    next_sequence: Math.max(Number(input.next_sequence) || 1, Math.max(0, ...flows.map((flow) => flow.sequence)) + 1),
    retention: normalizeRetention(input.retention, defaults),
    metadata: cloneJson(input.metadata ?? {}, 'metadata'),
    flows,
  };
}

function normalizeFlows(flows, now, { stripPaths }) {
  if (!Array.isArray(flows)) throw new SessionStoreError('INVALID_IMPORT', 'Imported session flows must be an array');
  const ids = new Set();
  const sequences = new Set();
  let next = 1;
  return flows.map((raw) => {
    const flow = cloneJson(raw, 'flow');
    if (stripPaths) {
      if (flow.request) delete flow.request.body_path;
      if (flow.response) delete flow.response.body_path;
    }
    const id = normalizeId(flow.id ?? flow.flow_id, 'flow_id');
    if (ids.has(id)) throw new SessionStoreError('INVALID_IMPORT', `Imported session has duplicate flow id: ${id}`);
    ids.add(id);
    let sequence = Number.isInteger(flow.sequence) && flow.sequence > 0 ? flow.sequence : next;
    while (sequences.has(sequence)) sequence += 1;
    sequences.add(sequence);
    next = Math.max(next, sequence + 1);
    return normalizeStoredFlow({ ...flow, id, sequence }, now, { stripPaths: false });
  }).sort((a, b) => a.sequence - b.sequence);
}

function normalizeStoredFlow(flow, fallback, { stripPaths }) {
  const output = cloneJson(flow, 'flow');
  if (stripPaths) {
    if (output.request) delete output.request.body_path;
    if (output.response) delete output.response.body_path;
  }
  output.id = normalizeId(output.id ?? output.flow_id, 'flow_id');
  delete output.flow_id;
  if (!Number.isInteger(output.sequence) || output.sequence < 1) throw new SessionStoreError('INVALID_DATA', 'flow sequence must be a positive integer');
  output.created_at = normalizeCaptureTimestamp(output.created_at ?? output.timestamp, fallback);
  output.updated_at = normalizeCaptureTimestamp(output.updated_at, fallback);
  return output;
}

function flowSizes(flow) {
  const json = jsonString(flow, 'flow');
  const dataBytes = Buffer.byteLength(json, 'utf8');
  const spilledBytes = (flow.request?.body_path ? Number(flow.request.body_size) || 0 : 0)
    + (flow.response?.body_path ? Number(flow.response.body_size) || 0 : 0);
  return { json, dataBytes, spilledBytes, totalBytes: dataBytes + spilledBytes };
}

function indexedFlowFields(flow) {
  let hostname = flow.request?.hostname ?? null;
  if (!hostname && flow.request?.url) {
    try { hostname = new URL(flow.request.url).hostname; } catch { /* malformed captured URL */ }
  }
  const status = Number(flow.response?.statusCode);
  return {
    method: flow.request?.method ? String(flow.request.method).toUpperCase() : null,
    url: flow.request?.url ? String(flow.request.url) : null,
    hostname: hostname ? String(hostname) : null,
    statusCode: Number.isInteger(status) ? status : null,
  };
}

function flowFilterSql(filters = {}) {
  const clauses = [];
  const params = [];
  const addContains = (column, value) => {
    clauses.push(`${column} LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(String(value))}%`);
  };
  if (filters.host_equals != null) {
    clauses.push('hostname = ?');
    params.push(String(filters.host_equals));
  } else {
    const hostContains = filters.host_contains ?? filters.host_filter ?? filters.domain;
    if (hostContains != null) addContains('hostname', hostContains);
  }
  if (filters.url_equals != null) {
    clauses.push('url = ?');
    params.push(String(filters.url_equals));
  } else if (filters.url_contains != null) addContains('url', filters.url_contains);
  const method = filters.method ?? filters.method_filter;
  if (method) {
    clauses.push('method = ?');
    params.push(String(method).toUpperCase());
  }
  if (filters.status_filter != null) {
    const statuses = (Array.isArray(filters.status_filter) ? filters.status_filter : [filters.status_filter])
      .filter(Number.isInteger);
    if (statuses.length) {
      clauses.push(`status_code IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
  }
  if (filters.status_min != null) { clauses.push('status_code >= ?'); params.push(filters.status_min); }
  if (filters.status_max != null) { clauses.push('status_code <= ?'); params.push(filters.status_max); }
  return { sql: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
}

function escapeLike(value) { return value.replace(/[\\%_]/g, (character) => `\\${character}`); }

function sumRowBytes(rows) {
  return rows.reduce((total, row) => total + Number(row.total_bytes), 0);
}

function flowRow(row) {
  const flow = parseJson(row.data_json, 'flow');
  if (flow.id !== row.id || Number(flow.sequence) !== Number(row.sequence)) {
    throw new SessionStoreError('CORRUPT_DATABASE', `Flow row identity mismatch: ${row.session_id}/${row.id}`);
  }
  return flow;
}

function retentionFromRow(row) {
  return {
    max_flows: Number(row.retention_max_flows),
    max_bytes: Number(row.retention_max_bytes),
    max_age_ms: Number(row.retention_max_age_ms),
  };
}

function publicSessionRow(row) {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    next_sequence: Number(row.next_sequence),
    retention: retentionFromRow(row),
    metadata: parseJson(row.metadata_json, 'metadata'),
    flow_count: Number(row.flow_count),
    total_bytes: Number(row.total_bytes),
  };
}

function sanitizeForExport(session) {
  const output = cloneJson(session, 'session');
  for (const flow of output.flows) {
    if (flow.request) delete flow.request.body_path;
    if (flow.response) delete flow.response.body_path;
  }
  return output;
}

function validateImport(document) {
  if (!document || typeof document !== 'object' || document.format !== FORMAT || !document.session || typeof document.session !== 'object') {
    throw new SessionStoreError('INVALID_IMPORT', `Expected ${FORMAT} document`);
  }
  return document.session;
}

function normalizeRetention(value = {}, fallback) {
  const source = { ...fallback, ...(value ?? {}) };
  for (const key of ['max_flows', 'max_bytes', 'max_age_ms']) {
    if (!Number.isFinite(source[key]) || source[key] < 0) {
      throw new SessionStoreError('INVALID_RETENTION', `${key} must be a non-negative finite number`);
    }
  }
  return {
    max_flows: Math.floor(source.max_flows),
    max_bytes: Math.floor(source.max_bytes),
    max_age_ms: Math.floor(source.max_age_ms),
  };
}

function normalizeId(value, label) {
  const id = String(value ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === '.' || id === '..') {
    throw new SessionStoreError('INVALID_ID', `${label} must contain 1-128 safe identifier characters`);
  }
  return id;
}

function normalizeName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 256) throw new SessionStoreError('INVALID_NAME', 'Session name must be 1-256 characters');
  return name;
}

function normalizeLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new SessionStoreError('INVALID_LIMIT', 'limit must be a positive integer');
  return Math.min(limit, MAX_PAGE_SIZE);
}

function encodeCursor(sessionId, sequence) {
  return Buffer.from(JSON.stringify({ v: 1, s: sessionId, q: sequence })).toString('base64url');
}

function decodeCursor(value, expectedSessionId) {
  try {
    const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (cursor?.v !== 1 || cursor.s !== expectedSessionId || !Number.isInteger(cursor.q) || cursor.q < 0) throw new Error('invalid');
    return cursor.q;
  } catch {
    throw new SessionStoreError('INVALID_CURSOR', 'Cursor is invalid or belongs to another session');
  }
}

function cloneJson(value, label) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { throw new SessionStoreError('INVALID_DATA', `${label} must be JSON serializable`); }
}

function jsonString(value, label) {
  try { return JSON.stringify(value); }
  catch { throw new SessionStoreError('INVALID_DATA', `${label} must be JSON serializable`); }
}

function parseJson(value, label) {
  try { return JSON.parse(value); }
  catch { throw new SessionStoreError('CORRUPT_DATABASE', `Stored ${label} is not valid JSON`); }
}

function captureTime(flow) {
  const parsed = Date.parse(flow.created_at ?? flow.timestamp ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(timestamp) { return new Date(timestamp).toISOString(); }

function normalizeCaptureTimestamp(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return iso(value);
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function isConstraint(error) { return String(error?.code ?? '').startsWith('SQLITE_CONSTRAINT'); }

function isSqliteCorruption(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  return code === 'SQLITE_CORRUPT'
    || code === 'SQLITE_NOTADB'
    || /database disk image is malformed|file is not a database/i.test(message);
}

function scalar(row) { return row ? Object.values(row)[0] : null; }

async function availableArchivePath(directory, name) {
  let candidate = path.join(directory, name);
  for (let attempt = 0; attempt < 1000; attempt++) {
    try { await fs.access(candidate); candidate = path.join(directory, `${name}.${attempt + 1}`); }
    catch { return candidate; }
  }
  throw new SessionStoreError('LEGACY_ARCHIVE_FULL', `Could not archive migrated legacy session: ${name}`);
}
