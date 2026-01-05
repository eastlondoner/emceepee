#!/usr/bin/env node
/**
 * MCP Proxy Server - stdio transport
 *
 * An stdio-based MCP server with static tools for managing and interacting with
 * multiple backend MCP servers dynamically. This is a single-session variant
 * designed for use with clients that communicate via stdin/stdout.
 *
 * Architecture:
 * - SessionManager: Creates/destroys sessions, manages shared server configs
 * - SessionState: Per-session state (connections, events, tasks, pending requests)
 * - Tools: Session-aware handlers that operate on the single session's state
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readFileSync } from "fs";

import { SessionManager } from "./session/session-manager.js";
import type { SessionState } from "./session/session-state.js";
import type { ProxyConfig } from "./types.js";
import { createFileLogger, createNullLogger, type StructuredLogger } from "./logging.js";

// =============================================================================
// Logging Transport Wrapper
// =============================================================================

/**
 * Wraps a Transport to log all incoming and outgoing messages.
 * Useful for debugging protocol issues.
 */
function createLoggingTransport(
  inner: Transport,
  logger: StructuredLogger
): Transport {
  const wrapped: Transport = {
    start: async () => {
      logger.debug("transport_start", {});
      return inner.start();
    },

    send: async (message: JSONRPCMessage, options) => {
      logger.debug("transport_send", {
        message: JSON.stringify(message),
        hasRelatedRequestId: options?.relatedRequestId !== undefined,
      });
      return inner.send(message, options);
    },

    close: async () => {
      logger.debug("transport_close", {});
      return inner.close();
    },

    get sessionId() {
      return inner.sessionId;
    },

    set onclose(handler: (() => void) | undefined) {
      inner.onclose = handler
        ? (): void => {
            logger.debug("transport_onclose", {});
            handler();
          }
        : undefined;
    },
    get onclose() {
      return inner.onclose;
    },

    set onerror(handler: ((error: Error) => void) | undefined) {
      inner.onerror = handler
        ? (error: Error): void => {
            logger.debug("transport_onerror", { error: error.message });
            handler(error);
          }
        : undefined;
    },
    get onerror() {
      return inner.onerror;
    },

    set onmessage(handler: ((message: JSONRPCMessage) => void) | undefined) {
      inner.onmessage = handler
        ? (message: JSONRPCMessage): void => {
            logger.debug("transport_onmessage", {
              message: JSON.stringify(message),
            });
            handler(message);
          }
        : undefined;
    },
    get onmessage() {
      return inner.onmessage;
    },

    setProtocolVersion: inner.setProtocolVersion?.bind(inner),
  };

  return wrapped;
}

// =============================================================================
// Types
// =============================================================================

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
  logLevel: "debug" | "info" | "warn" | "error";
  logFile?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let configPath: string | undefined;
  let logLevel: CliArgs["logLevel"] = "info";
  let logFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--config" && args[i + 1]) {
      configPath = args[i + 1];
      i++;
    } else if (arg?.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else if (arg === "--log-level" && args[i + 1]) {
      logLevel = args[i + 1] as CliArgs["logLevel"];
      i++;
    } else if (arg?.startsWith("--log-level=")) {
      logLevel = arg.slice("--log-level=".length) as CliArgs["logLevel"];
    } else if (arg === "--log-file" && args[i + 1]) {
      logFile = args[i + 1];
      i++;
    } else if (arg?.startsWith("--log-file=")) {
      logFile = arg.slice("--log-file=".length);
    }
  }

  return { configPath, logLevel, logFile };
}

function loadConfig(path: string): ProxyConfig {
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content) as ProxyConfig;
}

function loadConfigFromJson(json: string): ProxyConfig {
  return JSON.parse(json) as ProxyConfig;
}

// =============================================================================
// Session Resolution Helper
// =============================================================================

/**
 * Get the single session for a tool call.
 * In stdio mode, there's only one session, so we just return it.
 */
function getSession(session: SessionState | undefined): SessionState | undefined {
  return session;
}

/**
 * Create a tool error response
 */
