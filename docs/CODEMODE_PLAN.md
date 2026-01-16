# Codemode API Implementation Plan

## 1. Overview

### What is Codemode?

Codemode is a pattern that exposes just **two tools** (`search` and `execute`) that let an AI write JavaScript code to discover and call underlying MCP operations. Instead of exposing 29+ individual tools for every MCP operation, codemode provides a programmatic interface that dramatically reduces context usage.

### Why Add Codemode to emceepee?

emceepee currently exposes 29 tools to provide full MCP protocol access. While comprehensive, this creates challenges:

1. **Context bloat**: Tool schemas consume significant context window space
2. **Repetitive patterns**: Many operations follow similar patterns (list → filter → call)
3. **Multi-step workflows**: Complex operations require multiple tool calls with context overhead

Codemode addresses these by allowing the AI to:
- Write efficient JavaScript that performs multiple operations in one execution
- Use programmatic patterns (loops, conditionals, aggregation) unavailable with individual tools
- Reduce round-trips between AI and MCP server

### Example: Before and After

**Before (5 tool calls):**
```
1. list_servers() → ["server1", "server2", "server3"]
2. list_tools(server="server1") → [tools...]
3. list_tools(server="server2") → [tools...]
4. list_tools(server="server3") → [tools...]
5. execute_tool(server="server2", tool="target_tool", args={...})
```

**After (1 codemode_execute call):**
```javascript
const servers = await mcp.listServers();
for (const s of servers) {
  const tools = await mcp.listTools(s.name);
  const target = tools.find(t => t.name === "target_tool");
  if (target) {
    return await mcp.callTool(s.name, "target_tool", { ... });
  }
}
```

---

## 2. Design Goals

### Primary Goals

1. **Context Reduction**
   - Replace 29 tool schemas with 2 compact schemas
   - Estimated 80-90% reduction in tool schema context usage
   - Single execution can replace multiple tool call round-trips

2. **Security via Isolation**
   - Execute user code in sandboxed environment
   - Strict timeout enforcement
   - Memory limits to prevent resource exhaustion
   - No access to Node.js APIs, filesystem, or network (except via mcp.* API)

3. **Full MCP Protocol Support**
   - All MCP operations available via `mcp.*` API
   - Tools, resources, prompts, notifications
   - Server management (list, but not add/remove for security)

### Secondary Goals

4. **Debugging Support**
   - Capture console.log output from user code
   - Detailed error messages with stack traces
   - Execution timing information

5. **Backward Compatibility**
   - Existing 29 tools remain available
   - Codemode is an additional option, not a replacement
   - Can be disabled via configuration

6. **Minimal Dependencies**
   - Prefer Node.js built-in `vm` module initially
   - Optional upgrade path to `isolated-vm` for enhanced security

---

## 3. Architecture

### How Codemode Fits into emceepee

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           MCP Client (LLM)                               │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
          ┌──────────────────────┴──────────────────────┐
          │                                             │
          ▼                                             ▼
┌─────────────────────┐                    ┌─────────────────────────────┐
│   Existing Tools    │                    │      Codemode Tools         │
│   (29 tools)        │                    │  ┌─────────────────────┐   │
│                     │                    │  │  codemode_search    │   │
│  • add_server       │                    │  │  codemode_execute   │   │
│  • list_tools       │                    │  └──────────┬──────────┘   │
│  • execute_tool     │                    │             │              │
│  • read_resource    │                    │             ▼              │
│  • get_prompt       │                    │  ┌─────────────────────┐   │
│  • await_activity   │                    │  │   Sandbox (vm)      │   │
│  • ...              │                    │  │                     │   │
│                     │                    │  │  User JavaScript    │   │
└─────────┬───────────┘                    │  │  code executes      │   │
          │                                │  │  here with mcp.*    │   │
          │                                │  │  API access         │   │
          │                                │  └──────────┬──────────┘   │
          │                                │             │              │
          │                                │             ▼              │
          │                                │  ┌─────────────────────┐   │
          │                                │  │   API Bindings      │   │
          │                                │  │                     │   │
          │                                │  │  mcp.listServers()  │   │
          │                                │  │  mcp.listTools()    │   │
          │                                │  │  mcp.callTool()     │   │
          │                                │  │  mcp.readResource() │   │
          │                                │  │  ...                │   │
          │                                │  └──────────┬──────────┘   │
          │                                └─────────────┼──────────────┘
          │                                              │
          └──────────────────────┬───────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │     SessionState        │
                    │                         │
                    │  • backendConnections   │
                    │  • eventSystem          │
                    │  • taskManager          │
                    │  • pendingRequests      │
                    │  • bufferManager        │
                    │  • timerManager         │
                    └────────────┬────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
          ▼                      ▼                      ▼
   ┌────────────┐         ┌────────────┐         ┌────────────┐
   │  Backend   │         │  Backend   │         │  Backend   │
   │  Server 1  │         │  Server 2  │         │  Server 3  │
   │  (HTTP)    │         │  (stdio)   │         │  (HTTP)    │
   └────────────┘         └────────────┘         └────────────┘
