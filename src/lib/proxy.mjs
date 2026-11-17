import { BodyWorkerPool } from './body-worker-pool.mjs';
import { drainServer, defaultDrainMs, trackServer, mockttpListener, limitedLog } from './drain.mjs';
import { logLine } from './log-line.mjs';
import { increment, registerGauge } from './metrics.mjs';
import { validateCustomCaPaths } from './ca-paths.mjs';
import { readEnvironment } from './environment.mjs';
// Proxy engine wrapper: thin layer over mockttp that adds our flow capture,
// large-body spillover, mock-rule registration with file-backed bodies,
// rich matchers, and diagnostic events.

import * as mockttp from 'mockttp';
import lockfile from 'proper-lockfile';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BlockList, isIP, createServer as createTcpServer } from 'node:net';
import { writeMockBody, deleteFlowBodies } from './bodies.mjs';
import { STATE_DIR, TRANSFORM_PLUGIN_GRANT_ENV, liveTransformGrantEnabled } from './config.mjs';
import { atomicWriteFile } from './state.mjs';
import { commitCaPair, recoverCaPair } from './ca-transaction.mjs';
import { SessionStore } from './session-store.mjs';
import { JsonlWebSocketStoreBackend, WebSocketStore, mockttpWebSocketHandlers } from './websocket-store.mjs';
import { BreakpointManager, createMockttpBreakpointCallbacks } from './breakpoints.mjs';
import { redactBody, redactHeaders, redactUrl } from './redaction.mjs';
import { PluginStore } from './plugin-store.mjs';
import { activeConnectionAttemptTimeout } from './network-policy.mjs';
import { upstreamErrorDiagnostic, upstreamErrorFromTags, upstreamErrorTags } from './upstream-errors.mjs';
import {
  normalizeMatchUrl, matchUrlPath, matcherError, parseRequestQuery, queryMatches, ruleUrlMatchers,
  validateMatcherObject, validateMatchQuery,
} from './url-match.mjs';

const activeSocketSets = new Set();
const activeConnections = () => [...activeSocketSets].reduce((total, sockets) => total + sockets.size, 0);

const CA_DIR = path.join(STATE_DIR, 'ca');
const CA_KEY = path.join(CA_DIR, 'key.pem');
const CA_CERT = path.join(CA_DIR, 'cert.pem');
const configuredMaxFlows = Number.parseInt(readEnvironment('PROXY_MATE_MAX_FLOWS') || '500', 10);
const MAX_FLOWS = Number.isInteger(configuredMaxFlows) && configuredMaxFlows > 0
  ? Math.min(configuredMaxFlows, 10_000)
  : 500;
const DEFAULT_MAX_BODY_SIZE = 5 * 1024 * 1024;
const MAX_PLUGIN_BODY_PREVIEW_BYTES = 64 * 1024;

export { CA_CERT, CA_DIR };

export async function ensureCA() {
  await fs.mkdir(CA_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(CA_DIR, 0o700);
  const release = await lockfile.lock(path.join(CA_DIR, 'authority'), {
    realpath: false, stale: 10_000, update: 2_000,
    retries: { retries: 60, minTimeout: 200, maxTimeout: 200, factor: 1 },
  });
  try {
    await recoverCaPair(CA_DIR);
    if (existsSync(CA_KEY) !== existsSync(CA_CERT)) {
      throw codedEngineError('CA_INCOMPLETE', 'Only one CA file exists. Restore the matching key/certificate pair or explicitly rotate the CA; existing device trust was preserved.');
    }
    if (!existsSync(CA_KEY)) {
      const { key, cert } = await mockttp.generateCACertificate({
        subject: { commonName: 'proxy-mate CA', organizationName: 'proxy-mate' },
      });
      await commitCaPair(CA_DIR, { key, cert });
    }
    await fs.chmod(CA_KEY, 0o600);
    await validateCA(CA_KEY, CA_CERT);
    return { keyPath: CA_KEY, certPath: CA_CERT };
  } finally {
    await release();
  }
}

export async function validateCA(keyPath, certPath) {
  try {
    const [keyStat, certStat] = await Promise.all([fs.stat(keyPath), fs.stat(certPath)]);
    if (!keyStat.isFile() || !certStat.isFile() || keyStat.size > 1024 * 1024 || certStat.size > 1024 * 1024) {
      throw codedEngineError('CA_FILE_INVALID', 'CA files must be regular files smaller than 1 MiB.');
    }
    const [key, pem] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
    const cert = new crypto.X509Certificate(pem);
    if (!cert.ca) throw codedEngineError('CERTIFICATE_IS_NOT_CA', 'The configured certificate is not a CA.');
    if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) {
      throw codedEngineError('CERTIFICATE_NOT_CURRENTLY_VALID', 'The CA is expired or not yet valid. Explicitly rotate it and reinstall trust.');
    }
    if (cert.publicKey.asymmetricKeyType === 'rsa' && cert.publicKey.asymmetricKeyDetails.modulusLength < 2048) {
      throw codedEngineError('CA_KEY_TOO_SMALL', 'The CA RSA key must be at least 2048 bits.');
    }
    if (!cert.checkPrivateKey(crypto.createPrivateKey(key))) {
      throw codedEngineError('CA_KEY_MISMATCH', 'The CA certificate and private key do not match.');
    }
    return cert;
  } catch (error) {
    if (error.code && !error.code.startsWith('ERR_OSSL') && !error.code.startsWith('ERR_CRYPTO')) throw error;
    throw codedEngineError('INVALID_CA_CERTIFICATE', 'Unable to parse the CA certificate or private key. Restore the pair or explicitly rotate it.');
  }
}

