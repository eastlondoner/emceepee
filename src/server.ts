#!/usr/bin/env node
/**
 * MCP Proxy Server
 *
 * An HTTP MCP server with static tools for managing and interacting with
 * multiple backend MCP servers dynamically. Each client session gets isolated
 * backend connections and state management.
 *
 * Architecture:
 * - SessionManager: Creates/destroys sessions, manages shared server configs
 * - SessionState: Per-session state (connections, events, tasks, pending requests)
 * - Tools: Session-aware handlers that operate on the calling session's state
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
  ClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { createServer, type ServerResponse } from "http";
import { z } from "zod";
import { readFileSync } from "fs";

import { SessionManager } from "./session/session-manager.js";
import type { SessionState } from "./session/session-state.js";
import { SSEEventStore } from "./session/sse-event-store.js";
import type { ProxyConfig } from "./types.js";
import { isHttpServerConfig, isStdioServerConfig } from "./types.js";
import { BackendAuthRequiredError } from "./auth/backend/errors.js";
import { BackendTokenStore } from "./auth/backend/token-store.js";
import { FileDcrStore } from "./auth/backend/dcr-store.js";
import { PendingFlowRegistry, type PendingFlow } from "./auth/backend/pending-flows.js";
import { makeOAuthClientProvider } from "./auth/backend/oauth-provider.js";
import { buildAuthElicitation } from "./auth/backend/elicitation.js";
import { createConsoleLogger } from "./logging.js";
import { RequestTracker } from "./request-tracker.js";
import { generateWaterfallHTML, generateWaterfallJSON } from "./waterfall-ui.js";

// Codemode imports
import {
  search,
  execute,
  validateExecuteRequest,
  EXECUTE_LIMITS,
} from "./codemode/index.js";
import type { SearchQuery } from "./codemode/index.js";

// =============================================================================
// Types
// =============================================================================

/** Extra context provided to tool handlers by the MCP SDK */
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Standard tool response format - includes index signature for MCP SDK compatibility */
interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

// =============================================================================
// CLI Argument Parsing
// =============================================================================

interface CliArgs {
  configPath?: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  noCodemode: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let configPath: string | undefined;
  let port = Number(process.env["PORT"]) || 8080;
  let logLevel: CliArgs["logLevel"] = "info";
  // Check env var first, CLI flag can override
  let noCodemode = process.env["EMCEEPEE_NO_CODEMODE"] === "1";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--config" && args[i + 1]) {
      configPath = args[i + 1];
      i++;
    } else if (arg?.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else if (arg === "--port" && args[i + 1]) {
      port = Number(args[i + 1]);
      i++;
    } else if (arg?.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--log-level" && args[i + 1]) {
      logLevel = args[i + 1] as CliArgs["logLevel"];
      i++;
    } else if (arg?.startsWith("--log-level=")) {
      logLevel = arg.slice("--log-level=".length) as CliArgs["logLevel"];
    } else if (arg === "--no-codemode") {
      noCodemode = true;
    }
  }

  return { configPath, port, logLevel, noCodemode };
}

function loadConfig(path: string): ProxyConfig {
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content) as ProxyConfig;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// =============================================================================
// Session Resolution Helper
// =============================================================================

/**
 * Get the session for a tool call, creating one if needed.
 * This is the bridge between the MCP SDK's session handling and our SessionManager.
 */
function getSessionForTool(
  sessionManager: SessionManager,
  extra: ToolExtra,
  sessions: Map<string, string> // transportSessionId -> ourSessionId
): SessionState | undefined {
  const transportSessionId = extra.sessionId;
  if (!transportSessionId) return undefined;

  const ourSessionId = sessions.get(transportSessionId);
  if (!ourSessionId) return undefined;

  return sessionManager.getSession(ourSessionId);
}

// =============================================================================
// Context Info Wrapper
// =============================================================================

/**
 * Context info structure appended to tool responses.
 * Only included when there's something to report.
 */
interface ContextInfo {
  pending_client?: {
    sampling: number;
    elicitation: number;
  };
  expired_timers?: {
    id: string;
    message: string;
    expiredAt: string;
  }[];
  notifications?: {
    server: string;
    method: string;
    timestamp: string;
    params?: unknown;
  }[];
}

/**
 * Build context info from session state.
 * Returns null if there's nothing to report.
 */
function buildContextInfo(session: SessionState): ContextInfo | null {
  const samplingCount = session.pendingRequests.getPendingSamplingRequests().length;
  const elicitationCount = session.pendingRequests.getPendingElicitationRequests().length;
  const expiredTimers = session.timerManager.getAndClearExpired();
  const notifications = session.bufferManager.getAndClearNotifications();

  // Only return if there's something to report
  const hasPending = samplingCount > 0 || elicitationCount > 0;
  const hasTimers = expiredTimers.length > 0;
  const hasNotifications = notifications.length > 0;

  if (!hasPending && !hasTimers && !hasNotifications) {
    return null;
  }

  const context: ContextInfo = {};

  if (hasPending) {
    context.pending_client = {
      sampling: samplingCount,
      elicitation: elicitationCount,
    };
  }

  if (hasTimers) {
    context.expired_timers = expiredTimers;
  }

  if (hasNotifications) {
    context.notifications = notifications.map((n) => ({
      server: n.server,
      method: n.method,
      timestamp: n.timestamp.toISOString(),
      params: n.params,
    }));
  }

  return context;
}

/**
 * Wrap a tool response with context info.
 * Appends context as an additional JSON text block if there's anything to report.
 */
function wrapWithContext(response: ToolResponse, session: SessionState | undefined): ToolResponse {
  if (!session) return response;

  const context = buildContextInfo(session);
  if (!context) return response;

  return {
    ...response,
    content: [
      ...response.content,
      { type: "text", text: JSON.stringify(context) },
    ],
  };
}

// =============================================================================
// Tool Response Helpers
// =============================================================================

/**
 * Create a tool error response.
 * Note: Errors don't get context info - if session is missing, there's nothing to report.
 */
