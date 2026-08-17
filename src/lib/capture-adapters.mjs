import { execFile as nodeExecFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export const CAPTURE_ADAPTER_ERROR_CODES = Object.freeze({
  UNKNOWN_ADAPTER: 'CAPTURE_ADAPTER_UNKNOWN',
  INVALID_OPTIONS: 'CAPTURE_ADAPTER_INVALID_OPTIONS',
  TOOL_MISSING: 'CAPTURE_ADAPTER_TOOL_MISSING',
  PREFLIGHT_FAILED: 'CAPTURE_ADAPTER_PREFLIGHT_FAILED',
});

export class CaptureAdapterError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CaptureAdapterError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const DESCRIPTORS = Object.freeze([
  descriptor({
    id: 'apple-simulator',
    aliases: ['ios-simulator', 'xcode-simulator'],
    label: 'Apple Simulator',
    targets: ['ios-simulator', 'ipados-simulator', 'xcode-preview-simulator'],
    availability: ['darwin'],
    detection: { tools: ['xcrun', 'simctl'], read_only: true },
    capabilities: {
      capture_http: true,
      capture_https: true,
      proxy_configuration: 'application_or_simulator_manual',
      ca_installation: 'automatable_with_confirmation',
      ca_removal: 'manual_or_automatable_with_confirmation',
      certificate_pinning_bypass: false,
      root_required: false,
    },
  }),
  descriptor({
    id: 'apple-device-manual',
    aliases: ['ios-device', 'physical-apple-device', 'apple-physical-device', 'ios-physical-device', 'manual-device'],
    label: 'Physical Apple device (manual)',
    targets: ['iphone', 'ipad', 'apple-watch', 'apple-tv', 'vision-pro'],
    availability: ['darwin', 'linux', 'win32'],
    detection: { tools: [], read_only: true },
    capabilities: {
      capture_http: true,
      capture_https: true,
      proxy_configuration: 'manual',
      ca_installation: 'manual',
      ca_removal: 'manual',
      certificate_pinning_bypass: false,
      root_required: false,
    },
  }),
  descriptor({
    id: 'android-adb',
    aliases: ['android', 'adb'],
    label: 'Android device or emulator via ADB',
    targets: ['android-device', 'android-emulator'],
    availability: ['darwin', 'linux', 'win32'],
    detection: { tools: ['adb'], read_only: true },
    capabilities: {
      capture_http: true,
      capture_https: 'app_dependent',
      proxy_configuration: 'automatable_with_confirmation',
      ca_installation: 'manual',
      ca_removal: 'manual',
      certificate_pinning_bypass: false,
      root_required: false,
    },
  }),
  descriptor({
    id: 'docker',
    aliases: ['container', 'docker-container'],
    label: 'Docker container',
    targets: ['docker-container', 'docker-compose-service'],
    availability: ['darwin', 'linux', 'win32'],
    detection: { tools: ['docker'], read_only: true },
    capabilities: {
      capture_http: true,
      capture_https: 'image_and_runtime_dependent',
      proxy_configuration: 'environment_on_create_or_restart',
      ca_installation: 'image_or_runtime_manual',
      ca_removal: 'image_or_runtime_manual',
      certificate_pinning_bypass: false,
      root_required: false,
    },
  }),
  descriptor({
    id: 'terminal-env',
    aliases: ['terminal', 'environment', 'cli'],
    label: 'Terminal and environment-aware clients',
    targets: ['curl', 'node', 'python', 'ruby', 'go', 'generic-cli'],
    availability: ['darwin', 'linux', 'win32'],
    detection: { tools: [], read_only: true },
    capabilities: {
      capture_http: true,
      capture_https: 'client_dependent',
      proxy_configuration: 'environment',
      ca_installation: 'client_specific_environment',
      ca_removal: 'environment_cleanup',
      certificate_pinning_bypass: false,
      root_required: false,
    },
  }),
]);

const BY_ID = new Map();
for (const item of DESCRIPTORS) {
  BY_ID.set(item.id, item);
  for (const alias of item.aliases) BY_ID.set(alias, item);
}

export const CAPTURE_ADAPTER_DESCRIPTORS = deepFreeze(publicClone(DESCRIPTORS));
export const CAPTURE_ADAPTERS = CAPTURE_ADAPTER_DESCRIPTORS;

/** Create an injectable registry. The injected runner must behave like promisified execFile. */
export function createCaptureAdapterRegistry({ runCommand = defaultRunCommand, platform = process.platform } = {}) {
  if (typeof runCommand !== 'function') throw invalid('runCommand must be a function.');
  return Object.freeze({
    list: () => listCaptureAdapters(),
    get: (id) => getCaptureAdapterDescriptor(id),
    capabilities: () => captureAdapterCapabilitySummary(),
    preflight: (id, options) => runPreflight(resolveAdapter(id), options, { runCommand, platform }),
    setupPlan: (id, options) => createPlan(resolveAdapter(id), options),
  });
}

const defaultRegistry = createCaptureAdapterRegistry();

export function listCaptureAdapters() {
  return DESCRIPTORS.map(publicClone);
}

export function getCaptureAdapterDescriptor(id) {
  return publicClone(resolveAdapter(id));
}

export function captureAdapterCapabilitySummary() {
  return {
    schema_version: 1,
    safe_preflight: true,
    automatic_mutation: false,
    command_representation: 'exec_file_argv',
    adapters: DESCRIPTORS.map(({ id, label, capabilities }) => ({ id, label, ...publicClone(capabilities) })),
    boundaries: {
      certificate_pinning_bypass: false,
      root_escalation: false,
      device_or_container_mutation_requires_confirmation: true,
    },
  };
}

export async function preflightCaptureAdapter(id, options = {}, dependencies = undefined) {
  return dependencies
    ? createCaptureAdapterRegistry(dependencies).preflight(id, options)
    : defaultRegistry.preflight(id, options);
}

export function buildCaptureSetupPlan(id, options = {}) {
  return defaultRegistry.setupPlan(id, options);
}

// Concise aliases for callers that prefer noun-first APIs.
export const getCaptureSetupPlan = buildCaptureSetupPlan;
export const getCaptureAdapterCapabilities = captureAdapterCapabilitySummary;

async function runPreflight(adapter, options = {}, dependencies) {
  const timeoutMs = normalizeTimeout(options.timeout_ms ?? options.timeoutMs);
  const common = {
    adapter: publicClone(adapter),
    platform: dependencies.platform,
    mutates_target: false,
  };

  if (adapter.id === 'apple-device-manual' || adapter.id === 'terminal-env') {
    return { ...common, ok: true, status: 'manual_ready', checks: [] };
  }

  if (adapter.id === 'apple-simulator') {
    if (dependencies.platform !== 'darwin') {
      return failed(common, CAPTURE_ADAPTER_ERROR_CODES.TOOL_MISSING,
        'Apple Simulator capture requires macOS with full Xcode and simctl.', []);
    }
    const check = await probe(dependencies.runCommand, '/usr/bin/xcrun', ['--find', 'simctl'], timeoutMs, 'simctl');
    return check.ok
      ? { ...common, ok: true, status: 'ready', checks: [check] }
      : failed(common, check.code, check.message, [check]);
  }

  if (adapter.id === 'android-adb') {
    const version = await probe(dependencies.runCommand, 'adb', ['version'], timeoutMs, 'adb');
    if (!version.ok) return failed(common, version.code, version.message, [version]);
    const devices = await probe(dependencies.runCommand, 'adb', ['devices', '-l'], timeoutMs, 'adb_devices');
    const parsedDevices = devices.ok ? parseAdbDevices(devices.stdout) : [];
    return {
      ...common,
      ok: devices.ok,
      status: devices.ok ? (parsedDevices.length ? 'ready' : 'tool_ready_no_devices') : 'tool_ready_device_query_failed',
      code: devices.ok ? undefined : devices.code,
      message: devices.ok ? undefined : devices.message,
      checks: [version, devices],
      devices: parsedDevices,
    };
  }

  if (adapter.id === 'docker') {
    const client = await probe(dependencies.runCommand, 'docker', ['--version'], timeoutMs, 'docker_client');
    if (!client.ok) return failed(common, client.code, client.message, [client]);
    const daemon = await probe(
      dependencies.runCommand, 'docker', ['info', '--format', '{{json .ServerVersion}}'], timeoutMs, 'docker_daemon',
    );
    return {
      ...common,
      ok: daemon.ok,
      status: daemon.ok ? 'ready' : 'client_ready_daemon_unavailable',
      code: daemon.ok ? undefined : CAPTURE_ADAPTER_ERROR_CODES.PREFLIGHT_FAILED,
      message: daemon.ok ? undefined : 'Docker CLI is installed, but the Docker daemon is unavailable.',
      checks: [client, daemon],
    };
  }

  throw new CaptureAdapterError(CAPTURE_ADAPTER_ERROR_CODES.UNKNOWN_ADAPTER, 'Unknown capture adapter.');
}

async function probe(runCommand, executable, args, timeoutMs, name) {
  try {
    const result = await runCommand(executable, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES });
    return {
      name,
      ok: true,
      executable,
      args: [...args],
      stdout: compactOutput(result?.stdout),
      stderr: compactOutput(result?.stderr),
    };
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    return {
      name,
      ok: false,
      executable,
      args: [...args],
      code: missing ? CAPTURE_ADAPTER_ERROR_CODES.TOOL_MISSING : CAPTURE_ADAPTER_ERROR_CODES.PREFLIGHT_FAILED,
      message: missing ? `Required tool is not installed: ${name}.` : `Preflight check failed: ${name}.`,
    };
  }
}

