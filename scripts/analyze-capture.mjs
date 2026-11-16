#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { analyzeFlows, evaluateCaptureAssertions } from '../src/lib/analytics.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.input) usage('Missing --input <capture.json|har>.');

try {
  const document = JSON.parse(await fs.readFile(args.input, 'utf8'));
  const flows = ['proxy-mate.session/v1', 'proxy-mcp.session/v1'].includes(document?.format)
    ? document.session?.flows
    : document?.log?.entries?.map(fromHarEntry);
  if (!Array.isArray(flows)) usage('Input must be a proxy-mate capture-session export or HAR document.');
  const analysis = analyzeFlows(flows, { slow_limit: args.slowLimit, group_limit: args.groupLimit });
  let assertions = null;
  if (args.assertions) assertions = evaluateCaptureAssertions(
    analysis,
    JSON.parse(await fs.readFile(args.assertions, 'utf8')),
  );
  process.stdout.write(`${JSON.stringify({ analysis, assertions }, null, 2)}\n`);
  if (assertions && !assertions.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`proxy-mate analyze failed [${error.code ?? 'ERROR'}]: ${error.message}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--input') result.input = argv[++index];
    else if (value === '--assertions') result.assertions = argv[++index];
    else if (value === '--slow-limit') result.slowLimit = Number(argv[++index]);
    else if (value === '--group-limit') result.groupLimit = Number(argv[++index]);
    else if (value === '--help' || value === '-h') usage();
    else usage(`Unknown argument: ${value}`);
  }
  return result;
}

function fromHarEntry(entry, index) {
  const started = Date.parse(entry?.startedDateTime ?? '');
  return {
    id: `har-${index + 1}`,
    timestamp: Number.isFinite(started) ? started : null,
    duration_ms: Number(entry?.time) || null,
    request: { method: entry?.request?.method, url: entry?.request?.url },
    response: { statusCode: entry?.response?.status, body_size: entry?.response?.bodySize },
  };
}

function usage(error) {
  if (error) process.stderr.write(`${error}\n`);
  process.stderr.write('Usage: node scripts/analyze-capture.mjs --input <capture.json|har> [--assertions assertions.json]\n');
  process.exit(error ? 2 : 0);
}