function toolError(message: string): ToolResponse {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Create a tool success response
 */
function toolSuccess(message: string): ToolResponse {
  return {
    content: [{ type: "text", text: message }],
  };
}

/**
 * Create a JSON tool response
 */
function toolJson(data: unknown): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

// =============================================================================
// Tool Registration
// =============================================================================

function registerTools(
  server: McpServer,
  sessionManager: SessionManager,
  getActiveSession: () => SessionState | undefined
): void {
  // ---------------------------------------------------------------------------
  // Server Management Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "add_server",
    {
      description: "Connect to a backend MCP server. The server will be added to the shared configuration and this session will connect to it.",
      inputSchema: {
        name: z.string().describe("Unique name for this server"),
        url: z.string().url().describe("HTTP URL of the MCP server endpoint"),
      },
    },
    async ({ name, url }): Promise<ToolResponse> => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

      try {
        const connection = await sessionManager.addServer(session.sessionId, name, url);
        const capabilities = connection.client.getInfo().capabilities;
        return toolSuccess(
          `Connected to server '${name}' at ${url}\n` +
          `Capabilities: ${JSON.stringify(capabilities)}`
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
    async ({ name }): Promise<ToolResponse> => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

      try {
        await sessionManager.removeServer(session.sessionId, name);
        return toolSuccess(`Disconnected from server '${name}'`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to remove server: ${message}`);
      }
    }
  );

  server.registerTool(
    "list_servers",
    {
      description: "List all configured backend MCP servers with their connection status for this session",
      inputSchema: {},
    },
    (): ToolResponse => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

      const servers = sessionManager.listServers(session.sessionId);
      if (servers.length === 0) {
        return toolSuccess("No servers configured");
      }

      const formatted = servers.map((s) => ({
        name: s.name,
        url: s.url,
        status: s.status,
        connected: s.connected,
        connectedAt: s.connectedAt?.toISOString(),
        lastError: s.lastError,
      }));

      return toolJson(formatted);
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
    async ({ server: serverPattern, tool: toolPattern }): Promise<ToolResponse> => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
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
          return toolSuccess("No tools available");
        }

        return toolJson(allTools);
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
    async ({ server: serverName, tool, args }) => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

      try {
        const client = await sessionManager.getOrCreateConnection(session.sessionId, serverName);
        const result = await client.callTool(tool, args ?? {});

        // Pass through the result content directly, preserving all content types
        return {
          content: result.content,
          isError: result.isError,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
    async ({ server: serverName }): Promise<ToolResponse> => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
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
          return toolSuccess("No resources available");
        }

        return toolJson(resources);
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
    async ({ server: serverName }): Promise<ToolResponse> => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
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
          return toolSuccess("No resource templates available");
        }

        return toolJson(templates);
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
    async ({ server: serverName, uri }): Promise<ToolResponse> => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

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

        return toolJson({ contents });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to read resource: ${message}`);
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
    async ({ server: serverName }): Promise<ToolResponse> => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
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
          return toolSuccess("No prompts available");
        }

        return toolJson(prompts);
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
    async ({ server: serverName, name, arguments: promptArgs }): Promise<ToolResponse> => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

      try {
        const client = await sessionManager.getOrCreateConnection(session.sessionId, serverName);
        const result = await client.getPrompt(name, promptArgs ?? {});
        return toolJson(result);
      } catch (err) {
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
    (): ToolResponse => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

      const notifications = session.bufferManager.getAndClearNotifications();
      if (notifications.length === 0) {
        return toolSuccess("No notifications");
      }

      const formatted = notifications.map((n) => ({
        server: n.server,
        method: n.method,
        timestamp: n.timestamp.toISOString(),
        params: n.params,
      }));

      return toolJson(formatted);
    }
  );

  server.registerTool(
    "get_logs",
    {
      description: "Get and clear buffered log messages from backend servers for this session",
      inputSchema: {},
    },
    (): ToolResponse => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

      const logs = session.bufferManager.getAndClearLogs();
      if (logs.length === 0) {
        return toolSuccess("No log messages");
      }

      const formatted = logs.map((l) => ({
        server: l.server,
        level: l.level,
        logger: l.logger,
        timestamp: l.timestamp.toISOString(),
        data: l.data,
      }));

      return toolJson(formatted);
    }
  );

  // ---------------------------------------------------------------------------
  // Sampling Tools (LLM requests from backends)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "get_sampling_requests",
    {
      description: "Get pending sampling requests from backend servers that need LLM responses. These are requests from MCP servers asking for LLM completions.",
      inputSchema: {},
    },
    (): ToolResponse => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

      const requests = session.pendingRequests.getPendingSamplingRequests();
      if (requests.length === 0) {
        return toolSuccess("No pending sampling requests");
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

      return toolJson(formatted);
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
    ({ request_id, role, content, model, stop_reason }): ToolResponse => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

      try {
        session.pendingRequests.respondToSampling(request_id, {
          role,
          content: { type: "text", text: content },
          model,
          stopReason: stop_reason,
        });
        return toolSuccess(`Responded to sampling request '${request_id}'`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to respond: ${message}`);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Elicitation Tools (User input requests from backends)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "get_elicitations",
    {
      description: "Get pending elicitation requests from backend servers that need user input. These are requests from MCP servers asking for form data or user confirmation.",
      inputSchema: {},
    },
    (): ToolResponse => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

      const requests = session.pendingRequests.getPendingElicitationRequests();
      if (requests.length === 0) {
        return toolSuccess("No pending elicitation requests");
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

      return toolJson(formatted);
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
    ({ request_id, action, content }): ToolResponse => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

      try {
        session.pendingRequests.respondToElicitation(request_id, {
          action,
          content,
        });
        return toolSuccess(`Responded to elicitation request '${request_id}' with action '${action}'`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to respond: ${message}`);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Event and Activity Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "await_activity",
    {
      description: "Wait for activity (events, pending requests) or timeout. Use this to poll for changes efficiently instead of repeatedly calling get_* tools.",
      inputSchema: {
        timeout_ms: z.number().min(100).max(60000).default(30000)
          .describe("Maximum time to wait in milliseconds (100-60000, default: 30000)"),
        last_event_id: z.string().optional()
          .describe("Only return events after this ID (for pagination/continuation)"),
      },
    },
    async ({ timeout_ms, last_event_id }): Promise<ToolResponse> => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
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
        });
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
        });
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
      });
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
    ({ include_completed, server: serverName }): ToolResponse => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

      let tasks = session.taskManager.getAllTasks(include_completed);

      if (serverName) {
        tasks = tasks.filter((t) => t.server === serverName);
      }

      if (tasks.length === 0) {
        return toolSuccess("No tasks");
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

      return toolJson(formatted);
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
    ({ task_id }): ToolResponse => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
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
      });
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
    ({ task_id }): ToolResponse => {
      const session = getSession(getActiveSession());
      if (!session) {
        return toolError("Session not initialized");
      }

      const cancelled = session.taskManager.cancelTask(task_id);
      if (cancelled) {
        return toolSuccess(`Task '${task_id}' cancelled`);
      } else {
        return toolError(`Task '${task_id}' not found or not in working state`);
      }
    }
  );
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const { configPath, logLevel, logFile } = parseArgs();

  // In stdio mode, we can't log to console (that would interfere with the protocol).
  // Use file logging if specified via CLI arg or EMCEEPEE_LOG_DIR env var.
  let logger: StructuredLogger;

  // Determine log file path: CLI arg takes precedence, then env var
  let effectiveLogFile = logFile;
  const logDir = process.env["EMCEEPEE_LOG_DIR"];
  if (!effectiveLogFile && logDir) {
    // Create timestamped log file in the specified directory
    const fs = await import("fs");
    const path = await import("path");

    // Expand ~ to home directory
    const expandedDir = logDir.startsWith("~")
      ? path.join(process.env["HOME"] ?? "", logDir.slice(1))
      : logDir;

    // Ensure directory exists
    try {
      fs.mkdirSync(expandedDir, { recursive: true });
    } catch {
      // Directory may already exist, ignore
    }

    // Create log file with timestamp and PID for uniqueness
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    effectiveLogFile = path.join(expandedDir, `emceepee-${timestamp}-${String(process.pid)}.log`);
  }

  if (effectiveLogFile) {
    // Default to debug level when logging to file via env var
    const effectiveLogLevel = logFile ? logLevel : (logDir ? "debug" : logLevel);
    logger = createFileLogger(effectiveLogLevel, effectiveLogFile);
    // Log startup info including the log file location
    logger.info("Logging initialized", { logFile: effectiveLogFile, logLevel: effectiveLogLevel });
  } else {
    logger = createNullLogger();
  }

  logger.info("Starting MCP Proxy Server (stdio mode)", { configPath });

  // Create session manager
  const sessionManager = new SessionManager({
    logger,
    sessionTimeoutMs: 24 * 60 * 60 * 1000, // 24 hours (effectively infinite for dev sessions)
    cleanupIntervalMs: 5 * 60 * 1000, // 5 minutes
  });

  // Load initial servers from config (env var JSON takes precedence over file path)
  const configJson = process.env["EMCEEPEE_CONFIG"];

  if (configJson) {
    try {
      const config = loadConfigFromJson(configJson);
      logger.info("Loading servers from config", {
        count: config.servers.length,
        source: "EMCEEPEE_CONFIG env var",
      });

      for (const server of config.servers) {
        logger.info("Adding server config", { name: server.name, url: server.url });
        sessionManager.getServerConfigs().addConfig(server.name, server.url);
      }
    } catch (err) {
      logger.error("Failed to load config from EMCEEPEE_CONFIG", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  } else if (configPath) {
    try {
      const config = loadConfig(configPath);
      logger.info("Loading servers from config", {
        count: config.servers.length,
        path: configPath,
      });

      for (const server of config.servers) {
        logger.info("Adding server config", { name: server.name, url: server.url });
        sessionManager.getServerConfigs().addConfig(server.name, server.url);
      }
    } catch (err) {
      logger.error("Failed to load config", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  }

  // Create the MCP server
  const mcpServer = new McpServer({
    name: "emceepee",
    version: "0.2.0",
  });

  // Create the single session for stdio mode
  const activeSession = await sessionManager.createSession();
  logger.info("Session created", { sessionId: activeSession.sessionId });

  // Register all tools with a getter for the active session
  registerTools(mcpServer, sessionManager, () => activeSession);

  // Create stdio transport (with optional logging wrapper for debugging)
  const rawTransport = new StdioServerTransport();
  const transport = effectiveLogFile
    ? createLoggingTransport(rawTransport, logger)
    : rawTransport;

  // Handle shutdown
  const shutdown = async (): Promise<void> => {
    logger.info("Shutting down...", {});

    // Close transport
    await rawTransport.close();

    // Shutdown session manager (cleans up all sessions)
    await sessionManager.shutdown();

    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Connect and start
  await mcpServer.connect(transport);
  logger.info("Server started (stdio mode)", {});
}

main().catch((err: unknown) => {
  // In stdio mode, write errors to stderr
  console.error("Fatal error:", err);
  process.exit(1);
});
