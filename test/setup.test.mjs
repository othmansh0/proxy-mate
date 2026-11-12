import test from 'node:test';
import assert from 'node:assert/strict';
import { runCaptureSetup, parseApiDomains } from '../src/lib/setup.mjs';
import { gettingStarted } from '../src/lib/guidance.mjs';

function wizard(answers, overrides = {}) {
  const calls = [];
  let output = '';
  const execute = async (tool, args) => {
    calls.push({ tool, args });
    if (overrides[tool]) return overrides[tool](args);
    if (tool === 'list_simulator_apps') return args.udid
      ? { applications: [{ name: 'Demo', bundle_id: 'com.example.demo' }] }
      : { devices: [{ name: 'iPhone', udid: 'sim-1' }] };
    if (tool === 'get_proxy_status') return { running: true, port: 8080 };
    if (tool === 'setup_host_certificate') return { trusted: true };
    return { status: 'ready' };
  };
  return { calls, output: () => output, options: {
    ask: async () => { assert.ok(answers.length, 'Unexpected extra setup question'); return answers.shift(); },
    write: (text) => { output += text; }, call: execute,
  } };
}

test('first-time setup defaults to one app without asking APIs or touching Mac trust', async () => {
  const { calls, options, output } = wizard(['', '', '', '', 'y']);
  await runCaptureSetup(options);
  assert.deepEqual(calls.map((item) => item.tool), [
    'list_simulator_apps', 'list_simulator_apps', 'get_proxy_status', 'stop_proxy', 'start_app_capture',
  ]);
  assert.deepEqual(calls.at(-1).args, { udid: 'sim-1', bundle_id: 'com.example.demo', duration_seconds: 3600 });
  assert.match(output(), /Mac Keychain trust is not requested/);
});

test('cancelling or declining review performs no capture mutations', async () => {
  for (const answers of [['q'], ['', 'q'], ['', '', 'q'], ['', '', '', 'q'], ['', '', '', '', 'n']]) {
    const { calls, options } = wizard(answers);
    assert.equal((await runCaptureSetup(options)).status, 'cancelled');
    assert.ok(calls.every((item) => item.tool.startsWith('list_')));
  }
});

test('URL input becomes host scope and cannot silently enable all-Mac capture', () => {
  assert.deepEqual(parseApiDomains('https://api.example.com/v1,api.example.com,*.example.org'), ['api.example.com', '*.example.org']);
  for (const input of ['', '*', 'https://user:secret@example.com', 'file:///private', 'localhost']) {
    assert.throws(() => parseApiDomains(input));
  }
});

test('broader domain capture requires an explicit choice and certificate approval', async () => {
  const { calls, options } = wizard(['2', '', 'https://api.example.com/v1', '15', 'y']);
  await runCaptureSetup(options);
  assert.equal(calls.some((item) => item.tool === 'start_app_capture'), false);
  assert.deepEqual(calls.at(-1), { tool: 'set_proxy_routing', args: {
    domains: ['api.example.com'], allow_broad_routing: false, duration_seconds: 900,
  } });
  assert.equal(calls.at(-2).tool, 'setup_host_certificate');
});

test('all-Mac capture is only configured after selecting its separate advanced option', async () => {
  const { calls, options } = wizard(['3', '', '', 'y']);
  await runCaptureSetup(options);
  assert.deepEqual(calls.at(-1).args, { domains: ['*'], allow_broad_routing: true, duration_seconds: 3600 });
});

test('denied certificate approval stops the new capture without changing routing', async () => {
  const { calls, options } = wizard(['2', '', 'api.example.com', '', 'y'], {
    setup_host_certificate: async () => ({ trusted: false, error: 'Cancelled' }),
  });
  await assert.rejects(runCaptureSetup(options), /Cancelled/);
  assert.equal(calls.at(-1).tool, 'stop_proxy');
  assert.equal(calls.some((item) => item.tool === 'set_proxy_routing'), false);
});

test('chat onboarding does not infer broad interception permission from an API URL', () => {
  const state = { running: true, recording: true, routing_active: false };
  const result = gettingStarted({ url: 'https://api.example.com' }, state);
  assert.equal(result.default_capture_scope, 'app');
  assert.deepEqual(result.next_calls, [{ tool: 'get_flows', arguments: { host: 'api.example.com', limit: 20 } }]);
  assert.ok(result.setup_questions.length);
  const domains = gettingStarted({ url: 'https://api.example.com', capture_scope: 'domains' }, state);
  assert.equal(domains.next_calls.at(-1).arguments.domains[0], 'api.example.com');
});
