import { readEnvironment } from './environment.mjs';
// Test-only overrides. Production ignores them unless explicitly opted in.
export const testHooksAllowed = (env = process.env) => Boolean(env.NODE_TEST_CONTEXT || readEnvironment('PROXYFAN_ALLOW_FAKE_NETWORKSETUP', env) === '1');
export const fakeHostTrust = (env = process.env) => testHooksAllowed(env) && readEnvironment('PROXYFAN_FAKE_HOST_TRUST', env) === 'trusted';
export const networksetupBinary = (env = process.env) => testHooksAllowed(env) && readEnvironment('PROXYFAN_FAKE_NETWORKSETUP', env) || '/usr/sbin/networksetup';
export const testTiming = (name, fallback, env = process.env) => testHooksAllowed(env) && Number(env[name]) > 0 && Number.isFinite(Number(env[name])) ? Number(env[name]) : fallback;
