// Read configuration dynamically without mutating the embedding application's
// environment. Explicit Proxy Mate values take precedence, including "0".
export function readEnvironment(name, env = process.env) {
  return env?.[name] ?? env?.[name.replace(/^PROXY_MATE_/, 'PROXY_MCP_')];
}

export function serviceEnvironment(env = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('PROXY_MCP_')) result[key.replace(/^PROXY_MCP_/, 'PROXY_MATE_')] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('PROXY_MATE_') || key === 'DEVELOPER_DIR') result[key] = value;
  }
  return result;
}
