/**
 * Shared types for MCP Proxy Server
 */

import type {
  Tool,
  Resource,
  Prompt,
  ResourceTemplate,
  JSONRPCNotification,
  LoggingLevel,
  CreateMessageRequestParams,
  CreateMessageResult,
  ElicitRequestParams,
  ElicitResult,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

// Re-export ServerCapabilities for convenience
export type { ServerCapabilities };

// =============================================================================
// New State Module Types (canonical source for new code)
// =============================================================================

// Event system types
export type {
  ProxyEventType,
  StoredEvent,
  EventSystemConfig,
} from "./state/event-system.js";

// Task manager types
export type {
  ProxyTask,
  ProxyTaskStatus,
  TaskManagerConfig,
} from "./state/task-manager.js";

// HTTP upstream auth mode — canonical definition lives with the
// ServerConfigRegistry; re-exported here so ProxyConfig consumers can use
// the same literal type without importing from session internals.
import type { HttpAuthMode } from "./session/server-config.js";
export type { HttpAuthMode };

// =============================================================================
// New Types for Refactored Architecture
// =============================================================================

/**
 * Tool info from tools/list response (used by list_tools)
 */
export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Health status of a backend server
 */
export type HealthStatus = "healthy" | "degraded";

/**
 * Server info for list_servers tool (enhanced version of BackendServerInfo)
 */
export interface ServerInfo {
  name: string;
  url: string;
  connected: boolean;
  status: BackendServerStatus | "not_connected";
  connectedAt?: Date;
  lastError?: string;
  // Reconnection status (only present when status is "reconnecting")
  reconnectAttempt?: number;
  nextRetryMs?: number;
  // Health status (only present when status is "connected")
  healthStatus?: HealthStatus;
  consecutiveHealthFailures?: number;
}

/**
 * Result of server restart reconciliation
 */
export interface ReconciliationResult {
  invalidatedElicitations: string[];
  invalidatedSamplingRequests: string[];
  invalidatedTasks: string[];
  refreshedTools: boolean;
  refreshedResources: boolean;
  refreshedPrompts: boolean;
}

/**
 * Configuration for a backend HTTP MCP server
 */
export interface HttpServerConfig {
  /** Unique name to identify this server */
  name: string;
  /** HTTP URL of the MCP server endpoint */
  url: string;
  /** Custom headers to send with requests. Ignored when authMode === "oauth". */
  headers?: Record<string, string>;
  /** Upstream auth mode (default: "none"). */
  authMode?: HttpAuthMode;
  /** Optional OAuth scopes (only meaningful when authMode === "oauth"). */
  oauthScopes?: string[];
}

/**
 * Restart configuration for stdio servers
 */
export interface StdioRestartConfig {
  /** Whether to automatically restart on crash (default: true) */
  enabled?: boolean;
  /** Maximum restart attempts before giving up (default: 5) */
  maxAttempts?: number;
  /** Base delay in ms before first restart (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in ms between restarts (default: 60000) */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
}

/**
 * Configuration for a backend stdio MCP server
 */
export interface StdioServerConfig {
  /** Unique name to identify this server */
  name: string;
  /** Transport type - must be "stdio" */
  type: "stdio";
  /** Command to spawn */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Restart configuration */
  restartConfig?: StdioRestartConfig;
}

/**
 * Configuration for a backend MCP server (HTTP or stdio)
 */
export type BackendServerConfig = HttpServerConfig | StdioServerConfig;

/**
 * Type guard for HTTP server config
 */
export function isHttpServerConfig(config: BackendServerConfig): config is HttpServerConfig {
  return "url" in config && !("type" in config && config.type === "stdio");
}

/**
 * Type guard for stdio server config
 */
export function isStdioServerConfig(config: BackendServerConfig): config is StdioServerConfig {
  return "type" in config;
}

/**
 * Configuration file format for initial backend servers
 */
export interface ProxyConfig {
  servers: BackendServerConfig[];
}

/**
 * Status of a backend server connection
 */
export type BackendServerStatus =
  | "connecting"     // Initial connection in progress
  | "connected"      // Successfully connected
  | "disconnected"   // Cleanly disconnected (intentional, e.g., remove_server)
  | "reconnecting"   // Lost connection, attempting to reconnect
  | "error";         // Connection error (with message)

/**
 * Information about a connected backend server
 */
export interface BackendServerInfo {
  /** Server name */
  name: string;
  /** Server URL */
  url: string;
  /** Current connection status */
  status: BackendServerStatus;
  /** Error message if status is 'error' */
  error?: string;
  /** Transport type */
  transportType?: "http" | "stdio";
  /** Process ID for stdio servers */
  pid?: number;
  /** Server capabilities from initialization */
  capabilities?: {
    tools?: boolean;
    resources?: boolean;
    prompts?: boolean;
    resourceTemplates?: boolean;
    /** Whether the server supports resource subscriptions */
    resourceSubscriptions?: boolean;
  };
}

/**
 * A tool from a specific backend server
 */
export interface BackendTool extends Tool {
  /** The backend server this tool is from */
  server: string;
}

/**
 * A resource from a specific backend server
 */
export interface BackendResource extends Resource {
  /** The backend server this resource is from */
  server: string;
}

/**
 * A prompt from a specific backend server
 */
export interface BackendPrompt extends Prompt {
  /** The backend server this prompt is from */
  server: string;
}

/**
 * A resource template from a specific backend server
 */
export interface BackendResourceTemplate extends ResourceTemplate {
  /** The backend server this resource template is from */
  server: string;
}

/**
 * A buffered notification from a backend server
 */
export interface BufferedNotification {
  /** The backend server this notification came from */
  server: string;
  /** Timestamp when the notification was received */
  timestamp: Date;
  /** The notification method */
  method: string;
  /** The notification params */
  params?: JSONRPCNotification["params"];
}

/**
 * Result of a tool execution on a backend
 */
export interface ToolExecutionResult {
  /** Whether the tool execution resulted in an error */
  isError?: boolean;
  /** The content returned by the tool */
  content: {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    [key: string]: unknown;
  }[];
}

// =============================================================================
// Logging Types
// =============================================================================

/**
 * A buffered log message from a backend server
 */
export interface BufferedLog {
  /** The backend server this log came from */
  server: string;
  /** Timestamp when the log was received */
  timestamp: Date;
  /** Log level */
  level: LoggingLevel;
  /** Logger name (optional) */
  logger?: string;
  /** Log data (can be any JSON-serializable type) */
  data: unknown;
}

// =============================================================================
// Sampling Types
// =============================================================================

/**
 * A pending sampling request from a backend server awaiting response.
 * The promise resolve/reject functions are used to complete the original request.
 */
export interface PendingSamplingRequest {
  /** Unique ID for this request */
  id: string;
  /** The backend server this request came from */
  server: string;
  /** Timestamp when the request was received */
  timestamp: Date;
  /** The original request parameters */
  params: CreateMessageRequestParams;
  /** Promise resolver to complete the request */
  resolve: (result: CreateMessageResult) => void;
  /** Promise rejecter to fail the request */
  reject: (error: Error) => void;
}

/**
 * Simplified sampling request info for tool output (excludes internal resolver/rejecter)
 */
export interface SamplingRequestInfo {
  /** Unique ID for this request */
  id: string;
  /** The backend server this request came from */
  server: string;
  /** Timestamp when the request was received */
  timestamp: Date;
  /** The request parameters */
  params: CreateMessageRequestParams;
}

// =============================================================================
// Elicitation Types
// =============================================================================

/**
 * A pending elicitation request from a backend server awaiting response.
 * The promise resolve/reject functions are used to complete the original request.
 */
export interface PendingElicitationRequest {
  /** Unique ID for this request */
  id: string;
  /** The backend server this request came from */
  server: string;
  /** Timestamp when the request was received */
  timestamp: Date;
  /** The original request parameters */
  params: ElicitRequestParams;
  /** Promise resolver to complete the request */
  resolve: (result: ElicitResult) => void;
  /** Promise rejecter to fail the request */
  reject: (error: Error) => void;
}

/**
 * Simplified elicitation request info for tool output (excludes internal resolver/rejecter)
 */
export interface ElicitationRequestInfo {
  /** Unique ID for this request */
  id: string;
  /** The backend server this request came from */
  server: string;
  /** Timestamp when the request was received */
  timestamp: Date;
  /** The request parameters */
  params: ElicitRequestParams;
}
