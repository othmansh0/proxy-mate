import { readEnvironment } from './environment.mjs';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { STATE_DIR } from './config.mjs';

function configuredRoots() {
  const extra = String(readEnvironment('PROXYFAN_ALLOWED_PATHS') ?? '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set([STATE_DIR, process.cwd(), ...extra].map((item) => path.resolve(item)))];
}

function isContained(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function realExistingAncestor(target) {
  let current = target;
  while (true) {
    try {
      return { real: await fs.realpath(current), suffix: path.relative(current, target) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function authorizedPath(value, { mustExist, kind }) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw codedPathError('PATH_REQUIRED', `${kind} path is required`);
  }
  const resolved = path.resolve(value);
  const roots = configuredRoots();
  let canonical;
  try {
    if (mustExist) canonical = await fs.realpath(resolved);
    else {
      const ancestor = await realExistingAncestor(resolved);
      canonical = path.resolve(ancestor.real, ancestor.suffix);
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw codedPathError('PATH_NOT_FOUND', `${kind} path does not exist: ${resolved}`);
    throw error;
  }
  const allowed = await Promise.all(roots.map(async (root) => {
    try { return await fs.realpath(root); } catch { return root; }
  }));
  if (!allowed.some((root) => isContained(canonical, root))) {
    throw codedPathError(
      'PATH_NOT_AUTHORIZED',
      `${kind} path is outside proxyfan's authorized roots`,
      { path: resolved, allowed_roots: roots },
    );
  }
  return canonical;
}

export async function authorizeReadPath(value) {
  return authorizedPath(value, { mustExist: true, kind: 'read' });
}

export async function authorizeWritePath(value) {
  return authorizedPath(value, { mustExist: false, kind: 'write' });
}

export function defaultExportPath(...parts) {
  return path.join(STATE_DIR, 'exports', ...parts);
}

export function sensitiveAccessAllowed() {
  return readEnvironment('PROXYFAN_ALLOW_SENSITIVE') === '1';
}

export function requireSensitiveAccess(requested) {
  if (!requested) return false;
  if (sensitiveAccessAllowed()) return true;
  const error = new Error(
    'Sensitive flow access is disabled. Restart proxyfan with PROXYFAN_ALLOW_SENSITIVE=1 only in a trusted, temporary debugging session.',
  );
  error.code = 'SENSITIVE_ACCESS_DISABLED';
  error.retryable = false;
  error.recovery = ['Keep redaction enabled', 'Or restart a trusted local session with PROXYFAN_ALLOW_SENSITIVE=1'];
  throw error;
}

function codedPathError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  if (details) error.details = details;
  return error;
}
