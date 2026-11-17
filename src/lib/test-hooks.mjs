// Test-only overrides. Production ignores them unless explicitly opted in.
export const testHooksAllowed = (env = process.env) => Boolean(env.NODE_TEST_CONTEXT || env.PROXY_MATE_ALLOW_FAKE_NETWORKSETUP === '1');
export const fakeHostTrust = (env = process.env) => testHooksAllowed(env) && env.PROXY_MATE_FAKE_HOST_TRUST === 'trusted';
export const networksetupBinary = (env = process.env) => testHooksAllowed(env) && env.PROXY_MATE_FAKE_NETWORKSETUP || '/usr/sbin/networksetup';
export const testTiming = (name, fallback, env = process.env) => testHooksAllowed(env) && Number(env[name]) > 0 && Number.isFinite(Number(env[name])) ? Number(env[name]) : fallback;
