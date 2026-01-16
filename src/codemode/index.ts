/**
 * Codemode Module
 *
 * Provides a reduced-context API for AI to interact with MCP servers
 * via JavaScript code execution in a sandboxed environment.
 */

// Types
export type {
  // Sandbox configuration
  SandboxConfig,
  SandboxResult,
  SandboxError,
  SandboxStats,
  SandboxAPI,
  ExecutionContext,

  // Sandbox API types (exposed to user code)
  SandboxServerInfo,
  SandboxToolInfo,
  SandboxToolResult,
  SandboxResourceInfo,
  SandboxResourceTemplateInfo,
  SandboxResourceContent,
  SandboxPromptInfo,
  SandboxPromptResult,

  // Search tool types
  SearchQuery,
  SearchResult,
  SearchToolResult,
  SearchResourceResult,
  SearchPromptResult,
  SearchServerResult,

  // Execute tool types
  ExecuteRequest,
  ExecuteResult,

  // Internal types
  TypeConverters,
} from "./types.js";

// Constants
export { DEFAULT_SANDBOX_CONFIG } from "./types.js";

// Sandbox execution
export { createSandboxContext, executeSandbox } from "./sandbox.js";