function createPlan(adapter, options = {}) {
  const proxy = normalizeProxy(options.proxy ?? options);
  const ca = normalizeCaReference(options.ca ?? options.ca_certificate ?? options.caCertificate);
  const base = {
    schema_version: 1,
    adapter: publicClone(adapter),
    proxy,
    mutates_target: false,
    executes_automatically: false,
    steps: [],
    cleanup: [],
    boundaries: [
      'The capture proxy can decrypt TLS only after the client trusts its CA.',
      'Certificate-pinned applications may reject interception even when the system trusts the CA.',
      'This adapter does not disable pinning, obtain root access, or weaken platform security.',
    ],
  };

  if (adapter.id === 'apple-simulator') return appleSimulatorPlan(base, ca, options);
  if (adapter.id === 'apple-device-manual') return appleDevicePlan(base, ca);
  if (adapter.id === 'android-adb') return androidPlan(base, ca, options);
  if (adapter.id === 'docker') return dockerPlan(base, ca, options);
  if (adapter.id === 'terminal-env') return terminalPlan(base, ca, options);
  throw new CaptureAdapterError(CAPTURE_ADAPTER_ERROR_CODES.UNKNOWN_ADAPTER, 'Unknown capture adapter.');
}

function appleSimulatorPlan(base, ca, options) {
  return {
    ...base,
    prerequisites: ['A booted Apple Simulator', 'Full Xcode with simctl', ...(ca ? ['A generated proxy CA'] : [])],
    steps: [
      step('preflight', 'automatable_read_only', { type: 'adapter_preflight', adapter_id: 'apple-simulator' }),
      step('configure-proxy', 'manual', {
        type: 'instruction',
        text: `Configure the Simulator or target app to use ${base.proxy.url}.`,
      }),
      ...(ca ? [step('trust-ca', 'automatable_requires_confirmation', {
        type: 'mcp_tool',
        name: 'setup_simulator_certificate',
        arguments: cleanObject({
          cert_path: ca.cert_path,
          scope: options.scope ?? 'booted',
          device_ids: normalizeStringArray(options.device_ids, 'device_ids', 100),
          boot_shutdown: false,
          restart_apps: false,
        }),
      })] : [step('trust-ca', 'manual', { type: 'instruction', text: 'Generate a CA, then import and trust it in the Simulator.' })]),
      step('verify', 'manual', { type: 'instruction', text: 'Open an HTTPS endpoint and verify capture before debugging the target app.' }),
    ],
    cleanup: [
      step('remove-proxy', 'manual', { type: 'instruction', text: 'Remove the Simulator or app proxy setting.' }),
      step('remove-ca', 'manual', { type: 'instruction', text: 'Remove the proxy CA from the Simulator when testing is complete.' }),
    ],
  };
}

