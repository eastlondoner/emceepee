/**
 * Codemode Tests
 *
 * Tests for the codemode module which provides a sandboxed JavaScript
 * execution environment with access to MCP server operations.
 *
 * Run with: bun test test/codemode.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  createSandboxContext,
  executeSandbox,
  createSandboxAPI,
  search,
  execute,
  validateCode,
  validateTimeout,
  validateExecuteRequest,
  isSuccess,
  isTimeout,
  isCallLimitExceeded,
  EXECUTE_LIMITS,
} from "../src/codemode/index.js";
import type {
  SandboxAPI,
  SandboxServerInfo,
  SandboxToolInfo,
  SandboxToolResult,
  SandboxResourceInfo,
  SandboxResourceTemplateInfo,
  SandboxResourceContent,
  SandboxPromptInfo,
  SandboxPromptResult,
  ExecutionContext,
} from "../src/codemode/index.js";

// =============================================================================
// Mock API for Testing
// =============================================================================

/**
 * Create a mock SandboxAPI for testing sandbox execution
 */
function createMockAPI(overrides: Partial<SandboxAPI> = {}): SandboxAPI {
  return {
    listServers: async (): Promise<SandboxServerInfo[]> => [
      {
        name: "test-server",
        status: "connected",
        capabilities: { tools: true, resources: true, prompts: true },
      },
    ],
    listTools: async (): Promise<SandboxToolInfo[]> => [
      {
        server: "test-server",
        name: "echo",
        description: "Echo back the input",
        inputSchema: { type: "object", properties: { message: { type: "string" } } },
      },
    ],
    callTool: async (_server: string, _tool: string, args?: Record<string, unknown>): Promise<SandboxToolResult> => ({
      content: [{ type: "text", text: `Echo: ${args?.message ?? ""}` }],
      isError: false,
    }),
    listResources: async (): Promise<SandboxResourceInfo[]> => [
      {
        server: "test-server",
        uri: "file:///test.txt",
        name: "test.txt",
        description: "A test file",
        mimeType: "text/plain",
      },
    ],
    listResourceTemplates: async (): Promise<SandboxResourceTemplateInfo[]> => [],
    readResource: async (_server: string, uri: string): Promise<SandboxResourceContent> => ({
      contents: [{ uri, mimeType: "text/plain", text: "Test content" }],
    }),
    listPrompts: async (): Promise<SandboxPromptInfo[]> => [],
    getPrompt: async (): Promise<SandboxPromptResult> => ({
      description: "Test prompt",
      messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
    }),
    sleep: async (ms: number): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 100)));
    },
    log: (): void => {},
    ...overrides,
  };
}

// =============================================================================
// Sandbox Isolation Tests
// =============================================================================

describe("Sandbox Isolation", () => {
  test("blocks access to process global", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return typeof process", api);

    expect(result.success).toBe(true);
    expect(result.result).toBe("undefined");
  });

  test("blocks access to require", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return typeof require", api);

    expect(result.success).toBe(true);
    expect(result.result).toBe("undefined");
  });

  test("blocks access to global", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return typeof global", api);

    expect(result.success).toBe(true);
    expect(result.result).toBe("undefined");
  });

  test("blocks access to globalThis", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return typeof globalThis", api);

    expect(result.success).toBe(true);
    expect(result.result).toBe("undefined");
  });

  test("blocks access to eval", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return typeof eval", api);

    expect(result.success).toBe(true);
    expect(result.result).toBe("undefined");
  });

  test("blocks access to Function constructor", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return typeof Function", api);

    expect(result.success).toBe(true);
    expect(result.result).toBe("undefined");
  });

  test("blocks access to setTimeout", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return typeof setTimeout", api);

    expect(result.success).toBe(true);
    expect(result.result).toBe("undefined");
  });

  test("blocks access to fetch", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return typeof fetch", api);

    expect(result.success).toBe(true);
    expect(result.result).toBe("undefined");
  });

  test("allows access to JSON", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return JSON.stringify({a: 1})", api);

    expect(result.success).toBe(true);
    expect(result.result).toBe('{"a":1}');
  });

  test("allows access to Math", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return Math.max(1, 2, 3)", api);

    expect(result.success).toBe(true);
    expect(result.result).toBe(3);
  });

  test("allows access to mcp API", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return typeof mcp", api);

    expect(result.success).toBe(true);
    expect(result.result).toBe("object");
  });

  test("allows console.log", async () => {
    const api = createMockAPI();
    const result = await executeSandbox('console.log("test"); return "done"', api);

    expect(result.success).toBe(true);
    expect(result.result).toBe("done");
    expect(result.logs).toContain("test");
  });
});

