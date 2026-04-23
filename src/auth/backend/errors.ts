/**
 * Errors related to upstream MCP backend OAuth.
 */

/**
 * Thrown by MCPHttpClient when an upstream request returns UnauthorizedError
 * and the SDK has already initiated a fresh authorization redirect. The thrown
 * error carries the authorization URL we just registered so the tool handler
 * can hand it to the MCP client as a URL-mode elicitation or plaintext fallback.
 */
export class BackendAuthRequiredError extends Error {
  public readonly serverName: string;
  public readonly authorizationUrl: string;

  constructor(serverName: string, authorizationUrl: string) {
    super(`Authorization required for backend '${serverName}'`);
    this.name = "BackendAuthRequiredError";
    this.serverName = serverName;
    this.authorizationUrl = authorizationUrl;
  }
}
