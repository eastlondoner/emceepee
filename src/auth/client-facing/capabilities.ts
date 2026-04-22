/**
 * Classify the elicitation mode we should use to ask the calling MCP client
 * to open an OAuth URL.
 */

import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

export type ElicitationMode = "url" | "fallback";

/**
 * Returns "url" iff the client advertised the experimental URL-mode
 * elicitation capability (`capabilities.elicitation.url`). Otherwise returns
 * "fallback" — we'll return the authorize URL as plaintext in a tool result.
 */
export function classifyElicitation(
  caps: ClientCapabilities | undefined
): ElicitationMode {
  const elicitation = caps?.elicitation as
    | { url?: unknown; form?: unknown }
    | undefined;
  if (elicitation?.url !== undefined) {
    return "url";
  }
  return "fallback";
}