export async function rotateCA({ archivePrivateKey = false } = {}) {
  await fs.mkdir(CA_DIR, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(path.join(CA_DIR, 'authority'), {
    realpath: false, stale: 10_000, update: 2_000,
    retries: { retries: 60, minTimeout: 200, maxTimeout: 200, factor: 1 },
  });
  try {
    await recoverCaPair(CA_DIR);
    const readIfPresent = (file) => fs.readFile(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    const [oldKey, oldCert] = await Promise.all([readIfPresent(CA_KEY), readIfPresent(CA_CERT)]);
    let oldPairValid = false;
    try { await validateCA(CA_KEY, CA_CERT); oldPairValid = true; } catch { /* explicit repair may start with an invalid pair */ }
    let previousFingerprint = null;
    try { previousFingerprint = new crypto.X509Certificate(oldCert).fingerprint256.replaceAll(':', '').toLowerCase(); } catch { /* explicit repair of an incomplete/corrupt CA */ }
    // Generate before touching the working pair, under the same lock as ensureCA.
    const { key, cert } = await mockttp.generateCACertificate({ subject: { commonName: 'proxy-mate CA', organizationName: 'proxy-mate' } });
    const archive = oldKey || oldCert ? path.join(CA_DIR, 'archive', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`) : null;
    if (archive) {
      await fs.mkdir(archive, { recursive: true, mode: 0o700 });
      if (oldCert) await atomicWriteFile(path.join(archive, 'cert.pem'), oldCert, 0o600);
      if (archivePrivateKey && oldKey) await atomicWriteFile(path.join(archive, 'key.pem'), oldKey, 0o600);
    }
    try {
      await commitCaPair(CA_DIR, { key, cert });
      await validateCA(CA_KEY, CA_CERT);
    } catch (error) {
      // Rollback itself must be recoverable after a crash. If there was no
      // valid previous identity, keep the intended replacement journal.
      if (oldPairValid) await commitCaPair(CA_DIR, { key: oldKey.toString('utf8'), cert: oldCert.toString('utf8') });
      throw error;
    }
    const replacement = new crypto.X509Certificate(cert);
    return {
      rotated: Boolean(oldKey || oldCert), generated: true, archived: archive,
      archived_private_key: Boolean(archivePrivateKey && oldKey),
      previous_fingerprint_sha256: previousFingerprint,
      fingerprint_sha256: replacement.fingerprint256.replaceAll(':', '').toLowerCase(),
    };
  } finally { await release(); }
}

export class ProxyEngine {
  constructor({
    sessionStore = new SessionStore(),
    sessionId = 'default',
    webSocketStore,
    breakpointManager = new BreakpointManager({
      allowSensitive: readEnvironment('PROXY_MATE_ALLOW_SENSITIVE') === '1',
    }),
    storeSensitiveData = readEnvironment('PROXY_MATE_STORE_SENSITIVE') === '1',
    maxPendingPersistence = 2_000,
    failClosedOnPersistenceError = readEnvironment('PROXY_MATE_PERSISTENCE_FAIL_CLOSED') === '1',
    pluginStore = new PluginStore(),
    logWrite,
    caStat,
    bodyWorkerOptions,
  } = {}) {
    this.logWrite = logWrite;
    this.caStat = caStat;
    this.bodyWorkers = new BodyWorkerPool(bodyWorkerOptions);
    this.requestContexts = new Map();
    this.abortLog = limitedLog('proxy', 'request aborted', { write: logWrite });
    this.dropLog = limitedLog('proxy', 'connection dropped', { write: logWrite });
    this.server = null;
    this.port = null;
    this.flows = new Map();       // flow_id -> flow
    this.flowOrder = [];
    this.flowCacheSizes = new Map();
    this.flowCacheBytes = 0;
    this.maxFlowCacheBytes = 32 * 1024 * 1024;
    this.mockRules = new Map();   // rule_id -> { config, endpoint }
    this.ruleEndpointIds = new Map(); // mockttp endpoint id -> rule_id
    this.ruleMutation = Promise.resolve();
    this.lifecycleMutation = Promise.resolve();
    this.captureWork = new Map();
    this.captureDropped = 0;
    this.captureQueuedBytes = 0;
    this.maxCaptureQueuedBytes = 32 * 1024 * 1024;
    this.diagnostics = [];        // recent TLS/abort/client errors (ring buffer)
    this.maxDiagnostics = 100;
    this.recording = true;
    this.tlsPassthrough = [];
    this.allowRemote = false;
    this.allowedRemoteIps = [];
    this.remoteAccessExpiresAt = null;
    this.remoteAccessTimer = null;
    this.remoteSockets = new Set();
    this.sessionStore = sessionStore;
    this.sessionId = sessionId;
    this.flowPersistence = new Map();
    this.storeSensitiveData = Boolean(storeSensitiveData);
    if (webSocketStore) {
      this.webSocketStore = webSocketStore;
    } else {
      const durableBackend = new JsonlWebSocketStoreBackend(path.join(STATE_DIR, 'websocket-store.jsonl'));
      this.webSocketStore = new WebSocketStore({
        backend: {
          load: () => durableBackend.load(),
          save: (snapshot) => durableBackend.save(
            this.storeSensitiveData && this.captureBodyMode === 'all'
              ? snapshot
              : redactWebSocketSnapshotForStorage(snapshot),
          ),
        },
      });
    }
    this.webSocketStoreRestored = false;
    this.breakpoints = breakpointManager;
    this.maxPendingPersistence = Math.max(10, Math.min(Number(maxPendingPersistence) || 2_000, 10_000));
    this.persistenceHighWaterMark = 0;
    this.persistenceBackpressureWaits = 0;
    this.persistenceFailures = 0;
    this.persistenceConsecutiveFailures = 0;
    this.lastPersistenceError = null;
    this.failClosedOnPersistenceError = failClosedOnPersistenceError === true;
    this.persistenceFailClosedTriggered = false;
    this.captureBodyMode = 'text';
    this.pluginStore = pluginStore;
    this.socksEnabled = false;
    this.caCertPath = CA_CERT;
    this.caKeyPath = CA_KEY;
    this.upstreamProxyConfig = null;
    this.upstreamProxyPublicConfig = null;
  }

  start(options = {}) {
    const operation = this.lifecycleMutation.then(() => this.#start(options));
    this.lifecycleMutation = operation.catch(() => {});
    return operation;
  }

  async #start({
    port = 8080,
    tlsPassthrough = [],
    maxBodySize,
    allowRemote = false,
    allowedRemoteIps = [],
    remoteAccessTtlSeconds = 3600,
    captureBodyMode = 'text',
    enableSocks = false,
    caKeyPath = null,
    caCertPath = null,
    upstreamProxyConfig = null,
    upstreamProxyPublicConfig = null,
  } = {}) {
    if (this.server) {
      return { status: 'already_running', port: this.port };
    }
    const remotePolicy = buildRemoteAccessPolicy({ allowRemote, allowedRemoteIps, remoteAccessTtlSeconds });
    if (!['metadata_only', 'text', 'all'].includes(captureBodyMode)) {
      throw codedEngineError('INVALID_CAPTURE_BODY_MODE', 'capture_body_mode must be metadata_only, text, or all.');
    }
    if (captureBodyMode === 'all' && !this.storeSensitiveData) {
      throw codedEngineError('SENSITIVE_STORAGE_NOT_GRANTED', 'capture_body_mode=all requires PROXY_MATE_STORE_SENSITIVE=1.');
    }
    this.captureBodyMode = captureBodyMode;
    await this.pluginStore.init();
    this.breakpoints.reopen();
    await this.sessionStore.ensureSession({ id: this.sessionId, name: this.sessionId });
    await this.#hydrateSession();
    if (!this.webSocketStoreRestored && typeof this.webSocketStore.restore === 'function') {
      try { await this.webSocketStore.restore(); }
      catch (error) { this.#reportWebSocketPersistenceError('restore', error); }
      this.webSocketStoreRestored = true;
    }
    if ((caKeyPath == null) !== (caCertPath == null)) {
      throw codedEngineError('CUSTOM_CA_PAIR_REQUIRED', 'caKeyPath and caCertPath must be provided together.');
    }
    let keyPath;
    let certPath;
    if (caKeyPath != null) {
      [keyPath, certPath] = [path.resolve(caKeyPath), path.resolve(caCertPath)];
      await validateCustomCaPaths({ keyPath, certPath, stat: this.caStat });
    } else {
      ({ keyPath, certPath } = await ensureCA());
    }
    await validateCA(keyPath, certPath);
    const httpsOptions = { keyPath, certPath };
    if (Array.isArray(tlsPassthrough) && tlsPassthrough.length > 0) {
      httpsOptions.tlsPassthrough = tlsPassthrough.map((h) => ({ hostname: h }));
    }
    // We own bounded, redacted capture storage. Mockttp's default per-rule
    // history otherwise retains every raw request forever (including secrets).
    const opts = { https: httpsOptions, recordTraffic: false, suggestChanges: false };
    if (maxBodySize != null && (!Number.isSafeInteger(maxBodySize) || maxBodySize < 1 || maxBodySize > 50 * 1024 * 1024)) {
      throw codedEngineError('INVALID_BODY_LIMIT', 'maxBodySize must be between 1 byte and 50 MiB.');
    }
    this.maxBodySize = opts.maxBodySize = maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
    if (enableSocks === true) opts.socks = { authMethods: ['no-auth'] };
    else if (enableSocks !== false) throw codedEngineError('INVALID_SOCKS_CONFIGURATION', 'enableSocks must be a boolean.');
    await assertProxyPortAvailable(port);
    const server = mockttp.getLocal(opts);

    try {
      await server.start(port);
    } catch (e) {
      // Critical: do NOT keep `this.server` set if start failed. Issue #2.
      this.server = null;
      this.port = null;
      if (e?.code === 'EADDRINUSE') {
        const wrapped = new Error(`proxy port :${port} is busy — another process is listening (try \`proxy-mate doctor\` to inspect and clear orphans).`);
        wrapped.code = 'PROXY_PORT_BUSY';
        wrapped.cause = e;
        throw wrapped;
      }
      throw e;
    }

    this.server = server;
    let listener;
    try { listener = mockttpListener(server); }
    catch (error) { await server.stop(); this.server = null; throw error; }
    this.drainTracking = trackServer(listener);
    activeSocketSets.add(this.drainTracking.sockets);
    registerGauge('proxy.active_connections', activeConnections);
    listener.maxConnections = 128;
    listener.on('drop', () => { increment('proxy.connections_dropped'); this.dropLog({}); });
    this.port = server.port;
    this.socksEnabled = enableSocks === true;
    this.caCertPath = certPath;
    this.caKeyPath = keyPath;
    this.upstreamProxyConfig = upstreamProxyConfig;
    this.upstreamProxyPublicConfig = upstreamProxyPublicConfig;
    this.allowRemote = remotePolicy.enabled;
    this.allowedRemoteIps = remotePolicy.entries;
    this.remoteAccessExpiresAt = remotePolicy.expiresAt;
    // Mockttp exposes no listen-host option. Enforce access at the earliest
    // available socket hook, including when LAN access is enabled: loopback is
    // always accepted, while remote clients must match the explicit allowlist.
    server.server?.prependListener?.('connection', (socket) => {
      const address = normalizeRemoteAddress(socket.remoteAddress);
      if (isLoopbackAddress(address)) return;
      const remoteAllowed = this.allowRemote
        && (!this.remoteAccessExpiresAt || Date.now() < Date.parse(this.remoteAccessExpiresAt))
        && remotePolicy.allowlist.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
      if (!remoteAllowed) {
        socket.destroy();
        return;
      }
      this.remoteSockets.add(socket);
      socket.once('close', () => this.remoteSockets.delete(socket));
    });
    if (this.allowRemote) {
      this.remoteAccessTimer = setTimeout(
        () => this.revokeRemoteAccess('Remote access TTL expired.'),
        remotePolicy.ttlSeconds * 1000,
      );
      this.remoteAccessTimer.unref?.();
    }
    this.tlsPassthrough = [...tlsPassthrough];
    try {
      await this.#attachCaptureHandlers();
      await this.#attachWebSocketHandlers();
      await this.#attachDiagnosticHandlers();
      await this.#registerDefaultPassThroughs();
    } catch (error) {
      await this.#stop();
      throw error;
    }
    return {
      status: 'started', port: this.port, socks_enabled: this.socksEnabled,
      remote_access: this.remoteAccessStatus(), upstream_proxy: this.upstreamProxyPublicConfig,
    };
  }

  revokeRemoteAccess(_reason = 'Remote access revoked.') {
    if (this.remoteAccessTimer) clearTimeout(this.remoteAccessTimer);
    this.remoteAccessTimer = null;
    this.allowRemote = false;
    this.allowedRemoteIps = [];
    this.remoteAccessExpiresAt = null;
    for (const socket of this.remoteSockets) socket.destroy();
    this.remoteSockets.clear();
  }

  remoteAccessStatus() {
    return {
      enabled: this.allowRemote,
      allowed_ips: [...this.allowedRemoteIps],
      expires_at: this.remoteAccessExpiresAt,
      active_remote_connections: this.remoteSockets.size,
    };
  }

  stop(options = {}) {
    const operation = this.lifecycleMutation.then(async () => {
      try { return await this.#stop(options); }
      finally { await this.bodyWorkers.close(); }
    });
    this.lifecycleMutation = operation.catch(() => {});
    return operation;
  }

  async #stop({ graceMs = defaultDrainMs() } = {}) {
    await this.ruleMutation;
    // Resolve callbacks before asking Mockttp to stop, otherwise an intercepted
    // request can keep shutdown waiting for its breakpoint deadline. Closing
    // also prevents a last-millisecond request from creating a new pause.
    this.breakpoints.close({ reason: 'Proxy stopped while the breakpoint was pending.' });
    if (!this.server) {
      await this.#flushWebSocketStore();
      return { status: 'not_running' };
    }
    await new Promise((resolve) => setImmediate(resolve));
    if (graceMs > 0) {
      const summary = await drainServer(mockttpListener(this.server), { graceMs, ...this.drainTracking });
      logLine('proxy', 'drain completed', summary, { write: this.logWrite });
      // Public completion events are scheduled with setImmediate by mockttp.
      await new Promise(resolve => setImmediate(resolve));
    }
    try { await this.server.stop(); } catch (error) {
      // destroyable-server rejects the second close after a successful drain.
      if (error.code === 'ERR_SERVER_NOT_RUNNING') this.server.reset();
    }
    this.drainTracking?.dispose();
    activeSocketSets.delete(this.drainTracking?.sockets);
    this.drainTracking = null;
    this.requestContexts.clear();
    this.abortLog.flush(); this.dropLog.flush();
    await Promise.allSettled([...this.captureWork.values()]);
    await Promise.allSettled([...this.flowPersistence.values()]);
    await this.#flushWebSocketStore();
    this.server = null;
    this.port = null;
    this.socksEnabled = false;
    this.tlsPassthrough = [];
    this.upstreamProxyConfig = null;
    this.upstreamProxyPublicConfig = null;
    this.revokeRemoteAccess('Proxy stopped.');
    this.mockRules.clear();
    this.ruleEndpointIds.clear();
    return { status: 'stopped' };
  }

  isRunning() { return !!this.server; }

  // ---- capture ----
  async #attachCaptureHandlers() {
    await this.server.on('request', (req) => {
      this.#rememberRequest(req.id, req);
      increment('proxy.bytes', req.body?.buffer?.length ?? 0);
      return this.#queueCapture(req.id, async () => {
        this.#recordRuleHit(req.matchedRuleId);
        if (!this.recording) return;
        const reqBody = await this.#bodyToBuffer(req.body);
        const rawCaptureEnabled = this.storeSensitiveData && this.captureBodyMode === 'all';
        const stored = await this.bodyWorkers.process({ buffer: reqBody, headers: req.headers, flowId: req.id, kind: 'req', storeSensitiveData: rawCaptureEnabled, captureBodyMode: this.captureBodyMode, maxBodySize: this.maxBodySize });
        const flow = this.flows.get(req.id) ?? {
          id: req.id, timestamp: Date.now(), request: null, response: null,
        };
        flow.request = {
            method: req.method,
            url: rawCaptureEnabled ? req.url : redactUrl(req.url),
            protocol: req.protocol,
            http_version: req.httpVersion ?? req.http_version ?? null,
            hostname: req.hostname,
            path: rawCaptureEnabled ? req.path : redactUrl(req.path),
            headers: rawCaptureEnabled ? req.headers : redactHeaders(req.headers),
            body_inline: stored.inline,
            body_path: stored.path,
            body_size: stored.size,
            body_sha: stored.sha,
            body_encoding: stored.encoding,
            body_original_size: stored.original_size,
            body_redacted_at_capture: stored.redacted,
            body_omitted: stored.omitted,
            body_decoded: stored.decoded ?? false,
            matched_rule_id: this.ruleEndpointIds.get(req.matchedRuleId) ?? null,
            remote_ip: req.remoteIpAddress ?? req.remote_ip ?? null,
            remote_port: req.remotePort ?? req.remote_port ?? null,
            timing: jsonSafe(req.timingEvents),
            trailers: rawCaptureEnabled ? jsonSafe(req.trailers ?? null) : redactHeaders(jsonSafe(req.trailers ?? null)),
        };
        this.#rememberFlow(flow);
        await this.#persistFlow(flow);
      }, req.body?.buffer?.length ?? 0);
    });
    await this.server.on('response', (res) => {
      increment('proxy.flows_completed');
      increment('proxy.bytes', res.body?.buffer?.length ?? 0);
      this.requestContexts.delete(res.id);
      return this.#queueCapture(res.id, async () => {
        if (!this.recording) return;
        const resBody = await this.#bodyToBuffer(res.body);
        const rawCaptureEnabled = this.storeSensitiveData && this.captureBodyMode === 'all';
        const stored = await this.bodyWorkers.process({ buffer: resBody, headers: res.headers, flowId: res.id, kind: 'res', storeSensitiveData: rawCaptureEnabled, captureBodyMode: this.captureBodyMode, maxBodySize: this.maxBodySize });
        const existing = await this.getDurableFlow(res.id) ?? { id: res.id, timestamp: Date.now(), request: null };
        existing.response = {
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          tags: upstreamErrorTags(res.tags),
          upstream_error: upstreamErrorFromTags(res.tags),
          http_version: res.httpVersion ?? res.http_version ?? null,
          headers: rawCaptureEnabled ? res.headers : redactHeaders(res.headers),
          trailers: rawCaptureEnabled ? jsonSafe(res.trailers ?? null) : redactHeaders(jsonSafe(res.trailers ?? null)),
          timing: jsonSafe(res.timingEvents),
          remote_ip: res.remoteIpAddress ?? res.remote_ip ?? null,
          remote_port: res.remotePort ?? res.remote_port ?? null,
          body_inline: stored.inline,
          body_path: stored.path,
          body_size: stored.size,
          body_sha: stored.sha,
          body_encoding: stored.encoding,
          body_original_size: stored.original_size,
          body_redacted_at_capture: stored.redacted,
          body_omitted: stored.omitted,
          body_decoded: stored.decoded ?? false,
        };
        this.#rememberFlow(existing);
        await this.#persistFlow(existing);
      }, res.body?.buffer?.length ?? 0);
    });
  }

  #queueCapture(id, capture, bytes = 0) {
    // Mockttp emits asynchronously and does not await our listener promises.
    // Bound work BEFORE body conversion, and serialize both halves of a flow.
    if ((!this.captureWork.has(id) && this.captureWork.size >= 100) || this.captureQueuedBytes + bytes > this.maxCaptureQueuedBytes) {
      this.captureDropped += 1;
      increment('proxy.capture_dropped');
      return;
    }
    this.captureQueuedBytes += bytes;
    const operation = (this.captureWork.get(id) ?? Promise.resolve()).then(capture).catch((error) => {
      this.persistenceFailures += 1;
      this.lastPersistenceError = { timestamp: Date.now(), flow_id: id, code: error?.code ?? 'CAPTURE_FAILED', message: error?.message ?? String(error) };
      this.diagnostics.push({ kind: 'capture-error', ...this.lastPersistenceError });
      if (this.diagnostics.length > this.maxDiagnostics) this.diagnostics.shift();
      if (this.failClosedOnPersistenceError) {
        this.recording = false;
        setImmediate(() => this.stop().catch(() => {}));
      }
    }).finally(() => {
      this.captureQueuedBytes -= bytes;
      if (this.captureWork.get(id) === operation) this.captureWork.delete(id);
    });
    this.captureWork.set(id, operation);
  }

  #rememberRequest(id, data) {
    if (!id) return;
    let url;
    try { url = new URL(data.url); } catch { /* head events provide hostname */ }
    const previous = this.requestContexts.get(id);
    this.requestContexts.set(id, {
      method: data.method ?? previous?.method,
      host: data.hostname ?? url?.hostname ?? previous?.host,
      port: data.port ?? (url ? Number(url.port || (url.protocol === 'https:' ? 443 : 80)) : previous?.port),
      startedAt: previous?.startedAt ?? Date.now(),
      aborted: previous?.aborted ?? false,
    });
    if (this.requestContexts.size > 2048) this.requestContexts.delete(this.requestContexts.keys().next().value);
  }

  #requestAborted(id, data) {
    if (!this.requestContexts.has(id)) this.#rememberRequest(id, data);
    const context = this.requestContexts.get(id);
    if (context?.aborted) return; // abort and passthrough-abort can describe the same failure
    if (context) context.aborted = true;
    increment('proxy.requests_aborted');
    this.abortLog({ flow_id: id, method: context?.method, host: context?.host, port: context?.port,
      error_code: data.error?.code ?? null, downstream_aborted: data.downstreamAborted ?? true,
      elapsed_ms: Math.max(0, Date.now() - (context?.startedAt ?? Date.now())) });
  }

  async #attachDiagnosticHandlers() {
    const push = (kind, evt) => {
      const rec = { kind, timestamp: Date.now(), ...evt };
      this.diagnostics.push(rec);
      if (this.diagnostics.length > this.maxDiagnostics) {
        this.diagnostics.splice(0, this.diagnostics.length - this.maxDiagnostics);
      }
    };
    await this.server.on('rule-event', (event) => {
      if (event.eventType === 'passthrough-request-head') this.#rememberRequest(event.requestId, event.eventData);
      if (event.eventType === 'passthrough-abort') this.#requestAborted(event.requestId, event.eventData);
      const diagnostic = upstreamErrorDiagnostic(event);
      if (diagnostic) push('upstream-error', {
        ...diagnostic, connection_attempt_timeout_ms: activeConnectionAttemptTimeout(),
      });
    });
    try {
      await this.server.on('tls-client-error', (e) => push('tls-client-error', {
        failureCause: e?.failureCause,
        sniHostname: e?.tlsMetadata?.sniHostname,
        ja3Fingerprint: e?.tlsMetadata?.ja3Fingerprint,
        ja4Fingerprint: e?.tlsMetadata?.ja4Fingerprint,
        timing: e?.timingEvents,
      }));
    } catch { /* event not supported in this mockttp build */ }
    try {
      await this.server.on('client-error', (e) => push('client-error', {
        errorCode: e?.errorCode,
        message: e?.error?.message,
        request: e?.request && {
          method: e.request.method,
          url: redactDiagnosticUrl(e.request.url),
          headers: redactDiagnosticHeaders(e.request.headers),
        },
      }));
    } catch { /* ignore */ }
    try {
      await this.server.on('abort', (e) => push('abort', {
        id: e?.id,
        method: e?.method,
        url: redactUrl(e?.url),
        error: e?.error && { message: e.error.message, code: e.error.code },
      }));
      await this.server.on('abort', (e) => {
        this.#requestAborted(e?.id, e);
        try { this.webSocketStore.onError({ streamId: e?.id, error: e?.error, timingEvents: e?.timingEvents }); } catch { /* not a correlated WebSocket */ }
      });
    } catch { /* ignore */ }
    try {
      await this.server.on('tls-passthrough-opened', (e) => push('tls-passthrough-opened', {
        sniHostname: e?.tlsMetadata?.sniHostname,
        remoteIpAddress: e?.remoteIpAddress,
      }));
    } catch { /* ignore */ }
  }

  async #attachWebSocketHandlers() {
    for (const [event, handler] of Object.entries(mockttpWebSocketHandlers(this.webSocketStore))) {
      try {
        await this.server.on(event, async (payload) => {
          handler(payload);
          await this.#flushWebSocketStore();
        });
      } catch { /* feature unavailable in this Mockttp build */ }
    }
  }

  async #flushWebSocketStore() {
    if (typeof this.webSocketStore.flush !== 'function') return;
    try { await this.webSocketStore.flush(); }
    catch (error) { this.#reportWebSocketPersistenceError('write', error); }
  }

  #reportWebSocketPersistenceError(operation, error) {
    this.diagnostics.push({
      kind: 'websocket-store-error', operation, timestamp: Date.now(),
      code: error?.code ?? 'WEBSOCKET_PERSISTENCE_FAILED', message: error?.message ?? String(error),
    });
    if (this.diagnostics.length > this.maxDiagnostics) {
      this.diagnostics.splice(0, this.diagnostics.length - this.maxDiagnostics);
    }
  }

  async #bodyToBuffer(body) {
    if (!body) return Buffer.alloc(0);
    try {
      // Prefer the already-buffered representation; mockttp exposes
      // CompletedBody.buffer synchronously.
      if (body.buffer) return Buffer.from(body.buffer);
      if (typeof body.getText === 'function') {
        const t = await body.getText();
        return Buffer.from(t ?? '', 'utf8');
      }
    } catch { /* ignore */ }
    return Buffer.alloc(0);
  }

  #rememberFlow(flow) {
    const isNew = !this.flows.has(flow.id);
    if (isNew && this.flows.size === 0) { this.flowCacheSizes.clear(); this.flowCacheBytes = 0; }
    const size = Buffer.byteLength(JSON.stringify(flow)) * 2;
    this.flowCacheBytes += size - (this.flowCacheSizes.get(flow.id) ?? 0);
    this.flowCacheSizes.set(flow.id, size);
    this.flows.set(flow.id, flow);
    if (isNew) this.flowOrder.push(flow.id);
    while (this.flowOrder.length > MAX_FLOWS || this.flowCacheBytes > this.maxFlowCacheBytes) {
      const stale = this.flowOrder.shift();
      this.flowCacheBytes -= this.flowCacheSizes.get(stale) ?? 0;
      this.flowCacheSizes.delete(stale);
      this.flows.delete(stale);
    }
  }

  async clearFlows() {
    const priorIds = [];
    let cursor = null;
    do {
      const page = await this.sessionStore.listFlows({ sessionId: this.sessionId, cursor, limit: 1000 });
      priorIds.push(...page.flows.map((flow) => flow.id));
      cursor = page.next_cursor;
    } while (cursor);
    await Promise.allSettled([...this.flowPersistence.values()]);
    this.flows.clear();
    this.flowOrder.length = 0;
    this.flowPersistence.clear();
    this.flowCacheSizes.clear();
    this.flowCacheBytes = 0;
    await this.sessionStore.purgeSession(this.sessionId);
    await this.sessionStore.createSession({ id: this.sessionId, name: this.sessionId });
    await Promise.all(priorIds.map((id) => deleteFlowBodies(id)));
    return { purged: priorIds.length, session_id: this.sessionId };
  }

  async setActiveSession(sessionId, { name, create = true } = {}) {
    if (this.server) throw codedEngineError('SESSION_SWITCH_REQUIRES_STOPPED_PROXY', 'Stop the proxy before changing the active capture session.');
    const existing = await this.sessionStore.getSession(sessionId);
    if (!existing && !create) throw codedEngineError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    if (!existing) await this.sessionStore.createSession({ id: sessionId, name: name ?? sessionId });
    this.sessionId = sessionId;
    this.flows.clear();
    this.flowOrder.length = 0;
    this.flowPersistence.clear();
    await this.#hydrateSession();
    return this.sessionStore.getSession(sessionId);
  }

  async listDurableFlows(options = {}) {
    return this.sessionStore.listFlows({ sessionId: options.session_id ?? this.sessionId, ...options });
  }

  async getDurableFlow(flowId, sessionId = this.sessionId) {
    return (sessionId === this.sessionId ? this.flows.get(flowId) : null) ?? this.sessionStore.getFlow({ sessionId, flowId });
  }

  async #hydrateSession() {
    this.flows.clear();
    this.flowOrder.length = 0;
    this.flowCacheSizes.clear();
    this.flowCacheBytes = 0;
    let cursor = null;
    do {
      const page = await this.sessionStore.listFlows({ sessionId: this.sessionId, cursor, limit: 50 });
      for (const flow of page.flows) this.#rememberFlow(flow);
      cursor = page.next_cursor;
    } while (cursor);
  }

  async #persistFlow(flow) {
    const id = flow.id;
    while (!this.flowPersistence.has(id) && this.flowPersistence.size >= this.maxPendingPersistence) {
      this.persistenceBackpressureWaits += 1;
      await Promise.race(this.flowPersistence.values());
    }
    const previous = this.flowPersistence.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const existing = await this.sessionStore.getFlow({ sessionId: this.sessionId, flowId: id });
      const result = existing
        ? await this.sessionStore.updateFlow({ sessionId: this.sessionId, flowId: id, patch: flow })
        : await this.sessionStore.appendFlow({ sessionId: this.sessionId, flow });
      await Promise.all((result.retention?.removed_flow_ids ?? []).map((removedId) => deleteFlowBodies(removedId)));
      this.persistenceConsecutiveFailures = 0;
    }).catch((error) => {
      this.persistenceFailures += 1;
      this.persistenceConsecutiveFailures += 1;
      this.lastPersistenceError = {
        timestamp: Date.now(), flow_id: id, code: error?.code ?? 'SESSION_STORE_ERROR', message: error?.message ?? String(error),
      };
      this.diagnostics.push({ kind: 'session-store-error', ...this.lastPersistenceError });
      if (this.diagnostics.length > this.maxDiagnostics) {
        this.diagnostics.splice(0, this.diagnostics.length - this.maxDiagnostics);
      }
      if (this.failClosedOnPersistenceError) {
        this.recording = false;
        if (!this.persistenceFailClosedTriggered) {
          this.persistenceFailClosedTriggered = true;
          setImmediate(() => this.stop().catch((stopError) => {
            this.diagnostics.push({
              kind: 'persistence-fail-closed-stop-error', timestamp: Date.now(),
              code: stopError?.code, message: stopError?.message ?? String(stopError),
            });
          }));
        }
      }
    }).finally(() => {
      if (this.flowPersistence.get(id) === next) this.flowPersistence.delete(id);
    });
    this.flowPersistence.set(id, next);
    this.persistenceHighWaterMark = Math.max(this.persistenceHighWaterMark, this.flowPersistence.size);
    return await next;
  }
  persistenceHealth() {
    return {
      ok: this.persistenceConsecutiveFailures === 0,
      fail_closed: this.failClosedOnPersistenceError,
      fail_closed_triggered: this.persistenceFailClosedTriggered,
      failures_total: this.persistenceFailures,
      consecutive_failures: this.persistenceConsecutiveFailures,
      last_error: this.lastPersistenceError && { ...this.lastPersistenceError },
      queue_depth: this.flowPersistence.size,
      queue_limit: this.maxPendingPersistence,
      queue_high_water_mark: this.persistenceHighWaterMark,
      backpressure_waits: this.persistenceBackpressureWaits,
    };
  }
  clearDiagnostics() { this.diagnostics.length = 0; }
  setRecording(enabled) {
    const previous = this.recording;
    this.recording = Boolean(enabled);
    return { previous, recording: this.recording };
  }

  // ---- mock rule registration ----
  // Mockttp 3.x does not expose per-endpoint removal. Mutations therefore
  // replace the complete active rule set, with validation before reset and a
  // rollback if installation unexpectedly fails. The mutation queue prevents
  // concurrent MCP calls from interleaving two rebuilds.
  async registerRule(rule) {
    return this.#mutateRules(() => this.#registerRuleUnlocked(rule));
  }

  async #registerRuleUnlocked(rule) {
    this.#assertRunning();
    if (rule?.type === 'plugin_transform') {
      // Every registration path — tool call, startup replay, rule import —
      // funnels through here, so the live grant is enforced once at the choke
      // point instead of per caller. Stage validity is checked before the
      // grant: a websocket_offline plugin is never a valid live rule stage,
      // grant or no grant, so that diagnosis must win over the grant error.
      // Only a plugin that could otherwise run live (request/response) is
      // gated behind PROXY_MATE_ENABLE_TRANSFORM_PLUGINS.
      const plugin = await this.pluginStore.get(rule.plugin_id);
      if (!plugin) throw codedEngineError('PLUGIN_NOT_FOUND', `Plugin was not found: ${rule.plugin_id}`);
      if (!plugin.enabled) throw codedEngineError('PLUGIN_DISABLED', `Plugin is disabled: ${rule.plugin_id}`);
      if (!['request', 'response'].includes(plugin.stage)) {
        throw codedEngineError('PLUGIN_STAGE_MISMATCH', 'Live plugin rules require a request or response plugin.');
      }
      if (!liveTransformGrantEnabled()) {
        throw codedEngineError(
          'TRANSFORM_PLUGINS_NOT_ENABLED',
          `Live transform plugin rules require ${TRANSFORM_PLUGIN_GRANT_ENV}=1 on the server.`,
        );
      }
      if (rule.plugin_stage != null && rule.plugin_stage !== plugin.stage) {
        throw codedEngineError('PLUGIN_STAGE_MISMATCH', `Plugin ${plugin.id} is registered for ${plugin.stage}, not ${rule.plugin_stage}.`);
      }
      rule = { ...rule, plugin_stage: plugin.stage };
    }
    const old = this.mockRules.get(rule?.rule_id);
    const prepared = await prepareRuleConfig(rule, {
      existing: old?.config,
      nextOrder: nextRuleOrder(this.mockRules),
    });
    const previous = this.listRuleConfigs();
    const next = previous.filter((item) => item.rule_id !== prepared.config.rule_id);
    next.push(prepared.config);
    try {
      await this.#replaceRuleSet(next, previous);
    } catch (error) {
      if (prepared.createdBody) await removeOwnedMockBody(prepared.config.body_file);
      throw error;
    }
    if (old?.config?.body_file !== prepared.config.body_file
      && !this.listRuleConfigs().some((rule) => rule.body_file === old?.config?.body_file)) {
      await removeOwnedMockBody(old?.config?.body_file);
    }
    return cloneRuleConfig(prepared.config);
  }

  async updateRule(ruleId, patch = {}) {
    return this.#mutateRules(async () => {
      this.#assertRunning();
      const old = this.mockRules.get(ruleId);
      if (!old) return null;
      const merged = mergeRulePatch(old.config, patch, ruleId);
      return this.#registerRuleUnlocked(merged);
    });
  }

  async setRuleEnabled(ruleId, enabled) {
    return this.updateRule(ruleId, { enabled: Boolean(enabled) });
  }

  async setRulePriority(ruleId, priority) {
    return this.updateRule(ruleId, { priority });
  }

  async reorderRules(ruleIds) {
    return this.#mutateRules(async () => {
      this.#assertRunning();
      if (!Array.isArray(ruleIds)) throw new Error('rule_ids must be an array');
      const unique = new Set(ruleIds);
      if (unique.size !== ruleIds.length) throw new Error('rule_ids cannot contain duplicates');
      for (const id of ruleIds) {
        if (!this.mockRules.has(id)) throw new Error(`rule not found: ${id}`);
      }
      const previous = this.listRuleConfigs();
      const ordered = [
        ...ruleIds.map((id) => previous.find((rule) => rule.rule_id === id)),
        ...previous.filter((rule) => !unique.has(rule.rule_id)),
      ].map((rule, order) => ({ ...rule, order }));
      await this.#replaceRuleSet(ordered, previous);
      return this.listRuleConfigs();
    });
  }

  async removeRule(ruleId) {
    return this.#mutateRules(async () => {
      this.#assertRunning();
      const removed = this.mockRules.get(ruleId);
      if (!removed) return false;
      const previous = this.listRuleConfigs();
      const next = previous.filter((rule) => rule.rule_id !== ruleId);
      await this.#replaceRuleSet(next, previous);
      if (!next.some((rule) => rule.body_file === removed.config?.body_file)) await removeOwnedMockBody(removed.config?.body_file);
      return true;
    });
  }

  async clearRules() {
    return this.#mutateRules(async () => {
      this.#assertRunning();
      const previous = this.listRuleConfigs();
      await this.#replaceRuleSet([], previous);
      for (const rule of previous) await removeOwnedMockBody(rule.body_file);
    });
  }

  listRuleConfigs() {
    return Array.from(this.mockRules.values())
      .map((entry) => cloneRuleConfig(entry.config))
      .sort(compareRules);
  }

  explainRuleMatch(request = {}, { rule_id: onlyRuleId } = {}) {
    const normalizedRequest = normalizeDryRunRequest(request);
    const evaluations = this.listRuleConfigs()
      .filter((rule) => !onlyRuleId || rule.rule_id === onlyRuleId)
      .map((rule) => evaluateRule(rule, normalizedRequest));
    const selected = evaluations.find((evaluation) => evaluation.matched);
    return {
      dry_run: true,
      request: normalizedRequest.summary,
      matched: Boolean(selected),
      selected_rule_id: selected?.rule_id ?? null,
      evaluations,
    };
  }

  testRuleMatch(ruleId, request = {}) {
    return this.explainRuleMatch(request, { rule_id: ruleId });
  }

  #assertRunning() {
    if (!this.server) throw new Error('Proxy is not running. Call start_proxy first.');
  }

  #mutateRules(task) {
    const run = this.ruleMutation.then(task, task);
    this.ruleMutation = run.catch(() => {});
    return run;
  }

  async #replaceRuleSet(nextConfigs, rollbackConfigs) {
    try {
      await this.#installRuleSet(nextConfigs);
    } catch (error) {
      try {
        await this.#installRuleSet(rollbackConfigs);
      } catch (rollbackError) {
        const combined = new Error(`Rule update failed and rollback could not restore the prior rules: ${error.message}; rollback: ${rollbackError.message}`);
        combined.code = 'RULE_ROLLBACK_FAILED';
        combined.cause = error;
        throw combined;
      }
      throw error;
    }
  }

  async #installRuleSet(configs) {
    // Compile through a detached public builder sink, then swap all HTTP rules
    // in one setRequestRules call. Leave subscriptions, WS and pauses intact.
    const compiler = mockttp.getLocal({ recordTraffic: false });
    const definitions = [];
    compiler.addRequestRules = async (...rules) => {
      definitions.push(...rules);
      return rules.map(() => ({ id: crypto.randomUUID() }));
    };
    const sorted = configs.map(cloneRuleConfig).sort(compareRules);
    const enabled = sorted.filter((rule) => rule.enabled);
    for (let index = 0; index < enabled.length; index++) {
      await this.#registerEndpoint(enabled[index], enabled.length - index + 1, compiler);
    }
    await compiler.forUnmatchedRequest().thenPassThrough(proxyPassThroughOptions(this.upstreamProxyConfig));
    const endpoints = await this.server.setRequestRules(...definitions);
    const entries = new Map();
    const endpointIds = new Map();
    for (const config of sorted) {
      const endpoint = config.enabled ? endpoints[enabled.indexOf(config)] : null;
      if (endpoint) endpointIds.set(endpoint.id, config.rule_id);
      entries.set(config.rule_id, { config, endpoint });
    }
    this.mockRules = entries;
    this.ruleEndpointIds = endpointIds;
  }

  async #registerDefaultPassThroughs() {
    const options = proxyPassThroughOptions(this.upstreamProxyConfig);
    await this.server.forUnmatchedRequest().thenPassThrough(options);
    // WebSocket matching is separate from HTTP request matching in Mockttp.
    // A dedicated catch-all preserves normal WS pass-through and applies the
    // same upstream chain when configured. It does not imply frame mutation.
    if (typeof this.server.forAnyWebSocket === 'function') {
      await this.server.forAnyWebSocket().thenPassThrough(options);
    }
  }

  async #registerEndpoint(rule, runtimePriority, ruleServer = this.server) {
    const regex = compileSafeRegex(rule.url_pattern, 'url_pattern');
    let builder = methodBuilder(ruleServer, rule.method, regex).asPriority(runtimePriority);
    if (rule.match_headers) builder = builder.withHeaders(rule.match_headers);
    if (rule.match_query) builder = builder.withQuery(rule.match_query);
    if (rule.match_json_body_including) builder = builder.withJsonBodyIncluding(rule.match_json_body_including);
    if (rule.match_body_regex) builder = builder.withBody(compileSafeRegex(rule.match_body_regex, 'match_body_regex'));

    if (rule.fault === 'timeout') return builder.thenTimeout();
    if (rule.fault === 'close') {
      return rule.delay_ms
        ? builder.thenCallback(async () => { await waitMs(rule.delay_ms); return 'close'; })
        : builder.thenCloseConnection();
    }
    if (rule.fault === 'reset') {
      return rule.delay_ms
        ? builder.thenCallback(async () => { await waitMs(rule.delay_ms); return 'reset'; })
        : builder.thenResetConnection();
    }

    if (rule.type === 'breakpoint') {
      const directions = rule.breakpoint_direction === 'both'
        ? { request: true, response: true }
        : {
            request: rule.breakpoint_direction === 'request',
            response: rule.breakpoint_direction === 'response',
          };
      return builder.thenPassThrough({
        ...proxyPassThroughOptions(this.upstreamProxyConfig),
        ...createMockttpBreakpointCallbacks(this.breakpoints, {
          ruleId: rule.rule_id,
          ...directions,
          timeoutMs: rule.breakpoint_timeout_ms,
          defaultAction: rule.breakpoint_default_action,
        }),
      });
    }
    if (rule.type === 'map_remote') return registerMapRemote(builder, rule, this.upstreamProxyConfig);
    if (rule.type === 'network_condition') return registerPassThroughRule(builder, rule, this.upstreamProxyConfig);
    if (rule.type === 'plugin_transform') {
      return registerPluginTransformRule(builder, rule, this.pluginStore, this.upstreamProxyConfig, (error) => {
        this.diagnostics.push({
          kind: 'transform-plugin-error', timestamp: Date.now(), rule_id: rule.rule_id,
          plugin_id: rule.plugin_id, code: error?.code ?? 'TRANSFORM_FAILED', message: error?.message ?? String(error),
        });
        if (this.diagnostics.length > this.maxDiagnostics) this.diagnostics.shift();
      });
    }
    if (rule.type === 'blacklist') {
      if (rule.delay_ms) {
        return builder.thenCallback(async () => {
          await waitMs(rule.delay_ms);
          return {
            statusCode: rule.status,
            body: rule.body_inline,
            headers: { 'content-type': rule.content_type, ...rule.headers },
          };
        });
      }
      return builder.thenReply(rule.status, rule.body_inline ?? rule.body ?? 'Blocked by proxy-mate', {
        'content-type': rule.content_type ?? 'text/plain; charset=utf-8',
        ...rule.headers,
      });
    }
    if (rule.directory) return registerDirectoryMap(builder, rule, this.upstreamProxyConfig);
    if (rule.delay_ms) {
      return builder.thenCallback(async () => {
        await waitMs(rule.delay_ms);
        return {
          statusCode: rule.status,
          body: await fs.readFile(rule.body_file),
          headers: { 'content-type': rule.content_type, ...rule.headers },
        };
      });
    }
    return builder.thenFromFile(rule.status, rule.body_file, {
      'content-type': rule.content_type,
      ...rule.headers,
    });
  }

  #recordRuleHit(endpointId) {
    const ruleId = this.ruleEndpointIds.get(endpointId);
    if (!ruleId) return;
    const entry = this.mockRules.get(ruleId);
    if (!entry) return;
    entry.config.hit_count = (entry.config.hit_count ?? 0) + 1;
    entry.config.last_hit = new Date().toISOString();
  }
}

