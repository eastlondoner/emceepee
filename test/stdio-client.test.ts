#!/usr/bin/env bun
/**
 * Test script for MCPStdioClient
 *
 * Tests:
 * 1. Basic connection to stdio server
 * 2. Tool listing and calling
 * 3. stderr capture with proper source indication
 * 4. Crash handling and restart recovery
 * 5. Lifecycle events
 *
 * Usage:
 *   bun run test/stdio-client.test.ts
 */

import { MCPStdioClient } from "../src/stdio-client.js";
import { StdioLifecycleEventData } from "../src/types.js";
import { BufferedLog } from "../src/state/buffer-manager.js";

// ANSI colors for output
const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
};

function log(level: "info" | "success" | "error" | "warn", message: string): void {
  const colorMap = {
    info: colors.blue,
    success: colors.green,
    error: colors.red,
    warn: colors.yellow,
  };
  console.log(`${colorMap[level]}[${level.toUpperCase()}]${colors.reset} ${message}`);
}

function logEvent(event: StdioLifecycleEventData): void {
  console.log(`${colors.cyan}[EVENT]${colors.reset} ${event.event}: ${JSON.stringify(event)}`);
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  log("info", `Running test: ${name}`);
  try {
    await fn();
    results.push({ name, passed: true });
    log("success", `✓ ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
    log("error", `✗ ${name}: ${error}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  log("info", "Starting MCPStdioClient tests...\n");

  // Collect lifecycle events
  const lifecycleEvents: StdioLifecycleEventData[] = [];
  const stderrLogs: Array<{ timestamp: Date; data: string }> = [];

  // Test 1: Create and connect client
  let client: MCPStdioClient | null = null;

  await runTest("Create MCPStdioClient", async () => {
    client = new MCPStdioClient({
      name: "test-echo-server",
      command: "bun",
      args: ["run", "test/fixtures/echo-server.ts"],
      restartConfig: {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 2000,
        backoffMultiplier: 2,
      },
      onLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
        logEvent(event);
      },
      onLog: (logEntry: BufferedLog) => {
        if (logEntry.source === "stderr") {
          stderrLogs.push({ timestamp: logEntry.timestamp, data: String(logEntry.data) });
          console.log(`${colors.yellow}[STDERR]${colors.reset} ${logEntry.data}`);
        }
      },
    });

    if (!client) throw new Error("Client not created");
  });

  await runTest("Connect to echo server", async () => {
    if (!client) throw new Error("Client not available");
    await client.connect();

    // Verify connection
    if (!client.isConnected()) {
      throw new Error("Client not connected after connect()");
    }

    // Check for process_started event
    const startedEvent = lifecycleEvents.find((e) => e.event === "process_started");
    if (!startedEvent) {
      throw new Error("No process_started event received");
    }
  });

  await runTest("List tools", async () => {
    if (!client) throw new Error("Client not available");
    const tools = await client.listTools();

    if (tools.length !== 3) {
      throw new Error(`Expected 3 tools, got ${tools.length}`);
    }

    const toolNames = tools.map((t) => t.name);
    if (!toolNames.includes("echo")) throw new Error("Missing 'echo' tool");
    if (!toolNames.includes("crash")) throw new Error("Missing 'crash' tool");
    if (!toolNames.includes("slow_echo")) throw new Error("Missing 'slow_echo' tool");

    log("info", `Found tools: ${toolNames.join(", ")}`);
  });

  await runTest("Call echo tool", async () => {
    if (!client) throw new Error("Client not available");
    const result = await client.callTool("echo", { message: "Hello, MCP!" });

    if (result.isError) {
      throw new Error(`Tool call returned error: ${JSON.stringify(result.content)}`);
    }

    const textContent = result.content.find((c) => c.type === "text");
    if (!textContent || !("text" in textContent)) {
      throw new Error("No text content in result");
    }

    if (!textContent.text.includes("Hello, MCP!")) {
      throw new Error(`Unexpected response: ${textContent.text}`);
    }

    log("info", `Echo response: ${textContent.text}`);
  });

  await runTest("Call slow_echo tool", async () => {
    if (!client) throw new Error("Client not available");
    const start = Date.now();
    const result = await client.callTool("slow_echo", {
      message: "Delayed message",
      delayMs: 500,
    });
    const elapsed = Date.now() - start;

    if (result.isError) {
      throw new Error(`Tool call returned error`);
    }

    if (elapsed < 400) {
      throw new Error(`Response came too fast: ${elapsed}ms`);
    }

    log("info", `Slow echo completed in ${elapsed}ms`);
  });

  // Stderr test moved here so logs from tool calls are captured
  await runTest("Stderr capture working", async () => {
    // Give a moment for any async stderr to flush
    await sleep(100);

    if (stderrLogs.length === 0) {
      throw new Error("No stderr logs captured");
    }
    // Check for logs from tool calls (Listing tools, echo, etc.)
    const hasToolLog = stderrLogs.some((l) => l.data.includes("Listing tools") || l.data.includes("echo-server"));
    if (!hasToolLog) {
      throw new Error("Expected logs from echo server tool calls");
    }
    log("info", `Captured ${stderrLogs.length} stderr log entries`);
  });

  await runTest("Get client info", async () => {
    if (!client) throw new Error("Client not available");
    const info = client.getInfo();

    if (info.name !== "test-echo-server") {
      throw new Error(`Wrong name: ${info.name}`);
    }

    if (info.transportType !== "stdio") {
      throw new Error(`Wrong transport type: ${info.transportType}`);
    }

    if (typeof info.pid !== "number") {
      throw new Error(`PID not set: ${info.pid}`);
    }

    log("info", `Server info: name=${info.name}, pid=${info.pid}, status=${info.status}`);
  });

  // Test crash and restart
  await runTest("Crash and restart recovery", async () => {
    if (!client) throw new Error("Client not available");

    const preRestartEventCount = lifecycleEvents.length;

    // Trigger crash
    log("info", "Triggering server crash...");
    try {
      await client.callTool("crash", { exitCode: 1 });
    } catch {
      // Expected to fail or timeout
    }

    // Wait for restart cycle
    log("info", "Waiting for restart...");
    await sleep(3000);

    // Check lifecycle events
    const postCrashEvents = lifecycleEvents.slice(preRestartEventCount);
    const eventTypes = postCrashEvents.map((e) => e.event);

    log("info", `Post-crash events: ${eventTypes.join(" -> ")}`);

    const hasCrashEvent = eventTypes.includes("process_crashed");
    const hasRestartingEvent = eventTypes.includes("restarting");
    const hasRestartedEvent = eventTypes.includes("restarted");

    if (!hasCrashEvent) {
      throw new Error("No process_crashed event after crash");
    }

    if (!hasRestartingEvent) {
      throw new Error("No restarting event after crash");
    }

    if (!hasRestartedEvent) {
      log("warn", "No restarted event yet - may still be restarting");
    }

    // Verify client is reconnected
    if (client.isConnected()) {
      log("info", "Client successfully reconnected after crash");
    } else {
      log("warn", "Client not yet reconnected - checking status");
      log("info", `Client status: ${client.getStatus()}`);
    }
  });

  // Wait a bit more if still restarting
  if (client && !client.isConnected()) {
    log("info", "Waiting for reconnection...");
    await sleep(2000);
  }

  await runTest("Verify functionality after restart", async () => {
    if (!client) throw new Error("Client not available");

    if (!client.isConnected()) {
      throw new Error("Client not connected after restart");
    }

    // Call echo again to verify functionality
    const result = await client.callTool("echo", { message: "After restart!" });

    if (result.isError) {
      throw new Error("Tool call failed after restart");
    }

    log("info", "Echo tool works after restart");
  });

  // Cleanup
  await runTest("Disconnect cleanly", async () => {
    if (!client) throw new Error("Client not available");
    await client.disconnect();

    if (client.isConnected()) {
      throw new Error("Still connected after disconnect");
    }

    // Check for stopped event
    const stoppedEvent = lifecycleEvents.find((e) => e.event === "process_stopped");
    if (!stoppedEvent) {
      throw new Error("No process_stopped event received");
    }
  });

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("TEST SUMMARY");
  console.log("=".repeat(60));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  for (const result of results) {
    const icon = result.passed ? "✓" : "✗";
    const color = result.passed ? colors.green : colors.red;
    console.log(`${color}${icon}${colors.reset} ${result.name}`);
    if (result.error) {
      console.log(`  ${colors.red}Error: ${result.error}${colors.reset}`);
    }
  }

  console.log("\n" + "-".repeat(60));
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log("-".repeat(60));

  console.log(`\nLifecycle events received: ${lifecycleEvents.length}`);
  console.log(`Stderr logs captured: ${stderrLogs.length}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  log("error", `Test runner failed: ${error}`);
  process.exit(1);
});
