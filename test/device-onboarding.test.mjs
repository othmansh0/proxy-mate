import test from 'node:test';
import assert from 'node:assert/strict';

import { listLanAddresses, physicalDeviceInstructions } from '../src/lib/device-onboarding.mjs';

test('physical-device onboarding clearly separates automated and manual Apple steps', () => {
  const report = physicalDeviceInstructions({
    addresses: [{ interface: 'en0', address: '192.168.1.10', netmask: '255.255.255.0' }],
    proxyPort: 8080,
    portalPort: 8123,
    token: 'private-token',
  });
  assert.deepEqual(report.portal_urls, ['http://192.168.1.10:8123/private-token/']);
  assert(report.manual_required.some((step) => step.includes('Certificate Trust Settings')));
  assert(report.safety.some((step) => step.includes('Remove')));
  assert(Array.isArray(listLanAddresses()));
});
