# emceepee

**Connect to any MCP server, anytime. Access the full MCP protocol through tools.**

[![npm version](https://img.shields.io/npm/v/emceepee.svg)](https://www.npmjs.com/package/emceepee)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

```bash
npx emceepee
```

## Why?

**Problem 1: Static connections.** Most MCP clients only connect to servers at startup. Want to connect to a new server mid-session? Restart everything.

**Problem 2: Incomplete protocol support.** MCP has rich features—resources, prompts, notifications, sampling, elicitations—but many clients only implement tools. Those features? Inaccessible.

**emceepee solves both.** It's a proxy that exposes the entire MCP protocol as tools. Any client that supports tool calling can now:

- Connect to new MCP servers dynamically (HTTP or stdio)
- Spawn and manage MCP server processes with automatic crash recovery
- Access resources and resource templates
- Use prompts
- Receive notifications and logs (with source filtering)
- Handle sampling requests (bidirectional LLM calls)
- Handle elicitations (user input requests)

## Quick Start

### 1. Add to your MCP client

**Claude Code / Claude Desktop** (`.mcp.json`):
```json
{
  "mcpServers": {
    "emceepee": {
      "command": "npx",
      "args": ["emceepee"]
    }
  }
}
```

**Other clients** — point to the HTTP server:
```bash
npx emceepee-http  # runs on http://localhost:8080/mcp
```

### 2. Connect to servers mid-session

Ask your LLM:

> "Connect to http://localhost:3001/mcp and show me what it can do"

The LLM will use emceepee's tools to connect, explore, and interact with the server.

---

## How It Works

```
┌────────────┐     ┌───────────┐     ┌──────────────┐
│ MCP Client │────▶│ emceepee  │────▶│ MCP Server 1 │
│            │     │           │     └──────────────┘
│ (tools     │◀────│  (proxy)  │────▶┌──────────────┐
│   only)    │     │           │     │ MCP Server 2 │
└────────────┘     └───────────┘     └──────────────┘
```

emceepee exposes a **static set of tools** that never change. These tools provide access to the full MCP protocol, letting any tool-capable client use features it doesn't natively support.

## Server Transports

emceepee supports two transport types for connecting to backend MCP servers:

### HTTP/SSE Transport
Connect to remote MCP servers over HTTP with Server-Sent Events:
```
add_server(name: "myserver", url: "http://localhost:3001/mcp")
```

### Stdio Transport (Process Management)
Spawn and manage MCP servers as child processes communicating via stdin/stdout:
```
add_server(name: "myserver", command: "node", args: ["server.js"])
```

**Stdio features:**
- **Automatic crash recovery** with exponential backoff restart
- **Stderr capture** for debugging (exposed via `get_logs` with `source: "stderr"`)
- **Lifecycle events** for monitoring process state
- **Configurable restart behavior** (max attempts, delays, backoff multiplier)

### Process Lifecycle Events

When using stdio transport, emceepee tracks the full process lifecycle:

| Event | Description |
|-------|-------------|
| `process_started` | Process spawned successfully |
| `process_crashed` | Process exited unexpectedly |
| `restarting` | Attempting to restart (with attempt count) |
| `restarted` | Successfully restarted after crash |
| `restart_failed` | Max restart attempts exceeded |
| `process_stopped` | Process stopped cleanly |

### Restart Configuration

Customize crash recovery behavior per server:

```json
{
  "restartConfig": {
    "enabled": true,
    "maxAttempts": 5,
    "baseDelayMs": 1000,
    "maxDelayMs": 60000,
    "backoffMultiplier": 2
  }
}
```

## Tools

### Server Management
| Tool | Description |
|------|-------------|
| `add_server` | Connect to a backend MCP server |
| `remove_server` | Disconnect from a server |
| `list_servers` | List connected servers with status |

### Tools
| Tool | Description |
|------|-------------|
| `list_tools` | List tools from connected servers (with regex filtering) |
| `execute_tool` | Run a tool on a backend server |

### Resources
| Tool | Description |
|------|-------------|
| `list_resources` | List available resources |
| `list_resource_templates` | List resource templates |
| `read_resource` | Fetch a resource by URI |
| `subscribe_resource` | Subscribe to resource change notifications |
| `unsubscribe_resource` | Unsubscribe from resource change notifications |

### Prompts
| Tool | Description |
|------|-------------|
| `list_prompts` | List available prompts |
| `get_prompt` | Get a prompt with arguments |

### Notifications & Logs
| Tool | Description |
|------|-------------|
| `get_notifications` | Get buffered server notifications |
| `get_logs` | Get buffered log messages with source filtering |

The `get_logs` tool supports filtering by log source:
- `protocol`: MCP protocol messages and notifications
- `stderr`: Process stderr output (for stdio servers)
- `stdout`: Process stdout capture (for local HTTP servers)

Example: Get only protocol logs by excluding stderr/stdout:
```json
{ "exclude_sources": ["stderr", "stdout"] }
```

### Sampling (bidirectional LLM requests)
| Tool | Description |
|------|-------------|
| `get_sampling_requests` | Get pending requests from servers wanting LLM completions |
| `respond_to_sampling` | Send an LLM response back to the server |

### Elicitations (user input requests)
| Tool | Description |
|------|-------------|
| `get_elicitations` | Get pending requests for user input |
| `respond_to_elicitation` | Send user input back to the server |

### Tasks & Activity
| Tool | Description |
|------|-------------|
| `list_tasks` | List background tasks |
| `get_task` | Get task status |
| `cancel_task` | Cancel a running task |
| `await_activity` | Wait for server events (polling) |

### Timers
| Tool | Description |
|------|-------------|
| `set_timer` | Create a timer that fires after a duration |
| `list_timers` | List all timers |
| `get_timer` | Get timer details |
| `delete_timer` | Delete a timer (returns timer body) |

### Codemode (Reduced-Context API)
| Tool | Description |
|------|-------------|
| `codemode_search` | Search for capabilities across all servers |
| `codemode_execute` | Execute JavaScript with access to `mcp.*` API |

## Codemode API

Codemode is a reduced-context API that exposes just **2 tools** instead of the full set. This dramatically reduces token usage when AI needs to perform complex multi-step MCP operations.

### Tools

**`codemode_search`** - Search for tools, resources, prompts, or servers using regex patterns:
```json
{
  "query": "file|read",
  "type": "tools",
  "server": "myserver",
  "includeSchemas": false
}
```

**`codemode_execute`** - Run JavaScript in a sandboxed environment:
```json
{
  "code": "const tools = await mcp.listTools(); return tools.length;",
  "timeout": 30000
}
```

### The mcp.* API

Inside `codemode_execute`, your code has access to:

```javascript
// Server discovery
await mcp.listServers()

// Tool operations
await mcp.listTools(serverPattern?)
await mcp.callTool(server, tool, args?)

// Resource operations
await mcp.listResources(serverPattern?)
await mcp.listResourceTemplates(serverPattern?)
await mcp.readResource(server, uri)

// Prompt operations
await mcp.listPrompts(serverPattern?)
await mcp.getPrompt(server, name, args?)

// Utilities
await mcp.sleep(ms)    // max 5 seconds per call
mcp.log(...args)       // captured in result.logs
```

### Example: Multi-Step Operation

```javascript
// Find all "search" tools and call the first one
const tools = await mcp.listTools();
const searchTools = tools.filter(t => t.name.includes('search'));

if (searchTools.length === 0) {
  return { error: 'No search tools found' };
}

const tool = searchTools[0];
mcp.log(`Calling ${tool.server}/${tool.name}`);

const result = await mcp.callTool(tool.server, tool.name, {
  query: 'example'
});

return {
  tool: tool.name,
  server: tool.server,
  result: result.content
};
```

### Security Features

- **Sandboxed execution** - Blocked globals: `process`, `require`, `eval`, `fetch`, `setTimeout`, `Function`, etc.
- **Timeout enforcement** - 1 second to 5 minutes (default 30s)
- **MCP call limits** - Maximum 100 `mcp.*` calls per execution
- **Code size limits** - Maximum 100KB of code

### Configuration

Codemode is enabled by default. To disable:

```typescript
// When using emceepee as a library
registerTools(server, sessionManager, sessions, requestTracker, {
  codemodeEnabled: false
});
```

## Context Info

Every tool response may include additional context information as a second JSON text block. This provides real-time status without requiring explicit polling:

```json
{
  "content": [
    { "type": "text", "text": "Tool result here" },
    { "type": "text", "text": "{\"pending_client\":{\"sampling\":1,\"elicitation\":0},\"expired_timers\":[{\"id\":\"...\",\"message\":\"Check status\",\"expiredAt\":\"...\"}],\"notifications\":[...]}" }
  ]
}
```

**Context info fields:**

| Field | Description |
|-------|-------------|
| `pending_client.sampling` | Number of pending sampling requests (urgent - servers are blocked) |
| `pending_client.elicitation` | Number of pending elicitation requests (urgent - servers are blocked) |
| `expired_timers` | Timers that have fired since the last tool call (cleared after delivery) |
| `notifications` | Buffered notifications from backend servers (cleared after delivery) |

Context info is only included when there's something to report.

## Installation

```bash
# Run directly
npx emceepee

# Or install globally
npm install -g emceepee
```

## Usage

### stdio transport (Claude Code, Claude Desktop)

```bash
npx emceepee
```

### HTTP transport (web clients, custom integrations)

```bash
# Default port 8080
npx emceepee-http

# Custom port
PORT=9000 npx emceepee-http

# With pre-configured servers
npx emceepee-http --config servers.json
```

### Configuration File

Pre-configure backend servers (HTTP and stdio):

```json
{
  "servers": [
    {
      "name": "remote-server",
      "url": "http://localhost:3001/mcp"
    },
    {
      "name": "local-server",
      "type": "stdio",
      "command": "node",
      "args": ["./my-mcp-server.js"],
      "env": { "DEBUG": "true" },
      "restartConfig": {
        "maxAttempts": 3,
        "baseDelayMs": 1000
      }
    }
  ]
}
```

## Example Session

```
User: Connect to http://localhost:3001/mcp as "gameserver"

LLM: [uses add_server]
Connected to gameserver successfully.

User: What can it do?

LLM: [uses list_tools, list_resources, list_prompts]
gameserver has:
- 3 tools: screenshot, send_chat, move
- 2 resources: player_state, world_info
- 1 prompt: describe_scene

User: Get the player state

LLM: [uses read_resource with uri="minecraft://state"]
Player is at position (100, 64, -200), health: 18/20
```

## Library Usage

emceepee can also be used as a library for building custom MCP integrations:

### MCPStdioClient

Spawn and manage MCP servers as child processes:

```typescript
import { MCPStdioClient } from "emceepee";

const client = new MCPStdioClient({
  name: "my-server",
  command: "node",
  args: ["server.js"],
  restartConfig: {
    maxAttempts: 5,
    baseDelayMs: 1000,
  },
  onLifecycleEvent: (event) => {
    console.log(`${event.event}: ${JSON.stringify(event)}`);
  },
  onLog: (log) => {
    if (log.source === "stderr") {
      console.error(`[stderr] ${log.data}`);
    }
  },
});

await client.connect();

// Use the client
const tools = await client.listTools();
const result = await client.callTool("my-tool", { arg: "value" });

// Clean shutdown
await client.disconnect();
```

### IMCPClient Interface

Both HTTP and stdio clients implement the common `IMCPClient` interface:

```typescript
import { IMCPClient, isStdioClient, isHttpClient } from "emceepee";

function handleClient(client: IMCPClient) {
  if (isStdioClient(client)) {
    // Stdio-specific operations (e.g., access stderr buffer)
  } else if (isHttpClient(client)) {
    // HTTP-specific operations
  }

  // Common operations work on both
  const tools = await client.listTools();
  const info = client.getInfo();
}
```

## Development

```bash
bun install              # Install dependencies
bun run dev              # stdio server (development)
bun run dev:http         # HTTP server (development)
bun run check            # TypeScript + ESLint
bun run test             # Run tests
bun run build            # Production build
```

### Testing

```bash
bun run test             # Run all tests
bun run test:stdio       # Run stdio client tests
bun run test:codemode    # Run codemode tests
```

Tests cover:
- **Stdio client**: Connection lifecycle, tool invocation, stderr capture, crash recovery, lifecycle events
- **Codemode**: Sandbox isolation, timeout enforcement, API bindings, search/execute functionality, error handling

## License

MIT © Andrew Jefferson
