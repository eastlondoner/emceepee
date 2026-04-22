/**
 * Minimal OAuth-protected MCP-like HTTP server used by integration tests.
 *
 * Deliberately not using an Express dependency — we serve a handful of
 * well-known endpoints by hand so the MCP SDK's auth() helper can complete
 * the flow: protected-resource metadata, authorization-server metadata, DCR,
 * /authorize, /token, and a trivially-protected /mcp endpoint that issues a
 * 401 with the required WWW-Authenticate header until a bearer is supplied.
 *
 * The /authorize endpoint auto-approves — there's no consent screen — and
 * redirects straight back with a code. Good enough to exercise PKCE + DCR +
 * refresh + 401 interception.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { URL } from "node:url";

export interface MockMcpServerStats {
  dcrRegistrations: number;
  authorizeCalls: number;
  tokenCalls: number;
  /** How many /mcp requests succeeded (had a valid bearer). */
  mcpAuthorizedCalls: number;
  /** How many /mcp requests were rejected with 401. */
  mcpUnauthorizedCalls: number;
}

export interface MockOAuthMcpServer {
  url: string;
  mcpUrl: string;
  stats: MockMcpServerStats;
  /** Invalidate any token that has been issued. Forces next /mcp hit to 401. */
  revokeAllTokens: () => void;
  /** Advance the access-token expiry cursor forward so next /mcp hit looks expired. */
  expireAccessTokens: () => void;
  stop: () => Promise<void>;
}

