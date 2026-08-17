const MAX_PROXY_URL_BYTES = 8 * 1024;
const MAX_PROXY_URL_INPUT_BYTES = 64 * 1024;
const MAX_USERNAME_BYTES = 256;
const MAX_PASSWORD_BYTES = 1024;
const MAX_NO_PROXY_ITEMS = 256;
const MAX_NO_PROXY_BYTES = 1024;
const MAX_CA_BYTES = 1024 * 1024;
const MAX_CA_ITEMS = 32;
const MAX_PROXY_SETTINGS = 16;

export const UPSTREAM_PROXY_ERROR_CODES = Object.freeze({
  INVALID_CONFIG: 'UPSTREAM_PROXY_INVALID_CONFIG',
  INVALID_URL: 'UPSTREAM_PROXY_INVALID_URL',
  UNSUPPORTED_SCHEME: 'UPSTREAM_PROXY_UNSUPPORTED_SCHEME',
  CREDENTIALS_TOO_LARGE: 'UPSTREAM_PROXY_CREDENTIALS_TOO_LARGE',
  INVALID_NO_PROXY: 'UPSTREAM_PROXY_INVALID_NO_PROXY',
  INVALID_CA: 'UPSTREAM_PROXY_INVALID_CA',
  CA_UNAUTHORIZED: 'UPSTREAM_PROXY_CA_UNAUTHORIZED',
});

export class UpstreamProxyError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'UpstreamProxyError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const ALLOWED_PROTOCOLS = new Set([
  'http:',
  'https:',
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
  'socks5h:',
]);

/**
 * Normalize an MCP-safe upstream description into Mockttp 4.x ProxySetting data.
 *
 * Accepted input is a URL string, a setting object, or an array of either. A
 * setting object uses:
 *   { proxyUrl | proxy_url | url, noProxy | no_proxy,
 *     additionalTrustedCAs | extra_ca_certificates }
 *
 * CA descriptors use { certPath | cert_path } or { cert | pem }. They are never
 * read here and are rejected unless the caller explicitly authorizes them.
 */
export function normalizeUpstreamProxyConfig(input, options = {}) {
  if (Array.isArray(input)) {
    if (input.length === 0 || input.length > MAX_PROXY_SETTINGS) {
      throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_CONFIG,
        `proxyConfig must contain between 1 and ${MAX_PROXY_SETTINGS} settings.`);
    }
    return input.map((setting) => normalizeSetting(setting, options));
  }
  return normalizeSetting(input, options);
}

/** Return both the credential-bearing Mockttp value and a safe public view. */
export function prepareUpstreamProxyConfig(input, options = {}) {
  const proxyConfig = normalizeUpstreamProxyConfig(input, options);
  return {
    proxyConfig,
    publicConfig: redactUpstreamProxyConfig(proxyConfig),
  };
}

/**
 * Produce a JSON-safe public representation. Passwords, usernames and inline CA
 * contents are never included.
 */
export function redactUpstreamProxyConfig(config) {
  if (Array.isArray(config)) return config.map(redactSetting);
  return redactSetting(config);
}

export function upstreamProxyCapabilitySummary() {
  return {
    schema_version: 1,
    mockttp_proxy_config_shape: 'ProxySetting',
    supported_schemes: [...ALLOWED_PROTOCOLS].map((protocol) => protocol.slice(0, -1)),
    credentials: {
      url_userinfo: true,
      public_output_redacted: true,
      maximum_username_bytes: MAX_USERNAME_BYTES,
      maximum_password_bytes: MAX_PASSWORD_BYTES,
    },
    additional_proxy_ca_certificates: {
      inline_pem: true,
      path_descriptor: true,
      authorization_required: true,
      helper_reads_paths: false,
      replaces_default_trust: false,
    },
    unsupported: ['PAC URLs', 'proxy callbacks', 'rule-parameter references', 'trustedCAs replacement'],
  };
}

/**
 * Findings from the installed Mockttp 4.6.0 declarations and implementation.
 * This is deliberately descriptive only: no message-level emulation is exposed.
 */
