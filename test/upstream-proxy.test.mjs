import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UPSTREAM_PROXY_ERROR_CODES,
  mockttpWebSocketCapabilitySummary,
  normalizeUpstreamProxyConfig,
  prepareUpstreamProxyConfig,
  redactUpstreamProxyConfig,
  upstreamProxyCapabilitySummary,
} from '../src/lib/upstream-proxy.mjs';

test('normalizes an authenticated Mockttp proxy setting and fully redacts public credentials', () => {
  const prepared = prepareUpstreamProxyConfig({
    url: 'https://alice:s3cr%40t@proxy.example:8443',
    no_proxy: ['localhost', '.internal.example:443'],
  });
  assert.equal(prepared.proxyConfig.proxyUrl, 'https://alice:s3cr%40t@proxy.example:8443/');
  assert.equal(prepared.publicConfig.proxyUrl, 'https://proxy.example:8443/');
  assert.equal(prepared.publicConfig.hasCredentials, true);
  assert.equal(prepared.publicConfig.proxyUrl.includes('@'), false);
  assert.equal(JSON.stringify(prepared.publicConfig).includes('alice'), false);
  assert.equal(JSON.stringify(prepared.publicConfig).includes('s3cr'), false);
  assert.deepEqual(prepared.proxyConfig.noProxy, ['localhost', '.internal.example:443']);
});

test('supports HTTP, HTTPS and SOCKS families and rejects unsafe schemes', () => {
  for (const scheme of ['http', 'https', 'socks', 'socks4', 'socks4a', 'socks5', 'socks5h']) {
    assert.equal(normalizeUpstreamProxyConfig(`${scheme}://proxy.example:1080`).proxyUrl.startsWith(`${scheme}:`), true);
  }
  for (const value of ['file:///etc/passwd', 'data:text/plain,no', 'pac+http://proxy.example/pac']) {
    assert.throws(() => normalizeUpstreamProxyConfig(value), {
      code: UPSTREAM_PROXY_ERROR_CODES.UNSUPPORTED_SCHEME,
    });
  }
});

test('rejects malformed URLs, ambiguous paths and injection characters without echoing secrets', () => {
  for (const value of [
    'http://proxy.example/path',
    'http://proxy.example?x=1',
    'http://proxy.example/#fragment',
    'http://user:topsecret@proxy.example\n--flag',
  ]) {
    try {
      normalizeUpstreamProxyConfig(value);
      assert.fail('expected invalid URL');
    } catch (error) {
      assert.equal(error.code, UPSTREAM_PROXY_ERROR_CODES.INVALID_URL);
      assert.equal(error.message.includes('topsecret'), false);
    }
  }
});

test('rejects oversized decoded credentials with a stable non-secret error', () => {
  const password = 'x'.repeat(1025);
  assert.throws(() => normalizeUpstreamProxyConfig(`http://user:${password}@proxy.example`), {
    code: UPSTREAM_PROXY_ERROR_CODES.CREDENTIALS_TOO_LARGE,
    message: 'The upstream proxy credentials exceed the allowed size.',
  });
});

test('accepts only explicitly authorized CA descriptors and never reads their paths', () => {
  const prepared = prepareUpstreamProxyConfig({
    proxy_url: 'http://proxy.example:3128',
    extra_ca_certificates: [{ cert_path: '/approved/proxy-ca.pem' }],
  }, { authorized_ca_paths: ['/approved/proxy-ca.pem'] });

  assert.deepEqual(prepared.proxyConfig.additionalTrustedCAs, [{ certPath: '/approved/proxy-ca.pem' }]);
  assert.deepEqual(prepared.publicConfig.additionalTrustedCAs, [{ type: 'path', certPath: '/approved/proxy-ca.pem' }]);
  assert.throws(() => normalizeUpstreamProxyConfig({
    proxyUrl: 'http://proxy.example',
    additionalTrustedCAs: [{ certPath: '/unapproved/ca.pem' }],
  }), { code: UPSTREAM_PROXY_ERROR_CODES.CA_UNAUTHORIZED });
});

test('inline CA contents are authorization-gated and omitted from public output', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
  assert.throws(() => normalizeUpstreamProxyConfig({
    proxyUrl: 'https://proxy.example', additionalTrustedCAs: [{ cert: pem }],
  }), { code: UPSTREAM_PROXY_ERROR_CODES.CA_UNAUTHORIZED });

  const prepared = prepareUpstreamProxyConfig({
    proxyUrl: 'https://proxy.example', additionalTrustedCAs: [{ pem }],
  }, { allowInlineCa: true });
  assert.equal(prepared.proxyConfig.additionalTrustedCAs[0].cert, pem);
  assert.deepEqual(prepared.publicConfig.additionalTrustedCAs, [{ type: 'inline', bytes: Buffer.byteLength(pem) }]);
  assert.equal(JSON.stringify(prepared.publicConfig).includes('BEGIN CERTIFICATE'), false);
});

test('redaction helper is idempotent with respect to secrets', () => {
  const publicConfig = redactUpstreamProxyConfig({ proxyUrl: 'socks5://bob:p%40ss@localhost:1080', noProxy: [] });
  assert.equal(publicConfig.proxyUrl, 'socks5://localhost:1080');
  assert.equal(JSON.stringify(publicConfig).includes('bob'), false);
});

test('capability reports precisely mark native live WebSocket mutation and injection unsupported', () => {
  const upstream = upstreamProxyCapabilitySummary();
  assert.equal(upstream.additional_proxy_ca_certificates.helper_reads_paths, false);
  assert.equal(upstream.credentials.public_output_redacted, true);

  const ws = mockttpWebSocketCapabilitySummary();
  assert.equal(ws.mockttp_version_inspected, '4.6.0');
  assert.equal(ws.observe_messages_via_events, true);
  assert.equal(ws.live_message_mutation, false);
  assert.equal(ws.live_message_injection, false);
  assert.equal(ws.exact_feasibility, 'unsupported_by_public_api');
});