```

### File Structure

```
src/
├── server.ts                    # Registers codemode tools
├── codemode/
│   ├── index.ts                 # Module exports
│   ├── types.ts                 # Codemode-specific types
│   ├── sandbox.ts               # VM sandbox management
│   ├── api-bindings.ts          # mcp.* API implementation
│   ├── search.ts                # codemode_search implementation
│   └── execute.ts               # codemode_execute implementation
└── session/
    └── session-state.ts         # (unchanged, reused)
```

---

## 4. API Surface

### Tool: `codemode_search`

Search for MCP capabilities across connected servers. Returns compact schema information.

**Input Schema:**
```typescript
{
  query: z.string().describe(
    "Search query - matches against names and descriptions. Supports regex."
  ),
  type: z.enum(["tools", "resources", "prompts", "servers", "all"])
    .default("all")
    .describe("Type of capability to search for"),
  server: z.string().optional().describe(
    "Filter by server name (regex pattern)"
  ),
  includeSchemas: z.boolean().default(false).describe(
    "Include full input schemas in results (increases response size)"
  ),
}
```

**Output Format:**
```typescript
{
  tools: [
    {
      server: "server1",
      name: "tool_name",
      description: "...",
      // inputSchema only if includeSchemas=true
    }
  ],
  resources: [
    {
      server: "server1",
      uri: "resource://...",
      name: "resource_name",
      mimeType: "application/json",
    }
  ],
  prompts: [
    {
      server: "server1",
      name: "prompt_name",
      description: "...",
      arguments: [{ name: "arg1", required: true }],
    }
  ],
  servers: [
    {
      name: "server1",
      status: "connected",
      capabilities: { tools: true, resources: true, prompts: false },
    }
  ],
}
```

### Tool: `codemode_execute`

Execute JavaScript code with access to MCP operations via the `mcp.*` API.

**Input Schema:**
```typescript
{
  code: z.string().describe(
    "JavaScript code to execute. Has access to 'mcp' object for MCP operations. " +
    "Must return a value or call mcp.* methods. Async/await is supported."
  ),
  timeout: z.number().min(1000).max(300000).default(30000).describe(
    "Execution timeout in milliseconds (1s - 5min, default 30s)"
  ),
}
```

**Output Format:**
```typescript
{
  success: boolean,
  result: unknown,           // Return value from code (JSON-serializable)
  error?: {
    name: string,            // Error name (e.g., "TypeError")
    message: string,         // Error message
    stack?: string,          // Stack trace (if available)
  },
  logs: string[],            // Captured console.log output
  stats: {
    durationMs: number,      // Execution time
    mcpCalls: number,        // Number of mcp.* calls made
  },
}
```

---

## 5. Sandbox API

The `mcp` object available in user code provides these methods:

### Server Discovery

```typescript
mcp.listServers(): Promise<ServerInfo[]>
```
Returns all configured servers with connection status.

```typescript
interface ServerInfo {
  name: string;
  status: "connected" | "disconnected" | "reconnecting" | "error";
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
}
```

### Tool Operations

```typescript
mcp.listTools(serverPattern?: string): Promise<ToolInfo[]>
```
List tools from servers matching pattern (regex). Omit pattern for all servers.

```typescript
mcp.callTool(server: string, tool: string, args?: object): Promise<ToolResult>
```
Call a tool on a specific server.

```typescript
interface ToolInfo {
  server: string;
  name: string;
  description?: string;
  inputSchema: object;
}

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}
```

### Resource Operations

```typescript
mcp.listResources(serverPattern?: string): Promise<ResourceInfo[]>
```
List resources from servers matching pattern.

```typescript
mcp.readResource(server: string, uri: string): Promise<ResourceContent>
```
Read a resource by URI.

```typescript
mcp.listResourceTemplates(serverPattern?: string): Promise<ResourceTemplateInfo[]>
```
List resource templates.

```typescript
interface ResourceInfo {
  server: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface ResourceContent {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }>;
}
```

### Prompt Operations

```typescript
mcp.listPrompts(serverPattern?: string): Promise<PromptInfo[]>
```
List prompts from servers matching pattern.

```typescript
mcp.getPrompt(server: string, name: string, args?: object): Promise<PromptResult>
```
Get a prompt with arguments.

```typescript
interface PromptInfo {
  server: string;
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}
```

### Utility Functions

```typescript
mcp.sleep(ms: number): Promise<void>
```
Sleep for specified milliseconds (capped at 5000ms per call).

```typescript
mcp.log(...args: unknown[]): void
```
Log values (captured in response.logs). Alias for console.log.

### NOT Exposed (Security)

The following operations are intentionally NOT exposed in codemode:

- `add_server` / `remove_server` - Server management could be abused
- `reconnect_server` - Could disrupt connections
- `subscribe_resource` / `unsubscribe_resource` - Side effects beyond request
- `respond_to_sampling` / `respond_to_elicitation` - Requires human judgment
- `set_timer` / `delete_timer` - Persistent side effects
- Direct access to `SessionState` or `SessionManager`

---

## 6. Isolation Strategy

### Option A: Node.js `vm` Module (Recommended for Initial Implementation)

**Pros:**
- Built into Node.js, no additional dependencies
- Supports async/await with proper wrapping
- Sufficient isolation for most use cases
- Simpler implementation

**Cons:**
- Same V8 isolate as host process
- Memory limits require external enforcement
- Determined attacker could potentially escape (unlikely in our use case)

**Implementation:**
```typescript
import { createContext, runInContext } from 'vm';

