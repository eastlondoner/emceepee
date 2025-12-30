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
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Configuration for a backend MCP server
 */
export interface BackendServerConfig {
  /** Unique name to identify this server */
  name: string;
  /** HTTP URL of the MCP server endpoint */
  url: string;
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
export type BackendServerStatus = "connecting" | "connected" | "disconnected" | "error";

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
  /** Server capabilities from initialization */
  capabilities?: {
    tools?: boolean;
    resources?: boolean;
    prompts?: boolean;
    resourceTemplates?: boolean;
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
