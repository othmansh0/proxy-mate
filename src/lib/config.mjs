import os from 'node:os';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { readEnvironment } from './environment.mjs';

// A single overridable data root keeps runtime files consistent and makes the
// server testable without touching a developer's real ~/.proxy-mate directory.
export function resolveStateDirectory({ home = os.homedir(), env = process.env, exists = existsSync } = {}) {
  const explicit = readEnvironment('PROXY_MATE_HOME', env);
  if (explicit) return path.resolve(explicit);
  // Reuse existing installations in place: stored body paths, CA trust and
  // bridges may still refer to this directory. Never copy or rotate the CA.
  const legacy = path.join(home, '.proxy-mcp');
  return exists(legacy) ? legacy : path.join(home, '.proxy-mate');
}

export const STATE_DIR = resolveStateDirectory();

// Single source of truth for the live-transform grant. The plugin catalog and
// rules.json are both durable, so the grant has to be re-read per run at every
// registration path rather than trusted from the session that first set it.
export const TRANSFORM_PLUGIN_GRANT_ENV = 'PROXY_MATE_ENABLE_TRANSFORM_PLUGINS';

export function liveTransformGrantEnabled() {
  return readEnvironment(TRANSFORM_PLUGIN_GRANT_ENV) === '1';
}

export const SERVER_NAME = 'proxy-mate';
// npm version updates the package/lock once; installed snapshots include this manifest.
export const SERVER_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
export const PROXY_PORT_DEFAULT = 8080;
export const PAC_PORT_DEFAULT = 8081;
export const CONTROL_PORT_DEFAULT = 8082;
