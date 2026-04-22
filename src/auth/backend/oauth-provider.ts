/**
 * Factory for an OAuthClientProvider per backend server.
 *
 * This sits between the MCP SDK's `auth()` / `StreamableHTTPClientTransport`
 * and our token/DCR/pending-flow stores. The SDK does the heavy lifting
 * (PKCE, DCR, refresh, 401 retry, token exchange); we implement storage and
 * the "show the user a URL" redirect hook.
 */

import {
  type OAuthClientInformationFull,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import type { StructuredLogger } from "../../logging.js";
import type { BackendTokenStore } from "./token-store.js";
import type { DcrStore } from "./dcr-store.js";
import { normalizeIssuer } from "./dcr-store.js";
import type { PendingFlowRegistry } from "./pending-flows.js";

export interface MakeOAuthClientProviderOptions {
  /** Backend server name (token-store key). */
  serverName: string;
  /** Upstream MCP server URL (e.g. "https://disk.yo-mcp.com/mcp"). */
  serverUrl: string;
  /** emceepee-http base URL (e.g. "http://localhost:8080"). Callback lives at `${baseUrl}/oauth/callback`. */
  baseUrl: string;
  /** Optional OAuth scopes. */
  scopes?: string[];
  /** Session ID that initiated the flow (for `/oauth/callback` → notification correlation). */
  sessionId: string;
  tokenStore: BackendTokenStore;
  dcrStore: DcrStore;
  pendingFlows: PendingFlowRegistry;
  logger?: StructuredLogger;
}

/**
 * Our provider extends the SDK interface with a method to eagerly resolve the
 * upstream's authorization-server issuer URL (via the RFC 9728 protected
 * resource document). We need the issuer URL to key DCR lookups. The SDK
 * itself doesn't pass the issuer into `clientInformation()`, so we prefetch.
 */
export interface EmceepeeOAuthClientProvider extends OAuthClientProvider {
  /** Resolve + cache the issuer URL for this backend. Idempotent. */
  ensureIssuer(): Promise<string>;
  /**
   * The client (MCPHttpClient) sets this after construction so that the
   * auth URL we produce during `auth()` can be captured and re-thrown in a
   * BackendAuthRequiredError.
   */
  onAuthorizationRequired?: (url: string) => void;
}

const CLIENT_NAME = "emceepee";
const CLIENT_URI = "https://github.com/eastlondoner/emceepee";

export function makeOAuthClientProvider(
  options: MakeOAuthClientProviderOptions
): EmceepeeOAuthClientProvider {
  const {
    serverName,
    serverUrl,
    baseUrl,
    scopes,
    sessionId,
    tokenStore,
    dcrStore,
    pendingFlows,
    logger,
  } = options;

  const redirectUri = `${trimTrailingSlash(baseUrl)}/oauth/callback`;

  const clientMetadata: OAuthClientMetadata = {
    redirect_uris: [redirectUri],
    client_name: CLIENT_NAME,
    client_uri: CLIENT_URI,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(scopes && scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
  };

  let cachedIssuer: string | undefined;
  let cachedResource: string | undefined;

  async function resolveIssuer(): Promise<string> {
    if (cachedIssuer) return cachedIssuer;

    // Check if we already stashed an issuer on the token-store entry.
    const existing = tokenStore.get(serverName);
    if (existing?.issuerUrl) {
      cachedIssuer = existing.issuerUrl;
      if (existing.resourceUrl) {
        cachedResource = existing.resourceUrl;
      }
      return cachedIssuer;
    }

    let metadata: OAuthProtectedResourceMetadata | undefined;
    try {
      metadata = await discoverOAuthProtectedResourceMetadata(serverUrl);
    } catch (err) {
      logger?.debug("oauth_prm_discovery_failed", {
        serverName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const authServer = metadata?.authorization_servers?.[0];
    // Fall back: use the server's own origin as the issuer (common for
    // single-AS-single-RS setups like Cloudflare's worker OAuth provider).
    const issuer = authServer ?? new URL(serverUrl).origin;
    cachedIssuer = normalizeIssuer(issuer);
    cachedResource = metadata?.resource ?? serverUrl;
    tokenStore.update(serverName, {
      issuerUrl: cachedIssuer,
      resourceUrl: cachedResource,
    });
    return cachedIssuer;
  }

  const provider: EmceepeeOAuthClientProvider = {
    get redirectUrl(): string {
      return redirectUri;
    },

    get clientMetadata(): OAuthClientMetadata {
      return clientMetadata;
    },

    async ensureIssuer(): Promise<string> {
      return resolveIssuer();
    },

    state(): string {
      const existing = tokenStore.get(serverName);
      if (existing?.pendingState) {
        return existing.pendingState;
      }
      const fresh = pendingFlows.newState();
      tokenStore.update(serverName, { pendingState: fresh });
      return fresh;
    },

    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
      const issuer = await resolveIssuer();
      return dcrStore.get(issuer);
    },

    saveClientInformation(info: OAuthClientInformationMixed): void {
      // resolveIssuer must already have been called — the SDK only calls
      // saveClientInformation after clientInformation.
      const issuer = cachedIssuer;
      if (!issuer) {
        logger?.warn("oauth_save_client_no_issuer", { serverName });
        return;
      }
      dcrStore.put(issuer, info as OAuthClientInformationFull);
    },

    tokens(): OAuthTokens | undefined {
      return tokenStore.get(serverName)?.tokens;
    },

    saveTokens(tokens: OAuthTokens): void {
      tokenStore.update(serverName, { tokens });
      // Once we have tokens, the PKCE verifier is no longer needed.
      tokenStore.clearVerifier(serverName);
    },

    saveCodeVerifier(codeVerifier: string): void {
      tokenStore.update(serverName, { codeVerifier });
    },

    codeVerifier(): string {
      const entry = tokenStore.get(serverName);
      if (!entry?.codeVerifier) {
        throw new Error(`No PKCE code verifier stored for '${serverName}'`);
      }
      return entry.codeVerifier;
    },

    redirectToAuthorization(authorizationUrl: URL): void {
      // Single-flight: if a flow is already pending for this server, reuse
      // its URL — both concurrent callers see the same authorize URL.
      const existing = pendingFlows.findByServer(serverName);
      if (existing) {
        provider.onAuthorizationRequired?.(existing.authorizationUrl);
        return;
      }

      const issuer = cachedIssuer ?? normalizeIssuer(serverUrl);
      const stateParam = authorizationUrl.searchParams.get("state") ?? "";
      const verifier = tokenStore.get(serverName)?.codeVerifier ?? "";

      pendingFlows.register({
        state: stateParam,
        serverName,
        sessionId,
        issuerUrl: issuer,
        authorizationUrl: authorizationUrl.toString(),
        codeVerifier: verifier,
      });

      logger?.info("oauth_redirect_registered", {
        serverName,
        sessionId,
        issuer,
      });

      provider.onAuthorizationRequired?.(authorizationUrl.toString());
    },

    invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): void {
      switch (scope) {
        case "all":
          tokenStore.clear(serverName);
          if (cachedIssuer) {
            dcrStore.delete(cachedIssuer);
          }
          break;
        case "client":
          if (cachedIssuer) {
            dcrStore.delete(cachedIssuer);
          }
          break;
        case "tokens":
          tokenStore.clearTokens(serverName);
          break;
        case "verifier":
          tokenStore.clearVerifier(serverName);
          break;
      }
    },
  };

  return provider;
}

function trimTrailingSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}
