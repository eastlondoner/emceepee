/**
 * Tiny HTML helpers shared by the two OAuth surfaces that render
 * browser-facing pages:
 *   - emceepee-http's /oauth/callback + /connect routes (src/server.ts)
 *   - the EphemeralCallbackListener's completion page (stdio mode)
 *
 * Kept dependency-free so this module can be pulled into either context
 * without dragging extra imports.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a minimal styled HTML page with a title, message, and optional
 * code-style detail block.
 */
export function renderHtmlPage(
  title: string,
  message: string,
  detail?: string  
): string {
  const body =
    `<h1>${escapeHtml(title)}</h1>` +
    `<p>${escapeHtml(message)}</p>` +
    (detail ? `<pre>${escapeHtml(detail)}</pre>` : "");
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222}` +
    `h1{margin-bottom:.5rem}pre{background:#f5f5f7;padding:1rem;border-radius:6px;overflow-x:auto}</style></head>` +
    `<body>${body}</body></html>`
  );
}