export function mockttpWebSocketCapabilitySummary() {
  return {
    mockttp_version_inspected: '4.6.0',
    websocket_passthrough: true,
    handshake_request_transform: true,
    observe_messages_via_events: true,
    mock_behaviors: ['echo', 'listen', 'reject'],
    live_message_mutation: false,
    live_message_injection: false,
    exact_feasibility: 'unsupported_by_public_api',
    evidence: {
      public_passthrough_options: ['transformRequest'],
      public_message_events: ['websocket-message-received', 'websocket-message-sent'],
      implementation: 'PassThroughWebSocketStepImpl privately pipes message, close, ping, and pong events between downstream and upstream sockets.',
    },
    note: 'The public events are observational and expose no socket handle or reply/mutation callback. Implementing live mutation or injection would require a separate WebSocket bridge or dependence on Mockttp internals, neither of which this helper emulates.',
  };
}

export const getUpstreamProxyCapabilities = upstreamProxyCapabilitySummary;
export const getMockttpWebSocketCapabilities = mockttpWebSocketCapabilitySummary;

function normalizeSetting(input, options) {
  const object = typeof input === 'string' ? { proxyUrl: input } : input;
  if (!isPlainObject(object)) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_CONFIG, 'proxyConfig must be a proxy URL, a plain object, or an array of those values.');
  }

  const supportedKeys = new Set([
    'proxyUrl', 'proxy_url', 'url', 'noProxy', 'no_proxy',
    'additionalTrustedCAs', 'extra_ca_certificates', 'extraCACertificates',
  ]);
  const unknownKeys = Object.keys(object).filter((key) => !supportedKeys.has(key));
  if (unknownKeys.length) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_CONFIG, 'proxyConfig contains unsupported fields.', { fields: unknownKeys.sort() });
  }

  const proxyUrlValue = uniqueAlias(object, ['proxyUrl', 'proxy_url', 'url'], 'proxy URL');
  const noProxyValue = uniqueAlias(object, ['noProxy', 'no_proxy'], 'noProxy');
  const caValue = uniqueAlias(
    object,
    ['additionalTrustedCAs', 'extra_ca_certificates', 'extraCACertificates'],
    'additionalTrustedCAs',
  );
  const proxyUrl = normalizeProxyUrl(proxyUrlValue);
  const noProxy = normalizeNoProxy(noProxyValue);
  const additionalTrustedCAs = normalizeCaDescriptors(caValue, options);

  return cleanObject({ proxyUrl, noProxy, additionalTrustedCAs });
}

function normalizeProxyUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_PROXY_URL_INPUT_BYTES) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_URL, 'The upstream proxy URL is missing or too large.');
  }
  if (/\s|[\0-\x1f\x7f]/u.test(value)) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_URL, 'The upstream proxy URL contains forbidden whitespace or control characters.');
  }

  let parsed;
  try { parsed = new URL(value); }
  catch { throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_URL, 'The upstream proxy URL is invalid.'); }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.UNSUPPORTED_SCHEME, 'The upstream proxy URL scheme is not supported.', {
      supported_schemes: [...ALLOWED_PROTOCOLS].map((protocol) => protocol.slice(0, -1)),
    });
  }
  if (!parsed.hostname) throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_URL, 'The upstream proxy URL must include a hostname.');
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_URL, 'The upstream proxy URL cannot include a path, query, or fragment.');
  }
  if (parsed.port) {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_URL, 'The upstream proxy URL port is invalid.');
    }
  }

  const username = decodeUserInfo(parsed.username);
  const password = decodeUserInfo(parsed.password);
  if (Buffer.byteLength(username, 'utf8') > MAX_USERNAME_BYTES || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.CREDENTIALS_TOO_LARGE, 'The upstream proxy credentials exceed the allowed size.');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_PROXY_URL_BYTES) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_URL, 'The upstream proxy URL is missing or too large.');
  }

  return parsed.toString();
}

function decodeUserInfo(value) {
  try { return decodeURIComponent(value); }
  catch { throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_URL, 'The upstream proxy URL contains malformed credential encoding.'); }
}

