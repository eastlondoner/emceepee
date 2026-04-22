/**
 * Integration-style test for the OAuth backend proxy subsystem.
 *
 * We don't spin up full emceepee-http here — that would require Claude-style
 * MCP initialization and session plumbing that isn't relevant to the auth
 * flow. Instead we drive the SDK's `auth()` orchestrator directly against
 * our mock OAuth+MCP upstream, wiring in our real provider/stores so we
 * exercise the code paths emceepee-http uses at /connect/:server and
 * /oauth/callback.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

import { BackendTokenStore } from "../src/auth/backend/token-store.js";
import { FileDcrStore } from "../src/auth/backend/dcr-store.js";
import { PendingFlowRegistry } from "../src/auth/backend/pending-flows.js";
import { makeOAuthClientProvider } from "../src/auth/backend/oauth-provider.js";

import {
  startMockOAuthMcpServer,
  type MockOAuthMcpServer,
} from "./fixtures/mock-oauth-mcp-server.js";

interface Harness {
  upstream: MockOAuthMcpServer;
  tokenStore: BackendTokenStore;
  dcrStore: FileDcrStore;
  pendingFlows: PendingFlowRegistry;
  dcrPath: string;
  cleanup: () => Promise<void>;
}

async function buildHarness(): Promise<Harness> {
  const upstream = await startMockOAuthMcpServer();
  const dcrDir = mkdtempSync(join(tmpdir(), "emceepee-oauth-"));
  const dcrPath = join(dcrDir, "dcr.json");
  const tokenStore = new BackendTokenStore();
  const dcrStore = new FileDcrStore({ path: dcrPath });
  const pendingFlows = new PendingFlowRegistry({ ttlMs: 60_000, sweepIntervalMs: 1_000_000 });

  return {
    upstream,
    tokenStore,
    dcrStore,
    pendingFlows,
    dcrPath,
    cleanup: async (): Promise<void> => {
      pendingFlows.shutdown();
      await upstream.stop();
      rmSync(dcrDir, { recursive: true, force: true });
    },
  };
}

/**
 * Drive the auth flow exactly like /connect/:server does:
 * 1. ensureIssuer
 * 2. auth(provider, { serverUrl })  -> redirectToAuthorization captured
 * 3. simulate the browser hitting /oauth/callback by fetching the auth URL (auto-approve -> code)
 * 4. auth(provider, { serverUrl, authorizationCode })
 */
async function completeAuthFlow(
  h: Harness,
  opts: { serverName: string; serverUrl: string; baseUrl: string; sessionId: string }
): Promise<void> {
  const state = { authUrl: undefined as string | undefined };
  const providerOpts: Parameters<typeof makeOAuthClientProvider>[0] = {
    serverName: opts.serverName,
    serverUrl: opts.serverUrl,
    baseUrl: opts.baseUrl,
    sessionId: opts.sessionId,
    tokenStore: h.tokenStore,
    dcrStore: h.dcrStore,
    pendingFlows: h.pendingFlows,
  };
  const provider = makeOAuthClientProvider(providerOpts);
  provider.onAuthorizationRequired = (url: string): void => {
    state.authUrl = url;
  };

  await provider.ensureIssuer();
  const r1 = await auth(provider, { serverUrl: opts.serverUrl });
  if (r1 === "AUTHORIZED") {
    return; // tokens already cached
  }
  if (!state.authUrl) throw new Error("expected an auth URL");

  // Follow the authorize URL as a browser would; it auto-approves and 302s
  // to the redirect_uri with ?code=... Extract it without calling the
  // emceepee-http callback route.
  const authRes = await fetch(state.authUrl, { redirect: "manual" });
  expect(authRes.status).toBe(302);
  const location = authRes.headers.get("location");
  if (!location) throw new Error("authorize did not redirect");
  const callbackUrl = new URL(location);
  const code = callbackUrl.searchParams.get("code");
  const stateParam = callbackUrl.searchParams.get("state");
  if (!code) throw new Error("no code in callback");
  if (!stateParam) throw new Error("no state in callback");

  const flow = h.pendingFlows.consumeByState(stateParam);
  expect(flow).toBeDefined();
  expect(flow?.serverName).toBe(opts.serverName);

  // Simulate the callback handler: rebuild provider with the flow's sessionId
  // and finish the auth.
  const finishProviderOpts: Parameters<typeof makeOAuthClientProvider>[0] = {
    serverName: opts.serverName,
    serverUrl: opts.serverUrl,
    baseUrl: opts.baseUrl,
    sessionId: flow?.sessionId ?? opts.sessionId,
    tokenStore: h.tokenStore,
    dcrStore: h.dcrStore,
    pendingFlows: h.pendingFlows,
  };
  const finishProvider = makeOAuthClientProvider(finishProviderOpts);
  await finishProvider.ensureIssuer();
  const r2 = await auth(finishProvider, {
    serverUrl: opts.serverUrl,
    authorizationCode: code,
  });
  expect(r2).toBe("AUTHORIZED");
}