function appleDevicePlan(base, ca) {
  return {
    ...base,
    prerequisites: ['The device and proxy host are on the same trusted network', ...(ca ? ['A generated proxy CA'] : [])],
    steps: [
      step('allow-lan', 'automatable_requires_confirmation', {
        type: 'instruction',
        text: 'Start the proxy with remote access restricted to the physical device IP.',
      }),
      step('configure-proxy', 'manual', {
        type: 'instruction',
        text: `In the device Wi-Fi settings, set HTTP Proxy to ${base.proxy.host} port ${base.proxy.port}.`,
      }),
      step('install-ca', 'manual', {
        type: 'instruction',
        text: ca
          ? 'Install the supplied CA profile on the device.'
          : 'Use the time-limited onboarding portal to download and install the proxy CA profile.',
      }),
      step('trust-ca', 'manual', {
        type: 'instruction',
        text: 'In Settings > General > About > Certificate Trust Settings, enable full trust for the proxy CA.',
      }),
    ],
    cleanup: [
      step('remove-proxy', 'manual', { type: 'instruction', text: 'Set the Wi-Fi HTTP Proxy back to Off.' }),
      step('remove-ca', 'manual', { type: 'instruction', text: 'Remove the installed CA profile and trust setting.' }),
    ],
  };
}