function normalizeNoProxy(value) {
  if (value === undefined) return undefined;
  const entries = typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : value;
  if (!Array.isArray(entries) || entries.length > MAX_NO_PROXY_ITEMS) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_NO_PROXY, `noProxy must contain at most ${MAX_NO_PROXY_ITEMS} entries.`);
  }
  return entries.map((entry) => {
    if (typeof entry !== 'string' || !entry || Buffer.byteLength(entry, 'utf8') > MAX_NO_PROXY_BYTES || /[\0\r\n]/u.test(entry)) {
      throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_NO_PROXY, 'noProxy contains an invalid entry.');
    }
    return entry;
  });
}

function normalizeCaDescriptors(value, options) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_CA_ITEMS) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_CA, `additionalTrustedCAs must contain at most ${MAX_CA_ITEMS} descriptors.`);
  }
  return value.map((input, index) => {
    const descriptor = normalizeCaDescriptor(input);
    if (!isCaAuthorized(descriptor, input, options)) {
      throw proxyError(UPSTREAM_PROXY_ERROR_CODES.CA_UNAUTHORIZED, 'An additional CA descriptor was not authorized.', { index });
    }
    return descriptor;
  });
}

function normalizeCaDescriptor(input) {
  if (!isPlainObject(input)) throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_CA, 'Each additional CA must be a plain object.');
  const supportedKeys = new Set(['certPath', 'cert_path', 'cert', 'pem']);
  const unknownKeys = Object.keys(input).filter((key) => !supportedKeys.has(key));
  if (unknownKeys.length) throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_CA, 'An additional CA descriptor contains unsupported fields.');

  const certPath = uniqueAlias(input, ['certPath', 'cert_path'], 'CA certificate path');
  const cert = uniqueAlias(input, ['cert', 'pem'], 'inline CA certificate');
  if ((certPath === undefined) === (cert === undefined)) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_CA, 'Each additional CA must specify exactly one of certPath or cert.');
  }
  if (certPath !== undefined) {
    if (typeof certPath !== 'string' || !certPath || certPath.length > 4096 || /[\0\r\n]/u.test(certPath)) {
      throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_CA, 'The additional CA path is invalid.');
    }
    return { certPath };
  }
  if (!(typeof cert === 'string' || Buffer.isBuffer(cert)) || byteLength(cert) === 0 || byteLength(cert) > MAX_CA_BYTES) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_CA, 'The inline additional CA is empty or too large.');
  }
  return { cert };
}

function isCaAuthorized(normalized, original, options) {
  if (typeof options.authorizeCaDescriptor === 'function') {
    try { return options.authorizeCaDescriptor(normalized, original) === true; }
    catch { return false; }
  }
  if ('certPath' in normalized) {
    const allowed = options.authorizedCaPaths ?? options.authorized_ca_paths;
    if (allowed && typeof allowed[Symbol.iterator] === 'function') return new Set(allowed).has(normalized.certPath);
    return false;
  }
  return options.allowInlineCa === true || options.allow_inline_ca === true;
}

function redactSetting(value) {
  if (!isPlainObject(value)) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_CONFIG, 'A normalized proxy setting must be a plain object.');
  }
  let parsed;
  try { parsed = new URL(value.proxyUrl); }
  catch { throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_URL, 'The upstream proxy URL is invalid.'); }
  const hasCredentials = parsed.username !== '' || parsed.password !== '';
  if (hasCredentials) {
    parsed.username = '';
    parsed.password = '';
  }
  return cleanObject({
    proxyUrl: parsed.toString(),
    hasCredentials,
    noProxy: value.noProxy ? [...value.noProxy] : undefined,
    additionalTrustedCAs: value.additionalTrustedCAs?.map((ca) => ('certPath' in ca
      ? { type: 'path', certPath: ca.certPath }
      : { type: 'inline', bytes: byteLength(ca.cert) })),
  });
}

function uniqueAlias(object, aliases, label) {
  const present = aliases.filter((key) => object[key] !== undefined);
  if (present.length > 1) {
    throw proxyError(UPSTREAM_PROXY_ERROR_CODES.INVALID_CONFIG, `${label} was specified more than once.`);
  }
  return present.length ? object[present[0]] : undefined;
}

function byteLength(value) {
  return Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value, 'utf8');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function proxyError(code, message, details) {
  return new UpstreamProxyError(code, message, details);
}
