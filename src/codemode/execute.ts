/**
 * Codemode Execute Tool
 *
 * Implements the codemode_execute tool that runs user JavaScript code
 * in a sandboxed environment with access to the mcp.* API.
 */

import type { SessionState } from "../session/session-state.js";
import type { SessionManager } from "../session/session-manager.js";
import type {
  ExecuteRequest,
  ExecuteResult,
  SandboxConfig,
} from "./types.js";
import { DEFAULT_SANDBOX_CONFIG } from "./types.js";
import { executeSandbox } from "./sandbox.js";
import { createSandboxAPI } from "./api-bindings.js";

// =============================================================================
// Configuration
// =============================================================================

/**
 * Options for the execute function
 */
export interface ExecuteOptions {
  /** The session state */
  session: SessionState;
  /** The session manager */
  sessionManager: SessionManager;
  /** Override sandbox configuration */
  config?: Partial<SandboxConfig>;
}

/**
 * Minimum timeout in milliseconds (1 second)
 */
const MIN_TIMEOUT_MS = 1000;

/**
 * Maximum timeout in milliseconds (5 minutes)
 */
const MAX_TIMEOUT_MS = 300000;

/**
 * Default timeout in milliseconds (30 seconds)
 */
const DEFAULT_TIMEOUT_MS = 30000;

// =============================================================================
// Execute Implementation
// =============================================================================

/**
 * Execute JavaScript code in a sandboxed environment with mcp.* API access
 *
 * @param request - The execution request containing code and optional timeout
 * @param options - Session, manager, and configuration options
 * @returns Execution result with success/error, return value, logs, and stats
 */
export async function execute(
  request: ExecuteRequest,
  options: ExecuteOptions
): Promise<ExecuteResult> {
  const { session, sessionManager, config: configOverride } = options;
  const { code, timeout } = request;

  // Validate and clamp timeout
  const timeoutMs = clampTimeout(timeout);

  // Merge configuration
  const config: Partial<SandboxConfig> = {
    ...configOverride,
    timeoutMs,
  };

  // Create the mcp.* API
  const api = createSandboxAPI({
    session,
    sessionManager,
  });

  // Execute in sandbox
  const result = await executeSandbox(code, api, config);

  return result;
}

/**
 * Clamp timeout to valid range
 */
function clampTimeout(timeout: number | undefined): number {
  if (timeout === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(Math.max(timeout, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Execute code with default configuration
 */
export async function executeSimple(
  code: string,
  session: SessionState,
  sessionManager: SessionManager
): Promise<ExecuteResult> {
  return execute({ code }, { session, sessionManager });
}

/**
 * Execute code with a specific timeout
 */
export async function executeWithTimeout(
  code: string,
  timeoutMs: number,
  session: SessionState,
  sessionManager: SessionManager
): Promise<ExecuteResult> {
  return execute({ code, timeout: timeoutMs }, { session, sessionManager });
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate code before execution
 * Returns an error message if invalid, null if valid
 */
export function validateCode(code: string): string | null {
  // Check for empty code
  if (!code || code.trim().length === 0) {
    return "Code cannot be empty";
  }

  // Check code length
  if (code.length > DEFAULT_SANDBOX_CONFIG.maxCodeLength) {
    return `Code exceeds maximum length of ${String(DEFAULT_SANDBOX_CONFIG.maxCodeLength)} bytes`;
  }

  return null;
}

/**
 * Validate timeout value
 * Returns an error message if invalid, null if valid
 */
export function validateTimeout(timeout: number | undefined): string | null {
  if (timeout === undefined) {
    return null;
  }

  if (typeof timeout !== "number" || isNaN(timeout)) {
    return "Timeout must be a number";
  }

  if (timeout < MIN_TIMEOUT_MS) {
    return `Timeout must be at least ${String(MIN_TIMEOUT_MS)}ms`;
  }

  if (timeout > MAX_TIMEOUT_MS) {
    return `Timeout cannot exceed ${String(MAX_TIMEOUT_MS)}ms`;
  }

  return null;
}

/**
 * Validate an execute request
 * Returns an error message if invalid, null if valid
 */
export function validateExecuteRequest(request: ExecuteRequest): string | null {
  const codeError = validateCode(request.code);
  if (codeError) return codeError;

  const timeoutError = validateTimeout(request.timeout);
  if (timeoutError) return timeoutError;

  return null;
}

// =============================================================================
// Result Helpers
// =============================================================================

/**
 * Check if an execute result was successful
 */
export function isSuccess(result: ExecuteResult): boolean {
  return result.success;
}

/**
 * Check if an execute result was a timeout
 */
export function isTimeout(result: ExecuteResult): boolean {
  if (result.success || !result.error) {
    return false;
  }
  return result.error.message.includes("timed out");
}

/**
 * Check if an execute result exceeded the mcp call limit
 */
export function isCallLimitExceeded(result: ExecuteResult): boolean {
  if (result.success || !result.error) {
    return false;
  }
  return result.error.message.includes("call limit exceeded");
}

/**
 * Get a human-readable summary of an execute result
 */
export function summarizeResult(result: ExecuteResult): string {
  if (result.success) {
    const resultStr = result.result !== undefined
      ? `: ${JSON.stringify(result.result).slice(0, 100)}`
      : "";
    return `Success (${String(result.stats.durationMs)}ms, ${String(result.stats.mcpCalls)} mcp calls)${resultStr}`;
  }

  return `Error: ${result.error?.name ?? "Unknown"} - ${result.error?.message ?? "Unknown error"}`;
}

// =============================================================================
// Constants Export
// =============================================================================

export const EXECUTE_LIMITS = {
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_CODE_LENGTH: DEFAULT_SANDBOX_CONFIG.maxCodeLength,
  MAX_MCP_CALLS: DEFAULT_SANDBOX_CONFIG.maxMcpCalls,
} as const;
