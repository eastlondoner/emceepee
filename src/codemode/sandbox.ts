/**
 * Codemode Sandbox
 *
 * Provides isolated JavaScript execution environment using Node.js vm module.
 * User code runs in a sandboxed context with access only to the mcp.* API.
 */

import { createContext, Script } from "vm";
import { inspect } from "util";
import type {
  SandboxConfig,
  SandboxResult,
  SandboxError,
  SandboxAPI,
  ExecutionContext,
} from "./types.js";

// =============================================================================
// Constants
// =============================================================================

/**
 * Globals that are explicitly blocked in the sandbox
 */
const BLOCKED_GLOBALS = [
  // Node.js specific
  "process",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "global",
  "globalThis",
  "Buffer",

  // Timers (we provide controlled sleep instead)
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",

  // Network/IO
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Request",
  "Response",
  "Headers",

  // Dynamic code execution
  "eval",
  "Function",

  // Binary data (potential for exploits)
  "ArrayBuffer",
  "SharedArrayBuffer",
  "Atomics",
  "WebAssembly",
  "DataView",

  // Other potentially dangerous APIs
  "Proxy",
  "Reflect",
] as const;

/**
 * Maximum sleep duration per call (5 seconds)
 */
const MAX_SLEEP_MS = 5000;

// =============================================================================
// Console Capture
// =============================================================================

/**
 * Format a value for logging output
 */
function formatLogValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    try {
      return inspect(value, { depth: 3, colors: false, maxArrayLength: 50 });
    } catch {
      return inspect(value);
    }
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "function") {
    return "[Function]";
  }
  return inspect(value);
}

/**
 * Format multiple log arguments into a single string
 */
function formatLogArgs(args: unknown[]): string {
  return args.map(formatLogValue).join(" ");
}

/**
 * Create a console object that captures output
 */
function createCapturedConsole(logs: string[]): {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
} {
  const capture = (...args: unknown[]): void => {
    logs.push(formatLogArgs(args));
  };

  return {
    log: capture,
    warn: capture,
    error: capture,
    info: capture,
    debug: capture,
  };
}

// =============================================================================
// Sandbox Context Creation
// =============================================================================

/**
 * Create a sandboxed VM context with the mcp API and blocked globals
 */
export function createSandboxContext(
  api: SandboxAPI,
  executionContext: ExecutionContext
): object {
  // Create the context object with allowed globals
  const contextObj: Record<string, unknown> = {
    // The mcp API - the only way to interact with MCP servers
    mcp: api,

    // Captured console
    console: createCapturedConsole(executionContext.logs),

    // Safe built-ins
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    ReferenceError,
    SyntaxError,
    RangeError,
    URIError,
    EvalError,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    Promise,
    Intl,
    isNaN,
    isFinite,
    parseFloat,
    parseInt,
    decodeURI,
    decodeURIComponent,
    encodeURI,
    encodeURIComponent,

    // Typed arrays (safe subset)
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    BigInt,

    // Explicitly undefined blocked globals (prevents prototype chain access)
    ...Object.fromEntries(BLOCKED_GLOBALS.map((name) => [name, undefined])),
  };

  // Create the VM context
  return createContext(contextObj, {
    name: "codemode-sandbox",
    codeGeneration: {
      strings: false, // Disable eval() and Function()
      wasm: false, // Disable WebAssembly
    },
  });
}

// =============================================================================
// Code Wrapping
// =============================================================================

/**
 * Wrap user code in an async IIFE to support top-level await
 */
function wrapCode(code: string): string {
  // Wrap in async IIFE that returns the result
  return `
(async () => {
  "use strict";
  ${code}
})()
`.trim();
}

/**
 * Validate code before execution
 */
function validateCode(code: string, maxLength: number): void {
  if (code.length > maxLength) {
    throw new Error(`Code exceeds maximum length of ${String(maxLength)} bytes`);
  }

  // Basic syntax check by trying to parse
  try {
    new Script(wrapCode(code));
  } catch (e) {
    const error = e as Error;
    throw new Error(`Syntax error in code: ${error.message}`);
  }
}

// =============================================================================
// Timeout Handling
// =============================================================================

/**
 * Create a promise that rejects after a timeout
 */
function createTimeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Execution timed out after ${String(ms)}ms`));
    }, ms);
  });
}

// =============================================================================
// Error Handling
// =============================================================================

/**
 * Convert an error to SandboxError format
 */
function toSandboxError(error: unknown): SandboxError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

/**
 * Check if a value is JSON-serializable
 */
function isSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make a value JSON-serializable
 */
function makeSerializable(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (isSerializable(value)) {
    return value;
  }
  // For non-serializable values, convert to string representation
  return formatLogValue(value);
}

// =============================================================================
// Main Execution Function
// =============================================================================

/**
 * Execute JavaScript code in an isolated sandbox with the mcp API
 *
 * @param code - JavaScript code to execute
 * @param api - The mcp.* API to expose to the code
 * @param config - Sandbox configuration (timeout, limits)
 * @returns Execution result with success/error, return value, logs, and stats
 */
export async function executeSandbox(
  code: string,
  api: SandboxAPI,
  config: Partial<SandboxConfig> = {}
): Promise<SandboxResult> {
  const fullConfig: SandboxConfig = {
    timeoutMs: config.timeoutMs ?? 30000,
    maxMcpCalls: config.maxMcpCalls ?? 100,
    maxCodeLength: config.maxCodeLength ?? 102400,
  };

  const startTime = Date.now();
  const executionContext: ExecutionContext = {
    mcpCallCount: 0,
    maxMcpCalls: fullConfig.maxMcpCalls,
    logs: [],
    startTime,
  };

  try {
    // Validate code
    validateCode(code, fullConfig.maxCodeLength);

    // Create wrapped API that tracks call counts
    const trackedApi = createTrackedAPI(api, executionContext);

    // Create sandbox context
    const context = createSandboxContext(trackedApi, executionContext);

    // Wrap and compile code
    const wrappedCode = wrapCode(code);
    const script = new Script(wrappedCode, {
      filename: "codemode-user-script.js",
    });

    // Execute with timeout
    const resultPromise = script.runInContext(context, {
      timeout: fullConfig.timeoutMs,
      breakOnSigint: true,
    }) as Promise<unknown>;

    // Race against timeout (the vm timeout handles CPU-bound code,
    // but we need this for async code that yields)
    const result = await Promise.race([
      resultPromise,
      createTimeoutPromise(fullConfig.timeoutMs),
    ]);

    const durationMs = Date.now() - startTime;

    return {
      success: true,
      result: makeSerializable(result),
      logs: executionContext.logs,
      stats: {
        durationMs,
        mcpCalls: executionContext.mcpCallCount,
      },
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;

    return {
      success: false,
      error: toSandboxError(error),
      logs: executionContext.logs,
      stats: {
        durationMs,
        mcpCalls: executionContext.mcpCallCount,
      },
    };
  }
}

// =============================================================================
// API Call Tracking
// =============================================================================

/**
 * Wrap the mcp API to track call counts and enforce limits
 */
function createTrackedAPI(
  api: SandboxAPI,
  context: ExecutionContext
): SandboxAPI {
  const trackCall = (): void => {
    context.mcpCallCount++;
    if (context.mcpCallCount > context.maxMcpCalls) {
      throw new Error(
        `Maximum mcp.* call limit exceeded (${String(context.maxMcpCalls)})`
      );
    }
  };

  return {
    // Server discovery
    listServers: async (): ReturnType<SandboxAPI["listServers"]> => {
      trackCall();
      return api.listServers();
    },

    // Tool operations
    listTools: async (serverPattern?: string): ReturnType<SandboxAPI["listTools"]> => {
      trackCall();
      return api.listTools(serverPattern);
    },
    callTool: async (server: string, tool: string, args?: Record<string, unknown>): ReturnType<SandboxAPI["callTool"]> => {
      trackCall();
      return api.callTool(server, tool, args);
    },

    // Resource operations
    listResources: async (serverPattern?: string): ReturnType<SandboxAPI["listResources"]> => {
      trackCall();
      return api.listResources(serverPattern);
    },
    listResourceTemplates: async (serverPattern?: string): ReturnType<SandboxAPI["listResourceTemplates"]> => {
      trackCall();
      return api.listResourceTemplates(serverPattern);
    },
    readResource: async (server: string, uri: string): ReturnType<SandboxAPI["readResource"]> => {
      trackCall();
      return api.readResource(server, uri);
    },

    // Prompt operations
    listPrompts: async (serverPattern?: string): ReturnType<SandboxAPI["listPrompts"]> => {
      trackCall();
      return api.listPrompts(serverPattern);
    },
    getPrompt: async (server: string, name: string, args?: Record<string, string>): ReturnType<SandboxAPI["getPrompt"]> => {
      trackCall();
      return api.getPrompt(server, name, args);
    },

    // Utilities (these don't count toward the limit)
    sleep: async (ms: number): Promise<void> => {
      const clampedMs = Math.min(Math.max(0, ms), MAX_SLEEP_MS);
      return new Promise((resolve) => setTimeout(resolve, clampedMs));
    },
    log: (...args: unknown[]): void => {
      context.logs.push(formatLogArgs(args));
    },
  };
}