// =============================================================================
// Timeout Enforcement Tests
// =============================================================================

describe("Timeout Enforcement", () => {
  test("times out on infinite async loop", async () => {
    const api = createMockAPI();
    const result = await executeSandbox(
      `
      while (true) {
        await mcp.sleep(10);
      }
      `,
      api,
      { config: { timeoutMs: 500 } }
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("timed out");
    expect(isTimeout(result)).toBe(true);
  });

  test("completes fast code within timeout", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return 1 + 1", api, { config: { timeoutMs: 1000 } });

    expect(result.success).toBe(true);
    expect(result.result).toBe(2);
    expect(result.stats.durationMs).toBeLessThan(1000);
  });

  test("reports correct duration on success", async () => {
    const api = createMockAPI({
      sleep: async (ms: number): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    });
    const result = await executeSandbox("await mcp.sleep(100); return 'done'", api);

    expect(result.success).toBe(true);
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(90);
  });
});

// =============================================================================
// MCP Call Limit Tests
// =============================================================================

describe("MCP Call Limits", () => {
  test("enforces mcp call limit", async () => {
    const api = createMockAPI();
    const result = await executeSandbox(
      `
      for (let i = 0; i < 10; i++) {
        await mcp.listServers();
      }
      return "done";
      `,
      api,
      { config: { maxMcpCalls: 5 } }
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("call limit exceeded");
    expect(isCallLimitExceeded(result)).toBe(true);
    expect(result.stats.mcpCalls).toBeGreaterThanOrEqual(5);
  });

  test("allows calls within limit", async () => {
    const api = createMockAPI();
    const result = await executeSandbox(
      `
      const servers = await mcp.listServers();
      const tools = await mcp.listTools();
      return { servers: servers.length, tools: tools.length };
      `,
      api,
      { config: { maxMcpCalls: 10 } }
    );

    expect(result.success).toBe(true);
    expect(result.stats.mcpCalls).toBe(2);
  });

  test("does not count sleep and log toward limit", async () => {
    const api = createMockAPI();
    const result = await executeSandbox(
      `
      mcp.log("test1");
      await mcp.sleep(10);
      mcp.log("test2");
      await mcp.sleep(10);
      mcp.log("test3");
      return "done";
      `,
      api,
      { config: { maxMcpCalls: 1 } }
    );

    // Should succeed because sleep and log don't count toward limit
    expect(result.success).toBe(true);
    expect(result.stats.mcpCalls).toBe(0);
  });
});

// =============================================================================
// API Binding Tests
// =============================================================================

describe("API Bindings", () => {
  test("mcp.listServers returns server info", async () => {
    const api = createMockAPI();
    const result = await executeSandbox(
      `
      const servers = await mcp.listServers();
      return servers[0].name;
      `,
      api
    );

    expect(result.success).toBe(true);
    expect(result.result).toBe("test-server");
  });

  test("mcp.listTools returns tool info", async () => {
    const api = createMockAPI();
    const result = await executeSandbox(
      `
      const tools = await mcp.listTools();
      return tools[0].name;
      `,
      api
    );

    expect(result.success).toBe(true);
    expect(result.result).toBe("echo");
  });

  test("mcp.callTool executes tool", async () => {
    const api = createMockAPI();
    const result = await executeSandbox(
      `
      const result = await mcp.callTool("test-server", "echo", { message: "hello" });
      return result.content[0].text;
      `,
      api
    );

    expect(result.success).toBe(true);
    expect(result.result).toBe("Echo: hello");
  });

  test("mcp.listResources returns resource info", async () => {
    const api = createMockAPI();
    const result = await executeSandbox(
      `
      const resources = await mcp.listResources();
      return resources[0].uri;
      `,
      api
    );

    expect(result.success).toBe(true);
    expect(result.result).toBe("file:///test.txt");
  });

  test("mcp.readResource returns content", async () => {
    const api = createMockAPI();
    const result = await executeSandbox(
      `
      const content = await mcp.readResource("test-server", "file:///test.txt");
      return content.contents[0].text;
      `,
      api
    );

    expect(result.success).toBe(true);
    expect(result.result).toBe("Test content");
  });

  test("mcp.log captures messages", async () => {
    const api = createMockAPI();
    const result = await executeSandbox(
      `
      mcp.log("first");
      mcp.log("second", 123);
      mcp.log({ nested: true });
      return "done";
      `,
      api
    );

    expect(result.success).toBe(true);
    expect(result.logs.length).toBe(3);
    expect(result.logs[0]).toBe("first");
    expect(result.logs[1]).toBe("second 123");
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe("Error Handling", () => {
  test("catches syntax errors", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return {", api);

    expect(result.success).toBe(false);
    // Syntax errors may be wrapped or formatted differently by the VM
    expect(result.error?.message).toMatch(/SyntaxError|Unexpected/i);
  });

  test("catches runtime errors", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("throw new Error('test error')", api);

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("Error");
    expect(result.error?.message).toBe("test error");
  });

  test("catches reference errors", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return undefinedVariable", api);

    expect(result.success).toBe(false);
    // The error might be wrapped, so just check the message contains relevant info
    expect(result.error?.message).toMatch(/undefinedVariable|is not defined|ReferenceError/i);
  });

  test("catches type errors", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("null.foo()", api);

    expect(result.success).toBe(false);
    // The error message should indicate a type error of some kind
    expect(result.error?.message).toMatch(/null|undefined|cannot|TypeError/i);
  });

  test("handles API errors gracefully", async () => {
    const api = createMockAPI({
      listTools: async () => {
        throw new Error("API error");
      },
    });
    const result = await executeSandbox("await mcp.listTools()", api);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe("API error");
  });
});

// =============================================================================
// Validation Tests
// =============================================================================

describe("Validation", () => {
  test("validateCode rejects empty code", () => {
    expect(validateCode("")).toBe("Code cannot be empty");
    expect(validateCode("   ")).toBe("Code cannot be empty");
  });

  test("validateCode rejects code exceeding max length", () => {
    const longCode = "x".repeat(EXECUTE_LIMITS.MAX_CODE_LENGTH + 1);
    const error = validateCode(longCode);
    expect(error).toContain("exceeds maximum length");
  });

  test("validateCode accepts valid code", () => {
    expect(validateCode("return 1")).toBeNull();
  });

  test("validateTimeout accepts undefined", () => {
    expect(validateTimeout(undefined)).toBeNull();
  });

  test("validateTimeout rejects too small timeout", () => {
    const error = validateTimeout(100);
    expect(error).toContain("at least");
  });

  test("validateTimeout rejects too large timeout", () => {
    const error = validateTimeout(1000000);
    expect(error).toContain("cannot exceed");
  });

  test("validateTimeout accepts valid timeout", () => {
    expect(validateTimeout(5000)).toBeNull();
  });

  test("validateExecuteRequest combines validations", () => {
    expect(validateExecuteRequest({ code: "" })).toBe("Code cannot be empty");
    expect(validateExecuteRequest({ code: "x", timeout: 100 })).toContain("at least");
    expect(validateExecuteRequest({ code: "return 1", timeout: 5000 })).toBeNull();
  });
});

// =============================================================================
// Result Helper Tests
// =============================================================================

describe("Result Helpers", () => {
  test("isSuccess correctly identifies success", () => {
    expect(isSuccess({ success: true, logs: [], stats: { durationMs: 0, mcpCalls: 0 } })).toBe(true);
    expect(
      isSuccess({
        success: false,
        error: { name: "Error", message: "test" },
        logs: [],
        stats: { durationMs: 0, mcpCalls: 0 },
      })
    ).toBe(false);
  });

  test("isTimeout correctly identifies timeout", () => {
    expect(
      isTimeout({
        success: false,
        error: { name: "Error", message: "Execution timed out after 1000ms" },
        logs: [],
        stats: { durationMs: 1000, mcpCalls: 0 },
      })
    ).toBe(true);

    expect(
      isTimeout({
        success: false,
        error: { name: "Error", message: "Some other error" },
        logs: [],
        stats: { durationMs: 0, mcpCalls: 0 },
      })
    ).toBe(false);
  });

  test("isCallLimitExceeded correctly identifies limit exceeded", () => {
    expect(
      isCallLimitExceeded({
        success: false,
        error: { name: "Error", message: "Maximum mcp.* call limit exceeded (5)" },
        logs: [],
        stats: { durationMs: 0, mcpCalls: 5 },
      })
    ).toBe(true);
  });
});

// =============================================================================
// Console Capture Tests
// =============================================================================

describe("Console Capture", () => {
  test("captures console.log", async () => {
    const api = createMockAPI();
    const result = await executeSandbox('console.log("hello"); return 1', api);

    expect(result.success).toBe(true);
    expect(result.logs).toContain("hello");
  });

  test("captures console.warn", async () => {
    const api = createMockAPI();
    const result = await executeSandbox('console.warn("warning"); return 1', api);

    expect(result.success).toBe(true);
    expect(result.logs).toContain("warning");
  });

  test("captures console.error", async () => {
    const api = createMockAPI();
    const result = await executeSandbox('console.error("error"); return 1', api);

    expect(result.success).toBe(true);
    expect(result.logs).toContain("error");
  });

  test("captures multiple console arguments", async () => {
    const api = createMockAPI();
    const result = await executeSandbox('console.log("a", 1, true); return 1', api);

    expect(result.success).toBe(true);
    expect(result.logs[0]).toBe("a 1 true");
  });

  test("captures object values", async () => {
    const api = createMockAPI();
    const result = await executeSandbox('console.log({key: "value"}); return 1', api);

    expect(result.success).toBe(true);
    expect(result.logs[0]).toContain("key");
    expect(result.logs[0]).toContain("value");
  });
});

// =============================================================================
// Return Value Serialization Tests
// =============================================================================

describe("Return Value Serialization", () => {
  test("serializes primitives", async () => {
    const api = createMockAPI();

    expect((await executeSandbox("return 42", api)).result).toBe(42);
    expect((await executeSandbox('return "hello"', api)).result).toBe("hello");
    expect((await executeSandbox("return true", api)).result).toBe(true);
    expect((await executeSandbox("return null", api)).result).toBe(null);
  });

  test("serializes arrays", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return [1, 2, 3]", api);

    expect(result.success).toBe(true);
    expect(result.result).toEqual([1, 2, 3]);
  });

  test("serializes objects", async () => {
    const api = createMockAPI();
    const result = await executeSandbox('return {a: 1, b: "two"}', api);

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ a: 1, b: "two" });
  });

  test("converts undefined to null", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return undefined", api);

    expect(result.success).toBe(true);
    expect(result.result).toBe(null);
  });

  test("handles nested objects", async () => {
    const api = createMockAPI();
    const result = await executeSandbox("return {nested: {deep: {value: 42}}}", api);

    expect(result.success).toBe(true);
    expect((result.result as Record<string, unknown>)?.nested).toEqual({ deep: { value: 42 } });
  });
});

// =============================================================================
// Initial Logs (Warning) Tests
// =============================================================================

describe("Warning Logs", () => {
  test("initial logs are included in result", async () => {
    const api = createMockAPI();
    const result = await executeSandbox('return "done"', api, {
      initialLogs: ["Warning: Server 'test' failed to connect"],
    });

    expect(result.success).toBe(true);
    expect(result.logs).toContain("Warning: Server 'test' failed to connect");
  });

  test("initial logs appear before execution logs", async () => {
    const api = createMockAPI();
    const result = await executeSandbox('console.log("runtime"); return 1', api, {
      initialLogs: ["initial warning"],
    });

    expect(result.success).toBe(true);
    expect(result.logs[0]).toBe("initial warning");
    expect(result.logs[1]).toBe("runtime");
  });
});
