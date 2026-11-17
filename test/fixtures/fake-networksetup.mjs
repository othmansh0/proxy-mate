#!/usr/bin/env node
// Requires an explicit isolated state file; never delegates to networksetup.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
const file = process.env.PROXY_MATE_FAKE_NETWORK_STATE;
// Node may discover fixtures as standalone test files; no command means no work.
if (!file && process.env.NODE_TEST_CONTEXT && process.argv.length === 2) process.exit(0);
if (!file) throw new Error('PROXY_MATE_FAKE_NETWORK_STATE required');
const state = JSON.parse(readFileSync(file, 'utf8'));
const [command, service, value] = process.argv.slice(2);
if (service && !(state.services ?? [state.service]).includes(service)) throw new Error('Unknown fake service');
switch (command) {
case '-listallnetworkservices': console.log('An asterisk (*) denotes that a network service is disabled.\n' + (state.services ?? [state.service]).join('\n')); break;
case '-getautoproxyurl': console.log(`URL: ${state.url || '(null)'}\nEnabled: ${state.enabled ? 'Yes' : 'No'}`); break;
case '-getwebproxy': case '-getsecurewebproxy': {
  const proxy = (command === '-getwebproxy' ? state.web_proxy : state.secure_web_proxy) ?? {};
  console.log(`Enabled: ${proxy.enabled ? 'Yes' : 'No'}\nServer: ${proxy.server ?? ''}\nPort: ${proxy.port ?? 0}\nAuthenticated Proxy Enabled: 0`); break;
}
case '-setautoproxyurl': state.url = value; break;
case '-setautoproxystate': state.enabled = value === 'on'; break;
default: throw new Error('Unsupported fake command ' + command);
}
if (command.startsWith('-set')) { writeFileSync(file + '.tmp', JSON.stringify(state)); renameSync(file + '.tmp', file); }
