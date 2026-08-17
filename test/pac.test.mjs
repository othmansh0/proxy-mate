import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPacText } from '../src/lib/pac.mjs';

test('PAC routes configured domains and always bypasses loopback', () => {
  const pac = buildPacText(['*.example.com', 'api.test'], '127.0.0.1', 8080);
  assert.match(pac, /shExpMatch\(host, "\*\.example\.com"\)/);
  assert.match(pac, /host === "127\.0\.0\.1"/);
  assert.match(pac, /PROXY 127\.0\.0\.1:8080/);
  assert.match(pac, /return "DIRECT"/);
});

test('PAC string-escapes untrusted domain input', () => {
  const pac = buildPacText(['x\"); return "DIRECT'], '127.0.0.1', 8080);
  assert.match(pac, /x\\"\); return \\"DIRECT/);
});