async function executeSandbox(code: string, api: SandboxAPI): Promise<Result> {
  const context = createContext({
    mcp: api,
    console: { log: (...args) => logs.push(format(args)) },
    setTimeout: undefined,  // Blocked
    setInterval: undefined, // Blocked
    fetch: undefined,       // Blocked
    require: undefined,     // Blocked
    process: undefined,     // Blocked
  });

  // Wrap user code in async IIFE
  const wrappedCode = `(async () => { ${code} })()`;

  // Execute with timeout
  const result = await Promise.race([
    runInContext(wrappedCode, context),
    timeout(timeoutMs),
  ]);

  return result;
}
```

### Option B: `isolated-vm` (Future Enhancement)

**Pros:**
- Separate V8 isolate with true memory isolation
- CPU time limits enforced at V8 level
- Better security guarantees
- Used by Cloudflare Workers

**Cons:**
- Native dependency (compilation required)
- More complex async handling
- ~2MB additional install size

**When to upgrade:**
- If emceepee is deployed in multi-tenant environments
- If security audit requires stronger isolation
- If memory/CPU limits need strict enforcement

### Timeout Enforcement

Both options use the same timeout pattern:

```typescript
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}
```

---

## 7. Implementation Plan

### Phase 1: Core Infrastructure

- [ ] **1.1** Create `src/codemode/` directory structure
- [ ] **1.2** Define types in `src/codemode/types.ts`
  - `SandboxConfig`, `SandboxResult`, `SandboxAPI`
  - `SearchQuery`, `SearchResult`
  - `ExecuteRequest`, `ExecuteResult`
- [ ] **1.3** Implement `src/codemode/sandbox.ts`
  - `createSandboxContext()` - Build VM context with blocked globals
  - `executeSandbox()` - Run code with timeout
  - Console capture and log formatting

### Phase 2: API Bindings

- [ ] **2.1** Implement `src/codemode/api-bindings.ts`
  - `createSandboxAPI(session, sessionManager)` - Factory function
  - Server operations: `listServers()`
  - Tool operations: `listTools()`, `callTool()`
  - Resource operations: `listResources()`, `readResource()`, `listResourceTemplates()`
  - Prompt operations: `listPrompts()`, `getPrompt()`
  - Utilities: `sleep()`, `log()`
- [ ] **2.2** Add MCP call tracking for stats

### Phase 3: Tool Implementations

- [ ] **3.1** Implement `src/codemode/search.ts`
  - Query parsing (regex support)
  - Multi-server aggregation
  - Result filtering and formatting
- [ ] **3.2** Implement `src/codemode/execute.ts`
  - Code wrapping (async IIFE)
  - Result serialization
  - Error handling with stack traces
- [ ] **3.3** Create `src/codemode/index.ts` with exports

### Phase 4: Integration

- [ ] **4.1** Add `registerCodemodeTools()` function
- [ ] **4.2** Integrate into `server.ts` (HTTP server)
- [ ] **4.3** Integrate into `server-stdio.ts` (stdio server)
- [ ] **4.4** Add `codemodeEnabled` configuration option

### Phase 5: Testing & Documentation

- [ ] **5.1** Create `test/codemode.test.ts`
  - Sandbox isolation tests
  - API binding tests
  - Timeout enforcement tests
  - Error handling tests
- [ ] **5.2** Update README.md with codemode documentation
- [ ] **5.3** Add examples to docs/

### Phase 6: Polish

- [ ] **6.1** Add request tracking integration (waterfall UI)
- [ ] **6.2** Add structured logging for codemode executions
- [ ] **6.3** Performance optimization (context reuse if safe)

---

## 8. Security Considerations

### Sandbox Hardening

1. **Blocked Globals**
   ```typescript
   const BLOCKED = [
     'process', 'require', 'module', 'exports', '__dirname', '__filename',
     'fetch', 'XMLHttpRequest', 'WebSocket',
     'setTimeout', 'setInterval', 'setImmediate',
     'Buffer', 'ArrayBuffer', 'SharedArrayBuffer',
     'Atomics', 'WebAssembly',
     'eval', 'Function',  // Prevent dynamic code execution
   ];
   ```

2. **Timeout Enforcement**
   - Default: 30 seconds
   - Maximum: 5 minutes
   - Hard kill if code doesn't yield

3. **Memory Limits** (Phase 2 - with isolated-vm)
   - Default: 128MB per execution
   - Configurable per deployment

4. **API Rate Limiting**
   - Max mcp.* calls per execution: 100 (configurable)
   - Prevents runaway loops

### Audit Logging

Every codemode execution should log:
```typescript
{
  sessionId: string,
  timestamp: Date,
  codeHash: string,      // SHA256 of executed code
  codeLength: number,
  timeoutMs: number,
  success: boolean,
  durationMs: number,
  mcpCallCount: number,
  errorType?: string,
}
```

### Input Validation

- Code must be valid JavaScript (syntax check before execution)
- Code length limit: 100KB
- No binary/encoded payloads

### Denial of Service Prevention

1. **CPU**: Timeout enforcement
2. **Memory**: Context isolation (full protection requires isolated-vm)
3. **Network**: No network APIs exposed
4. **Disk**: No filesystem APIs exposed
5. **Recursion**: Stack size limits via V8

---

## 9. Future Enhancements

### Short-term (Post-MVP)

1. **Code Templates**
   - Pre-built code snippets for common operations
   - `mcp.templates.listAllTools()`, `mcp.templates.findToolByName()`

2. **Result Caching**
   - Cache `listTools()`, `listResources()` results within execution
   - Reduce redundant backend calls

3. **Execution History**
   - Store last N executions per session
   - Allow re-running previous code

### Medium-term

4. **isolated-vm Migration**
   - Stronger security guarantees
   - True memory isolation
   - CPU time limits

5. **TypeScript Support**
   - Accept TypeScript code
   - Transpile on-the-fly
   - Better IDE support for users

6. **Streaming Results**
   - For long-running operations
   - Progressive output via SSE

### Long-term

7. **Persistent Scripts**
   - Save and name scripts
   - Run by name instead of inline code
   - Version control for scripts

8. **Webhooks/Triggers**
   - Run code on server events
   - Notification handlers
   - Scheduled execution

9. **Multi-language Support**
   - Python via pyodide
   - Other WASM-based runtimes

---

## Appendix: Example Usage

### Example 1: Find and call a tool across all servers

```javascript
// Find a tool named "get_weather" on any server and call it
const servers = await mcp.listServers();
for (const server of servers.filter(s => s.status === "connected")) {
  const tools = await mcp.listTools(server.name);
  const weatherTool = tools.find(t => t.name === "get_weather");
  if (weatherTool) {
    return await mcp.callTool(server.name, "get_weather", { city: "London" });
  }
}
return { error: "get_weather tool not found on any server" };
```

### Example 2: Aggregate data from multiple resources

```javascript
// Read config from all servers and merge
const configs = {};
const resources = await mcp.listResources();
for (const r of resources.filter(r => r.uri.endsWith("/config.json"))) {
  const content = await mcp.readResource(r.server, r.uri);
  configs[r.server] = JSON.parse(content.contents[0].text);
}
return configs;
```

### Example 3: Execute tools in sequence with error handling

```javascript
// Run a pipeline of tools
const results = [];
try {
  results.push(await mcp.callTool("db", "query", { sql: "SELECT * FROM users LIMIT 5" }));
  results.push(await mcp.callTool("transform", "format", { data: results[0], format: "csv" }));
  results.push(await mcp.callTool("storage", "upload", { content: results[1], path: "/exports/users.csv" }));
  return { success: true, path: "/exports/users.csv" };
} catch (e) {
  return { success: false, error: e.message, completedSteps: results.length };
}
```