export async function startMockOAuthMcpServer(): Promise<MockOAuthMcpServer> {
  const stats: MockMcpServerStats = {
    dcrRegistrations: 0,
    authorizeCalls: 0,
    tokenCalls: 0,
    mcpAuthorizedCalls: 0,
    mcpUnauthorizedCalls: 0,
  };

  interface Registered {
    client_id: string;
    redirect_uris: string[];
  }
  const clients = new Map<string, Registered>();

  interface AuthorizationGrant {
    clientId: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    redirectUri: string;
    scope?: string;
  }
  const pendingCodes = new Map<string, AuthorizationGrant>();

  interface IssuedToken {
    clientId: string;
    refreshToken: string;
    accessToken: string;
    /** Incrementing epoch — if < currentExpiryEpoch, token is expired. */
    epoch: number;
    revoked: boolean;
  }
  const tokens = new Map<string, IssuedToken>(); // access_token -> issued
  const refreshToToken = new Map<string, string>(); // refresh_token -> current access_token
  let currentExpiryEpoch = 0;

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });
      req.on("error", reject);
    });
  }

  function b64url(input: Buffer): string {
    return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function verifyPkce(verifier: string, challenge: string, method: string): boolean {
    if (method !== "S256") return false;
    const actual = b64url(createHash("sha256").update(verifier).digest());
    return actual === challenge;
  }

  let baseUrl = "";

  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? "/", baseUrl);
        const { pathname } = url;

        // RFC 9728 — protected resource metadata
        if (pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
          json(res, 200, {
            resource: `${baseUrl}/mcp`,
            authorization_servers: [baseUrl],
            scopes_supported: ["mcp"],
          });
          return;
        }

        // RFC 8414 — authorization-server metadata
        if (pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
          json(res, 200, {
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            registration_endpoint: `${baseUrl}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
          return;
        }

        // RFC 7591 — dynamic client registration
        if (pathname === "/register" && req.method === "POST") {
          const body = await readBody(req);
          const parsed = JSON.parse(body) as { redirect_uris?: string[] };
          const clientId = `client-${randomUUID()}`;
          clients.set(clientId, {
            client_id: clientId,
            redirect_uris: parsed.redirect_uris ?? [],
          });
          stats.dcrRegistrations++;
          json(res, 201, {
            client_id: clientId,
            redirect_uris: parsed.redirect_uris ?? [],
            token_endpoint_auth_method: "none",
          });
          return;
        }

        // Authorize — auto-approve, redirect with a code.
        if (pathname === "/authorize" && req.method === "GET") {
          stats.authorizeCalls++;
          const clientId = url.searchParams.get("client_id") ?? "";
          const redirectUri = url.searchParams.get("redirect_uri") ?? "";
          const state = url.searchParams.get("state") ?? "";
          const codeChallenge = url.searchParams.get("code_challenge") ?? "";
          const codeChallengeMethod =
            url.searchParams.get("code_challenge_method") ?? "S256";
          const scope = url.searchParams.get("scope") ?? undefined;

          const client = clients.get(clientId);
          if (!client) {
            json(res, 400, { error: "invalid_client" });
            return;
          }
          const code = `code-${randomUUID()}`;
          pendingCodes.set(code, {
            clientId,
            codeChallenge,
            codeChallengeMethod,
            redirectUri,
            scope,
          });
          const redir = new URL(redirectUri);
          redir.searchParams.set("code", code);
          if (state) redir.searchParams.set("state", state);
          res.writeHead(302, { Location: redir.toString() });
          res.end();
          return;
        }

        // Token endpoint — auth code + refresh token grants.
        if (pathname === "/token" && req.method === "POST") {
          stats.tokenCalls++;
          const body = await readBody(req);
          const params = new URLSearchParams(body);
          const grant = params.get("grant_type");

          if (grant === "authorization_code") {
            const code = params.get("code") ?? "";
            const verifier = params.get("code_verifier") ?? "";
            const clientId = params.get("client_id") ?? "";
            const pending = pendingCodes.get(code);
            if (!pending) {
              json(res, 400, { error: "invalid_grant" });
              return;
            }
            pendingCodes.delete(code);
            if (pending.clientId !== clientId) {
              json(res, 400, { error: "invalid_client" });
              return;
            }
            if (
              !verifyPkce(verifier, pending.codeChallenge, pending.codeChallengeMethod)
            ) {
              json(res, 400, { error: "invalid_grant", error_description: "pkce" });
              return;
            }
            const access = `access-${randomUUID()}`;
            const refresh = `refresh-${randomUUID()}`;
            tokens.set(access, {
              clientId,
              refreshToken: refresh,
              accessToken: access,
              epoch: currentExpiryEpoch,
              revoked: false,
            });
            refreshToToken.set(refresh, access);
            json(res, 200, {
              access_token: access,
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: refresh,
              scope: pending.scope,
            });
            return;
          }

          if (grant === "refresh_token") {
            const refresh = params.get("refresh_token") ?? "";
            const oldAccess = refreshToToken.get(refresh);
            if (!oldAccess) {
              json(res, 400, { error: "invalid_grant" });
              return;
            }
            const oldEntry = tokens.get(oldAccess);
            if (!oldEntry || oldEntry.revoked) {
              json(res, 400, { error: "invalid_grant" });
              return;
            }
            tokens.delete(oldAccess);
            const newAccess = `access-${randomUUID()}`;
            tokens.set(newAccess, {
              ...oldEntry,
              accessToken: newAccess,
              epoch: currentExpiryEpoch,
            });
            refreshToToken.set(refresh, newAccess);
            json(res, 200, {
              access_token: newAccess,
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: refresh,
            });
            return;
          }

          json(res, 400, { error: "unsupported_grant_type" });
          return;
        }

        // MCP endpoint — needs bearer, otherwise 401 with WWW-Authenticate.
        if (pathname === "/mcp") {
          const authz = req.headers.authorization ?? "";
          const match = /^Bearer (.+)$/.exec(authz);
          const access = match ? match[1] : undefined;
          const entry = access ? tokens.get(access) : undefined;
          const valid = entry && !entry.revoked && entry.epoch >= currentExpiryEpoch;
          if (!valid) {
            stats.mcpUnauthorizedCalls++;
            res.writeHead(401, {
              "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
              "Content-Type": "application/json",
            });
            res.end(
              JSON.stringify({ error: "unauthorized", error_description: "need bearer" })
            );
            return;
          }
          stats.mcpAuthorizedCalls++;
          // Minimal MCP-ish response — we don't go through the full protocol
          // in these tests, we only exercise emceepee's OAuth handshake.
          json(res, 200, { ok: true });
          return;
        }

        json(res, 404, { error: "not_found", path: pathname });
      } catch (err) {
        json(res, 500, { error: "server_error", message: (err as Error).message });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock server did not bind to a port");
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;

  return {
    url: baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    stats,
    revokeAllTokens: (): void => {
      for (const entry of tokens.values()) {
        entry.revoked = true;
      }
    },
    expireAccessTokens: (): void => {
      currentExpiryEpoch++;
    },
    stop: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
