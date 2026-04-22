/**
 * Integration-style test for the emceepee-stdio OAuth flow orchestrator.
 *
 * Drives runStdioOAuthFlow against the mock OAuth+MCP upstream. Instead of
 * a real browser, we `fetch()` the authorize URL (the mock auto-approves
 * and returns a 302 → our ephemeral listener's redirect_uri), which is
 * exactly what a user's browser does. The listener catches the callback,
 * the code is exchanged for tokens, and the completion promise resolves.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BackendTokenStore } from "../src/auth/backend/token-store.js";
import { FileDcrStore } from "../src/auth/backend/dcr-store.js";
import { runStdioOAuthFlow } from "../src/auth/backend/stdio-oauth-flow.js";

import {
  startMockOAuthMcpServer,
  type MockOAuthMcpServer,
} from "./fixtures/mock-oauth-mcp-server.js";

interface Harness {
  upstream: MockOAuthMcpServer;
  tokenStore: BackendTokenStore;
  dcrStore: FileDcrStore;
  cleanup: () => Promise<void>;
}

async function buildHarness(): Promise<Harness> {
  const upstream = await startMockOAuthMcpServer();
  const dir = mkdtempSync(join(tmpdir(), "emceepee-stdio-oauth-"));
  const dcrStore = new FileDcrStore({ path: join(dir, "dcr.json") });
  return {
    upstream,
    tokenStore: new BackendTokenStore(),
    dcrStore,
    cleanup: async (): Promise<void> => {
      await upstream.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("runStdioOAuthFlow (end-to-end)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  test("happy path: flow yields URL + completion resolves with tokens stored", async () => {
    const flow = await runStdioOAuthFlow({
      serverName: "disk",
      serverUrl: h.upstream.mcpUrl,
      tokenStore: h.tokenStore,
      dcrStore: h.dcrStore,
      timeoutMs: 5_000,
    });

    expect(flow.status).toBe("redirect");
    expect(flow.authorizationUrl).toBeDefined();

    // Simulate the user's browser following the authorize URL. The mock
    // auto-approves and 302s to the listener's redirect_uri with a code.
    const res = await fetch(flow.authorizationUrl!, { redirect: "follow" });
    expect(res.status).toBe(200);

    const result = await flow.completion;
    expect(result.status).toBe("completed");
    expect(h.tokenStore.get("disk")?.tokens?.access_token).toBeDefined();
    expect(h.upstream.stats.dcrRegistrations).toBe(1);
  });

  test("cached tokens short-circuit: flow returns status=authorized", async () => {
    // First flow populates tokens.
    const first = await runStdioOAuthFlow({
      serverName: "disk",
      serverUrl: h.upstream.mcpUrl,
      tokenStore: h.tokenStore,
      dcrStore: h.dcrStore,
      timeoutMs: 5_000,
    });
    await fetch(first.authorizationUrl!, { redirect: "follow" });
    const firstResult = await first.completion;
    expect(firstResult.status).toBe("completed");

    // Second call should not prompt — tokens are cached.
    const second = await runStdioOAuthFlow({
      serverName: "disk",
      serverUrl: h.upstream.mcpUrl,
      tokenStore: h.tokenStore,
      dcrStore: h.dcrStore,
      timeoutMs: 5_000,
    });
    expect(second.status).toBe("authorized");
    expect(second.authorizationUrl).toBeUndefined();
    const result = await second.completion;
    expect(result.status).toBe("completed");
  });

  test("listener times out if no callback arrives", async () => {
    const flow = await runStdioOAuthFlow({
      serverName: "disk",
      serverUrl: h.upstream.mcpUrl,
      tokenStore: h.tokenStore,
      dcrStore: h.dcrStore,
      timeoutMs: 80,
    });
    // Don't follow the URL — just wait for the timeout.
    const result = await flow.completion;
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("timeout");
    }
  });

  test("user denies: error param surfaces as failed completion", async () => {
    const flow = await runStdioOAuthFlow({
      serverName: "disk",
      serverUrl: h.upstream.mcpUrl,
      tokenStore: h.tokenStore,
      dcrStore: h.dcrStore,
      timeoutMs: 5_000,
    });

    // Replace the authorize URL's endpoint with a manual error redirect
    // to simulate the user clicking "deny" at the consent screen.
    const state = new URL(flow.authorizationUrl!).searchParams.get("state") ?? "";
    const redirectUri = new URL(flow.authorizationUrl!).searchParams.get("redirect_uri") ?? "";
    const denyUrl = new URL(redirectUri);
    denyUrl.searchParams.set("error", "access_denied");
    denyUrl.searchParams.set("error_description", "user declined");
    denyUrl.searchParams.set("state", state);
    await fetch(denyUrl.toString());

    const result = await flow.completion;
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("access_denied");
    }
    expect(h.tokenStore.get("disk")?.tokens).toBeUndefined();
  });
});