async function prepareRuleConfig(input, { existing, nextOrder }) {
  if (!input || typeof input !== 'object') throw new Error('rule must be an object');
  const ruleId = input.rule_id;
  if (typeof ruleId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(ruleId)) {
    throw new Error('rule_id must contain only letters, numbers, dot, underscore, or hyphen (1-128 characters)');
  }
  const type = input.type ?? 'map_local';
  if (!['map_local', 'map_remote', 'blacklist', 'network_condition', 'breakpoint', 'plugin_transform'].includes(type)) {
    throw new Error(`unsupported rule type: ${type}`);
  }
  // `url` is the friendly surface, and the rule-creating tools convert it up
  // front — but an update_rule patch, an imported rule and a replayed rule all
  // arrive here unconverted, where url_pattern and match_query are the only
  // fields read. Converting at the choke point means a patched url retargets
  // the rule instead of being silently dropped.
  if (input.url != null && input.url_pattern == null) {
    input = { ...input, ...ruleUrlMatchers(input.url, input) };
  }
  compileSafeRegex(input.url_pattern, 'url_pattern');
  const method = String(input.method ?? 'ANY').toUpperCase();
  if (!['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
    throw new Error(`unsupported HTTP method: ${method}`);
  }
  const status = input.status ?? (type === 'blacklist' ? 403 : 200);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error('status must be an integer from 100 to 599');
  }
  const priority = input.priority ?? existing?.priority ?? 0;
  if (!Number.isInteger(priority) || priority < -10_000 || priority > 10_000) {
    throw new Error('priority must be an integer from -10000 to 10000');
  }
  const order = input.order ?? existing?.order ?? nextOrder;
  if (!Number.isInteger(order) || order < 0) throw new Error('order must be a non-negative integer');
  const delayMs = input.delay_ms ?? input.delay ?? 0;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 300_000) {
    throw new Error('delay_ms must be an integer from 0 to 300000');
  }
  const fault = input.fault ?? null;
  if (fault != null && !['timeout', 'close', 'reset'].includes(fault)) {
    throw new Error('fault must be timeout, close, or reset');
  }
  if (type === 'breakpoint' && fault != null) {
    throw new Error('breakpoint rules cannot also configure a fault');
  }
  const breakpointDirection = input.direction ?? input.breakpoint_direction ?? existing?.breakpoint_direction ?? 'request';
  if (!['request', 'response', 'both'].includes(breakpointDirection)) {
    throw new Error('breakpoint direction must be request, response, or both');
  }
  const breakpointTimeoutMs = input.timeout_ms ?? input.breakpoint_timeout_ms
    ?? existing?.breakpoint_timeout_ms ?? 30_000;
  if (!Number.isInteger(breakpointTimeoutMs) || breakpointTimeoutMs < 10 || breakpointTimeoutMs > 300_000) {
    throw new Error('breakpoint timeout_ms must be an integer from 10 to 300000');
  }
  const breakpointDefaultAction = input.default_action ?? input.breakpoint_default_action
    ?? existing?.breakpoint_default_action ?? 'continue';
  if (!['continue', 'abort', 'close', 'reset'].includes(breakpointDefaultAction)) {
    throw new Error('breakpoint default_action must be continue, abort, close, or reset');
  }
  validateHeaders(input.headers, 'headers');
  validateHeaders(input.match_headers, 'match_headers', { matcher: true });
  validateMatchQuery(input.match_query);
  // Top-level only: mockttp matches this with _.isMatch, so an empty object at
  // the root matches every JSON-bodied request. A nested empty object is still
  // permissive; see docs/CAPABILITIES.md.
  validateMatcherObject(input.match_json_body_including, 'match_json_body_including', {
    code: 'MATCH_JSON_BODY',
    invalidMessage: 'match_json_body_including must be an object of JSON fields',
    invalidRecovery: [
      'Pass match_json_body_including as {"field": value}; it matches a subset of the request JSON.',
      'Omit match_json_body_including entirely for no body constraint.',
    ],
    emptyMessage: 'match_json_body_including has no fields, and an empty body matcher matches every JSON request',
    emptyRecovery: [
      'Omit match_json_body_including entirely for no body constraint.',
      'Name at least one field, e.g. {"action": "checkout"}.',
      'A rule written, imported, or stored before this guard can carry match_json_body_including: {} meaning "any JSON body"; re-create it with the fields it meant to constrain.',
    ],
  });
  if (input.match_body_regex) compileSafeRegex(input.match_body_regex, 'match_body_regex');

  const requestTransform = normalizeTransform(input.request_transform ?? requestTransformFromFlatFields(input), 'request');
  const responseTransform = normalizeTransform(input.response_transform ?? responseTransformFromFlatFields(input), 'response');
  if (type === 'breakpoint' && (delayMs !== 0 || requestTransform || responseTransform)) {
    throw new Error('breakpoint rules cannot combine delay or static request/response transforms; resolve each pause explicitly');
  }
  const pluginId = input.plugin_id ?? null;
  const pluginStage = input.plugin_stage ?? null;
  if (type === 'plugin_transform') {
    if (typeof pluginId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(pluginId)) {
      throw new Error('plugin_transform rules require a valid plugin_id');
    }
    if (!['request', 'response'].includes(pluginStage)) {
      throw new Error('plugin_transform rules require plugin_stage request or response');
    }
    if (delayMs !== 0 || fault != null || requestTransform || responseTransform) {
      throw new Error('plugin_transform rules cannot combine delay, faults, or static transforms');
    }
  }
  let bodyFile = input.body_file ?? null;
  let directory = input.directory ?? input.body_directory ?? null;
  let createdBody = false;

  let remoteTarget = null;
  if (type === 'map_remote') {
    if (!input.to_url) throw new Error('to_url is required for map_remote');
    remoteTarget = parseHttpUrl(input.to_url, 'to_url');
  } else if (type === 'map_local' && directory) {
    directory = path.resolve(directory);
    const stat = await fs.stat(directory).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`directory does not exist or is not a directory: ${directory}`);
    directory = await fs.realpath(directory);
  } else if (type === 'map_local') {
    if (!bodyFile) {
      bodyFile = await writeMockBody(ruleId, input.body_inline ?? input.body ?? '');
      createdBody = true;
    } else {
      bodyFile = path.resolve(bodyFile);
    }
    if (!existsSync(bodyFile)) throw new Error(`body_file does not exist: ${bodyFile}`);
    const stat = await fs.stat(bodyFile);
    if (!stat.isFile()) throw new Error(`body_file is not a regular file: ${bodyFile}`);
  }
  await validateTransformFiles(requestTransform, 'request_transform');
  await validateTransformFiles(responseTransform, 'response_transform');
  if (type === 'map_remote' && requiresRemoteCallback({
    ...input,
    request_transform: requestTransform,
    delay_ms: delayMs,
    preserve_host_header: Boolean(input.preserve_host_header),
  }, remoteTarget)) {
    if (requestTransform?.patch_json_body || responseTransform?.patch_json_body) {
      throw new Error('JSON Patch cannot be combined with delayed, path-replacing, URL-replacing, or preserve-host Map Remote rules');
    }
  }

  return {
    createdBody,
    config: {
      rule_id: ruleId,
      type,
      url_pattern: input.url_pattern,
      method,
      status,
      content_type: input.content_type ?? (type === 'blacklist' ? 'text/plain; charset=utf-8' : 'application/json'),
      headers: input.headers ? { ...input.headers } : {},
      body_inline: type === 'blacklist'
        ? (input.body_inline ?? input.body ?? 'Blocked by proxy-mate')
        : null,
      body_file: bodyFile,
      directory,
      directory_content_type_auto: input.directory_content_type_auto ?? (input.content_type == null),
      directory_strip_prefix: input.directory_strip_prefix ?? null,
      directory_index: input.directory_index ?? 'index.html',
      fallthrough: input.fallthrough !== false,
      to_url: input.to_url ?? null,
      preserve_host_header: Boolean(input.preserve_host_header),
      preserve_path: input.preserve_path ?? null,
      replace_path: input.replace_path ?? null,
      replace_query: input.replace_query ?? null,
      request_transform: requestTransform,
      response_transform: responseTransform,
      delay_ms: delayMs,
      fault,
      ...(type === 'breakpoint' ? {
        breakpoint_direction: breakpointDirection,
        breakpoint_timeout_ms: breakpointTimeoutMs,
        breakpoint_default_action: breakpointDefaultAction,
      } : {}),
      ...(type === 'plugin_transform' ? { plugin_id: pluginId, plugin_stage: pluginStage } : {}),
      enabled: input.enabled !== false,
      priority,
      order,
      match_headers: input.match_headers ? { ...input.match_headers } : null,
      match_query: input.match_query ? structuredClone(input.match_query) : null,
      match_json_body_including: input.match_json_body_including ? structuredClone(input.match_json_body_including) : null,
      match_body_regex: input.match_body_regex ?? null,
      hit_count: Number.isSafeInteger(input.hit_count) && input.hit_count >= 0
        ? input.hit_count
        : (existing?.hit_count ?? 0),
      last_hit: input.last_hit ?? existing?.last_hit ?? null,
      created_at: input.created_at ?? existing?.created_at ?? new Date().toISOString(),
      updated_at: input.updated_at ?? new Date().toISOString(),
    },
  };
}

