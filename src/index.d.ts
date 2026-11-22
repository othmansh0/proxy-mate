export interface ProxyClientOptions {
  /** Absolute daemon state directory. Defaults to PROXYFAN_HOME, an existing legacy root, or ~/.proxyfan. */
  home?: string;
  /** Bounded readiness wait before each call, 0–60000 ms. Default 15000. */
  readyTimeoutMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Per-call RPC timeout, 1–300000 ms. Defaults to the tool's own deadline. */
  timeoutMs?: number;
}

export interface ProxyClient {
  /** Returns tool data directly. Errors reject with code/recovery fields when available.
   * Each instance remembers only the task lease it explicitly acquired.
   * Call finish_capture_task explicitly; dropping the client never cleans up capture.
   */
  callTool<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>, options?: RequestOptions): Promise<T>;
}

/** Connect to the existing local daemon without starting or changing capture. */
export function createProxyClient(options?: ProxyClientOptions): ProxyClient;
