import os from 'node:os';
import path from 'node:path';

// A single overridable data root keeps runtime files consistent and makes the
// server testable without touching a developer's real ~/.proxy-mcp directory.
export const STATE_DIR = path.resolve(
  process.env.PROXY_MCP_HOME || path.join(os.homedir(), '.proxy-mcp'),
);

// Single source of truth for the live-transform grant. The plugin catalog and
// rules.json are both durable, so the grant has to be re-read per run at every
// registration path rather than trusted from the session that first set it.
export const TRANSFORM_PLUGIN_GRANT_ENV = 'PROXY_MCP_ENABLE_TRANSFORM_PLUGINS';

export function liveTransformGrantEnabled() {
  return process.env[TRANSFORM_PLUGIN_GRANT_ENV] === '1';
}

export const SERVER_NAME = 'proxy-mcp';
export const SERVER_VERSION = '0.8.2';
export const PROXY_PORT_DEFAULT = 8080;
export const PAC_PORT_DEFAULT = 8081;
export const CONTROL_PORT_DEFAULT = 8082;