function mergeRulePatch(current, patch, ruleId) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('rule patch must be an object');
  const merged = { ...cloneRuleConfig(current), ...structuredClone(patch), rule_id: ruleId };
  if (patch.rule_id && patch.rule_id !== ruleId) throw new Error('rule_id cannot be changed');
  // A patched url retargets the rule, so the pattern and query derived from the
  // old one must not survive it; an explicit url_pattern or match_query in the
  // same patch still wins, as everywhere else.
  if (patch.url != null && patch.url_pattern == null) {
    delete merged.url_pattern;
    if (patch.match_query == null) delete merged.match_query;
  }
  if ('body' in patch || 'body_inline' in patch) merged.body_file = null;
  if ('directory' in patch || 'body_directory' in patch) merged.body_file = null;
  if ('body_file' in patch) merged.directory = null;
  if (patch.request_transform && current.request_transform) {
    merged.request_transform = { ...current.request_transform, ...patch.request_transform };
  }
  if (patch.response_transform && current.response_transform) {
    merged.response_transform = { ...current.response_transform, ...patch.response_transform };
  }
  delete merged.updated_at;
  return merged;
}

function nextRuleOrder(ruleMap) {
  let maximum = -1;
  for (const { config } of ruleMap.values()) maximum = Math.max(maximum, config.order ?? -1);
  return maximum + 1;
}

