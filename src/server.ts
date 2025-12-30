#!/usr/bin/env node
/**
 * MCP Proxy Server
 *
 * An HTTP MCP server with static tools for managing and interacting with
 * multiple backend MCP servers dynamically.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "http";
import { z } from "zod";
import { ServerRegistry } from "./registry.js";
import type { ProxyConfig } from "./types.js";
import { readFileSync } from "fs";

// Parse CLI arguments
function parseArgs(): { configPath?: string; port: number } {
  const args = process.argv.slice(2);
  let configPath: string | undefined;
  let port = Number(process.env["PORT"]) || 8080;

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
    }
  }

  return { configPath, port };
}

// Load config file
function loadConfig(path: string): ProxyConfig {
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content) as ProxyConfig;
}

// Create and configure the MCP server
function createMcpServer(registry: ServerRegistry): McpServer {
  const server = new McpServer({
    name: "mcp-proxy",
    version: "0.1.0",
  });

  // Tool: add_server
  server.registerTool(
    "add_server",
    {
      description: "Connect to a backend MCP server",
      inputSchema: {
        name: z.string().describe("Unique name for this server"),
        url: z.string().url().describe("HTTP URL of the MCP server endpoint"),
      },
    },
    async ({ name, url }): Promise<{ content: { type: "text"; text: string }[] }> => {
      try {
        await registry.addServer({ name, url });
        return {
          content: [{ type: "text", text: `Connected to server '${name}' at ${url}` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to add server: ${message}` }],
        };
      }
    }
  );

  // Tool: remove_server
  server.registerTool(
    "remove_server",
    {
      description: "Disconnect from a backend MCP server",
      inputSchema: {
        name: z.string().describe("Name of the server to remove"),
      },
    },
    async ({ name }): Promise<{ content: { type: "text"; text: string }[] }> => {
      try {
        await registry.removeServer(name);
        return {
          content: [{ type: "text", text: `Disconnected from server '${name}'` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to remove server: ${message}` }],
        };
      }
    }
  );

  // Tool: list_servers
  server.registerTool(
    "list_servers",
    {
      description: "List all connected backend MCP servers with their status",
      inputSchema: {},
    },
    (): { content: { type: "text"; text: string }[] } => {
      const servers = registry.listServers();
      if (servers.length === 0) {
        return {
          content: [{ type: "text", text: "No servers connected" }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(servers, null, 2) }],
      };
    }
  );

  // Tool: list_tools
  server.registerTool(
    "list_tools",
    {
      description: "List tools available from backend servers",
      inputSchema: {
        server: z.string().default(".*").describe("Regex pattern to match server names (default: .*)"),
        tool: z.string().default(".*").describe("Regex pattern to match tool names (default: .*)"),
      },
    },
    async ({ server: serverPattern, tool: toolPattern }): Promise<{ content: { type: "text"; text: string }[] }> => {
      try {
        const serverRegex = new RegExp(serverPattern);
        const toolRegex = new RegExp(toolPattern);

        // Get tools from all servers, then filter
        const allTools = await registry.listTools();
        const filtered = allTools.filter((t) =>
          serverRegex.test(t.server) && toolRegex.test(t.name)
        );

        if (filtered.length === 0) {
          return {
            content: [{ type: "text", text: "No tools available" }],
          };
        }
        // Format tools with full schema for usability
        const formatted = filtered.map((t) => ({
          server: t.server,
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to list tools: ${message}` }],
        };
      }
    }
  );

  // Tool: execute_tool
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
      try {
        const result = await registry.executeTool(serverName, tool, args ?? {});
        // Pass through the result content directly, preserving image/audio/text types
        return {
          content: result.content,
          isError: result.isError,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to execute tool: ${message}` }],
        };
      }
    }
  );

  // Tool: get_notifications
  server.registerTool(
    "get_notifications",
    {
      description: "Get and clear buffered notifications from backend servers",
      inputSchema: {},
    },
    (): { content: { type: "text"; text: string }[] } => {
      const notifications = registry.getNotifications();
      if (notifications.length === 0) {
        return {
          content: [{ type: "text", text: "No notifications" }],
        };
      }
      const formatted = notifications.map((n) => ({
        server: n.server,
        method: n.method,
        timestamp: n.timestamp.toISOString(),
        params: n.params,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
      };
    }
  );

  // Tool: get_logs
  server.registerTool(
    "get_logs",
    {
      description: "Get and clear buffered log messages from backend servers",
      inputSchema: {},
    },
    (): { content: { type: "text"; text: string }[] } => {
      const logs = registry.getLogs();
      if (logs.length === 0) {
        return {
          content: [{ type: "text", text: "No log messages" }],
        };
      }
      const formatted = logs.map((l) => ({
        server: l.server,
        level: l.level,
        logger: l.logger,
        timestamp: l.timestamp.toISOString(),
        data: l.data,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
      };
    }
  );

  // Tool: get_sampling_requests
  server.registerTool(
    "get_sampling_requests",
    {
      description: "Get pending sampling requests from backend servers that need LLM responses. These are requests from MCP servers asking for LLM completions.",
      inputSchema: {},
    },
    (): { content: { type: "text"; text: string }[] } => {
      const requests = registry.getPendingSamplingRequests();
      if (requests.length === 0) {
        return {
          content: [{ type: "text", text: "No pending sampling requests" }],
        };
      }
      const formatted = requests.map((r) => ({
        id: r.id,
        server: r.server,
        timestamp: r.timestamp.toISOString(),
        maxTokens: r.params.maxTokens,
        systemPrompt: r.params.systemPrompt,
        temperature: r.params.temperature,
        messages: r.params.messages,
        modelPreferences: r.params.modelPreferences,
        tools: r.params.tools?.map((t) => ({ name: t.name, description: t.description })),
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
      };
    }
  );

  // Tool: respond_to_sampling
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
    ({ request_id, role, content, model, stop_reason }): { content: { type: "text"; text: string }[] } => {
      try {
        registry.respondToSamplingRequest(request_id, {
          role,
          content: { type: "text", text: content },
          model,
          stopReason: stop_reason,
        });
        return {
          content: [{ type: "text", text: `Responded to sampling request '${request_id}'` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to respond: ${message}` }],
        };
      }
    }
  );

  // Tool: get_elicitations
  server.registerTool(
    "get_elicitations",
    {
      description: "Get pending elicitation requests from backend servers that need user input. These are requests from MCP servers asking for form data or user confirmation.",
      inputSchema: {},
    },
    (): { content: { type: "text"; text: string }[] } => {
      const requests = registry.getPendingElicitationRequests();
      if (requests.length === 0) {
        return {
          content: [{ type: "text", text: "No pending elicitation requests" }],
        };
      }
      const formatted = requests.map((r) => ({
        id: r.id,
        server: r.server,
        timestamp: r.timestamp.toISOString(),
        mode: "mode" in r.params ? r.params.mode : "form",
        message: r.params.message,
        requestedSchema: "requestedSchema" in r.params ? r.params.requestedSchema : undefined,
        elicitationId: "elicitationId" in r.params ? r.params.elicitationId : undefined,
        url: "url" in r.params ? r.params.url : undefined,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
      };
    }
  );

  // Tool: respond_to_elicitation
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
    ({ request_id, action, content }): { content: { type: "text"; text: string }[] } => {
      try {
        registry.respondToElicitationRequest(request_id, {
          action,
          content,
        });
        return {
          content: [{ type: "text", text: `Responded to elicitation request '${request_id}' with action '${action}'` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to respond: ${message}` }],
        };
      }
    }
  );

  // Tool: list_resources
  server.registerTool(
    "list_resources",
    {
      description: "List resources available from backend servers",
      inputSchema: {
        server: z.string().optional().describe("Server name to filter by (omit for all servers)"),
      },
    },
    async ({ server: serverName }): Promise<{ content: { type: "text"; text: string }[] }> => {
      try {
        const resources = await registry.listResources(serverName);
        if (resources.length === 0) {
          return {
            content: [{ type: "text", text: "No resources available" }],
          };
        }
        const formatted = resources.map((r) => ({
          server: r.server,
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to list resources: ${message}` }],
        };
      }
    }
  );

  // Tool: read_resource
  server.registerTool(
    "read_resource",
    {
      description: "Read a specific resource from a backend server",
      inputSchema: {
        server: z.string().describe("Name of the backend server"),
        uri: z.string().describe("URI of the resource to read"),
      },
    },
    async ({ server: serverName, uri }): Promise<{ content: { type: "text"; text: string }[] }> => {
      try {
        const result = await registry.readResource(serverName, uri);
        // Format the contents for output
        const contents = result.contents.map((c) => {
          if ("text" in c && typeof c.text === "string") {
            return { uri: c.uri, mimeType: c.mimeType, text: c.text };
          } else if ("blob" in c && typeof c.blob === "string") {
            return { uri: c.uri, mimeType: c.mimeType, blob: `[base64 data, ${String(c.blob.length)} chars]` };
          }
          return c;
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ contents }, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to read resource: ${message}` }],
        };
      }
    }
  );

  // Tool: list_prompts
  server.registerTool(
    "list_prompts",
    {
      description: "List prompts available from backend servers",
      inputSchema: {
        server: z.string().optional().describe("Server name to filter by (omit for all servers)"),
      },
    },
    async ({ server: serverName }): Promise<{ content: { type: "text"; text: string }[] }> => {
      try {
        const prompts = await registry.listPrompts(serverName);
        if (prompts.length === 0) {
          return {
            content: [{ type: "text", text: "No prompts available" }],
          };
        }
        const formatted = prompts.map((p) => ({
          server: p.server,
          name: p.name,
          description: p.description,
          arguments: p.arguments,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to list prompts: ${message}` }],
        };
      }
    }
  );

  // Tool: get_prompt
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
    async ({ server: serverName, name, arguments: args }): Promise<{ content: { type: "text"; text: string }[] }> => {
      try {
        const result = await registry.getPrompt(serverName, name, args ?? {});
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to get prompt: ${message}` }],
        };
      }
    }
  );

  return server;
}

// Main entry point
async function main(): Promise<void> {
  const { configPath, port } = parseArgs();
  const registry = new ServerRegistry({
    onServerStatusChange: (name, info): void => {
      console.log(`[${name}] Status: ${info.status}${info.error ? ` - ${info.error}` : ""}`);
    },
  });

  // Load initial servers from config if provided
  if (configPath) {
    try {
      const config = loadConfig(configPath);
      console.log(`Loading ${String(config.servers.length)} server(s) from ${configPath}`);
      for (const server of config.servers) {
        console.log(`  Adding ${server.name} at ${server.url}`);
        await registry.addServer(server);
      }
    } catch (err) {
      console.error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  // Create the MCP server
  const mcpServer = createMcpServer(registry);

  // Track transports for cleanup
  const transports = new Map<string, StreamableHTTPServerTransport>();

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

    // Get or create session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      // Handle new or existing session
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        // Create new transport for this session
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: (): string => crypto.randomUUID(),
          onsessioninitialized: (newSessionId): void => {
            transports.set(newSessionId, newTransport);
            console.log(`Session initialized: ${newSessionId}`);
          },
        });
        transport = newTransport;

        // Connect to MCP server
        void mcpServer.connect(newTransport);
      }

      // Handle the request
      void transport.handleRequest(req, res);
    } else if (req.method === "GET") {
      // SSE connection for existing session
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing mcp-session-id header" }));
        return;
      }

      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      void transport.handleRequest(req, res);
    } else if (req.method === "DELETE") {
      // Session cleanup
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId);
        void transport?.close();
        transports.delete(sessionId);
        console.log(`Session closed: ${sessionId}`);
      }
      res.writeHead(200);
      res.end();
    } else {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
    }
  });

  // Handle shutdown
  const shutdown = (): void => {
    console.log("\nShutting down...");
    void registry.shutdown();
    for (const transport of transports.values()) {
      void transport.close();
    }
    httpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start server
  httpServer.listen(port, () => {
    console.log(`MCP Proxy Server running at http://localhost:${String(port)}/mcp`);
    console.log("Available tools:");
    console.log("  Server management: add_server, remove_server, list_servers");
    console.log("  Tools: list_tools, execute_tool");
    console.log("  Resources: list_resources, read_resource");
    console.log("  Prompts: list_prompts, get_prompt");
    console.log("  Notifications: get_notifications, get_logs");
    console.log("  Sampling: get_sampling_requests, respond_to_sampling");
    console.log("  Elicitation: get_elicitations, respond_to_elicitation");
  });
}

void main();
