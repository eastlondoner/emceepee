# OAuth-protected upstream MCP servers

emceepee-http can proxy OAuth 2.1 + PKCE + Dynamic Client Registration on
behalf of the MCP client you're running (Claude Desktop / Claude Code /
ChatGPT). This lets you connect to upstream MCP servers that require OAuth
(for example, `disk-mcp-cf`) without wiring any of it up yourself.

This document explains the intended flow and the security posture.

## Design assumptions

- **Local-dev, single-user, localhost-only.** emceepee-http itself has no
  frontend authentication. Bind it to loopback (`EMCEEPEE_HOST=127.0.0.1`,
  the default) and do not expose it to the network without a trusted
  reverse proxy in front.
- **Upstream tokens live in-memory.** They are process-global and shared
  across all MCP client sessions connected to this emceepee-http instance.
  Restarting emceepee-http re-prompts for authorization.
- **DCR client registrations persist to `~/.emceepee/dcr-clients.json`**
  (override via `EMCEEPEE_DCR_STORE_PATH`), keyed by authorization-server
  issuer URL. This avoids re-registering on every restart. The file is
  written atomically with mode 0600.
- **stdio mode uses a per-flow ephemeral loopback listener.** When you
  call `add_server` with `authMode: "oauth"` in stdio mode, emceepee
  opens a one-shot HTTP listener on `127.0.0.1:<random-port>`, uses
  that as the `redirect_uri`, returns the authorize URL in the tool
  response, and tears the listener down as soon as the callback lands
  (or after a 10-minute timeout). Tokens land in the shared
  `BackendTokenStore`, so subsequent tool calls on the server connect
  silently.

## Registering an OAuth upstream

From any connected MCP client, call the `add_server` tool:

```json
{
  "name": "disk",
  "url": "https://disk.yo-mcp.com/mcp",
  "authMode": "oauth"
}
```

### stdio mode

`add_server` starts an ephemeral loopback listener (random port on
127.0.0.1), runs the OAuth flow, and returns the authorize URL in the
tool response. The user opens that URL in their browser; the listener
catches the callback, exchanges the code for tokens, and closes. Then
any tool call on the server connects with the cached bearer. The
listener times out after 10 minutes if no callback arrives.

If the refresh token later becomes invalid, tool calls will return an
`authorization required` error — run `add_server` again to trigger a
fresh flow.

### emceepee-http mode

The first time a tool call hits that upstream (`execute_tool`, `read_resource`,
etc.), emceepee:

1. Discovers the upstream's authorization server via RFC 9728 protected
   resource metadata.
2. Registers a client with that AS using Dynamic Client Registration
   (RFC 7591) — once per issuer, persisted to disk.
3. Generates a PKCE code verifier and state, builds the authorize URL.
4. Returns the URL to your MCP client. How depends on the client's
   advertised capabilities:
   - **URL-mode elicitation** (Claude Desktop / Claude Code with URL
     elicitation): emceepee throws a JSON-RPC error with code `-32042`
     and an `ElicitRequestURLParams` payload; the client opens the URL,
     the user authorizes, and the client auto-retries the tool call.
   - **Fallback** (ChatGPT / clients without URL elicitation): emceepee
     returns the authorize URL as plaintext in a tool-result text block.
     The user opens it manually and retries the tool.
5. When the user completes the consent flow, the browser is redirected to
   `${EMCEEPEE_BASE_URL}/oauth/callback?code=...&state=...`. emceepee
   exchanges the code for tokens, stores them in the in-memory token
   store, and emits `notifications/elicitation/complete` to the session
   that initiated the flow.
6. Subsequent tool calls use the bearer token transparently. If the access
   token expires, the MCP SDK refreshes it silently using the refresh
   token — no elicitation, no user action.

## Manually pre-authorizing

To authorize an upstream without waiting for the first tool call, visit:

```
http://localhost:8080/connect/<server-name>
```

emceepee will redirect you through the same consent flow. If you already
have a valid token cached, you'll see an "Already connected" page instead.

## Example with `disk-mcp-cf`

```bash
# Start emceepee-http on 127.0.0.1:8080
bun run dev:http

# In a separate MCP client session, register the server
add_server(
  name: "disk",
  url: "https://disk.yo-mcp.com/mcp",
  authMode: "oauth"
)

# Call a tool — the client will be asked to open a GitHub consent URL
execute_tool(server: "disk", tool: "list_disks", args: {})

# After consent, the tool call auto-retries and succeeds.
```

## Environment variables

See `.env.example` for the full list:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | 8080 | HTTP port |
| `EMCEEPEE_HOST` | 127.0.0.1 | Bind address. Non-loopback binds print a warning. |
| `EMCEEPEE_BASE_URL` | `http://localhost:${PORT}` | Public URL for OAuth redirect + `/connect` links |
| `EMCEEPEE_DCR_STORE_PATH` | `~/.emceepee/dcr-clients.json` | Where DCR registrations are persisted |
| `EMCEEPEE_STDIO_OAUTH_PORT` | 14500 | Placeholder port for stdio mode's session-manager provider. Not the listener port (listeners use kernel-assigned random ports). |

## Security posture

- Upstream tokens never persist to disk. Only DCR client registrations do.
- The DCR file is written atomically (tmp + rename) with mode 0600.
- emceepee-http makes no effort to authenticate the MCP client connecting
  to it. Anyone who can reach the `/mcp` endpoint can use any upstream
  token cached in-memory. **Bind to loopback.**
- If the DCR file is ever corrupted, emceepee renames it to
  `.corrupt-<ts>` and starts fresh — startup is not blocked, but you'll
  re-register on next use.

## Limitations

- No support for token revocation endpoints (RFC 7009) — the user has to
  revoke in the authorization server's UI if needed.
- No client-credentials or JWT-bearer flows — only authorization_code +
  refresh_token, which is what the MCP authorization profile requires.
- Only one OAuth flow per backend server at a time. If two tool calls
  race the first prompt before the second arrives, both receive the same
  authorization URL (single-flight dedupe in `PendingFlowRegistry`).