function compareRules(a, b) {
  return (b.priority ?? 0) - (a.priority ?? 0)
    || (a.order ?? 0) - (b.order ?? 0)
    || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
    || String(a.rule_id).localeCompare(String(b.rule_id));
}

function cloneRuleConfig(config) {
  return structuredClone(config);
}

function validatePlainObject(value, label) {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

// `matcher` marks the one caller whose headers are a constraint rather than
// headers to send: match_headers goes through the same gate as match_query,
// because mockttp's HeaderMatcher runs _.isMatch(request.headers, expected) —
// exactly what withQuery does one field over. Headers a rule sends are not a
// matcher, and an empty set of them adds nothing and constrains nothing, so
// they keep the plain-object check.
function validateHeaders(value, label, { matcher = false } = {}) {
  if (matcher) {
    validateMatcherObject(value, label, {
      code: 'MATCH_HEADERS',
      invalidMessage: `${label} must be an object of header names and values`,
      invalidRecovery: [
        `Pass ${label} as {"header-name": "value"}; matching is by exact value, on a lower-cased name.`,
        `Omit ${label} entirely for no header constraint.`,
      ],
      emptyMessage: `${label} has no headers, and an empty header matcher matches every request`,
      emptyRecovery: [
        `Omit ${label} entirely for no header constraint.`,
        `Name at least one header in ${label}, e.g. {"authorization": "Bearer token"}.`,
        `A rule written, imported, or stored before this guard can carry ${label}: {} meaning "any headers"; re-create it with the headers it meant to constrain.`,
      ],
    });
  } else {
    validatePlainObject(value, label);
  }
  if (!value) return;
  for (const [name, headerValue] of Object.entries(value)) {
    if (!name || /[\r\n:]/.test(name)) throw new Error(`${label} contains an invalid header name`);
    if (headerValue != null && typeof headerValue !== 'string' && !Array.isArray(headerValue)) {
      throw new Error(`${label}.${name} must be a string, string array, null, or undefined`);
    }
    // The empty matcher one level down, and the same lodash rule that produces
    // MATCH_QUERY_EMPTY_VALUE: isMatch reads an expected [] as a vacuous subset
    // of an array actual, so it matches whatever values a repeated header
    // (set-cookie and friends) arrives with, while a single-valued header does
    // not match at all.
    if (matcher && Array.isArray(headerValue) && headerValue.length === 0) {
      throw matcherError('MATCH_HEADERS_EMPTY_VALUE', `${label}.${name} is an empty array, which matches any values a repeated ${name} arrives with`, [
        `Name the value ${name} must have, e.g. {"${name}": "value"}.`,
        `Drop ${name} from ${label} if any value of it is acceptable.`,
      ]);
    }
    if (String(headerValue ?? '').includes('\r') || String(headerValue ?? '').includes('\n')) {
      throw new Error(`${label}.${name} cannot contain newlines`);
    }
  }
}

function requestTransformFromFlatFields(rule) {
  const transform = {};
  if (rule.request_method != null) transform.replace_method = rule.request_method;
  if (rule.request_headers != null) transform.update_headers = rule.request_headers;
  if (rule.request_body != null) transform.replace_body = rule.request_body;
  if (rule.request_url != null) transform.replace_url = rule.request_url;
  return transform;
}

function responseTransformFromFlatFields(rule) {
  const transform = {};
  if (rule.response_status != null) transform.replace_status = rule.response_status;
  if (rule.response_headers != null) transform.update_headers = rule.response_headers;
  if (rule.response_body != null) transform.replace_body = rule.response_body;
  return transform;
}

function normalizeTransform(value, kind) {
  if (value == null) return null;
  validatePlainObject(value, `${kind}_transform`);
  if (Object.keys(value).length === 0) return null;
  const transform = {
    ...(kind === 'request' && (value.replace_method ?? value.method) != null
      ? { replace_method: String(value.replace_method ?? value.method).toUpperCase() }
      : {}),
    ...(kind === 'request' && (value.replace_url ?? value.url) != null
      ? { replace_url: String(value.replace_url ?? value.url) }
      : {}),
    ...(kind === 'response' && (value.replace_status ?? value.status ?? value.status_code) != null
      ? { replace_status: value.replace_status ?? value.status ?? value.status_code }
      : {}),
    ...((value.update_headers ?? value.headers) != null
      ? { update_headers: structuredClone(value.update_headers ?? value.headers) }
      : {}),
    ...(value.replace_headers != null ? { replace_headers: structuredClone(value.replace_headers) } : {}),
    ...((value.replace_body ?? value.body) != null
      ? { replace_body: value.replace_body ?? value.body }
      : {}),
    ...((value.replace_body_file ?? value.body_file) != null
      ? { replace_body_file: path.resolve(value.replace_body_file ?? value.body_file) }
      : {}),
    ...(value.update_json_body != null ? { update_json_body: structuredClone(value.update_json_body) } : {}),
    ...(value.patch_json_body != null ? { patch_json_body: structuredClone(value.patch_json_body) } : {}),
    ...(value.match_replace_body != null
      ? { match_replace_body: Array.isArray(value.match_replace_body)
        ? value.match_replace_body.map(normalizeReplacementConfig)
        : value.match_replace_body }
      : {}),
  };
  if (transform.replace_method && !/^[A-Z][A-Z0-9_-]{0,31}$/.test(transform.replace_method)) {
    throw new Error('request_transform.replace_method is invalid');
  }
  if (transform.replace_url) parseHttpUrl(transform.replace_url, 'request_transform.replace_url');
  if (transform.replace_status != null && (!Number.isInteger(transform.replace_status) || transform.replace_status < 100 || transform.replace_status > 599)) {
    throw new Error('response_transform.replace_status must be an integer from 100 to 599');
  }
  validateHeaders(transform.update_headers, `${kind}_transform.update_headers`);
  validateHeaders(transform.replace_headers, `${kind}_transform.replace_headers`);
  if (transform.update_headers && transform.replace_headers) {
    throw new Error(`${kind}_transform cannot combine update_headers and replace_headers`);
  }
  const bodyTransforms = ['replace_body', 'replace_body_file', 'update_json_body', 'patch_json_body', 'match_replace_body']
    .filter((key) => transform[key] != null);
  if (bodyTransforms.length > 1) throw new Error(`${kind}_transform can specify only one body transformation`);
  if (transform.replace_body_file && !existsSync(transform.replace_body_file)) {
    throw new Error(`${kind}_transform.replace_body_file does not exist: ${transform.replace_body_file}`);
  }
  if (transform.patch_json_body && !Array.isArray(transform.patch_json_body)) {
    throw new Error(`${kind}_transform.patch_json_body must be an array`);
  }
  if (transform.patch_json_body) validateJsonPatch(transform.patch_json_body, `${kind}_transform.patch_json_body`);
  if (transform.match_replace_body && !Array.isArray(transform.match_replace_body)) {
    throw new Error(`${kind}_transform.match_replace_body must be an array`);
  }
  return transform;
}

async function validateTransformFiles(transform, label) {
  if (!transform?.replace_body_file) return;
  const stat = await fs.stat(transform.replace_body_file).catch(() => null);
  if (!stat?.isFile()) throw new Error(`${label}.replace_body_file is not a regular file: ${transform.replace_body_file}`);
}

function validateJsonPatch(patch, label) {
  for (const [index, operation] of patch.entries()) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    if (!['add', 'remove', 'replace', 'move', 'copy', 'test'].includes(operation.op)) {
      throw new Error(`${label}[${index}].op is invalid`);
    }
    if (typeof operation.path !== 'string' || (operation.path !== '' && !operation.path.startsWith('/'))) {
      throw new Error(`${label}[${index}].path must be a JSON Pointer`);
    }
    if (['move', 'copy'].includes(operation.op)
      && (typeof operation.from !== 'string' || (operation.from !== '' && !operation.from.startsWith('/')))) {
      throw new Error(`${label}[${index}].from must be a JSON Pointer`);
    }
    if (['add', 'replace', 'test'].includes(operation.op) && !Object.hasOwn(operation, 'value')) {
      throw new Error(`${label}[${index}].value is required`);
    }
  }
}

