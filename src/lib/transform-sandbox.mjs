import { getQuickJS } from 'quickjs-emscripten';

const KiB = 1024;
const MiB = 1024 * KiB;

export const DEFAULT_TRANSFORM_LIMITS = Object.freeze({
  maxSourceBytes: 64 * KiB,
  maxInputBytes: 256 * KiB,
  maxOutputBytes: 256 * KiB,
  memoryLimitBytes: 16 * MiB,
  maxStackBytes: 512 * KiB,
  timeoutMs: 50,
  maxJsonDepth: 64,
  maxJsonNodes: 100_000,
});

const FORBIDDEN_SOURCE = [
  [/(^|[^\w$])import\s*(?:\(|[\w{*])/m, 'module imports'],
  [/(^|[^\w$])export\s+(?:default|const|let|var|function|class|{|\*)/m, 'module exports'],
  [/\b(?:require|process|Buffer|fetch|XMLHttpRequest|WebSocket|Deno|Bun)\b/, 'host APIs'],
];

export class TransformSandboxError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'TransformSandboxError';
    this.code = code;
    this.details = details;
  }
}

/**
 * A reusable policy object. A new QuickJS runtime and context are still created
 * for every execute call; dispose() only prevents further executions.
 */
export class TransformSandbox {
  constructor(options = {}) {
    this.limits = normalizeLimits(options);
    this.disposed = false;
    this.quickJsPromise = options.quickJs ? Promise.resolve(options.quickJs) : getQuickJS();
  }

  validateSource(source) {
    ensureActive(this);
    if (typeof source !== 'string' || source.trim() === '') {
      throw new TransformSandboxError('TRANSFORM_INVALID_SOURCE', 'Transform source must be a non-empty JavaScript function expression');
    }
    const sourceBytes = Buffer.byteLength(source, 'utf8');
    if (sourceBytes > this.limits.maxSourceBytes) {
      throw new TransformSandboxError('TRANSFORM_SOURCE_TOO_LARGE', `Transform source exceeds the ${this.limits.maxSourceBytes}-byte limit`, {
        byte_size: sourceBytes,
        max_bytes: this.limits.maxSourceBytes,
      });
    }
    for (const [pattern, label] of FORBIDDEN_SOURCE) {
      if (pattern.test(source)) {
        throw new TransformSandboxError('TRANSFORM_FORBIDDEN_SOURCE', `Transform source may not use ${label}`);
      }
    }
    return { byte_size: sourceBytes };
  }

  async execute({ source, input } = {}) {
    ensureActive(this);
    this.validateSource(source);
    const inputText = serializeJsonInput(input, this.limits);
    const quickJs = await this.quickJsPromise;
    ensureActive(this);

    const runtime = quickJs.newRuntime();
    let context;
    const startedAt = Date.now();
    const deadline = startedAt + this.limits.timeoutMs;
    runtime.setMemoryLimit(this.limits.memoryLimitBytes);
    runtime.setMaxStackSize(this.limits.maxStackBytes);
    runtime.setInterruptHandler(() => Date.now() >= deadline);
    // Module loading is off by default, and is explicitly removed so a future
    // library default cannot turn source imports into a host callback.
    runtime.removeModuleLoader();

    try {
      context = runtime.newContext();
      const result = context.evalCode(
        buildProgram(source, inputText, this.limits),
        'proxyfan-transform.js',
        { type: 'global', strict: true },
      );

      // Evaluation is over, so lifting the VM allocation cap only permits the
      // small result/error handle to be copied out for classification.
      runtime.setMemoryLimit(-1);
      if (result.error) {
        let guestError;
        try { guestError = context.dump(result.error); } finally { result.error.dispose(); }
        throw classifyGuestError(guestError, Date.now() >= deadline);
      }

      let outputText;
      try { outputText = context.dump(result.value); } finally { result.value.dispose(); }
      if (typeof outputText !== 'string') {
        throw new TransformSandboxError('TRANSFORM_INVALID_RESULT', 'Transform did not return a JSON value');
      }
      const outputBytes = Buffer.byteLength(outputText, 'utf8');
      if (outputBytes > this.limits.maxOutputBytes) {
        throw new TransformSandboxError('TRANSFORM_OUTPUT_TOO_LARGE', `Transform output exceeds the ${this.limits.maxOutputBytes}-byte limit`, {
          byte_size: outputBytes,
          max_bytes: this.limits.maxOutputBytes,
        });
      }
      try { return JSON.parse(outputText); }
      catch { throw new TransformSandboxError('TRANSFORM_INVALID_RESULT', 'Transform did not return valid JSON'); }
    } catch (error) {
      if (error instanceof TransformSandboxError) throw error;
      throw classifyGuestError(error, Date.now() >= deadline);
    } finally {
      if (context?.alive) context.dispose();
      if (runtime.alive) runtime.dispose();
    }
  }

  dispose() { this.disposed = true; }
}

/** Convenience API for callers that do not need to retain a policy object. */
export async function executeTransform({ source, input, ...options } = {}) {
  const sandbox = new TransformSandbox(options);
  try { return await sandbox.execute({ source, input }); }
  finally { sandbox.dispose(); }
}

function ensureActive(sandbox) {
  if (sandbox.disposed) throw new TransformSandboxError('TRANSFORM_SANDBOX_DISPOSED', 'Transform sandbox has been disposed');
}

function normalizeLimits(options) {
  const limits = {};
  for (const [name, fallback] of Object.entries(DEFAULT_TRANSFORM_LIMITS)) {
    const value = options[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TransformSandboxError('TRANSFORM_INVALID_CONFIGURATION', `${name} must be a positive integer`);
    }
    limits[name] = value;
  }
  return Object.freeze(limits);
}

function serializeJsonInput(value, limits) {
  assertJsonValue(value, limits, 'TRANSFORM_INVALID_INPUT', 'Transform input');
  let text;
  try { text = JSON.stringify(value); }
  catch { throw new TransformSandboxError('TRANSFORM_INVALID_INPUT', 'Transform input must be JSON-serializable'); }
  const byteSize = Buffer.byteLength(text, 'utf8');
  if (byteSize > limits.maxInputBytes) {
    throw new TransformSandboxError('TRANSFORM_INPUT_TOO_LARGE', `Transform input exceeds the ${limits.maxInputBytes}-byte limit`, {
      byte_size: byteSize,
      max_bytes: limits.maxInputBytes,
    });
  }
  return text;
}

function assertJsonValue(root, limits, code, label) {
  const seen = new WeakSet();
  const pending = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    nodes += 1;
    if (nodes > limits.maxJsonNodes || depth > limits.maxJsonDepth) {
      throw new TransformSandboxError(code, `${label} exceeds JSON complexity limits`);
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    if (!value || typeof value !== 'object') throw new TransformSandboxError(code, `${label} must contain JSON values only`);
    if (seen.has(value)) throw new TransformSandboxError(code, `${label} must not contain circular references`);
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || Object.keys(value).length !== value.length) {
        throw new TransformSandboxError(code, `${label} arrays must be dense JSON arrays`);
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) throw new TransformSandboxError(code, `${label} may not contain accessors`);
        pending.push({ value: descriptor.value, depth: depth + 1 });
      }
      continue;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TransformSandboxError(code, `${label} must contain plain JSON objects only`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TransformSandboxError(code, `${label} may not contain symbol keys`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!('value' in descriptor)) throw new TransformSandboxError(code, `${label} may not contain accessors`);
      pending.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
}

function buildProgram(source, inputText, limits) {
  return `
"use strict";
(() => {
  const __getPrototypeOf = Reflect.getPrototypeOf;
  const __ownKeys = Reflect.ownKeys;
  const __getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const __objectPrototype = Object.prototype;
  const __arrayPrototype = Array.prototype;
  const __RealDate = Date;
  class __DeterministicDate extends __RealDate {
    constructor(...args) { super(...(args.length ? args : [0])); }
    static now() { return 0; }
  }
  Object.defineProperty(Math, "random", { value: () => 0.5, writable: false, configurable: false });
  Object.defineProperty(globalThis, "Date", { value: __DeterministicDate, writable: false, configurable: false });
  for (const __name of ["process", "require", "module", "exports", "Buffer", "fetch", "XMLHttpRequest", "WebSocket", "Deno", "Bun", "print", "console"]) {
    Object.defineProperty(globalThis, __name, { value: undefined, writable: false, configurable: false });
  }
  const __transform = (${source}\n);
  if (typeof __transform !== "function") throw new TypeError("__PROXYFAN_NOT_FUNCTION__");
  const __output = __transform(JSON.parse(${JSON.stringify(inputText)}));
  const __seen = new Set();
  const __pending = [[__output, 0]];
  let __nodes = 0;
  while (__pending.length) {
    const [__value, __depth] = __pending.pop();
    if (++__nodes > ${limits.maxJsonNodes} || __depth > ${limits.maxJsonDepth}) throw new TypeError("__PROXYFAN_INVALID_RESULT__:complexity");
    if (__value === null || typeof __value === "string" || typeof __value === "boolean") continue;
    if (typeof __value === "number" && Number.isFinite(__value)) continue;
    if (!__value || typeof __value !== "object") throw new TypeError("__PROXYFAN_INVALID_RESULT__:type");
    if (__seen.has(__value)) throw new TypeError("__PROXYFAN_INVALID_RESULT__:cycle");
    __seen.add(__value);
    const __prototype = __getPrototypeOf(__value);
    if (Array.isArray(__value)) {
      if (__prototype !== __arrayPrototype || Object.keys(__value).length !== __value.length) throw new TypeError("__PROXYFAN_INVALID_RESULT__:array");
    } else if (__prototype !== __objectPrototype && __prototype !== null) {
      throw new TypeError("__PROXYFAN_INVALID_RESULT__:object");
    }
    for (const __key of __ownKeys(__value)) {
      if (typeof __key !== "string") throw new TypeError("__PROXYFAN_INVALID_RESULT__:symbol");
      const __descriptor = __getOwnPropertyDescriptor(__value, __key);
      if (!__descriptor || !__descriptor.enumerable) continue;
      if (!("value" in __descriptor)) throw new TypeError("__PROXYFAN_INVALID_RESULT__:accessor");
      __pending.push([__descriptor.value, __depth + 1]);
    }
  }
  return JSON.stringify(__output);
})()
`;
}

function classifyGuestError(error, deadlineReached) {
  const name = typeof error?.name === 'string' ? error.name : 'Error';
  const message = typeof error?.message === 'string' ? error.message : String(error ?? 'Unknown transform error');
  if (deadlineReached || /interrupted/i.test(message)) {
    return new TransformSandboxError('TRANSFORM_TIMEOUT', 'Transform exceeded its execution deadline');
  }
  if (/out of memory|allocation failed/i.test(message)) {
    return new TransformSandboxError('TRANSFORM_MEMORY_LIMIT', 'Transform exceeded its memory limit');
  }
  if (/stack overflow|stack limit/i.test(message)) {
    return new TransformSandboxError('TRANSFORM_STACK_LIMIT', 'Transform exceeded its stack limit');
  }
  if (/__PROXYFAN_(?:INVALID_RESULT|NOT_FUNCTION)__/.test(message)) {
    return new TransformSandboxError('TRANSFORM_INVALID_RESULT', 'Transform must be a function that returns a synchronous JSON value');
  }
  return new TransformSandboxError('TRANSFORM_EXECUTION_FAILED', 'Transform execution failed', { guest_error_name: name });
}