describe("OAuth backend integration", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  test("happy path: ensureIssuer -> authorize -> exchange yields tokens", async () => {
    const baseUrl = "http://localhost:9876";
    await completeAuthFlow(harness, {
      serverName: "disk",
      serverUrl: harness.upstream.mcpUrl,
      baseUrl,
      sessionId: "sess-1",
    });
    const tokens = harness.tokenStore.get("disk")?.tokens;
    expect(tokens?.access_token).toBeDefined();
    expect(tokens?.refresh_token).toBeDefined();
    expect(harness.upstream.stats.dcrRegistrations).toBe(1);
  });

  test("access token refresh is silent (no new DCR or authorize hit)", async () => {
    const baseUrl = "http://localhost:9876";
    await completeAuthFlow(harness, {
      serverName: "disk",
      serverUrl: harness.upstream.mcpUrl,
      baseUrl,
      sessionId: "sess-1",
    });

    // Expire the current access token on the upstream side, keep the refresh
    // token valid, and assert auth() refreshes silently.
    harness.upstream.expireAccessTokens();
    // The SDK only refreshes when it sees a 401 during an actual request;
    // we can trigger that by calling auth() and passing the refreshed tokens
    // back through. Easier: simulate by mutating the stored access token to
    // something the upstream will reject, then ask the provider to refresh.
    const entry = harness.tokenStore.get("disk");
    if (entry?.tokens) {
      entry.tokens.expires_in = 1; // signal near-immediate expiry to SDK helpers
    }

    const authorizeCountBefore = harness.upstream.stats.authorizeCalls;
    const dcrCountBefore = harness.upstream.stats.dcrRegistrations;

    // Calling auth() again with only serverUrl should leverage cached
    // client info + refresh token path (no new authorize redirect).
    const providerOpts: Parameters<typeof makeOAuthClientProvider>[0] = {
      serverName: "disk",
      serverUrl: harness.upstream.mcpUrl,
      baseUrl,
      sessionId: "sess-1",
      tokenStore: harness.tokenStore,
      dcrStore: harness.dcrStore,
      pendingFlows: harness.pendingFlows,
    };
    const provider = makeOAuthClientProvider(providerOpts);
    await provider.ensureIssuer();
    const result = await auth(provider, { serverUrl: harness.upstream.mcpUrl });
    expect(result).toBe("AUTHORIZED");
    expect(harness.upstream.stats.authorizeCalls).toBe(authorizeCountBefore);
    expect(harness.upstream.stats.dcrRegistrations).toBe(dcrCountBefore);
  });

  test("DCR registration persists across store instances (same issuer -> single register)", async () => {
    const baseUrl = "http://localhost:9876";
    await completeAuthFlow(harness, {
      serverName: "disk",
      serverUrl: harness.upstream.mcpUrl,
      baseUrl,
      sessionId: "sess-1",
    });
    expect(harness.upstream.stats.dcrRegistrations).toBe(1);

    // Simulate an emceepee-http restart: drop the token store but reuse the
    // DCR file from disk. A fresh auth run should NOT register a new client.
    harness.tokenStore.clearAll();
    const freshDcr = new FileDcrStore({ path: harness.dcrPath });
    const freshHarness: Harness = {
      ...harness,
      tokenStore: new BackendTokenStore(),
      dcrStore: freshDcr,
      pendingFlows: new PendingFlowRegistry({ ttlMs: 60_000, sweepIntervalMs: 1_000_000 }),
    };
    try {
      await completeAuthFlow(freshHarness, {
        serverName: "disk",
        serverUrl: harness.upstream.mcpUrl,
        baseUrl,
        sessionId: "sess-2",
      });
      expect(harness.upstream.stats.dcrRegistrations).toBe(1);
    } finally {
      freshHarness.pendingFlows.shutdown();
    }
  });
});