function parseHttpUrl(value, label) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error(`${label} must be an absolute HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} must use http or https`);
  return parsed;
}

async function registerMapRemote(builder, rule, proxyConfig) {
  const target = parseHttpUrl(rule.to_url, 'to_url');
  const requestTransform = toMockttpTransform(rule.request_transform, 'request');
  const responseTransform = toMockttpTransform(rule.response_transform, 'response');
  const requiresUrlCallback = requiresRemoteCallback(rule, target);
  if (!requiresUrlCallback) {
    return builder.thenPassThrough({
      ...proxyPassThroughOptions(proxyConfig),
      transformRequest: {
        ...(requestTransform ?? {}),
        setProtocol: target.protocol.slice(0, -1),
        replaceHost: {
          targetHost: target.host,
          updateHostHeader: rule.preserve_host_header ? false : true,
        },
      },
      ...(responseTransform ? { transformResponse: responseTransform } : {}),
    });
  }
  return builder.thenPassThrough({
    ...proxyPassThroughOptions(proxyConfig),
    beforeRequest: async (request) => applyRequestCallbackTransform(request, rule, target),
    ...(rule.response_transform
      ? { beforeResponse: async (response) => applyResponseCallbackTransform(response, rule.response_transform) }
      : {}),
  });
}

async function registerPassThroughRule(builder, rule, proxyConfig) {
  const requestTransform = toMockttpTransform(rule.request_transform, 'request');
  const responseTransform = toMockttpTransform(rule.response_transform, 'response');
  if (!rule.delay_ms) {
    return builder.thenPassThrough({
      ...proxyPassThroughOptions(proxyConfig),
      ...(requestTransform ? { transformRequest: requestTransform } : {}),
      ...(responseTransform ? { transformResponse: responseTransform } : {}),
    });
  }
  return builder.thenPassThrough({
    ...proxyPassThroughOptions(proxyConfig),
    beforeRequest: async (request) => {
      await waitMs(rule.delay_ms);
      const output = {};
      await addCallbackBodyTransform(output, request.body, rule.request_transform ?? {});
      if (rule.request_transform?.replace_method) output.method = rule.request_transform.replace_method;
      if (rule.request_transform?.update_headers) output.headers = mergeHeaders(request.headers, rule.request_transform.update_headers);
      return output;
    },
    ...(rule.response_transform
      ? { beforeResponse: async (response) => applyResponseCallbackTransform(response, rule.response_transform) }
      : {}),
  });
}

async function registerPluginTransformRule(builder, rule, pluginStore, proxyConfig, reportError) {
  const execute = async (stage, exchange) => {
    try {
      const input = await pluginExchangeInput(stage, exchange, rule);
      const patch = await pluginStore.execute({ id: rule.plugin_id, stage, input });
      return stage === 'request'
        ? normalizePluginRequestPatch(patch, exchange)
        : normalizePluginResponsePatch(patch, exchange);
    } catch (error) {
      reportError(error);
      throw error;
    }
  };
  return builder.thenPassThrough({
    ...proxyPassThroughOptions(proxyConfig),
    ...(rule.plugin_stage === 'request'
      ? { beforeRequest: async (request) => execute('request', request) }
      : { beforeResponse: async (response) => execute('response', response) }),
  });
}

function proxyPassThroughOptions(proxyConfig) {
  return proxyConfig == null ? {} : { proxyConfig };
}

async function pluginExchangeInput(stage, exchange, rule) {
  const body = await boundedPluginBody(exchange?.body);
  return stage === 'request' ? {
    stage,
    rule: { id: rule.rule_id, plugin_id: rule.plugin_id },
    request: {
      method: exchange?.method ?? 'GET',
      url: exchange?.url ?? null,
      headers: structuredClone(exchange?.headers ?? {}),
      body,
    },
  } : {
    stage,
    rule: { id: rule.rule_id, plugin_id: rule.plugin_id },
    response: {
      status_code: exchange?.statusCode ?? null,
      headers: structuredClone(exchange?.headers ?? {}),
      body,
    },
  };
}

async function boundedPluginBody(completedBody) {
  if (!completedBody) return { size: 0, text: '', base64: null, truncated: false };
  let buffer;
  try { buffer = Buffer.from(completedBody.buffer ?? []); }
  catch { return { size: null, text: null, base64: null, truncated: true, unavailable: true }; }
  const preview = buffer.subarray(0, MAX_PLUGIN_BODY_PREVIEW_BYTES);
  const text = preview.toString('utf8');
  const roundTripsAsUtf8 = Buffer.from(text, 'utf8').equals(preview);
  return {
    size: buffer.length,
    text: roundTripsAsUtf8 ? text : null,
    base64: roundTripsAsUtf8 ? null : preview.toString('base64'),
    truncated: buffer.length > preview.length,
  };
}