function androidPlan(base, ca, options) {
  const serial = normalizeIdentifier(options.serial, 'serial');
  const adbPrefix = serial ? ['-s', serial] : [];
  const proxyValue = `${formatHost(base.proxy.host)}:${base.proxy.port}`;
  return {
    ...base,
    prerequisites: ['ADB installed', 'An authorized Android device or emulator', ...(ca ? ['A generated proxy CA'] : [])],
    steps: [
      step('preflight', 'automatable_read_only', { type: 'adapter_preflight', adapter_id: 'android-adb' }),
      step('configure-proxy', 'automatable_requires_confirmation', {
        type: 'exec_file', executable: 'adb', args: [...adbPrefix, 'shell', 'settings', 'put', 'global', 'http_proxy', proxyValue],
        mutation: 'device_proxy_setting',
      }),
      step('install-ca', 'manual', {
        type: 'instruction',
        text: ca
          ? `Install the user CA from the authorized certificate at ${ca.cert_path}.`
          : 'Install the proxy CA as a user certificate using Android Settings.',
      }),
      step('app-trust', 'manual', {
        type: 'instruction',
        text: 'For Android 7+ apps, use a debug Network Security Configuration that opts into user CAs when the app does not already trust them.',
      }),
    ],
    cleanup: [
      step('remove-proxy', 'automatable_requires_confirmation', {
        type: 'exec_file', executable: 'adb', args: [...adbPrefix, 'shell', 'settings', 'delete', 'global', 'http_proxy'],
        mutation: 'device_proxy_setting',
      }),
      step('remove-ca', 'manual', { type: 'instruction', text: 'Remove the user CA in Android security settings.' }),
    ],
    unsupported: [
      'Automatic system-CA installation is not provided because it typically requires a rooted emulator or device and modifies the system trust store.',
      'Certificate pinning bypass is not provided.',
    ],
  };
}

