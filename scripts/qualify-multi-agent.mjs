#!/usr/bin/env node
// Usage: node scripts/qualify-multi-agent.mjs --seconds 10 --cpu-factor 1 --json /tmp/multi.json
// Includes real routing checks against gated fake system settings; heavy CPU settings are opt-in.
// Fresh process required: all src imports happen after the temporary home is set.
import { runMultiAgent } from './lib/multi-agent-support.mjs';
import { parseOptions } from './lib/load-support.mjs';
import { writeFile } from 'node:fs/promises';
const config = parseOptions(process.argv.slice(2));
const report = await runMultiAgent(config);
if (config.json) await writeFile(config.json, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
