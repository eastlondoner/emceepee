/**
 * One-shot OAuth callback listener bound to 127.0.0.1.
 *
 * Used by emceepee-stdio (and anyone else without a fixed HTTP callback
 * surface) to receive an upstream OAuth authorization response. The
 * listener:
 *   - binds to the loopback interface only,
 *   - accepts a single callback on its configured path,
 *   - validates the `state` parameter against the expected value,
 *   - resolves its `result` promise with the received code/error,
 *   - serves a minimal HTML "you can close this tab" page to the browser,
 *   - self-destructs after the first hit (or on timeout / close()).
 *
 * The listener is intentionally tiny — no framework, no routing. It is
 * the OAuth equivalent of `nc -l 127.0.0.1 <port>`.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export interface EphemeralCallbackResult {
  /** Authorization code, when the AS returned success. */
  code?: string;
  /** OAuth state parameter echoed back by the AS. */
  state?: string;
  /** OAuth error code (e.g. "access_denied"), when the AS refused. */
  error?: string;
  /** Human-readable OAuth error description, when provided. */
  errorDescription?: string;
}

export interface EphemeralCallbackListenerOptions {
  /** Expected OAuth state. Callbacks with a mismatching state are rejected. */
  expectedState: string;
  /** Bind host. Default: "127.0.0.1". Non-loopback binds throw. */
  host?: string;
  /** Bind port. Default: 0 (kernel picks a free port). */
  port?: number;
  /** Callback path. Default: "/oauth/callback". */
  path?: string;
  /** Auto-close after this many ms with a "timeout" error. Default: 600_000. */
  timeoutMs?: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * A one-shot HTTP callback receiver.
 *
 * Typical usage:
 *   const listener = await EphemeralCallbackListener.start({ expectedState });
 *   // ... hand listener.redirectUri to the OAuth client, show auth URL to user ...
 *   const result = await listener.result;
 *   if (result.code) { // exchange for tokens }
 *   await listener.close();
 */
export class EphemeralCallbackListener {
  public readonly redirectUri: string;
  public readonly result: Promise<EphemeralCallbackResult>;
  private readonly server: Server;
  private readonly path: string;
  private readonly expectedState: string;
  private readonly resolveResult: (r: EphemeralCallbackResult) => void;
  private timeoutHandle: NodeJS.Timeout | null;
  private closed = false;
  private resolved = false;

  public static async start(
    options: EphemeralCallbackListenerOptions
  ): Promise<EphemeralCallbackListener> {
    const host = options.host ?? "127.0.0.1";
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(
        `EphemeralCallbackListener refuses to bind to non-loopback host '${host}'`
      );
    }
    const path = options.path ?? "/oauth/callback";
    const port = options.port ?? 0;

    let resolveResult!: (r: EphemeralCallbackResult) => void;
    const resultPromise = new Promise<EphemeralCallbackResult>((r) => {
      resolveResult = r;
    });

    const listener = new EphemeralCallbackListener(
      path,
      options.expectedState,
      resultPromise,
      resolveResult
    );

    await new Promise<void>((resolve, reject) => {
      listener.server.once("error", reject);
      listener.server.listen(port, host, () => {
        listener.server.off("error", reject);
        resolve();
      });
    });

    const addr = listener.server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("EphemeralCallbackListener: server.address() returned null");
    }
    // Assign to readonly via Object.defineProperty-style write: the field is
    // declared readonly on the public interface, but we set it once during
    // construction post-bind.
    (listener as { redirectUri: string }).redirectUri = `http://${host}:${String(addr.port)}${path}`;

    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    listener.timeoutHandle = setTimeout(() => {
      listener.complete({
        error: "timeout",
        errorDescription: `Ephemeral callback listener timed out after ${String(timeoutMs)}ms`,
      });
    }, timeoutMs);
    listener.timeoutHandle.unref();

    return listener;
  }

  private constructor(
    path: string,
    expectedState: string,
    resultPromise: Promise<EphemeralCallbackResult>,
    resolveResult: (r: EphemeralCallbackResult) => void
  ) {
    this.path = path;
    this.expectedState = expectedState;
    this.result = resultPromise;
    this.resolveResult = resolveResult;
    this.timeoutHandle = null;
    this.redirectUri = "";
    this.server = createServer((req, res) => {
      this.handle(req, res);
    });
  }

  public get port(): number {
    const addr = this.server.address();
    if (!addr || typeof addr === "string") return 0;
    return addr.port;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" });
      res.end("method not allowed");
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${String(this.port)}`);
    if (url.pathname !== this.path) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }

    const code = url.searchParams.get("code") ?? undefined;
    const state = url.searchParams.get("state") ?? undefined;
    const error = url.searchParams.get("error") ?? undefined;
    const errorDescription = url.searchParams.get("error_description") ?? undefined;

    // Validate state BEFORE consuming the result. An unrelated request
    // (e.g. a malicious local process) hitting our port should not race
    // the real callback.
    if (state !== this.expectedState) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("state mismatch");
      return;
    }

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlPage("Authorization failed", error, errorDescription));
      this.complete({ error, errorDescription, state });
      return;
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("missing code");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      htmlPage(
        "Connected",
        "You can close this tab and return to your MCP client.",
        undefined
      )
    );
    this.complete({ code, state });
  }

  private complete(r: EphemeralCallbackResult): void {
    if (this.resolved) return;
    this.resolved = true;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.resolveResult(r);
  }
}

function htmlPage(title: string, message: string, detail: string | undefined): string {
  const esc = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const body =
    `<h1>${esc(title)}</h1>` +
    `<p>${esc(message)}</p>` +
    (detail ? `<pre>${esc(detail)}</pre>` : "");
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222}` +
    `h1{margin-bottom:.5rem}pre{background:#f5f5f7;padding:1rem;border-radius:6px;overflow-x:auto}</style></head>` +
    `<body>${body}</body></html>`
  );
}
