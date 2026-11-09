import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

export function connectionAttemptTimeout(env = process.env) {
  const raw = env.PROXY_MCP_CONNECT_ATTEMPT_TIMEOUT_MS;
  if (raw === undefined) return 2000;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < 10 || Number(raw) > 10000) {
    throw Object.assign(new Error('PROXY_MCP_CONNECT_ATTEMPT_TIMEOUT_MS must be a whole number from 10 to 10000.'), {
      code: 'INVALID_CONNECT_ATTEMPT_TIMEOUT',
    });
  }
  return Number(raw);
}

export function configureConnectionAttempts(env = process.env) {
  const timeout = connectionAttemptTimeout(env);
  setDefaultAutoSelectFamilyAttemptTimeout(timeout);
  return timeout;
}

export function activeConnectionAttemptTimeout() {
  return getDefaultAutoSelectFamilyAttemptTimeout();
}
