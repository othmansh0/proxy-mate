// Earlier service installations can pass either of the two previous prefixes.
const prefixes = ['PROXY_MCP_', 'PROXY_MATE_', 'PROXYFAN_'];

export function readEnvironment(name, env = process.env) {
  if (!name.startsWith('PROXYFAN_')) return env?.[name];
  const suffix = name.slice('PROXYFAN_'.length);
  return env?.[name] ?? env?.['PROXY_MATE_' + suffix] ?? env?.['PROXY_MCP_' + suffix];
}

export function serviceEnvironment(env = process.env) {
  const result = {};
  for (const prefix of prefixes) {
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith(prefix)) result['PROXYFAN_' + key.slice(prefix.length)] = value;
    }
  }
  if (env.DEVELOPER_DIR !== undefined) result.DEVELOPER_DIR = env.DEVELOPER_DIR;
  return result;
}