function dockerPlan(base, ca, options) {
  const container = normalizeIdentifier(options.container, 'container');
  const containerHost = normalizeHost(options.proxy_host_for_container, 'proxy_host_for_container')
    ?? (base.proxy.host === '127.0.0.1' || base.proxy.host === 'localhost' ? 'host.docker.internal' : base.proxy.host);
  const containerProxyUrl = `${base.proxy.scheme}://${formatHost(containerHost)}:${base.proxy.port}`;
  return {
    ...base,
    target: container ? { container } : null,
    prerequisites: ['Docker CLI and daemon', 'A container image or Compose service you are authorized to reconfigure'],
    steps: [
      step('preflight', 'automatable_read_only', { type: 'adapter_preflight', adapter_id: 'docker' }),
      step('configure-environment', 'manual_or_orchestrator_requires_confirmation', {
        type: 'environment',
        set: { HTTP_PROXY: containerProxyUrl, HTTPS_PROXY: containerProxyUrl, http_proxy: containerProxyUrl, https_proxy: containerProxyUrl },
        applies_on: 'container_create_or_restart',
      }),
      ...(ca ? [step('provide-ca', 'manual_or_image_build', {
        type: 'mount_or_copy_plan',
        source: ca.cert_path,
        destination: options.ca_container_path ? normalizePathLike(options.ca_container_path, 'ca_container_path') : '/tmp/proxy-mcp-ca.pem',
        read_source: false,
      })] : []),
      step('client-trust', 'manual', {
        type: 'instruction',
        text: 'Configure the application runtime to trust the mounted CA, or add it during an authorized image build. The correct method depends on the image and client.',
      }),
    ],
    cleanup: [
      step('remove-environment', 'manual_or_orchestrator_requires_confirmation', {
        type: 'environment', unset: ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'], applies_on: 'container_recreate_or_restart',
      }),
      step('remove-ca', 'manual_or_image_build', { type: 'instruction', text: 'Remove the temporary CA mount or rebuild the image without it.' }),
    ],
    notes: ['On Linux, host.docker.internal may require an explicitly authorized host-gateway mapping. This plan does not add one automatically.'],
  };
}

function terminalPlan(base, ca, options) {
  const noProxy = normalizeStringArray(options.no_proxy ?? options.noProxy, 'no_proxy', 256) ?? [];
  const env = {
    HTTP_PROXY: base.proxy.url,
    HTTPS_PROXY: base.proxy.url,
    http_proxy: base.proxy.url,
    https_proxy: base.proxy.url,
    ...(noProxy.length ? { NO_PROXY: noProxy.join(','), no_proxy: noProxy.join(',') } : {}),
  };
  return {
    ...base,
    prerequisites: ['A client that supports explicit proxy environment variables'],
    steps: [
      step('configure-environment', 'manual', { type: 'environment', set: env, scope: 'new_process_only' }),
      ...(ca ? [step('configure-ca', 'manual_client_specific', {
        type: 'client_ca_options',
        cert_path: ca.cert_path,
        options: [
          { client: 'node', environment: { NODE_EXTRA_CA_CERTS: ca.cert_path } },
          { client: 'python-requests', environment: { REQUESTS_CA_BUNDLE: ca.cert_path } },
          { client: 'curl', argv_append: ['--cacert', ca.cert_path] },
        ],
      })] : []),
      step('launch-client', 'manual', { type: 'instruction', text: 'Launch the target client as a child of the configured environment.' }),
    ],
    cleanup: [step('unset-environment', 'manual', { type: 'environment', unset: [...Object.keys(env), 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE'] })],
    notes: ['SSL_CERT_FILE can replace rather than extend a runtime trust bundle, so it is not set automatically.'],
  };
}

function normalizeProxy(input) {
  const hostValue = input.host ?? input.proxy_host ?? input.proxyHost ?? '127.0.0.1';
  const portValue = input.port ?? input.proxy_port ?? input.proxyPort;
  const scheme = input.scheme ?? 'http';
  if (scheme !== 'http' && scheme !== 'https') throw invalid('Proxy scheme must be http or https.');
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    throw invalid('proxy port must be an integer between 1 and 65535.');
  }
  if (typeof hostValue !== 'string' || !hostValue || hostValue.length > 253 || !/^[A-Za-z0-9._:-]+$/u.test(hostValue)) {
    throw invalid('proxy host is invalid.');
  }
  let parsed;
  try { parsed = new URL(`http://${formatHost(hostValue)}:${portValue}`); }
  catch { throw invalid('proxy host is invalid.'); }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return { scheme, host, port: portValue, url: `${scheme}://${formatHost(host)}:${portValue}` };
}

function normalizeCaReference(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return { cert_path: normalizePathLike(value, 'CA certificate path') };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('CA certificate reference must be a path or object.');
  const certPath = value.cert_path ?? value.certPath ?? value.path;
  return { cert_path: normalizePathLike(certPath, 'CA certificate path') };
}

function normalizePathLike(value, name) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/u.test(value)) throw invalid(`${name} is invalid.`);
  return value;
}

function normalizeToken(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512 || /[\0\r\n]/u.test(value)) throw invalid(`${name} is invalid.`);
  return value;
}

