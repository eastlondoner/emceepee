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
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "http";
import { z } from "zod";
import { readFileSync } from "fs";

import { SessionManager } from "./session/session-manager.js";
import type { SessionState } from "./session/session-state.js";
import type { ProxyConfig } from "./types.js";
import { createConsoleLogger } from "./logging.js";

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
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let configPath: string | undefined;
  let port = Number(process.env["PORT"]) || 8080;
  let logLevel: CliArgs["logLevel"] = "info";

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
    }
  }

  return { configPath, port, logLevel };
}

function loadConfig(path: string): ProxyConfig {
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content) as ProxyConfig;
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
  sessions: Map<string, string>
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
    async ({ name, url }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
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
    async ({ name }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
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
    (_args, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
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
    async ({ server: serverName, tool, args }, extra) => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
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
    async ({ server: serverName, name, arguments: promptArgs }, extra): Promise<ToolResponse> => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
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
    (_args, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
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
    (_args, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
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
    (_args, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
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
    (_args, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
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
    ({ task_id }, extra): ToolResponse => {
      const session = getSessionForTool(sessionManager, extra, sessions);
      if (!session) {
        return toolError("Session not found");
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
// HTTP Server Setup
// =============================================================================

function main(): void {
  const { configPath, port, logLevel } = parseArgs();
  const logger = createConsoleLogger(logLevel);

  logger.info("Starting MCP Proxy Server", { port, configPath });

  // Create session manager
  const sessionManager = new SessionManager({
    logger,
    sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
    cleanupIntervalMs: 5 * 60 * 1000, // 5 minutes
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

  // Map transport session IDs to our session IDs
  const transportToSession = new Map<string, string>();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Register all tools
  registerTools(mcpServer, sessionManager, transportToSession);

  // Create HTTP server
  const httpServer = createServer((req, res) => {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);

    // Only handle /mcp endpoint
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Get transport session ID from header
    const transportSessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      // Handle new or existing session
      let transport = transportSessionId ? transports.get(transportSessionId) : undefined;

      if (!transport) {
        // Create new transport for this session
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: (): string => crypto.randomUUID(),
          onsessioninitialized: (newTransportSessionId): void => {
            transports.set(newTransportSessionId, newTransport);

            // Create our session and map it
            void sessionManager.createSession().then((session) => {
              transportToSession.set(newTransportSessionId, session.sessionId);
              logger.info("Session created", {
                transportSessionId: newTransportSessionId,
                sessionId: session.sessionId,
              });
            });
          },
        });
        transport = newTransport;

        // Connect to MCP server
        void mcpServer.connect(newTransport);
      } else {
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

      void transport.handleRequest(req, res);
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

    httpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Start server
  httpServer.listen(port, () => {
    logger.info("Server started", { url: `http://localhost:${String(port)}/mcp` });
    console.log(`MCP Proxy Server running at http://localhost:${String(port)}/mcp`);
    console.log("\nAvailable tools:");
    console.log("  Server management: add_server, remove_server, list_servers");
    console.log("  Tools: list_tools, execute_tool");
    console.log("  Resources: list_resources, read_resource");
    console.log("  Prompts: list_prompts, get_prompt");
    console.log("  Notifications: get_notifications, get_logs");
    console.log("  Sampling: get_sampling_requests, respond_to_sampling");
    console.log("  Elicitation: get_elicitations, respond_to_elicitation");
    console.log("  Activity: await_activity");
    console.log("  Tasks: list_tasks, get_task, cancel_task");
  });
}

main();
