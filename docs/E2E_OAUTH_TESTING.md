# End-to-end OAuth testing with tmux + claude-code

This doc captures the concrete recipe we use to drive an end-to-end OAuth
flow against `disk-mcp-cf` (production, at `disk.yo-mcp.com`) with
emceepee running in **stdio** mode. The outer harness is a tmux session
running `claude --dangerously-skip-permissions`, and an orchestrating
assistant (Claude Code on your dev box) drives that inner claude-code via
`tmux send-keys` and reads the results via `tmux capture-pane`.

It is intentionally specific: the point is reproducibility, not
abstraction. If you add a second upstream or want to exercise the
emceepee-http path instead, adapt from this.

## What this exercises

- `add_server` tool with `authMode: "oauth"` in stdio mode
- Ephemeral loopback listener accepting the upstream's
  `/oauth/callback?code=...&state=...`
- PKCE code-verifier pinning across the listener → token-exchange boundary
- Dynamic Client Registration persisting to `~/.emceepee/dcr-clients.json`
- Token storage in the process-global `BackendTokenStore`
- A real tool call (`list_disks`) round-tripping through the cached bearer

## Prerequisites

- `bun` (repo already uses it)
- `tmux`
- `claude` CLI (Claude Code), authenticated
- `gh` CLI, authenticated to a GitHub account that has a disk on
  `disk.yo-mcp.com` (we rely on the upstream's GitHub consent screen)
- A GUI browser on the same host as tmux — the ephemeral listener binds
  to `127.0.0.1:<random-port>` and only accepts connections from that
  machine

## Files in the repo

- `testing/.mcp.json` — the `.mcp.json` the inner claude-code loads.
  Points at the stdio server directly with `bun run`:

  ```json
  {
    "mcpServers": {
      "emceepee": {
        "type": "stdio",
        "command": "bun",
        "args": ["run", "/Users/andy/repos/archil/emceepee/src/server-stdio.ts"],
        "env": {
          "EMCEEPEE_LOG_DIR": "/Users/andy/repos/archil/emceepee/testing/logs",
          "EMCEEPEE_STDIO_OAUTH_TIMEOUT_MS": "1800000"
        }
      }
    }
  }
  ```

  The 30-minute listener timeout (`EMCEEPEE_STDIO_OAUTH_TIMEOUT_MS`
  bumps the default 10 minutes) gives comfortable slack for manual
  browser consent.

- `testing/logs/` — structured log output from the stdio server. Each
  run creates a new `emceepee-<timestamp>-<pid>.log`. Gitignored via
  the repo-root `*.log`.

## Clean-slate reset

Do this between runs. Leftover DCR registrations + stale browser
session cookies caused the most painful debugging (see "Gotchas" at the
bottom):

```bash
rm -f ~/.emceepee/dcr-clients.json
rm -rf /Users/andy/repos/archil/emceepee/testing/logs/*
tmux kill-session -t oauth-test 2>/dev/null || true
```

Using an **incognito/private** browser window for the consent step
avoids carrying cookie state from previous aborted flows.

## Starting the harness

```bash
tmux new-session -d -s oauth-test -c /Users/andy/repos/archil/emceepee/testing \
  'claude --dangerously-skip-permissions'
```

`.mcp.json` is discovered because we start claude in `testing/`.

Sanity-check the session is alive:

```bash
tmux capture-pane -t oauth-test -p | tail -20
```

## Driving claude-code via tmux

The orchestrating assistant interacts with the inner claude purely
through `tmux send-keys` + `tmux capture-pane`. Two things regularly
bite:

1. **Newlines in the prompt text get interpreted as Enter.** Keep each
   prompt on a single line, or use explicit `C-m` keys.
2. **Sending text then `Enter` in two separate `tmux send-keys` calls
   does not always submit.** The first call ends without a newline,
   the second sends only `Enter` — claude-code's input box sometimes
   interprets that as a newline within the prompt, not submit. If the
   prompt visibly stays in the footer instead of being executed, send
   a bare `Enter` again.

Minimal driver pattern:

```bash
# Send the prompt
tmux send-keys -t oauth-test 'Please call mcp__emceepee__add_server with name="disk" url="https://disk.yo-mcp.com/mcp" authMode="oauth" and print the authorize URL.'
# Submit
tmux send-keys -t oauth-test Enter
# Give claude room to call the tool
sleep 8
# Read the output (with scrollback)
tmux capture-pane -t oauth-test -p -S -100 | tail -40
```

If the last command shows the prompt still lingering in the footer, just
send another `Enter`.

### Extracting the authorize URL

The URL is long and wraps across tmux's visible columns. Two reliable
approaches:

1. Ask claude to fence it: append "Print the full authorize URL in a
   markdown code fence so it does not wrap" — claude re-emits it on
   one logical line inside triple backticks, and you can copy it by
   visual inspection.
2. Grep structured logs directly:

   ```bash
   grep -o 'https://[^"\\]*oauth/authorize[^"\\]*' \
     /Users/andy/repos/archil/emceepee/testing/logs/emceepee-*.log | head -1
   ```

   Works because the server logs the tool response containing the URL
   at DEBUG level.

## The happy-path flow

From the orchestrator's perspective:

1. Send `add_server` prompt. The stdio server logs:
   ```
   INFO oauth_redirect_registered {"serverName":"disk","sessionId":"stdio",...}
   INFO server_config_added {"server":"disk","authMode":"oauth",...}
   ```
   and returns the authorize URL in the tool response.
2. Paste the URL into an **incognito** browser window, complete GitHub
   consent. Browser lands on the ephemeral listener's "You can close
   this tab" page served by `127.0.0.1:<port>/oauth/callback`.
3. Server logs `INFO stdio_oauth_flow_completed {"name":"disk"}`.
   Tokens are now in the in-process `BackendTokenStore`.
4. Verify by asking claude to call:
   ```
   mcp__emceepee__execute_tool server="disk" tool="list_disks" args={}
   ```
   Expected: the upstream returns your actual disks array. This is the
   first real connection to the backend — it uses the cached bearer.

`mcp__emceepee__list_tools server="disk"` is **not** a good verifier
— it silently skips servers that aren't yet connected. `execute_tool`
is the one that forces a connect-on-demand. (This is the
"`list_tools` returned 'No tools available'" red herring we hit in
testing.)

## Monitoring in real time

Tail the stdio server's log for OAuth-relevant events while the browser
dance is happening:

```bash
tail -f /Users/andy/repos/archil/emceepee/testing/logs/emceepee-*.log \
  | grep --line-buffered -iE 'oauth|callback|listener|ephemeral|token|state'
```

Events you should see in order:

| Event                              | When                                        |
|------------------------------------|---------------------------------------------|
| `oauth_redirect_registered`        | `add_server` tool call, listener is up      |
| `ephemeral_callback_received`      | browser hits the listener                   |
| `stdio_oauth_flow_completed`       | SDK finished the token exchange             |
| (then) `MCPHttpClient` connect log | first `execute_tool` call                   |

Absence of `stdio_oauth_flow_completed` after a browser submission
almost always means a state mismatch or a hung DCR — check the body
of the `ephemeral_callback_received` log line for the received state
and compare to `oauth_redirect_registered`.

## Gotchas we've actually hit

- **State mismatch with weird leading `+++`.** Example state param
  from the callback: `+++cc29e008-848d-4e20-83e1-da513f9eaeff`. The
  `+++` URL-decodes to three leading spaces, and the tail was a
  Frankenstein of a previous run's state. Root cause was upstream
  browser cookie state from an aborted earlier flow. Fix: fresh
  incognito window + wipe DCR + restart tmux.
- **Listener timeout.** Default 10 min; if you're typing slowly or
  navigating MFA, bump `EMCEEPEE_STDIO_OAUTH_TIMEOUT_MS`
  (milliseconds). The `testing/.mcp.json` bumps it to 30 min.
- **`list_tools` gives no output after auth succeeded.** Not a bug —
  listing doesn't trigger a connect. Use `execute_tool`.
- **`tmux send-keys` not submitting.** Send a bare `Enter` again.
- **Permission denied on `git push`.** `gh` has multiple accounts;
  the push uses git credentials tied to the active `gh auth switch`
  account. Switch to an account with push rights on the fork
  (`gh auth switch --user <name>`) before pushing.
- **Second concurrent flow on the same server.** The single-flight
  dedupe in `PendingFlowRegistry` will return the first flow's URL
  for every subsequent `add_server` call until that flow resolves or
  times out. This is intentional — but if you want to force a fresh
  flow, wait for the first to time out or restart the stdio process.

## Useful one-liners

```bash
# Did the DCR registration get written?
ls -l ~/.emceepee/dcr-clients.json

# How many clients have we registered across all flows?
jq 'keys | length' ~/.emceepee/dcr-clients.json

# Full timeline of an OAuth flow from the most recent log:
latest=$(ls -t /Users/andy/repos/archil/emceepee/testing/logs/emceepee-*.log | head -1)
grep -iE 'oauth|listener|ephemeral|token' "$latest"

# Kill the harness:
tmux kill-session -t oauth-test
```

## Running the same story against a different upstream

Swap `https://disk.yo-mcp.com/mcp` for the upstream's MCP URL, and make
sure the consent screen is reachable on the same host as tmux. Every
other step is identical. If the upstream requires non-default scopes,
add `oauthScopes: ["read", "write"]` to the `add_server` args.