function normalizePluginRequestPatch(value, request) {
  const patch = pluginPatchObject(value);
  const output = {};
  if (patch.method != null) {
    const method = String(patch.method).toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(method)) throw codedEngineError('PLUGIN_INVALID_PATCH', 'Plugin request method is invalid.');
    output.method = method;
  }
  if (patch.url != null) {
    output.url = parseHttpUrl(String(patch.url), 'plugin request url').toString();
  }
  if (patch.headers != null) {
    validateHeaders(patch.headers, 'plugin request headers');
    output.headers = mergeHeaders(request?.headers ?? {}, patch.headers);
  }
  if (patch.body != null) output.body = boundedPluginPatchBody(patch.body);
  return output;
}

function normalizePluginResponsePatch(value, response) {
  const patch = pluginPatchObject(value);
  const output = {};
  const status = patch.status_code ?? patch.statusCode ?? patch.status;
  if (status != null) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw codedEngineError('PLUGIN_INVALID_PATCH', 'Plugin response status must be an integer from 100 to 599.');
    }
    output.statusCode = status;
  }
  if (patch.headers != null) {
    validateHeaders(patch.headers, 'plugin response headers');
    output.headers = mergeHeaders(response?.headers ?? {}, patch.headers);
  }
  if (patch.body != null) output.body = boundedPluginPatchBody(patch.body);
  return output;
}

function pluginPatchObject(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw codedEngineError('PLUGIN_INVALID_PATCH', 'Transform plugin output must be a JSON object or null.');
  }
  return value;
}

function boundedPluginPatchBody(value) {
  if (typeof value !== 'string') throw codedEngineError('PLUGIN_INVALID_PATCH', 'Plugin body output must be a string.');
  if (Buffer.byteLength(value, 'utf8') > MAX_PLUGIN_BODY_PREVIEW_BYTES * 4) {
    throw codedEngineError('PLUGIN_INVALID_PATCH', 'Plugin body output exceeds the 256 KiB live-transform limit.');
  }
  return value;
}

function requiresRemoteCallback(rule, target) {
  return Boolean(
    rule.delay_ms
    || rule.request_transform?.replace_url
    || rule.replace_path != null
    || rule.replace_query != null
    || target.pathname !== '/'
    || target.search
  );
}

function toMockttpTransform(transform, kind) {
  if (!transform) return null;
  const result = {};
  if (kind === 'request' && transform.replace_method) result.replaceMethod = transform.replace_method;
  if (kind === 'response' && transform.replace_status != null) result.replaceStatus = transform.replace_status;
  if (transform.update_headers) result.updateHeaders = nullHeadersToUndefined(transform.update_headers);
  if (transform.replace_headers) result.replaceHeaders = transform.replace_headers;
  if (transform.replace_body != null) result.replaceBody = transform.replace_body;
  if (transform.replace_body_file) result.replaceBodyFromFile = transform.replace_body_file;
  if (transform.update_json_body) result.updateJsonBody = transform.update_json_body;
  if (transform.patch_json_body) result.patchJsonBody = transform.patch_json_body;
  if (transform.match_replace_body) result.matchReplaceBody = transform.match_replace_body.map(normalizeReplacementPair);
  return Object.keys(result).length ? result : null;
}

async function applyRequestCallbackTransform(request, rule, target) {
  if (rule.delay_ms) await waitMs(rule.delay_ms);
  const transform = rule.request_transform ?? {};
  const current = new URL(request.url);
  let destination = transform.replace_url ? new URL(transform.replace_url) : new URL(current);
  if (!transform.replace_url) {
    destination.protocol = target.protocol;
    destination.host = target.host;
    if (rule.replace_path != null) {
      destination.pathname = rule.replace_path;
    } else if (target.pathname !== '/') {
      destination.pathname = rule.preserve_path === true
        ? joinUrlPaths(target.pathname, current.pathname)
        : target.pathname;
    }
    if (rule.replace_query != null) destination.search = normalizeQueryReplacement(rule.replace_query);
    else if (target.search) destination.search = target.search;
  }
  const result = { url: destination.toString() };
  if (transform.replace_method) result.method = transform.replace_method;
  if (transform.update_headers || transform.replace_headers || rule.preserve_host_header) {
    let headers = transform.replace_headers
      ? { ...transform.replace_headers }
      : mergeHeaders(request.headers, transform.update_headers);
    if (!rule.preserve_host_header) headers = removeHeader(headers, 'host');
    result.headers = headers;
  }
  await addCallbackBodyTransform(result, request.body, transform);
  if (result.headers && callbackReplacedBody(result)) result.headers = removeHeader(result.headers, 'content-length');
  return result;
}

async function applyResponseCallbackTransform(response, transform) {
  const result = {};
  if (transform.replace_status != null) result.statusCode = transform.replace_status;
  if (transform.update_headers || transform.replace_headers) {
    result.headers = transform.replace_headers
      ? { ...transform.replace_headers }
      : mergeHeaders(response.headers, transform.update_headers);
  }
  await addCallbackBodyTransform(result, response.body, transform);
  if (result.headers && callbackReplacedBody(result)) result.headers = removeHeader(result.headers, 'content-length');
  return result;
}

function callbackReplacedBody(result) {
  return result.body !== undefined || result.rawBody !== undefined || result.json !== undefined;
}

async function addCallbackBodyTransform(result, completedBody, transform) {
  if (transform.replace_body != null) result.body = transform.replace_body;
  else if (transform.replace_body_file) result.body = await fs.readFile(transform.replace_body_file);
  else if (transform.update_json_body) {
    const json = await completedBody.getJson();
    if (json === undefined) throw new Error('cannot update JSON in a non-JSON body');
    result.json = deepMergeJson(json, transform.update_json_body);
  } else if (transform.patch_json_body) {
    throw new Error('JSON Patch with URL/path replacement is not supported; use an origin-only to_url or replace_body');
  } else if (transform.match_replace_body) {
    const text = await completedBody.getText();
    if (text === undefined) throw new Error('cannot replace text in a non-text body');
    result.body = transform.match_replace_body.reduce((body, pair) => {
      const [match, replacement] = normalizeReplacementPair(pair);
      return body.replace(match, replacement);
    }, text);
  }
}

function normalizeReplacementPair(pair) {
  if (Array.isArray(pair) && pair.length === 2) return [pair[0], String(pair[1])];
  if (pair && typeof pair === 'object' && pair.match != null) {
    return [pair.regex ? compileTransformRegex(pair.match, pair.flags ?? '') : String(pair.match), String(pair.replace ?? '')];
  }
  throw new Error('match_replace_body entries must be [match, replace] or { match, replace, regex, flags }');
}

function normalizeReplacementConfig(pair) {
  if (Array.isArray(pair) && pair.length === 2) {
    if (pair[0] instanceof RegExp) {
      return { match: pair[0].source, replace: String(pair[1]), regex: true, flags: pair[0].flags };
    }
    return [String(pair[0]), String(pair[1])];
  }
  if (pair && typeof pair === 'object' && pair.match != null) {
    if (pair.regex) compileTransformRegex(pair.match, pair.flags);
    return {
      match: String(pair.match), replace: String(pair.replace ?? ''),
      regex: Boolean(pair.regex), ...(pair.flags ? { flags: String(pair.flags) } : {}),
    };
  }
  throw new Error('match_replace_body entries must be [match, replace] or { match, replace, regex, flags }');
}

function compileTransformRegex(pattern, flags = '') {
  if (typeof pattern !== 'string' || pattern.length > 500) throw new Error('body replacement regex must be at most 500 characters');
  if (!/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length) throw new Error('body replacement regex flags are invalid');
  return new RegExp(pattern, flags);
}

function nullHeadersToUndefined(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, value == null ? undefined : value]));
}

function mergeHeaders(original = {}, updates = {}) {
  const result = { ...original };
  for (const [name, value] of Object.entries(updates ?? {})) {
    const currentName = Object.keys(result).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (currentName) delete result[currentName];
    if (value != null) result[name] = value;
  }
  return result;
}

function removeHeader(headers, name) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== name.toLowerCase()));
}

function joinUrlPaths(base, suffix) {
  return `${base.replace(/\/$/, '')}/${suffix.replace(/^\//, '')}`;
}

function normalizeQueryReplacement(value) {
  if (typeof value === 'string') return value ? (value.startsWith('?') ? value : `?${value}`) : '';
  if (value && typeof value === 'object') return `?${new URLSearchParams(value).toString()}`;
  return '';
}

function deepMergeJson(target, patch) {
  if (!isPlainObject(target) || !isPlainObject(patch)) return structuredClone(patch);
  const result = structuredClone(target);
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? deepMergeJson(result[key], value)
      : structuredClone(value);
  }
  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function registerDirectoryMap(builder, rule, proxyConfig) {
  const root = rule.directory;
  return builder.thenPassThrough({
    ...proxyPassThroughOptions(proxyConfig),
    beforeRequest: async (request) => {
      if (rule.delay_ms) await waitMs(rule.delay_ms);
      let pathname;
      try { pathname = decodeURIComponent(new URL(request.url).pathname); }
      catch { return rule.fallthrough ? undefined : directoryNotFoundResponse(); }
      if (rule.directory_strip_prefix && pathname.startsWith(rule.directory_strip_prefix)) {
        pathname = pathname.slice(rule.directory_strip_prefix.length);
      }
      let relative = pathname.replace(/^\/+/, '');
      if (!relative || relative.endsWith('/')) relative += rule.directory_index;
      const candidate = path.resolve(root, relative);
      if (!isPathInside(root, candidate)) return rule.fallthrough ? undefined : directoryNotFoundResponse();
      let real;
      try { real = await fs.realpath(candidate); }
      catch { return rule.fallthrough ? undefined : directoryNotFoundResponse(); }
      if (!isPathInside(root, real)) return rule.fallthrough ? undefined : directoryNotFoundResponse();
      const stat = await fs.stat(real).catch(() => null);
      if (!stat?.isFile()) return rule.fallthrough ? undefined : directoryNotFoundResponse();
      return {
        response: {
          statusCode: rule.status,
          headers: {
            'content-type': rule.directory_content_type_auto
              ? contentTypeForPath(real)
              : rule.content_type,
            ...rule.headers,
          },
          body: await fs.readFile(real),
        },
      };
    },
  });
}

