/**
 * Codemode Types
 *
 * Type definitions for the codemode API which provides a reduced-context
 * interface for AI to interact with MCP servers via JavaScript code execution.
 */

import type { Tool, Resource, Prompt, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";

// =============================================================================
// Sandbox Configuration
// =============================================================================

/**
 * Configuration for sandbox execution
 */
export interface SandboxConfig {
  /** Maximum execution time in milliseconds (default: 30000) */
  timeoutMs: number;
  /** Maximum number of mcp.* calls allowed (default: 100) */
  maxMcpCalls: number;
  /** Maximum code length in bytes (default: 102400 = 100KB) */
  maxCodeLength: number;
}

/**
 * Default sandbox configuration
 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  timeoutMs: 30000,
  maxMcpCalls: 100,
  maxCodeLength: 102400,
};

// =============================================================================
// Sandbox Execution Results
// =============================================================================

/**
 * Error information from sandbox execution
 */
export interface SandboxError {
  /** Error name (e.g., "TypeError", "ReferenceError") */
  name: string;
  /** Error message */
  message: string;
  /** Stack trace if available */
  stack?: string;
}

/**
 * Execution statistics
 */
export interface SandboxStats {
  /** Total execution time in milliseconds */
  durationMs: number;
  /** Number of mcp.* calls made */
  mcpCalls: number;
}

/**
 * Result of sandbox code execution
 */
export interface SandboxResult {
  /** Whether execution completed successfully */
  success: boolean;
  /** Return value from the code (JSON-serializable) */
  result?: unknown;
  /** Error information if execution failed */
  error?: SandboxError;
  /** Captured console.log output */
  logs: string[];
  /** Execution statistics */
  stats: SandboxStats;
}

// =============================================================================
// Sandbox API Types (exposed to user code as `mcp.*`)
// =============================================================================

/**
 * Server information returned by mcp.listServers()
 */
export interface SandboxServerInfo {
  /** Server name */
  name: string;
  /** Connection status */
  status: "connected" | "connecting" | "disconnected" | "reconnecting" | "error";
  /** Server capabilities */
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
}

/**
 * Tool information returned by mcp.listTools()
 */
export interface SandboxToolInfo {
  /** Server the tool belongs to */
  server: string;
  /** Tool name */
  name: string;
  /** Tool description */
  description?: string;
  /** Input schema for the tool */
  inputSchema: Record<string, unknown>;
}

/**
 * Tool execution result returned by mcp.callTool()
 */
export interface SandboxToolResult {
  /** Content items returned by the tool */
  content: {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }[];
  /** Whether the tool execution resulted in an error */
  isError?: boolean;
}

/**
 * Resource information returned by mcp.listResources()
 */
export interface SandboxResourceInfo {
  /** Server the resource belongs to */
  server: string;
  /** Resource URI */
  uri: string;
  /** Resource name */
  name: string;
  /** Resource description */
  description?: string;
  /** MIME type of the resource */
  mimeType?: string;
}

/**
 * Resource template information returned by mcp.listResourceTemplates()
 */
export interface SandboxResourceTemplateInfo {
  /** Server the template belongs to */
  server: string;
  /** URI template pattern */
  uriTemplate: string;
  /** Template name */
  name: string;
  /** Template description */
  description?: string;
  /** MIME type of resources from this template */
  mimeType?: string;
}

/**
 * Resource content returned by mcp.readResource()
 */
export interface SandboxResourceContent {
  /** Content items */
  contents: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }[];
}

/**
 * Prompt information returned by mcp.listPrompts()
 */
export interface SandboxPromptInfo {
  /** Server the prompt belongs to */
  server: string;
  /** Prompt name */
  name: string;
  /** Prompt description */
  description?: string;
  /** Prompt arguments */
  arguments?: {
    name: string;
    description?: string;
    required?: boolean;
  }[];
}

/**
 * Prompt result returned by mcp.getPrompt()
 */
export interface SandboxPromptResult {
  /** Optional description */
  description?: string;
  /** Prompt messages */
  messages: {
    role: "user" | "assistant";
    content: {
      type: string;
      text?: string;
      resource?: unknown;
    };
  }[];
}

/**
 * The mcp.* API interface exposed to sandbox code
 */
export interface SandboxAPI {
  // Server discovery
  listServers(): Promise<SandboxServerInfo[]>;

  // Tool operations
  listTools(serverPattern?: string): Promise<SandboxToolInfo[]>;
  callTool(server: string, tool: string, args?: Record<string, unknown>): Promise<SandboxToolResult>;

  // Resource operations
  listResources(serverPattern?: string): Promise<SandboxResourceInfo[]>;
  listResourceTemplates(serverPattern?: string): Promise<SandboxResourceTemplateInfo[]>;
  readResource(server: string, uri: string): Promise<SandboxResourceContent>;

  // Prompt operations
  listPrompts(serverPattern?: string): Promise<SandboxPromptInfo[]>;
  getPrompt(server: string, name: string, args?: Record<string, string>): Promise<SandboxPromptResult>;

  // Utilities
  sleep(ms: number): Promise<void>;
  log(...args: unknown[]): void;
}

// =============================================================================
// Search Tool Types
// =============================================================================

/**
 * Search query input
 */
export interface SearchQuery {
  /** Search query string (supports regex) */
  query: string;
  /** Type of capability to search for */
  type: "tools" | "resources" | "prompts" | "servers" | "all";
  /** Server name filter (regex pattern) */
  server?: string;
  /** Whether to include full schemas in results */
  includeSchemas?: boolean;
}

/**
 * Compact tool info for search results
 */
export interface SearchToolResult {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Compact resource info for search results
 */
export interface SearchResourceResult {
  server: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * Compact prompt info for search results
 */
export interface SearchPromptResult {
  server: string;
  name: string;
  description?: string;
  arguments?: { name: string; required?: boolean }[];
}

/**
 * Compact server info for search results
 */
export interface SearchServerResult {
  name: string;
  status: string;
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
}

/**
 * Search results
 */
export interface SearchResult {
  tools?: SearchToolResult[];
  resources?: SearchResourceResult[];
  prompts?: SearchPromptResult[];
  servers?: SearchServerResult[];
}

// =============================================================================
// Execute Tool Types
// =============================================================================

/**
 * Execute request input
 */
export interface ExecuteRequest {
  /** JavaScript code to execute */
  code: string;
  /** Execution timeout in milliseconds */
  timeout?: number;
}

/**
 * Execute response (same as SandboxResult)
 */
export type ExecuteResult = SandboxResult;

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Context for tracking mcp.* call counts
 */
export interface ExecutionContext {
  /** Number of mcp.* calls made */
  mcpCallCount: number;
  /** Maximum allowed mcp.* calls */
  maxMcpCalls: number;
  /** Captured log messages */
  logs: string[];
  /** Start time of execution */
  startTime: number;
}

/**
 * Converter functions for SDK types to sandbox types
 */
export interface TypeConverters {
  toolToSandbox(server: string, tool: Tool): SandboxToolInfo;
  resourceToSandbox(server: string, resource: Resource): SandboxResourceInfo;
  resourceTemplateToSandbox(server: string, template: ResourceTemplate): SandboxResourceTemplateInfo;
  promptToSandbox(server: string, prompt: Prompt): SandboxPromptInfo;
}