function normalizeIdentifier(value, name) {
  const token = normalizeToken(value, name);
  if (token !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(token)) throw invalid(`${name} is invalid.`);
  return token;
}

function normalizeHost(value, name) {
  const token = normalizeToken(value, name);
  if (token === null) return null;
  if (token.length > 253 || !/^[A-Za-z0-9._:-]+$/u.test(token)) throw invalid(`${name} is invalid.`);
  try {
    const parsed = new URL(`http://${formatHost(token)}`);
    return parsed.hostname.replace(/^\[|\]$/g, '');
  } catch {
    throw invalid(`${name} is invalid.`);
  }
}

function normalizeStringArray(value, name, maxItems) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw invalid(`${name} must be an array with at most ${maxItems} items.`);
  return value.map((item) => {
    if (typeof item !== 'string' || !item || item.length > 1024 || /[\0\r\n]/u.test(item)) throw invalid(`${name} contains an invalid value.`);
    return item;
  });
}

function normalizeTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 100 || value > MAX_TIMEOUT_MS) throw invalid(`timeout must be between 100 and ${MAX_TIMEOUT_MS} milliseconds.`);
  return value;
}

function parseAdbDevices(stdout) {
  return String(stdout ?? '').split(/\r?\n/u).slice(1).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [serial, state, ...details] = line.split(/\s+/u);
    return { serial, state, details };
  });
}

function resolveAdapter(id) {
  if (typeof id !== 'string' || !BY_ID.has(id)) {
    throw new CaptureAdapterError(CAPTURE_ADAPTER_ERROR_CODES.UNKNOWN_ADAPTER, 'Unknown capture adapter.', {
      available: DESCRIPTORS.map((item) => item.id),
    });
  }
  return BY_ID.get(id);
}

function failed(common, code, message, checks) {
  return { ...common, ok: false, status: 'unavailable', code, message, checks };
}

function step(id, execution, action) {
  return { id, execution, action };
}

function descriptor(value) {
  return deepFreeze({ schema_version: 1, ...value });
}

function invalid(message) {
  return new CaptureAdapterError(CAPTURE_ADAPTER_ERROR_CODES.INVALID_OPTIONS, message);
}

function formatHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function compactOutput(value) {
  return String(value ?? '').trim().slice(0, 4096);
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function publicClone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function defaultRunCommand(executable, args, options) {
  return new Promise((resolve, reject) => {
    nodeExecFile(executable, args, options, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve({ stdout, stderr });
    });
  });
}
