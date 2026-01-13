#!/usr/bin/env bun
/**
 * Test Echo MCP Server
 *
 * A minimal MCP server for testing stdio transport functionality.
 *
 * Tools:
 * - echo: Returns the input message back
 * - crash: Exits the process (for testing crash recovery)
 * - slow_echo: Returns after a delay (for testing timeouts)
 *
 * Resources:
 * - echo://messages: List of echoed messages
 *
 * Usage:
 *   bun run test/fixtures/echo-server.ts
 *   node test/fixtures/echo-server.js (after compilation)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Store echoed messages for resource access
const echoedMessages: Array<{ timestamp: string; message: string }> = [];

// Log to stderr (for testing stderr capture)
function logToStderr(message: string): void {
  console.error(`[echo-server] ${new Date().toISOString()} - ${message}`);
}

async function main(): Promise<void> {
  logToStderr("Starting echo server...");

  const server = new Server(
    {
      name: "echo-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logToStderr("Listing tools");
    return {
      tools: [
        {
          name: "echo",
          description: "Echo back the provided message",
          inputSchema: {
            type: "object",
            properties: {
              message: {
                type: "string",
                description: "The message to echo back",
              },
            },
            required: ["message"],
          },
        },
        {
          name: "crash",
          description: "Crash the server (for testing restart recovery)",
          inputSchema: {
            type: "object",
            properties: {
              exitCode: {
                type: "number",
                description: "Exit code to use (default: 1)",
              },
            },
          },
        },
        {
          name: "slow_echo",
          description: "Echo back after a delay",
          inputSchema: {
            type: "object",
            properties: {
              message: {
                type: "string",
                description: "The message to echo back",
              },
              delayMs: {
                type: "number",
                description: "Delay in milliseconds before responding",
              },
            },
            required: ["message"],
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logToStderr(`Tool called: ${name}`);

    switch (name) {
      case "echo": {
        const message = (args as { message: string }).message;
        echoedMessages.push({
          timestamp: new Date().toISOString(),
          message,
        });
        logToStderr(`Echoing: ${message}`);
        return {
          content: [
            {
              type: "text",
              text: `Echo: ${message}`,
            },
          ],
        };
      }

      case "crash": {
        const exitCode = (args as { exitCode?: number }).exitCode ?? 1;
        logToStderr(`Crashing with exit code ${exitCode}...`);
        // Give time for the log to be written
        setTimeout(() => {
          process.exit(exitCode);
        }, 100);
        return {
          content: [
            {
              type: "text",
              text: `Server will crash with exit code ${exitCode}`,
            },
          ],
        };
      }

      case "slow_echo": {
        const message = (args as { message: string; delayMs?: number }).message;
        const delayMs = (args as { delayMs?: number }).delayMs ?? 1000;
        logToStderr(`Slow echo: waiting ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        logToStderr(`Slow echo: responding with "${message}"`);
        return {
          content: [
            {
              type: "text",
              text: `Slow Echo (${delayMs}ms): ${message}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  // List available resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    logToStderr("Listing resources");
    return {
      resources: [
        {
          uri: "echo://messages",
          name: "Echoed Messages",
          description: "List of all messages that have been echoed",
          mimeType: "application/json",
        },
      ],
    };
  });

  // Read resources
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    logToStderr(`Reading resource: ${uri}`);

    if (uri === "echo://messages") {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(echoedMessages, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  logToStderr("Connecting via stdio transport...");
  await server.connect(transport);
  logToStderr("Echo server ready!");
}

main().catch((error) => {
  logToStderr(`Fatal error: ${error}`);
  process.exit(1);
});
