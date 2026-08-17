import os from 'node:os';
import path from 'node:path';

// A single overridable data root keeps runtime files consistent and makes the
// server testable without touching a developer's real ~/.proxy-mcp directory.
export const STATE_DIR = path.resolve(
  process.env.PROXY_MCP_HOME || path.join(os.homedir(), '.proxy-mcp'),
);

export const SERVER_NAME = 'proxy-mcp';
export const SERVER_VERSION = '0.6.0';
export const PROXY_PORT_DEFAULT = 8080;
export const PAC_PORT_DEFAULT = 8081;
export const CONTROL_PORT_DEFAULT = 8082;
