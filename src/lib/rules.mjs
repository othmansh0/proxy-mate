// Mock rule persistence: serialize/deserialize the rule registry to
// ~/.proxy-mcp/rules.json so rules survive daemon restarts and can be
// shared across sessions.
//
// Rule schema (one object per rule):
//   {
//     rule_id, url_pattern, method, status, content_type, headers,
//     body_file,                              // path on disk (preferred)
//     directory, fallthrough,                 // optional Map Local tree
//     body_inline,                            // legacy/back-compat
//     match_headers, match_query,             // optional rich matchers
//     match_json_body_including,
//     match_body_regex,
//     enabled, priority, order, hit_count, last_hit,
//     request_transform, response_transform, delay_ms, fault,
//     created_at, updated_at,
//   }

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';
import { atomicWriteJson } from './state.mjs';

const RULES_FILE = path.join(STATE_DIR, 'rules.json');

export async function loadRules() {
  try {
    const raw = await fs.readFile(RULES_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.rules)) return data.rules;
    return [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export async function saveRules(rules) {
  await atomicWriteJson(RULES_FILE, { version: 2, rules }, 0o600);
}

// Export the current rule definitions (not the live mockttp endpoints) to a
// caller-specified path. Path defaults to STATE_DIR/rules-export.json.
export async function exportRulesTo(rules, destPath) {
  const out = destPath || path.join(STATE_DIR, 'rules-export.json');
  await fs.mkdir(path.dirname(out), { recursive: true });
  const assetsName = `${path.basename(out, path.extname(out))}.assets`;
  const assetsDir = path.join(path.dirname(out), assetsName);
  const portable = [];
  for (const rule of rules) {
    const copy = { ...rule };
    if (copy.body_file) {
      const safeId = String(copy.rule_id).replace(/[^A-Za-z0-9._-]/g, '_');
      const assetName = `${safeId}.bin`;
      await fs.mkdir(assetsDir, { recursive: true, mode: 0o700 });
      await fs.copyFile(copy.body_file, path.join(assetsDir, assetName));
      copy.body_file = `./${assetsName}/${assetName}`;
    }
    if (copy.directory) {
      const safeId = String(copy.rule_id).replace(/[^A-Za-z0-9._-]/g, '_');
      const assetName = `${safeId}-directory`;
      const destination = path.join(assetsDir, assetName);
      await fs.mkdir(assetsDir, { recursive: true, mode: 0o700 });
      await fs.cp(copy.directory, destination, { recursive: true, force: true });
      copy.directory = `./${assetsName}/${assetName}`;
    }
    portable.push(copy);
  }
  await atomicWriteJson(out, { version: 2, rules: portable }, 0o600);
  return out;
}

export async function importRulesFrom(srcPath) {
  const raw = await fs.readFile(srcPath, 'utf8');
  const data = JSON.parse(raw);
  const rules = Array.isArray(data) ? data : data?.rules;
  if (Array.isArray(rules)) {
    return rules.map((rule) => ({
      ...rule,
      body_file: rule.body_file && !path.isAbsolute(rule.body_file)
        ? path.resolve(path.dirname(srcPath), rule.body_file)
        : rule.body_file,
      directory: rule.directory && !path.isAbsolute(rule.directory)
        ? path.resolve(path.dirname(srcPath), rule.directory)
        : rule.directory,
    }));
  }
  throw new Error('rule import: expected array or { rules: [...] }');
}