function toolError(message: string): ToolResponse {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Create a tool success response with optional context info.
 */
function toolSuccess(message: string, session?: SessionState): ToolResponse {
  const response: ToolResponse = {
    content: [{ type: "text", text: message }],
  };
  return wrapWithContext(response, session);
}

/**
 * Create a JSON tool response with optional context info.
 */
function toolJson(data: unknown, session?: SessionState): ToolResponse {
  const response: ToolResponse = {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
  return wrapWithContext(response, session);
}

// =============================================================================
// Tool Registration
// =============================================================================

interface RegisterToolsOptions {
  /** Enable codemode tools (codemode_search, codemode_execute). Default: true */
  codemodeEnabled?: boolean;
}

/**
 * Translate a BackendAuthRequiredError into either a thrown URL-mode JSON-RPC
 * error (for clients that advertise URL elicitation) or a plaintext fallback
 * tool result (for clients that don't).
 *
 * Reads capabilities only from the session's own record — populated when the
 * session's initialize request was sniffed on its transport. Do NOT fall back
 * to the shared McpServer's getClientCapabilities(): that field is overwritten
 * by every initialize from any transport and would leak between sessions.
 */
function handleBackendAuthRequired(
  err: BackendAuthRequiredError,
  session: SessionState
): ToolResponse {
  const payload = buildAuthElicitation(session.clientCapabilities, err);
  if (payload.mode === "url") {
    throw new McpError(payload.error.code, payload.error.message, payload.error.data);
  }
  return payload.result;
}

function registerTools(
  server: McpServer,
  sessionManager: SessionManager,
  sessions: Map<string, string>,
  requestTracker: RequestTracker,
  options: RegisterToolsOptions = {}
): void {
  const { codemodeEnabled = true } = options;
  // ---------------------------------------------------------------------------
  // Server Management Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "add_server",
    {
      description: "Connect to a backend MCP server. Supports two transport types:\n\n" +
        "**HTTP Transport**: Provide a `url` to connect to a remote HTTP/SSE MCP server.\n" +
        "Example: add_server(name: \"myserver\", url: \"http://localhost:3001/mcp\")\n\n" +
        "**Stdio Transport**: Provide `command` (and optionally `args`) to spawn a local MCP server process.\n" +
        "Example: add_server(name: \"myserver\", command: \"npx\", args: [\"some-mcp-server\"])\n\n" +
        "Stdio servers support automatic crash recovery with exponential backoff restart.",
      inputSchema: {
        name: z.string().describe("Unique name for this server"),
        url: z.string().url().optional().describe("HTTP URL of the MCP server endpoint (for HTTP transport)"),
        headers: z.record(z.string()).optional().describe("Custom headers to send with HTTP requests (e.g., {\"Authorization\": \"Bearer token\"}). Ignored when authMode is 'oauth'."),
        authMode: z.enum(["none", "oauth"]).optional().describe("HTTP auth mode. 'none' (default) passes `headers` through. 'oauth' makes emceepee proxy OAuth 2.1 + PKCE + DCR on the user's behalf; requires emceepee-http (not stdio)."),
        oauthScopes: z.array(z.string()).optional().describe("Optional OAuth scopes to request (only used when authMode='oauth')."),
        command: z.string().optional().describe("Command to spawn (for stdio transport, e.g., 'node', 'npx', 'python')"),
        args: z.array(z.string()).optional().describe("Arguments for the command (for stdio transport)"),
        env: z.record(z.string()).optional().describe("Environment variables for the spawned process (stdio only)"),
        cwd: z.string().optional().describe("Working directory for the spawned process (stdio only)"),
        restartConfig: z.object({
          enabled: z.boolean().optional().describe("Enable automatic restart on crash (default: true)"),
          maxAttempts: z.number().optional().describe("Maximum restart attempts (default: 5)"),
          baseDelayMs: z.number().optional().describe("Base delay before restart in ms (default: 1000)"),
          maxDelayMs: z.number().optional().describe("Maximum delay between restarts in ms (default: 60000)"),
          backoffMultiplier: z.number().optional().describe("Backoff multiplier (default: 2)"),
        }).optional().describe("Restart configuration for stdio servers"),
      },
    },
    async ({ name, url, headers, authMode, oauthScopes, command, args, env, cwd, restartConfig }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      // Validate that either url OR command is provided, but not both
      if (url && command) {
        return toolError("Provide either 'url' (for HTTP) or 'command' (for stdio), not both");
      }
      if (!url && !command) {
        return toolError("Must provide either 'url' (for HTTP transport) or 'command' (for stdio transport)");
      }

      try {
        let connection;
        let serverDescription: string;

        if (url) {
          // HTTP transport
          connection = await sessionManager.addServer(session.sessionId, name, url, {
            headers,
            authMode,
            oauthScopes,
          });
          serverDescription = `${url}${authMode === "oauth" ? " (oauth)" : ""}`;
        } else if (command) {
          // Stdio transport
          connection = await sessionManager.addStdioServer(
            session.sessionId,
            name,
            command,
            args,
            { env, cwd, restartConfig }
          );
          serverDescription = `stdio://${command}${args?.length ? ` ${args.join(" ")}` : ""}`;
        } else {
          return toolError("Internal error: no transport specified");
        }

        const capabilities = connection.client.getInfo().capabilities;
        return toolSuccess(
          `Connected to server '${name}' at ${serverDescription}\n` +
          `Capabilities: ${JSON.stringify(capabilities)}`,
          session
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to add server: ${message}`);
      }
    }
  );

  server.registerTool(
    "remove_server",
    {
      description: "Disconnect from a backend MCP server and remove it from the configuration. This disconnects ALL sessions from the server.",
      inputSchema: {
        name: z.string().describe("Name of the server to remove"),
      },
    },
    async ({ name }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        await sessionManager.removeServer(session.sessionId, name);
        return toolSuccess(`Disconnected from server '${name}'`, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to remove server: ${message}`);
      }
    }
  );

  server.registerTool(
    "reconnect_server",
    {
      description: "Force reconnection to a backend MCP server. Works on connected, disconnected, or reconnecting servers. Cancels any pending reconnection and immediately attempts a fresh connection.",
      inputSchema: {
        name: z.string().describe("Name of the server to reconnect"),
      },
    },
    async ({ name }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        await sessionManager.reconnectServer(session.sessionId, name);
        return toolSuccess(`Reconnected to server '${name}'`, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to reconnect: ${message}`);
      }
    }
  );

  server.registerTool(
    "list_servers",
    {
      description: "List all configured backend MCP servers with their connection status for this session",
      inputSchema: {},
    },
    (_args, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      const servers = sessionManager.listServers(session.sessionId);
      if (servers.length === 0) {
        return toolSuccess("No servers configured", session);
      }

      const formatted = servers.map((s) => {
        const result: Record<string, unknown> = {
          name: s.name,
          url: s.url,
          status: s.status,
          connected: s.connected,
          connectedAt: s.connectedAt?.toISOString(),
          lastError: s.lastError,
        };

        // Add reconnection state if reconnecting
        if (s.status === "reconnecting") {
          result["reconnectAttempt"] = s.reconnectAttempt;
          result["nextRetryMs"] = s.nextRetryMs;
        }

        // Add health status if connected
        if (s.status === "connected") {
          result["healthStatus"] = s.healthStatus;
          if (s.consecutiveHealthFailures !== undefined && s.consecutiveHealthFailures > 0) {
            result["consecutiveHealthFailures"] = s.consecutiveHealthFailures;
          }
        }

        return result;
      });

      return toolJson(formatted, session);
    }
  );

  // ---------------------------------------------------------------------------
  // Tool Discovery and Execution
  // ---------------------------------------------------------------------------

  server.registerTool(
    "list_tools",
    {
      description: "List tools available from backend servers",
      inputSchema: {
        server: z.string().default(".*").describe("Regex pattern to match server names (default: .*)"),
        tool: z.string().default(".*").describe("Regex pattern to match tool names (default: .*)"),
      },
    },
    async ({ server: serverPattern, tool: toolPattern }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        const serverRegex = new RegExp(serverPattern);
        const toolRegex = new RegExp(toolPattern);

        // Collect tools from all connected backend servers
        const allTools: {
          server: string;
          name: string;
          description?: string;
          inputSchema: unknown;
        }[] = [];

        for (const serverName of session.listConnectedServers()) {
          if (!serverRegex.test(serverName)) continue;

          const connection = session.getConnection(serverName);
          if (connection?.status !== "connected") continue;

          try {
            const tools = await connection.client.listTools();
            for (const tool of tools) {
              if (toolRegex.test(tool.name)) {
                allTools.push({
                  server: serverName,
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                });
              }
            }
          } catch {
            // Skip servers that fail to list tools
          }
        }

        if (allTools.length === 0) {
          return toolSuccess("No tools available", session);
        }

        return toolJson(allTools, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to list tools: ${message}`);
      }
    }
  );

  server.registerTool(
    "execute_tool",
    {
      description: "Execute a tool on a specific backend server",
      inputSchema: {
        server: z.string().describe("Name of the backend server"),
        tool: z.string().describe("Name of the tool to execute"),
        args: z.record(z.unknown()).optional().describe("Arguments to pass to the tool"),
      },
    },
    async ({ server: serverName, tool, args }, extra) => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      // Check if server is reconnecting
      const connection = session.getConnection(serverName);
      if (connection?.status === "reconnecting") {
        const reconnState = connection.client.getReconnectionState();
        const details = reconnState
          ? ` (attempt ${String(reconnState.attempt)}, next retry in ${String(reconnState.nextRetryMs)}ms)`
          : "";
        return toolError(`Server '${serverName}' is reconnecting${details}. Use reconnect_server to force immediate reconnection or await_activity to wait for reconnection.`);
      }

      // Track the request
      const requestId = requestTracker.startRequest(
        session.sessionId,
        "backend_tool",
        tool,
        { server: serverName, args }
      );

      try {
        const client = await sessionManager.getOrCreateConnection(session.sessionId, serverName);
        const result = await client.callTool(tool, args ?? {});

        // Track completion
        const summary = result.isError ? "error" : "ok";
        requestTracker.completeRequest(requestId, summary);

        // Pass through the result content directly, preserving all content types
        // Wrap with context info - cast to any to avoid type issues with backend content types
        const context = buildContextInfo(session);
        if (context) {
          return {
            content: [
              ...result.content,
              { type: "text" as const, text: JSON.stringify(context) },
            ],
            isError: result.isError,
          };
        }
        return {
          content: result.content,
          isError: result.isError,
        };
      } catch (err) {
        if (err instanceof BackendAuthRequiredError) {
          requestTracker.failRequest(requestId, "auth_required");
          return handleBackendAuthRequired(err, session);
        }
        const message = err instanceof Error ? err.message : String(err);
        requestTracker.failRequest(requestId, message);
        return toolError(`Failed to execute tool: ${message}`);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Resource Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "list_resources",
    {
      description: "List resources available from backend servers",
      inputSchema: {
        server: z.string().optional().describe("Server name to filter by (omit for all servers)"),
      },
    },
    async ({ server: serverName }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        const resources: {
          server: string;
          uri: string;
          name: string;
          description?: string;
          mimeType?: string;
        }[] = [];

        const serversToQuery = serverName
          ? [serverName]
          : session.listConnectedServers();

        for (const name of serversToQuery) {
          const connection = session.getConnection(name);
          if (connection?.status !== "connected") continue;

          try {
            const serverResources = await connection.client.listResources();
            for (const r of serverResources) {
              resources.push({
                server: name,
                uri: r.uri,
                name: r.name,
                description: r.description,
                mimeType: r.mimeType,
              });
            }
          } catch {
            // Skip servers that fail
          }
        }

        if (resources.length === 0) {
          return toolSuccess("No resources available", session);
        }

        return toolJson(resources, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to list resources: ${message}`);
      }
    }
  );

  server.registerTool(
    "list_resource_templates",
    {
      description: "List resource templates available from backend servers. Templates define parameterized resources that can be read with specific arguments.",
      inputSchema: {
        server: z.string().optional().describe("Server name to filter by (omit for all servers)"),
      },
    },
    async ({ server: serverName }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        const templates: {
          server: string;
          uriTemplate: string;
          name: string;
          description?: string;
          mimeType?: string;
        }[] = [];

        const serversToQuery = serverName
          ? [serverName]
          : session.listConnectedServers();

        for (const name of serversToQuery) {
          const connection = session.getConnection(name);
          if (connection?.status !== "connected") continue;

          try {
            const serverTemplates = await connection.client.listResourceTemplates();
            for (const t of serverTemplates) {
              templates.push({
                server: name,
                uriTemplate: t.uriTemplate,
                name: t.name,
                description: t.description,
                mimeType: t.mimeType,
              });
            }
          } catch {
            // Skip servers that fail
          }
        }

        if (templates.length === 0) {
          return toolSuccess("No resource templates available", session);
        }

        return toolJson(templates, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to list resource templates: ${message}`);
      }
    }
  );

  server.registerTool(
    "read_resource",
    {
      description: "Read a specific resource from a backend server",
      inputSchema: {
        server: z.string().describe("Name of the backend server"),
        uri: z.string().describe("URI of the resource to read"),
      },
    },
    async ({ server: serverName, uri }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      // Track the request
      const requestId = requestTracker.startRequest(
        session.sessionId,
        "backend_resource",
        uri,
        { server: serverName }
      );

      try {
        const client = await sessionManager.getOrCreateConnection(session.sessionId, serverName);
        const result = await client.readResource(uri);

        // Format the contents for output
        const contents = result.contents.map((c) => {
          if ("text" in c && typeof c.text === "string") {
            return { uri: c.uri, mimeType: c.mimeType, text: c.text };
          } else if ("blob" in c && typeof c.blob === "string") {
            return { uri: c.uri, mimeType: c.mimeType, blob: `[base64 data, ${String(c.blob.length)} chars]` };
          }
          return c;
        });

        requestTracker.completeRequest(requestId, `${String(contents.length)} content(s)`);
        return toolJson({ contents }, session);
      } catch (err) {
        if (err instanceof BackendAuthRequiredError) {
          requestTracker.failRequest(requestId, "auth_required");
          return handleBackendAuthRequired(err, session);
        }
        const message = err instanceof Error ? err.message : String(err);
        requestTracker.failRequest(requestId, message);
        return toolError(`Failed to read resource: ${message}`);
      }
    }
  );

  server.registerTool(
    "subscribe_resource",
    {
      description: "Subscribe to updates for a specific resource. The server will send notifications when the resource changes. Use get_notifications or await_activity to receive updates.",
      inputSchema: {
        server: z.string().describe("Name of the backend server"),
        uri: z.string().describe("URI of the resource to subscribe to"),
      },
    },
    async ({ server: serverName, uri }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        const client = await sessionManager.getOrCreateConnection(session.sessionId, serverName);

        // Check if server supports subscriptions
        if (!client.supportsResourceSubscriptions()) {
          return toolError(`Server '${serverName}' does not support resource subscriptions`);
        }

        await client.subscribeResource(uri);
        return toolSuccess(`Subscribed to resource '${uri}' on server '${serverName}'`, session);
      } catch (err) {
        if (err instanceof BackendAuthRequiredError) {
          return handleBackendAuthRequired(err, session);
        }
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to subscribe to resource: ${message}`);
      }
    }
  );

  server.registerTool(
    "unsubscribe_resource",
    {
      description: "Unsubscribe from updates for a specific resource",
      inputSchema: {
        server: z.string().describe("Name of the backend server"),
        uri: z.string().describe("URI of the resource to unsubscribe from"),
      },
    },
    async ({ server: serverName, uri }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        const client = await sessionManager.getOrCreateConnection(session.sessionId, serverName);

        // Check if server supports subscriptions
        if (!client.supportsResourceSubscriptions()) {
          return toolError(`Server '${serverName}' does not support resource subscriptions`);
        }

        await client.unsubscribeResource(uri);
        return toolSuccess(`Unsubscribed from resource '${uri}' on server '${serverName}'`, session);
      } catch (err) {
        if (err instanceof BackendAuthRequiredError) {
          return handleBackendAuthRequired(err, session);
        }
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to unsubscribe from resource: ${message}`);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Prompt Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "list_prompts",
    {
      description: "List prompts available from backend servers",
      inputSchema: {
        server: z.string().optional().describe("Server name to filter by (omit for all servers)"),
      },
    },
    async ({ server: serverName }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        const prompts: {
          server: string;
          name: string;
          description?: string;
          arguments?: unknown[];
        }[] = [];

        const serversToQuery = serverName
          ? [serverName]
          : session.listConnectedServers();

        for (const name of serversToQuery) {
          const connection = session.getConnection(name);
          if (connection?.status !== "connected") continue;

          try {
            const serverPrompts = await connection.client.listPrompts();
            for (const p of serverPrompts) {
              prompts.push({
                server: name,
                name: p.name,
                description: p.description,
                arguments: p.arguments,
              });
            }
          } catch {
            // Skip servers that fail
          }
        }

        if (prompts.length === 0) {
          return toolSuccess("No prompts available", session);
        }

        return toolJson(prompts, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to list prompts: ${message}`);
      }
    }
  );

  server.registerTool(
    "get_prompt",
    {
      description: "Get a specific prompt from a backend server",
      inputSchema: {
        server: z.string().describe("Name of the backend server"),
        name: z.string().describe("Name of the prompt to get"),
        arguments: z.record(z.string()).optional().describe("Arguments to pass to the prompt"),
      },
    },
    async ({ server: serverName, name, arguments: promptArgs }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        const client = await sessionManager.getOrCreateConnection(session.sessionId, serverName);
        const result = await client.getPrompt(name, promptArgs ?? {});
        return toolJson(result, session);
      } catch (err) {
        if (err instanceof BackendAuthRequiredError) {
          return handleBackendAuthRequired(err, session);
        }
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to get prompt: ${message}`);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Notification and Log Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "get_notifications",
    {
      description: "Get and clear buffered notifications from backend servers for this session",
      inputSchema: {},
    },
    (_args, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      const notifications = session.bufferManager.getAndClearNotifications();
      if (notifications.length === 0) {
        return toolSuccess("No notifications", session);
      }

      const formatted = notifications.map((n) => ({
        server: n.server,
        method: n.method,
        timestamp: n.timestamp.toISOString(),
        params: n.params,
      }));

      return toolJson(formatted, session);
    }
  );

  server.registerTool(
    "get_logs",
    {
      description: "Get and clear buffered log messages from backend servers for this session",
      inputSchema: {},
    },
    (_args, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      const logs = session.bufferManager.getAndClearLogs();
      if (logs.length === 0) {
        return toolSuccess("No log messages", session);
      }

      const formatted = logs.map((l) => ({
        server: l.server,
        level: l.level,
        logger: l.logger,
        timestamp: l.timestamp.toISOString(),
        data: l.data,
      }));

      return toolJson(formatted, session);
    }
  );

  // ---------------------------------------------------------------------------
  // Sampling Tools (LLM requests from backends)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "get_sampling_requests",
    {
      description: "Get pending sampling requests from backend servers that need LLM responses. These are requests from MCP servers asking for LLM completions. URGENT: Backend servers are blocked waiting for these responses. You MUST respond promptly using respond_to_sampling.",
      inputSchema: {},
    },
    (_args, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      const requests = session.pendingRequests.getPendingSamplingRequests();
      if (requests.length === 0) {
        return toolSuccess("No pending sampling requests", session);
      }

      const formatted = requests.map((r) => ({
        requestId: r.requestId,
        server: r.server,
        timestamp: r.timestamp.toISOString(),
        maxTokens: r.params.maxTokens,
        systemPrompt: r.params.systemPrompt,
        temperature: r.params.temperature,
        messages: r.params.messages,
        modelPreferences: r.params.modelPreferences,
        tools: r.params.tools?.map((t) => ({ name: t.name, description: t.description })),
      }));

      return toolJson(formatted, session);
    }
  );

  server.registerTool(
    "respond_to_sampling",
    {
      description: "Respond to a pending sampling request with an LLM result",
      inputSchema: {
        request_id: z.string().describe("The ID of the sampling request to respond to"),
        role: z.enum(["user", "assistant"]).describe("The role of the message"),
        content: z.string().describe("The text content of the response"),
        model: z.string().describe("The model that generated the response"),
        stop_reason: z.enum(["endTurn", "maxTokens", "stopSequence", "toolUse"]).optional()
          .describe("Why the model stopped generating"),
      },
    },
    ({ request_id, role, content, model, stop_reason }, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        session.pendingRequests.respondToSampling(request_id, {
          role,
          content: { type: "text", text: content },
          model,
          stopReason: stop_reason,
        });
        return toolSuccess(`Responded to sampling request '${request_id}'`, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to respond: ${message}`);
      }
    }
  );

  server.registerTool(
    "cancel_sampling_request",
    {
      description: "Cancel a pending sampling request without responding. Use this when you want to ignore a request or if it seems to be part of a loop.",
      inputSchema: {
        request_id: z.string().describe("The ID of the sampling request to cancel"),
        reason: z.string().default("User cancelled").describe("Optional reason for cancellation"),
      },
    },
    ({ request_id, reason }, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        session.pendingRequests.cancelSampling(request_id, reason);
        return toolSuccess(`Cancelled sampling request '${request_id}'`, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to cancel: ${message}`);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Elicitation Tools (User input requests from backends)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "get_elicitations",
    {
      description: "Get pending elicitation requests from backend servers that need user input. These are requests from MCP servers asking for form data or user confirmation. URGENT: Backend servers are blocked waiting for user responses. You MUST respond promptly using respond_to_elicitation or the request may time out.",
      inputSchema: {},
    },
    (_args, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      const requests = session.pendingRequests.getPendingElicitationRequests();
      if (requests.length === 0) {
        return toolSuccess("No pending elicitation requests", session);
      }

      const formatted = requests.map((r) => ({
        requestId: r.requestId,
        server: r.server,
        timestamp: r.timestamp.toISOString(),
        mode: "mode" in r.params ? r.params.mode : "form",
        message: r.params.message,
        requestedSchema: "requestedSchema" in r.params ? r.params.requestedSchema : undefined,
        elicitationId: "elicitationId" in r.params ? r.params.elicitationId : undefined,
        url: "url" in r.params ? r.params.url : undefined,
      }));

      return toolJson(formatted, session);
    }
  );

  server.registerTool(
    "respond_to_elicitation",
    {
      description: "Respond to a pending elicitation request with user input",
      inputSchema: {
        request_id: z.string().describe("The ID of the elicitation request to respond to"),
        action: z.enum(["accept", "decline", "cancel"])
          .describe("The user's action: accept (with content), decline, or cancel"),
        content: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
          .optional()
          .describe("The form field values (required if action is 'accept' for form mode)"),
      },
    },
    ({ request_id, action, content }, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        session.pendingRequests.respondToElicitation(request_id, {
          action,
          content,
        });
        return toolSuccess(`Responded to elicitation request '${request_id}' with action '${action}'`, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to respond: ${message}`);
      }
    }
  );

  server.registerTool(
    "cancel_elicitation_request",
    {
      description: "Cancel a pending elicitation request without responding.",
      inputSchema: {
        request_id: z.string().describe("The ID of the elicitation request to cancel"),
        reason: z.string().default("User cancelled").describe("Optional reason for cancellation"),
      },
    },
    ({ request_id, reason }, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        session.pendingRequests.cancelElicitation(request_id, reason);
        return toolSuccess(`Cancelled elicitation request '${request_id}'`, session);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to cancel: ${message}`);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Event and Activity Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "await_activity",
    {
      description: "Wait for activity (events, pending requests) or timeout. Use this to poll for changes efficiently instead of repeatedly calling get_* tools. IMPORTANT: If pending_client.sampling or pending_client.elicitation counts are non-zero, you MUST respond promptly - backend servers are blocked waiting.",
      inputSchema: {
        timeout_ms: z.number().min(100).max(900000).default(30000)
          .describe("Maximum time to wait in milliseconds (100-900000, default: 30000)"),
        last_event_id: z.string().optional()
          .describe("Only return events after this ID (for pagination/continuation)"),
      },
    },
    async ({ timeout_ms, last_event_id }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      // Check for immediately available events
      const existingEvents = last_event_id
        ? session.eventSystem.getEventsAfter(last_event_id)
        : session.eventSystem.getNewEvents();

      if (existingEvents.length > 0) {
        // Return immediately with existing events
        return toolJson({
          triggered_by: "existing_events",
          events: existingEvents.map((e) => ({
            id: e.id,
            type: e.type,
            server: e.server,
            createdAt: e.createdAt.toISOString(),
            data: e.data,
          })),
          pending_server: {
            tasks: session.taskManager.getAllTasks().map((t) => ({
              taskId: t.taskId,
              server: t.server,
              toolName: t.toolName,
              status: t.status,
            })),
          },
          pending_client: {
            sampling: session.pendingRequests.getPendingSamplingRequests().length,
            elicitation: session.pendingRequests.getPendingElicitationRequests().length,
          },
        }, session);
      }

      // Wait for new activity
      const event = await session.eventSystem.waitForActivity(timeout_ms);

      if (event) {
        // Got an event
        const newEvents = session.eventSystem.getNewEvents();
        return toolJson({
          triggered_by: event.type,
          events: newEvents.map((e) => ({
            id: e.id,
            type: e.type,
            server: e.server,
            createdAt: e.createdAt.toISOString(),
            data: e.data,
          })),
          pending_server: {
            tasks: session.taskManager.getAllTasks().map((t) => ({
              taskId: t.taskId,
              server: t.server,
              toolName: t.toolName,
              status: t.status,
            })),
          },
          pending_client: {
            sampling: session.pendingRequests.getPendingSamplingRequests().length,
            elicitation: session.pendingRequests.getPendingElicitationRequests().length,
          },
        }, session);
      }

      // Timeout - return current state
      return toolJson({
        triggered_by: "timeout",
        events: [],
        pending_server: {
          tasks: session.taskManager.getAllTasks().map((t) => ({
            taskId: t.taskId,
            server: t.server,
            toolName: t.toolName,
            status: t.status,
          })),
        },
        pending_client: {
          sampling: session.pendingRequests.getPendingSamplingRequests().length,
          elicitation: session.pendingRequests.getPendingElicitationRequests().length,
        },
      }, session);
    }
  );

  // ---------------------------------------------------------------------------
  // Task Management Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "list_tasks",
    {
      description: "List proxy tasks (background tool executions that exceeded timeout)",
      inputSchema: {
        include_completed: z.boolean().default(false)
          .describe("Include completed/failed/cancelled tasks (default: false, only working tasks)"),
        server: z.string().optional()
          .describe("Filter by server name"),
      },
    },
    ({ include_completed, server: serverName }, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      let tasks = session.taskManager.getAllTasks(include_completed);

      if (serverName) {
        tasks = tasks.filter((t) => t.server === serverName);
      }

      if (tasks.length === 0) {
        return toolSuccess("No tasks", session);
      }

      const formatted = tasks.map((t) => ({
        taskId: t.taskId,
        server: t.server,
        toolName: t.toolName,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
        lastUpdatedAt: t.lastUpdatedAt.toISOString(),
        error: t.error,
        hasResult: t.result !== undefined,
      }));

      return toolJson(formatted, session);
    }
  );

  server.registerTool(
    "get_task",
    {
      description: "Get details of a specific task including its result if completed",
      inputSchema: {
        task_id: z.string().describe("The task ID to retrieve"),
      },
    },
    ({ task_id }, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      const task = session.taskManager.getTask(task_id);
      if (!task) {
        return toolError(`Task '${task_id}' not found`);
      }

      return toolJson({
        taskId: task.taskId,
        server: task.server,
        toolName: task.toolName,
        args: task.args,
        status: task.status,
        createdAt: task.createdAt.toISOString(),
        lastUpdatedAt: task.lastUpdatedAt.toISOString(),
        ttl: task.ttl,
        error: task.error,
        result: task.result,
      }, session);
    }
  );

  server.registerTool(
    "cancel_task",
    {
      description: "Cancel a working task",
      inputSchema: {
        task_id: z.string().describe("The task ID to cancel"),
      },
    },
    ({ task_id }, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      const cancelled = session.taskManager.cancelTask(task_id);
      if (cancelled) {
        return toolSuccess(`Task '${task_id}' cancelled`, session);
      } else {
        return toolError(`Task '${task_id}' not found or not in working state`);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Timer Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "set_timer",
    {
      description: "Set a timer that will fire after a specified duration. When the timer expires, you'll receive a notification in the context info of subsequent tool responses, and it will also appear as a timer_expired event in await_activity.",
      inputSchema: {
        duration_ms: z.number().min(1).max(86400000)
          .describe("Duration in milliseconds until the timer fires (max 24 hours)"),
        message: z.string().min(1).max(500)
          .describe("Message to include in the notification when the timer fires"),
        interval: z.boolean().default(false)
          .describe("If true, timer repeats at the specified interval instead of firing once (default: false)"),
      },
    },
    ({ duration_ms, message, interval }, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      try {
        const timer = session.timerManager.createTimer(duration_ms, message, interval);
        return toolJson({
          timerId: timer.id,
          message: timer.message,
          durationMs: timer.durationMs,
          interval: timer.interval,
          createdAt: timer.createdAt.toISOString(),
          expiresAt: timer.expiresAt.toISOString(),
        }, session);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to set timer: ${errorMessage}`);
      }
    }
  );

  server.registerTool(
    "list_timers",
    {
      description: "List all timers for this session",
      inputSchema: {
        include_inactive: z.boolean().default(false)
          .describe("Include expired and deleted timers (default: false, only active timers)"),
      },
    },
    ({ include_inactive }, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      const timers = session.timerManager.getAllTimers(include_inactive);
      if (timers.length === 0) {
        return toolSuccess("No timers", session);
      }

      const formatted = timers.map((t) => ({
        id: t.id,
        message: t.message,
        durationMs: t.durationMs,
        status: t.status,
        interval: t.interval,
        fireCount: t.fireCount,
        createdAt: t.createdAt.toISOString(),
        expiresAt: t.expiresAt.toISOString(),
      }));

      return toolJson(formatted, session);
    }
  );

  server.registerTool(
    "get_timer",
    {
      description: "Get details of a specific timer",
      inputSchema: {
        timer_id: z.string().describe("The timer ID to retrieve"),
      },
    },
    ({ timer_id }, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      const timer = session.timerManager.getTimer(timer_id);
      if (!timer) {
        return toolError(`Timer '${timer_id}' not found`);
      }

      return toolJson({
        id: timer.id,
        message: timer.message,
        durationMs: timer.durationMs,
        status: timer.status,
        interval: timer.interval,
        fireCount: timer.fireCount,
        createdAt: timer.createdAt.toISOString(),
        expiresAt: timer.expiresAt.toISOString(),
      }, session);
    }
  );

  server.registerTool(
    "delete_timer",
    {
      description: "Delete a timer. Returns the timer details before deletion.",
      inputSchema: {
        timer_id: z.string().describe("The timer ID to delete"),
      },
    },
    ({ timer_id }, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
      }

      const timer = session.timerManager.deleteTimer(timer_id);
      if (!timer) {
        return toolError(`Timer '${timer_id}' not found`);
      }

      return toolJson({
        deleted: true,
        timer: {
          id: timer.id,
          message: timer.message,
          durationMs: timer.durationMs,
          status: timer.status,
          interval: timer.interval,
          fireCount: timer.fireCount,
          createdAt: timer.createdAt.toISOString(),
          expiresAt: timer.expiresAt.toISOString(),
        },
      }, session);
    }
  );

  // ---------------------------------------------------------------------------
  // Codemode Tools (reduced-context API)
  // ---------------------------------------------------------------------------

  if (codemodeEnabled) {
    server.registerTool(
      "codemode_search",
      {
        description:
          "Search for MCP capabilities (tools, resources, prompts, servers) across all connected backend servers. " +
          "Returns compact results that can be used to discover available functionality. " +
          "Use regex patterns in the query to match names and descriptions.",
        inputSchema: {
          query: z.string().describe(
            "Search query - matches against names and descriptions. Supports regex patterns."
          ),
          type: z.enum(["tools", "resources", "prompts", "servers", "all"])
            .default("all")
            .describe("Type of capability to search for"),
          server: z.string().optional().describe(
            "Filter by server name (regex pattern). Omit to search all servers."
          ),
          includeSchemas: z.boolean().default(false).describe(
            "Include full input schemas for tools (increases response size)"
          ),
        },
      },
      async ({ query, type, server: serverPattern, includeSchemas }, extra): Promise<ToolResponse> => {
        const session = getSessionForTool(sessionManager, extra, sessions);
        if (!session) {
          return toolError("Session not found");
        }

        // Track the request
        const requestId = requestTracker.startRequest(
          session.sessionId,
          "codemode_search",
          query,
          { args: { type, server: serverPattern, includeSchemas } }
        );

        try {
          const searchQuery: SearchQuery = {
            query,
            type,
            server: serverPattern,
            includeSchemas,
          };

          const results = await search(searchQuery, {
            session,
            sessionManager,
          });

          // Summarize results for tracking
          const resultCounts = [
            results.tools?.length ? `${String(results.tools.length)} tools` : null,
            results.resources?.length ? `${String(results.resources.length)} resources` : null,
            results.prompts?.length ? `${String(results.prompts.length)} prompts` : null,
            results.servers?.length ? `${String(results.servers.length)} servers` : null,
          ].filter(Boolean).join(", ");
          requestTracker.completeRequest(requestId, resultCounts || "no results");

          return toolJson(results, session);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          requestTracker.failRequest(requestId, message);
          return toolError(`Search failed: ${message}`);
        }
      }
    );

    server.registerTool(
      "codemode_execute",
      {
        description:
          "Execute JavaScript code in a sandboxed environment with access to MCP operations via the `mcp.*` API. " +
          "Use this to perform complex operations that would require multiple tool calls. " +
          "Available API: mcp.listServers(), mcp.listTools(pattern?), mcp.callTool(server, tool, args?), " +
          "mcp.listResources(pattern?), mcp.readResource(server, uri), mcp.listPrompts(pattern?), " +
          "mcp.getPrompt(server, name, args?), mcp.sleep(ms), mcp.log(...args). " +
          "Code runs with async/await support. Return a value to include it in the response.",
        inputSchema: {
          code: z.string().describe(
            "JavaScript code to execute. Has access to 'mcp' object for MCP operations. " +
            "Async/await is supported. Return a value to include it in the result."
          ),
          timeout: z.number()
            .min(EXECUTE_LIMITS.MIN_TIMEOUT_MS)
            .max(EXECUTE_LIMITS.MAX_TIMEOUT_MS)
            .default(EXECUTE_LIMITS.DEFAULT_TIMEOUT_MS)
            .describe(
              `Execution timeout in milliseconds (${String(EXECUTE_LIMITS.MIN_TIMEOUT_MS)}ms - ${String(EXECUTE_LIMITS.MAX_TIMEOUT_MS)}ms, default ${String(EXECUTE_LIMITS.DEFAULT_TIMEOUT_MS)}ms)`
            ),
        },
      },
      async ({ code, timeout }, extra): Promise<ToolResponse> => {
        const session = getSessionForTool(sessionManager, extra, sessions);
        if (!session) {
          return toolError("Session not found");
        }

        // Validate request
        const validationError = validateExecuteRequest({ code, timeout });
        if (validationError) {
          return toolError(validationError);
        }

        // Track the request - use code preview as name
        const codePreview = code.length > 50 ? code.substring(0, 50) + "..." : code;
        const requestId = requestTracker.startRequest(
          session.sessionId,
          "codemode_execute",
          codePreview.replace(/\n/g, " "),
          { args: { codeLength: code.length, timeout } }
        );

        try {
          const result = await execute(
            { code, timeout },
            { session, sessionManager }
          );

          // Summarize result for tracking
          const summary = result.success
            ? `success (${String(result.stats.durationMs)}ms, ${String(result.stats.mcpCalls)} mcp calls)`
            : `error: ${result.error?.message ?? "unknown"}`;

          if (result.success) {
            requestTracker.completeRequest(requestId, summary);
          } else if (result.error?.message.includes("timed out")) {
            requestTracker.timeoutRequest(requestId);
          } else {
            requestTracker.failRequest(requestId, result.error?.message ?? "unknown error");
          }

          return toolJson(result, session);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          requestTracker.failRequest(requestId, message);
          return toolError(`Execution failed: ${message}`);
        }
      }
    );
  }
}

// =============================================================================
// HTTP Server Setup
// =============================================================================

function main(): void {
  const { configPath, port, logLevel, noCodemode } = parseArgs();
  const logger = createConsoleLogger(logLevel);

  const host = process.env["EMCEEPEE_HOST"] ?? "127.0.0.1";
  const baseUrl = (
    process.env["EMCEEPEE_BASE_URL"] ?? `http://localhost:${String(port)}`
  ).replace(/\/+$/, "");
  const oauthRedirectUri = `${baseUrl}/oauth/callback`;
  const dcrStorePath = process.env["EMCEEPEE_DCR_STORE_PATH"];

  const isLoopbackHost =
    host === "127.0.0.1" || host === "localhost" || host === "::1";

  logger.info("Starting MCP Proxy Server", {
    port,
    host,
    baseUrl,
    configPath,
    codemodeEnabled: !noCodemode,
  });

  if (!isLoopbackHost) {
    const warning =
      `EMCEEPEE_HOST=${host} is not a loopback address. ` +
      `emceepee-http has no frontend authentication and exposes management ` +
      `tools for any connected MCP client. Bind to 127.0.0.1 unless you ` +
      `have deliberately placed it behind a trusted proxy.`;
    console.warn(`\n!!! ${warning} !!!\n`);
    logger.warn("non_loopback_host", { host, baseUrl });
  }

  // Upstream OAuth support (in-memory tokens, on-disk DCR clients).
  const tokenStore = new BackendTokenStore();
  const dcrStore = new FileDcrStore(
    dcrStorePath ? { path: dcrStorePath, logger } : { logger }
  );
  const pendingFlows = new PendingFlowRegistry({ logger });

  // Create session manager
  // Use long timeout - sessions are typically long-lived dev sessions with Cursor
  const sessionManager = new SessionManager({
    logger,
    sessionTimeoutMs: 24 * 60 * 60 * 1000, // 24 hours (effectively infinite for dev sessions)
    cleanupIntervalMs: 60 * 60 * 1000, // 1 hour
    tokenStore,
    dcrStore,
    pendingFlows,
    baseUrl,
  });

  // Load initial servers from config if provided
  if (configPath) {
    try {
      const config = loadConfig(configPath);
      logger.info("Loading servers from config", {
        count: config.servers.length,
        path: configPath,
      });

      for (const server of config.servers) {
        if (isHttpServerConfig(server)) {
          logger.info("Adding HTTP server config", {
            name: server.name,
            url: server.url,
            authMode: server.authMode ?? "none",
          });
          sessionManager.getServerConfigs().addConfig(server.name, server.url, {
            headers: server.headers,
            authMode: server.authMode,
            oauthScopes: server.oauthScopes,
          });
        } else if (isStdioServerConfig(server)) {
          logger.info("Adding stdio server config", { name: server.name, command: server.command });
          sessionManager.getServerConfigs().addStdioConfig(
            server.name,
            server.command,
            server.args,
            { env: server.env, cwd: server.cwd, restartConfig: server.restartConfig }
          );
        }
      }
    } catch (err) {
      logger.error("Failed to load config", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  }

  // Create request tracker for debugging/waterfall UI
  const requestTracker = new RequestTracker({ logger });

  // Create the MCP server
  const mcpServer = new McpServer({
    name: "emceepee",
    version: "0.2.0",
  });

  // Map transport session IDs to our session IDs
  const transportToSession = new Map<string, string>();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  /** Inverse lookup: our sessionId → transport, so callback handlers can push `notifications/elicitation/complete`. */
  const sessionToTransport = new Map<string, StreamableHTTPServerTransport>();

  // Register all tools
  registerTools(mcpServer, sessionManager, transportToSession, requestTracker, {
    codemodeEnabled: !noCodemode,
  });

  function sendHtmlError(
    res: ServerResponse,
    status: number,
    title: string,
    detail: unknown
  ): void {
    const message =
      detail instanceof Error
        ? detail.message
        : typeof detail === "string"
          ? detail
          : detail === undefined || detail === null
            ? ""
            : JSON.stringify(detail);
    const body =
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222}` +
      `h1{margin-bottom:.5rem}pre{background:#f5f5f7;padding:1rem;border-radius:6px;overflow-x:auto}</style></head>` +
      `<body><h1>${escapeHtml(title)}</h1>` +
      (message ? `<pre>${escapeHtml(message)}</pre>` : "") +
      `</body></html>`;
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  }

  function sendHtmlOk(
    res: ServerResponse,
    title: string,
    body: string
  ): void {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
        `<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222}` +
        `h1{margin-bottom:.5rem}</style></head>` +
        `<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`
    );
  }

  /**
   * GET /connect/:server — start an upstream OAuth flow for the named server
   * and redirect the browser to the authorization URL. Used when a user wants
   * to pre-authorize instead of being prompted by an elicitation.
   */
  async function handleConnect(
    url: URL,
    res: ServerResponse
  ): Promise<void> {
    const serverName = decodeURIComponent(url.pathname.slice("/connect/".length));
    if (!serverName) {
      sendHtmlError(res, 400, "Missing server name", "");
      return;
    }

    const serverConfig = sessionManager.getServerConfigs().getConfig(serverName);
    if (serverConfig?.type !== "http") {
      sendHtmlError(res, 404, "Unknown server", `No HTTP server config for '${serverName}'.`);
      return;
    }
    if (serverConfig.authMode !== "oauth") {
      sendHtmlError(
        res,
        400,
        "Server is not OAuth-protected",
        `'${serverName}' is configured with authMode="${serverConfig.authMode ?? "none"}". ` +
          `Set authMode="oauth" when registering the server.`
      );
      return;
    }

    // Short-circuit if a flow is already in progress for this server.
    const existing = pendingFlows.findByServer(serverName);
    if (existing) {
      res.writeHead(302, { Location: existing.authorizationUrl });
      res.end();
      return;
    }

    // The redirect state is wrapped in a container so TS flow analysis
    // doesn't narrow `redirected` to a literal `false` past the callback.
    const state: { redirected: boolean } = { redirected: false };
    const providerOpts: Parameters<typeof makeOAuthClientProvider>[0] = {
      serverName,
      serverUrl: serverConfig.url,
      redirectUri: oauthRedirectUri,
      sessionId: "system:/connect",
      tokenStore,
      dcrStore,
      pendingFlows,
      logger,
    };
    if (serverConfig.oauthScopes) providerOpts.scopes = serverConfig.oauthScopes;
    const provider = makeOAuthClientProvider(providerOpts);
    provider.onAuthorizationRequired = (authUrl: string): void => {
      state.redirected = true;
      res.writeHead(302, { Location: authUrl });
      res.end();
    };

    await provider.ensureIssuer();

    try {
      const result = await auth(provider, { serverUrl: serverConfig.url });
      if (!state.redirected) {
        if (result === "AUTHORIZED") {
          sendHtmlOk(
            res,
            "Already connected",
            `<p>'${escapeHtml(serverName)}' is already authorized. You can close this tab.</p>`
          );
        } else {
          sendHtmlError(
            res,
            500,
            "Unexpected auth result",
            `auth() returned '${result}' without calling redirectToAuthorization`
          );
        }
      }
    } catch (err) {
      if (!state.redirected) {
        sendHtmlError(res, 500, "Authorization failed", err);
      }
    }
  }

  /**
   * GET /oauth/callback?code=...&state=... — exchange the code for tokens
   * using the pending flow's provider, then notify the originating session.
   */
  async function handleOAuthCallback(
    url: URL,
    res: ServerResponse
  ): Promise<void> {
    const stateParam = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const errorParam = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    if (!stateParam) {
      sendHtmlError(res, 400, "Missing state", "OAuth callback requires a state parameter.");
      return;
    }

    const flow = pendingFlows.consumeByState(stateParam);
    if (!flow) {
      sendHtmlError(
        res,
        404,
        "Unknown or expired flow",
        "No pending OAuth flow matches this state. The flow may have expired (10-minute TTL) or already completed."
      );
      return;
    }

    if (errorParam) {
      const msg = errorDescription ? `${errorParam}: ${errorDescription}` : errorParam;
      emitElicitationComplete(flow, "failed", msg);
      sendHtmlError(res, 400, "Authorization denied", msg);
      return;
    }

    if (!code) {
      emitElicitationComplete(flow, "failed", "Missing authorization code");
      sendHtmlError(res, 400, "Missing code", "OAuth callback returned no authorization code.");
      return;
    }

    const serverConfig = sessionManager.getServerConfigs().getConfig(flow.serverName);
    if (serverConfig?.type !== "http") {
      const msg = `Server config for '${flow.serverName}' is gone`;
      emitElicitationComplete(flow, "failed", msg);
      sendHtmlError(res, 404, "Unknown server", msg);
      return;
    }

    // The sessionId on this provider only matters if redirectToAuthorization
    // is called during the callback (it shouldn't be — this is the
    // authorization_code exchange path, not a fresh auth). Using any
    // subscriber from the original flow is fine.
    const initiatingSessionId = flow.sessionIds.values().next().value ?? "system:/callback";
    const providerOpts: Parameters<typeof makeOAuthClientProvider>[0] = {
      serverName: flow.serverName,
      serverUrl: serverConfig.url,
      redirectUri: oauthRedirectUri,
      sessionId: initiatingSessionId,
      tokenStore,
      dcrStore,
      pendingFlows,
      logger,
      // Pin the verifier captured when the authorize URL was registered.
      // A concurrent second auth() call on the same server runs
      // startAuthorization independently and overwrites
      // tokenStore.codeVerifier; without pinning, this callback would
      // exchange the code against the wrong PKCE verifier and fail.
      pinnedCodeVerifier: flow.codeVerifier,
    };
    if (serverConfig.oauthScopes) providerOpts.scopes = serverConfig.oauthScopes;
    const provider = makeOAuthClientProvider(providerOpts);

    try {
      await provider.ensureIssuer();
      const result = await auth(provider, {
        serverUrl: serverConfig.url,
        authorizationCode: code,
      });
      if (result === "AUTHORIZED") {
        emitElicitationComplete(flow, "completed");
        sendHtmlOk(
          res,
          `Connected '${flow.serverName}'`,
          `<p>Authorization complete. You can close this tab and return to your MCP client.</p>`
        );
      } else {
        const msg = `auth() returned '${result}' after code exchange`;
        emitElicitationComplete(flow, "failed", msg);
        sendHtmlError(res, 500, "Authorization incomplete", msg);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitElicitationComplete(flow, "failed", msg);
      sendHtmlError(res, 500, "Token exchange failed", err);
    }
  }

  /**
   * Push `notifications/elicitation/complete` into the originating session's
   * SSE stream (best-effort) and emit `elicitation_completed` into the
   * session's event system for await_activity consumers.
   */
  function emitElicitationComplete(
    flow: PendingFlow,
    status: "completed" | "failed",
    errorMessage?: string
  ): void {
    const params: Record<string, unknown> = {
      server: flow.serverName,
      status,
    };
    if (errorMessage !== undefined) {
      params["error"] = errorMessage;
    }

    // Broadcast to every session that was subscribed to this flow.
    // Single-flight dedupe attaches additional sessionIds to a flow when a
    // concurrent caller reuses the in-flight authorize URL; all of them
    // must be notified or the later caller hangs on await_activity.
    for (const sid of flow.sessionIds) {
      const session = sessionManager.getSession(sid);
      if (session) {
        session.eventSystem.addEvent("elicitation_completed", flow.serverName, {
          server: flow.serverName,
          status,
          error: errorMessage,
        });
      }
      const transport = sessionToTransport.get(sid);
      if (transport) {
        void transport
          .send({
            jsonrpc: "2.0",
            method: "notifications/elicitation/complete",
            params,
          })
          .catch((err: unknown) => {
            logger.debug("elicitation_notification_send_failed", {
              sessionId: sid,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
    }
  }

  // Create HTTP server
  const httpServer = createServer((req, res) => {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);

    // Serve waterfall UI
    if (url.pathname === "/waterfall" || url.pathname === "/waterfall/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(generateWaterfallHTML(requestTracker));
      return;
    }

    // Serve waterfall JSON data
    if (url.pathname === "/waterfall/json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(generateWaterfallJSON(requestTracker), null, 2));
      return;
    }

    // --- OAuth backend proxy: /connect/:server and /oauth/callback --------
    if (url.pathname.startsWith("/connect/")) {
      void handleConnect(url, res).catch((err: unknown) => {
        sendHtmlError(res, 500, "Internal error", err);
      });
      return;
    }
    if (url.pathname === "/oauth/callback") {
      void handleOAuthCallback(url, res).catch((err: unknown) => {
        sendHtmlError(res, 500, "Internal error", err);
      });
      return;
    }

    // Only handle /mcp endpoint for MCP protocol
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Available endpoints: /mcp, /connect/<server>, /oauth/callback, /waterfall, /waterfall/json" }));
      return;
    }

    // Get transport session ID from header
    const transportSessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      // Handle new or existing session
      let transport = transportSessionId ? transports.get(transportSessionId) : undefined;

      if (!transport) {
        // Log when we're creating a new transport
        if (transportSessionId) {
          // Session ID provided but transport not found - this could indicate a bug
          logger.warn("transport_not_found_for_session", {
            transportSessionId,
            transportCount: transports.size,
            knownTransports: Array.from(transports.keys()),
          });
        }

        // Create new transport for this session
        // Create per-transport event store for SSE resumability
        const eventStore = new SSEEventStore({ logger });

        // Per-transport capture of the client's advertised capabilities.
        // The shared McpServer's internal _clientCapabilities field is
        // overwritten by every `initialize` from any transport, so reading
        // it at tool-call time can leak capabilities across sessions. We
        // sniff this transport's initialize message ourselves instead.
        const capsHolder: { caps?: ClientCapabilities } = {};

        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: (): string => crypto.randomUUID(),
          eventStore, // Enable SSE resumability via Last-Event-ID
          onsessioninitialized: (newTransportSessionId): void => {
            transports.set(newTransportSessionId, newTransport);

            // Create our session and map it
            void sessionManager.createSession().then((session) => {
              transportToSession.set(newTransportSessionId, session.sessionId);
              sessionToTransport.set(session.sessionId, newTransport);
              if (capsHolder.caps) {
                session.clientCapabilities = capsHolder.caps;
              }
              logger.info("Session created", {
                transportSessionId: newTransportSessionId,
                sessionId: session.sessionId,
              });
            });
          },
        });
        transport = newTransport;

        // Install a pre-connect onmessage sniffer. The SDK's connect()
        // preserves an existing onmessage and invokes it before its own
        // handler (see shared/protocol.ts), so assigning here wins the race.
        newTransport.onmessage = (message): void => {
          const asObj = message as { method?: unknown; params?: unknown };
          if (
            asObj.method === "initialize" &&
            typeof asObj.params === "object" &&
            asObj.params !== null
          ) {
            const params = asObj.params as { capabilities?: ClientCapabilities };
            if (params.capabilities) {
              capsHolder.caps = params.capabilities;
            }
          }
        };

        // Connect to MCP server
        void mcpServer.connect(newTransport);
      } else {
        logger.debug("using_existing_transport", { transportSessionId });
        // Touch the session on activity
        const ourSessionId = transportToSession.get(transportSessionId ?? "");
        if (ourSessionId) {
          sessionManager.touchSession(ourSessionId);
        }
      }

      // Handle the request
      void transport.handleRequest(req, res);
    } else if (req.method === "GET") {
      // SSE connection for existing session
      if (!transportSessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing mcp-session-id header" }));
        return;
      }

      const transport = transports.get(transportSessionId);
      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      // Track SSE connection close for session cleanup
      res.on("close", () => {
        logger.info("sse_connection_closed", { transportSessionId });

        // Clean up transport and session when SSE connection closes
        const existingTransport = transports.get(transportSessionId);
        if (existingTransport) {
          void existingTransport.close();
          transports.delete(transportSessionId);

          const ourSessionId = transportToSession.get(transportSessionId);
          if (ourSessionId) {
            void sessionManager.destroySession(ourSessionId);
            transportToSession.delete(transportSessionId);
            sessionToTransport.delete(ourSessionId);
            logger.info("session_closed_via_sse", { transportSessionId, sessionId: ourSessionId });
          }
        }
      });

      // Check if this is a replay request (has Last-Event-ID header)
      const isReplayRequest = req.headers["last-event-id"] !== undefined;

      // Start handling the request (this sets up the SSE stream)
      void transport.handleRequest(req, res);

      // After GET SSE stream is established, send a priming notification
      // This gives the client an initial event ID for replay if connection drops
      // Skip if this is already a replay request (client already has event IDs)
      if (!isReplayRequest) {
        // Small delay to ensure stream is fully established before sending
        setTimeout(() => {
          logger.debug("sending_sse_priming_notification", { transportSessionId });
          mcpServer.sendToolListChanged();
        }, 100);
      }
    } else if (req.method === "DELETE") {
      // Session cleanup
      if (transportSessionId && transports.has(transportSessionId)) {
        const transport = transports.get(transportSessionId);
        void transport?.close();
        transports.delete(transportSessionId);

        // Clean up our session
        const ourSessionId = transportToSession.get(transportSessionId);
        if (ourSessionId) {
          void sessionManager.destroySession(ourSessionId);
          transportToSession.delete(transportSessionId);
          sessionToTransport.delete(ourSessionId);
        }

        logger.info("Session closed", { transportSessionId });
      }
      res.writeHead(200);
      res.end();
    } else {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
    }
  });

  // Handle shutdown
  const shutdown = async (): Promise<void> => {
    logger.info("Shutting down...", {});

    // Close all transports
    for (const transport of transports.values()) {
      void transport.close();
    }

    // Shutdown session manager (cleans up all sessions)
    await sessionManager.shutdown();

    pendingFlows.shutdown();

    httpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Start server
  httpServer.listen(port, host, () => {
    logger.info("Server started", { url: `${baseUrl}/mcp`, host });
    console.log(`MCP Proxy Server running at ${baseUrl}/mcp`);
    console.log(`Waterfall UI available at ${baseUrl}/waterfall`);
    console.log(`OAuth endpoints: ${baseUrl}/connect/<server>, ${baseUrl}/oauth/callback`);
    console.log("\nAvailable tools:");
    console.log("  Server management: add_server, remove_server, reconnect_server, list_servers");
    console.log("  Tools: list_tools, execute_tool");
    console.log("  Resources: list_resources, list_resource_templates, read_resource, subscribe_resource, unsubscribe_resource");
    console.log("  Prompts: list_prompts, get_prompt");
    console.log("  Notifications: get_notifications, get_logs");
    console.log("  Sampling: get_sampling_requests, respond_to_sampling");
    console.log("  Elicitation: get_elicitations, respond_to_elicitation");
    console.log("  Activity: await_activity");
    console.log("  Tasks: list_tasks, get_task, cancel_task");
  });
}

main();