function waitMs(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isPathInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function directoryNotFoundResponse() {
  return { response: { statusCode: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Map Local file not found' } };
}

function contentTypeForPath(filePath) {
  return ({
    '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.xml': 'application/xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.bin': 'application/octet-stream',
  })[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function normalizeDryRunRequest(request) {
  const url = String(request.url ?? 'http://invalid.local/');
  if (!URL.canParse(url)) throw new Error('dry-run request.url must be an absolute URL');
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  // url-match.mjs owns the parser the live proxy matches with. URLSearchParams
  // has no key cap and mockttp's url.parse(url, true) stops at
  // MAX_QUERY_PARAMS, so building the dry-run query any other way makes the two
  // disagree on every request carrying more parameters than that.
  const query = request.query ?? parseRequestQuery(url);
  let jsonBody = request.json_body;
  if (jsonBody === undefined && typeof request.body === 'string') {
    try { jsonBody = JSON.parse(request.body); } catch { /* not JSON */ }
  }
  return {
    url, method: String(request.method ?? 'GET').toUpperCase(), headers, query,
    body: request.body == null ? '' : String(request.body), jsonBody,
    summary: { url, method: String(request.method ?? 'GET').toUpperCase(), headers, query, has_body: request.body != null },
  };
}

function evaluateRule(rule, request) {
  const criteria = [];
  criteria.push(matchCriterion('enabled', rule.enabled, true));
  const methodMatched = rule.method === 'ANY' || rule.method === request.method;
  criteria.push(matchCriterion('method', methodMatched, rule.method, request.method));
  // Mockttp tests url_pattern against the normalized URL (query and fragment
  // cut, default port dropped), and a method-specific rule compiles to a
  // RegexPathMatcher that also tests the path alone, while method 'ANY' goes
  // through withUrlMatching and tests the full URL only. The dry run mirrors
  // both, or it reports matches the live proxy never makes and misses ones it
  // does.
  const matchableUrl = normalizeMatchUrl(request.url);
  let urlMatched = false;
  try {
    const pattern = compileSafeRegex(rule.url_pattern, 'url_pattern');
    urlMatched = pattern.test(matchableUrl)
      || (rule.method !== 'ANY' && pattern.test(matchUrlPath(matchableUrl)));
  } catch { /* normalized rules should compile */ }
  criteria.push(matchCriterion('url_pattern', urlMatched, rule.url_pattern, matchableUrl));
  if (rule.match_headers) {
    const matched = Object.entries(rule.match_headers).every(([name, expected]) => valuesEqual(request.headers[name.toLowerCase()], expected));
    criteria.push(matchCriterion('headers', matched, rule.match_headers));
  }
  if (rule.match_query) {
    // Query matching is lodash isMatch inside mockttp, not the loose header
    // comparison: url-match.mjs owns that parity so the two cannot drift.
    criteria.push(matchCriterion('query', queryMatches(request.query, rule.match_query), rule.match_query, request.query));
  }
  if (rule.match_json_body_including) {
    criteria.push(matchCriterion('json_body_including', jsonIncludes(request.jsonBody, rule.match_json_body_including), rule.match_json_body_including));
  }
  if (rule.match_body_regex) {
    criteria.push(matchCriterion('body_regex', compileSafeRegex(rule.match_body_regex, 'match_body_regex').test(request.body), rule.match_body_regex));
  }
  return {
    rule_id: rule.rule_id,
    type: rule.type,
    enabled: rule.enabled,
    priority: rule.priority,
    order: rule.order,
    matched: criteria.every((criterion) => criterion.matched),
    criteria,
  };
}

function matchCriterion(field, matched, expected, actual) {
  return { field, matched: Boolean(matched), expected, ...(actual !== undefined ? { actual } : {}) };
}

function valuesEqual(actual, expected) {
  if (Array.isArray(expected)) {
    const actualArray = Array.isArray(actual) ? actual.map(String) : [String(actual)];
    return expected.every((item) => actualArray.includes(String(item)));
  }
  return String(actual) === String(expected);
}

function jsonIncludes(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((item, index) => jsonIncludes(actual[index], item));
  }
  if (isPlainObject(expected)) {
    return isPlainObject(actual) && Object.entries(expected).every(([key, value]) => jsonIncludes(actual[key], value));
  }
  return Object.is(actual, expected);
}

function methodBuilder(server, method, urlRegex) {
  switch ((method ?? 'ANY').toUpperCase()) {
    case 'GET':     return server.forGet(urlRegex);
    case 'POST':    return server.forPost(urlRegex);
    case 'PUT':     return server.forPut(urlRegex);
    case 'PATCH':   return server.forPatch(urlRegex);
    case 'DELETE':  return server.forDelete(urlRegex);
    case 'HEAD':    return server.forHead(urlRegex);
    case 'OPTIONS': return server.forOptions(urlRegex);
    case 'ANY':
    default:        return server.forAnyRequest().withUrlMatching(urlRegex);
  }
}

function redactDiagnosticHeaders(headers) {
  if (!headers) return headers;
  return Object.fromEntries(Object.entries(headers).map(([name, value]) =>
    /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i.test(name)
      ? [name, '[REDACTED]']
      : [name, value]));
}

function isLoopbackAddress(address) {
  if (!address) return false;
  const normalized = String(address).toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1';
}

function normalizeRemoteAddress(address) {
  return String(address ?? '').split('%', 1)[0].toLowerCase();
}

// A wildcard IPv6 listener can coexist with an occupied IPv4 address on some
// hosts. Refuse that split ownership before reporting a usable loopback proxy.
async function assertProxyPortAvailable(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw codedEngineError('INVALID_PROXY_PORT', 'Proxy port must be an integer from 0 to 65535.');
  if (port === 0) return;
  for (const host of ['127.0.0.1', '::1']) {
    const reservation = createTcpServer();
    try {
      await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(port, host, resolve); });
    } catch (error) {
      if (error.code === 'EADDRINUSE') throw codedEngineError('PROXY_PORT_BUSY', `Proxy port ${port} is occupied on ${host}; choose another port. No existing listener was stopped.`);
      if (host !== '::1' || !['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) throw error;
    } finally {
      if (reservation.listening) await new Promise((resolve) => reservation.close(resolve));
    }
  }
}

export function buildRemoteAccessPolicy({ allowRemote = false, allowedRemoteIps = [], remoteAccessTtlSeconds = 3600 } = {}) {
  if (!allowRemote) {
    return { enabled: false, entries: [], allowlist: new BlockList(), ttlSeconds: 0, expiresAt: null };
  }
  if (!Array.isArray(allowedRemoteIps) || allowedRemoteIps.length === 0) {
    throw codedEngineError('REMOTE_ALLOWLIST_REQUIRED', 'allow_remote requires at least one exact IP address or CIDR in allowed_remote_ips.');
  }
  if (allowedRemoteIps.length > 64) {
    throw codedEngineError('REMOTE_ALLOWLIST_TOO_LARGE', 'allowed_remote_ips accepts at most 64 entries.');
  }
  if (!Number.isInteger(remoteAccessTtlSeconds) || remoteAccessTtlSeconds < 1 || remoteAccessTtlSeconds > 86_400) {
    throw codedEngineError('INVALID_REMOTE_ACCESS_TTL', 'remote_access_ttl_seconds must be an integer from 1 to 86400.');
  }

  const allowlist = new BlockList();
  const entries = [];
  for (const rawEntry of allowedRemoteIps) {
    const entry = String(rawEntry ?? '').trim();
    const [address, prefixText, ...extra] = entry.split('/');
    const familyNumber = isIP(address);
    if (extra.length || !familyNumber) {
      throw codedEngineError('INVALID_REMOTE_ALLOWLIST_ENTRY', `Invalid IP address or CIDR: ${entry}`);
    }
    const family = familyNumber === 6 ? 'ipv6' : 'ipv4';
    if (prefixText === undefined) {
      allowlist.addAddress(address, family);
    } else {
      if (!/^\d+$/.test(prefixText)) {
        throw codedEngineError('INVALID_REMOTE_ALLOWLIST_ENTRY', `Invalid CIDR prefix: ${entry}`);
      }
      const prefix = Number(prefixText);
      const maxPrefix = familyNumber === 6 ? 128 : 32;
      if (prefix < 0 || prefix > maxPrefix) {
        throw codedEngineError('INVALID_REMOTE_ALLOWLIST_ENTRY', `CIDR prefix must be from 0 to ${maxPrefix}: ${entry}`);
      }
      allowlist.addSubnet(address, prefix, family);
    }
    entries.push(entry);
  }

  return {
    enabled: true,
    entries: [...new Set(entries)],
    allowlist,
    ttlSeconds: remoteAccessTtlSeconds,
    expiresAt: new Date(Date.now() + remoteAccessTtlSeconds * 1000).toISOString(),
  };
}

function redactDiagnosticUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(access_token|refresh_token|api_key|apikey|auth|authorization|client_secret|password|secret|session|token)$/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch { return value; }
}

function redactWebSocketSnapshotForStorage(snapshot) {
  const safe = structuredClone(snapshot);
  for (const connection of safe.connections ?? []) {
    if (connection.request) {
      connection.request.url = redactUrl(connection.request.url);
      connection.request.headers = redactHeaders(connection.request.headers);
    }
    if (connection.accepted) connection.accepted.headers = redactHeaders(connection.accepted.headers);
    for (const message of connection.messages ?? []) {
      if (message.data?.type === 'text') {
        message.data.text = redactBody(message.data.text, { 'content-type': 'text/plain' });
        message.data.stored_byte_size = Buffer.byteLength(message.data.text);
      } else if (message.data?.type === 'binary') {
        delete message.data.base64;
        message.data.omitted = true;
        message.data.omission_reason = 'binary WebSocket payload omitted by capture storage policy';
        message.data.stored_byte_size = 0;
      }
    }
  }
  return safe;
}

export function compileSafeRegex(pattern, label = 'pattern') {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 500) {
    throw new Error(`${label} must contain 1 to 500 characters`);
  }
  let compiled;
  try { compiled = new RegExp(pattern); }
  catch (error) { throw new Error(`${label} is not a valid regular expression: ${error.message}`); }

  const unsafeReason = unsafeRegexReason(pattern);
  if (unsafeReason) {
    const error = new Error(`${label} is outside the safe regular-expression subset: ${unsafeReason}`);
    error.code = 'UNSAFE_REGULAR_EXPRESSION';
    throw error;
  }
  return compiled;
}

// Mockttp requires a synchronous RegExp object, so worker timeouts cannot
// protect evaluation performed inside the matcher. Accept a conservative,
// RE2-like subset instead: no backreferences/lookaround, and no repeated group
// that itself contains repetition or alternation. The scanner understands
// escapes and character classes, closing the common textual-check bypasses.
function unsafeRegexReason(pattern) {
  const stack = [{ containsQuantifier: false, containsAlternation: false }];
  let inClass = false;
  let escaped = false;
  let quantifierCount = 0;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) {
      if (!inClass && (/[1-9]/.test(char) || (char === 'k' && pattern[index + 1] === '<'))) {
        return 'backreferences are not supported';
      }
      escaped = false;
      continue;
    }
    if (char === '\\') { escaped = true; continue; }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') { inClass = true; continue; }
    if (char === '(') {
      if (pattern[index + 1] === '?' && ['=', '!'].includes(pattern[index + 2])) {
        return 'lookaround assertions are not supported';
      }
      if (pattern.slice(index + 1, index + 4) === '?<=' || pattern.slice(index + 1, index + 4) === '?<!') {
        return 'lookaround assertions are not supported';
      }
      if (pattern[index + 1] === '?' && pattern[index + 2] === ':') index += 2;
      else if (pattern[index + 1] === '?') return 'advanced group syntax is not supported';
      stack.push({ containsQuantifier: false, containsAlternation: false });
      continue;
    }
    if (char === '|') {
      stack.at(-1).containsAlternation = true;
      continue;
    }
    if (char === ')') {
      const group = stack.pop();
      if (!group || stack.length === 0) return 'unbalanced group';
      const quantifier = readQuantifier(pattern, index + 1);
      if (quantifier) {
        quantifierCount += 1;
        if (quantifier.repeats && group.containsQuantifier) return 'nested quantifiers are not supported';
        if (quantifier.repeats && group.containsAlternation) return 'quantified alternation is not supported';
        stack.at(-1).containsQuantifier = true;
        index += quantifier.length;
      } else if (group.containsQuantifier) {
        stack.at(-1).containsQuantifier = true;
      }
      if (group.containsAlternation) stack.at(-1).containsAlternation = true;
      continue;
    }
    const quantifier = readQuantifier(pattern, index);
    if (quantifier) {
      quantifierCount += 1;
      stack.at(-1).containsQuantifier = true;
      index += quantifier.length - 1;
    }
  }
  if (stack.length !== 1) return 'unbalanced group';
  if (quantifierCount > 64) return 'too many quantified atoms';
  if (hasOverlappingUnboundedWildcards(pattern)) return 'overlapping unbounded wildcards are not supported';
  return null;
}

function readQuantifier(pattern, index) {
  const char = pattern[index];
  if (char === '*' || char === '+') return { length: 1, repeats: true };
  if (char === '?') return { length: 1, repeats: false };
  if (char !== '{') return null;
  const end = pattern.indexOf('}', index + 1);
  if (end === -1) return null;
  const body = pattern.slice(index + 1, end);
  if (!/^\d+(?:,\d*)?$/.test(body)) return null;
  const [minimum, maximumText] = body.split(',');
  const maximum = maximumText === undefined ? Number(minimum) : (maximumText === '' ? Infinity : Number(maximumText));
  return { length: end - index + 1, repeats: maximum > 1 };
}

function hasOverlappingUnboundedWildcards(pattern) {
  // `.*.*`, `.+.+`, and equivalent wildcard runs can force polynomial scans
  // on attacker-sized URLs/bodies even without nested groups.
  const stripped = pattern.replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'C');
  return /\.\*[^^$|]*\.\*/.test(stripped) || /\.\+[^^$|]*\.\+/.test(stripped);
}

function codedEngineError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function jsonSafe(value) {
  if (value == null) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

export async function removeOwnedMockBody(filePath) {
  if (!filePath) return;
  const ownedRoot = path.join(STATE_DIR, 'bodies', 'mocks') + path.sep;
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ownedRoot)) return;
  try { await fs.unlink(resolved); } catch { /* already absent */ }
}
