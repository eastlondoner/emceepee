/**
 * OAuth flow orchestrator for emceepee-stdio.
 *
 * emceepee-http serves a fixed `/oauth/callback` route on its long-running
 * HTTP server. emceepee-stdio has no HTTP surface, so each OAuth flow spins
 * up a one-shot EphemeralCallbackListener bound to 127.0.0.1, uses its
 * address as the `redirect_uri`, and completes the token exchange inside
 * this process.
 *
 * A flow:
 *   1. Start the listener + build provider with its `redirect_uri`.
 *   2. Run `auth(provider, { serverUrl })`. If tokens are already cached
 *      ("AUTHORIZED"), return immediately.
 *   3. On "REDIRECT", the provider's redirectToAuthorization stored a
 *      PendingFlow entry. Pull its authorize URL and return it to the
 *      caller — the caller is expected to elicit/print the URL to the
 *      user so their browser can open it.
 *   4. Start awaiting the listener in the background. When the browser
 *      redirects here, exchange the code for tokens, store them, close
 *      the listener.
 *
 * The caller receives { authorizationUrl, completion } synchronously;
 * `completion` resolves when the flow terminates (success or failure).
 */

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { URL } from "node:url";
import type { StructuredLogger } from "../../logging.js";
import type { BackendTokenStore } from "./token-store.js";
import type { DcrStore } from "./dcr-store.js";
import { PendingFlowRegistry } from "./pending-flows.js";
import { EphemeralCallbackListener } from "./ephemeral-listener.js";
import { makeOAuthClientProvider } from "./oauth-provider.js";

export interface StdioOAuthFlowOptions {
  serverName: string;
  serverUrl: string;
  tokenStore: BackendTokenStore;
  dcrStore: DcrStore;
  /** Optional OAuth scopes to request. */
  scopes?: string[];
  /** Listener timeout (ms). Default: 10 minutes. */
  timeoutMs?: number;
  logger?: StructuredLogger;
}

export interface StdioOAuthFlowStarted {
  /**
   * URL the user must open in their browser to authorize. When tokens
   * were already cached and no user interaction is needed, this is
   * undefined — check `status` first.
   */
  authorizationUrl?: string;
  /**
   * "authorized" when tokens were already cached (no listener started),
   * "redirect" when a listener is awaiting the browser callback.
   */
  status: "authorized" | "redirect";
  /**
   * Resolves when the flow terminates:
   *   - "completed": tokens stored, listener closed.
   *   - "failed": token exchange errored or listener timed out.
   * Never rejects — failures are surfaced through the resolved value.
   */
  completion: Promise<StdioOAuthFlowResult>;
}

export type StdioOAuthFlowResult =
  | { status: "completed" }
  | { status: "failed"; error: string };

/**
 * Kick off an OAuth flow for `serverName`. The returned authorization URL
 * (if any) must be shown to the user so they can open it in a browser. The
 * `completion` promise settles when the flow ends.
 */
export async function runStdioOAuthFlow(
  opts: StdioOAuthFlowOptions
): Promise<StdioOAuthFlowStarted> {
  const { serverName, serverUrl, tokenStore, dcrStore, scopes, logger, timeoutMs } =
    opts;

  // Each stdio flow has its own private PendingFlowRegistry: single-flight
  // dedupe only makes sense within one flow lifetime, and the caller knows
  // there's exactly one listener per flow.
  const pendingFlows = new PendingFlowRegistry({
    ttlMs: timeoutMs ?? 10 * 60 * 1000,
    sweepIntervalMs: 60 * 60 * 1000,
  });

  // We need the state that the provider will set BEFORE startAuthorization
  // runs, so the ephemeral listener can validate it. The provider's
  // state() method reads tokenStore.pendingState; set one we control.
  const expectedState = pendingFlows.newState();
  tokenStore.update(serverName, { pendingState: expectedState });

  const listener = await EphemeralCallbackListener.start({
    expectedState,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

  const providerOpts: Parameters<typeof makeOAuthClientProvider>[0] = {
    serverName,
    serverUrl,
    redirectUri: listener.redirectUri,
    sessionId: "stdio",
    tokenStore,
    dcrStore,
    pendingFlows,
  };
  if (scopes) providerOpts.scopes = scopes;
  if (logger) providerOpts.logger = logger;
  const provider = makeOAuthClientProvider(providerOpts);

  try {
    await provider.ensureIssuer();
    const result = await auth(provider, { serverUrl });

    if (result === "AUTHORIZED") {
      // Tokens already cached; no browser interaction needed.
      await listener.close();
      pendingFlows.shutdown();
      return {
        status: "authorized",
        completion: Promise.resolve({ status: "completed" }),
      };
    }

    // REDIRECT: provider registered a pending flow with the authorize URL.
    const pendingFlow = pendingFlows.findByServer(serverName);
    if (!pendingFlow) {
      await listener.close();
      pendingFlows.shutdown();
      return {
        status: "redirect",
        completion: Promise.resolve({
          status: "failed",
          error: "Provider requested redirect but no pending flow was registered",
        }),
      };
    }

    const completion = (async (): Promise<StdioOAuthFlowResult> => {
      try {
        const cb = await listener.result;
        if (cb.error) {
          const msg = cb.errorDescription
            ? `${cb.error}: ${cb.errorDescription}`
            : cb.error;
          return { status: "failed", error: msg };
        }
        if (!cb.code) {
          return { status: "failed", error: "callback returned no code" };
        }

        // Finalize: pin the verifier captured at redirect time so a
        // future concurrent flow can't poison the exchange via the
        // shared tokenStore.
        const finalizerOpts: Parameters<typeof makeOAuthClientProvider>[0] = {
          serverName,
          serverUrl,
          redirectUri: listener.redirectUri,
          sessionId: "stdio",
          tokenStore,
          dcrStore,
          pendingFlows,
          pinnedCodeVerifier: pendingFlow.codeVerifier,
        };
        if (scopes) finalizerOpts.scopes = scopes;
        if (logger) finalizerOpts.logger = logger;
        const finalizer = makeOAuthClientProvider(finalizerOpts);
        await finalizer.ensureIssuer();
        const r2 = await auth(finalizer, {
          serverUrl,
          authorizationCode: cb.code,
        });
        if (r2 === "AUTHORIZED") {
          return { status: "completed" };
        }
        return { status: "failed", error: `auth() returned '${r2}' after code exchange` };
      } catch (err) {
        return {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        await listener.close();
        pendingFlows.shutdown();
      }
    })();

    return {
      status: "redirect",
      authorizationUrl: pendingFlow.authorizationUrl,
      completion,
    };
  } catch (err) {
    await listener.close();
    pendingFlows.shutdown();
    return {
      status: "redirect",
      completion: Promise.resolve({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

/**
 * Rewrite a URL so its OAuth `redirect_uri` and `state` query parameters
 * reflect a fresh ephemeral listener — used nowhere in production, exposed
 * for tests that want to drive the authorize URL directly without a
 * real browser.
 */
export function _rewriteAuthUrlForTest(
  authorizationUrl: string,
  replacements: { redirectUri?: string; state?: string }
): string {
  const u = new URL(authorizationUrl);
  if (replacements.redirectUri !== undefined) {
    u.searchParams.set("redirect_uri", replacements.redirectUri);
  }
  if (replacements.state !== undefined) {
    u.searchParams.set("state", replacements.state);
  }
  return u.toString();
}
