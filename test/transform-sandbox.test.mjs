import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TransformSandbox,
  TransformSandboxError,
  executeTransform,
} from '../src/lib/transform-sandbox.mjs';

function hasCode(code) {
  return (error) => error instanceof TransformSandboxError && error.code === code;
}

test('executes a JSON transform with deterministic time/random and isolated globals', async () => {
  const source = `(input) => ({
    value: input.value + 1,
    time: Date.now(),
    random: Math.random(),
    leaked: globalThis.previousExecution ?? null,
    set: (globalThis.previousExecution = "present", true)
  })`;
  const first = await executeTransform({ source, input: { value: 1 } });
  const second = await executeTransform({ source, input: { value: 5 } });
  assert.deepEqual(first, { value: 2, time: 0, random: 0.5, leaked: null, set: true });
  assert.deepEqual(second, { value: 6, time: 0, random: 0.5, leaked: null, set: true });
});

test('interrupts an infinite loop at the wall-clock deadline', async () => {
  const sandbox = new TransformSandbox({ timeoutMs: 20 });
  const started = Date.now();
  await assert.rejects(sandbox.execute({ source: '() => { while (true) {} }', input: null }), hasCode('TRANSFORM_TIMEOUT'));
  assert.ok(Date.now() - started < 2_000);
  sandbox.dispose();
});

test('enforces source, input, output, and memory bounds with stable errors', async () => {
  const sourceBound = new TransformSandbox({ maxSourceBytes: 16 });
  await assert.rejects(sourceBound.execute({ source: `(value) => value /* ${'x'.repeat(40)} */`, input: null }), hasCode('TRANSFORM_SOURCE_TOO_LARGE'));
  sourceBound.dispose();

  const inputBound = new TransformSandbox({ maxInputBytes: 16 });
  await assert.rejects(inputBound.execute({ source: '(value) => value', input: { value: 'x'.repeat(40) } }), hasCode('TRANSFORM_INPUT_TOO_LARGE'));
  inputBound.dispose();

  const outputBound = new TransformSandbox({ maxOutputBytes: 32 });
  await assert.rejects(outputBound.execute({ source: '() => "x".repeat(100)', input: null }), hasCode('TRANSFORM_OUTPUT_TOO_LARGE'));
  outputBound.dispose();

  const memoryBound = new TransformSandbox({ memoryLimitBytes: 2 * 1024 * 1024 });
  await assert.rejects(memoryBound.execute({ source: '() => new Array(1_000_000).fill("memory")', input: null }), hasCode('TRANSFORM_MEMORY_LIMIT'));
  memoryBound.dispose();
});

test('rejects module syntax and host API identifiers before evaluation', async () => {
  for (const source of [
    'async (input) => import("node:fs")',
    '(input) => require("node:fs")',
    '(input) => process.env',
    '(input) => fetch("https://example.test")',
  ]) {
    await assert.rejects(executeTransform({ source, input: null }), hasCode('TRANSFORM_FORBIDDEN_SOURCE'), source);
  }
});

test('rejects non-function, asynchronous, cyclic, and non-JSON results', async () => {
  for (const source of [
    '({ value: true })',
    'async () => ({ value: true })',
    '() => undefined',
    '() => NaN',
    '() => { const value = {}; value.self = value; return value; }',
    '() => new Date(0)',
  ]) {
    await assert.rejects(executeTransform({ source, input: {} }), hasCode('TRANSFORM_INVALID_RESULT'), source);
  }
});

test('accepts JSON only as input and honors explicit disposal', async () => {
  const sandbox = new TransformSandbox();
  await assert.rejects(sandbox.execute({ source: '(value) => value', input: { value: 1n } }), hasCode('TRANSFORM_INVALID_INPUT'));
  sandbox.dispose();
  await assert.rejects(sandbox.execute({ source: '(value) => value', input: null }), hasCode('TRANSFORM_SANDBOX_DISPOSED'));
});
