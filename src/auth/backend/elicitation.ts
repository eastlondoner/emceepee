/**
 * Build the tool-handler response that asks the calling MCP client to open an
 * upstream OAuth authorization URL.
 *
 * Two modes:
 *   - "url": throw a JSON-RPC error with code -32042 and the URL in `data`.
 *     Capable clients (Claude Desktop/Code with URL elicitation) will pop the
 *     URL, let the user authorize, and auto-retry the tool call.
 *   - "fallback": return a plaintext tool result telling the user to open the
 *     URL themselves. Used for clients that don't advertise URL elicitation.
 */

import { randomUUID } from "node:crypto";
import type {
  ClientCapabilities,
  ElicitRequestURLParams,
} from "@modelcontextprotocol/sdk/types.js";
import type { BackendAuthRequiredError } from "./errors.js";
import { classifyElicitation } from "../client-facing/capabilities.js";

/**
 * JSON-RPC error code we use to signal "the client must open this URL".
 * Matches the SDK's `ErrorCode.UrlElicitationRequired`.
 */
export const URL_ELICITATION_ERROR_CODE = -32042;

/**
 * The JSON-RPC error payload we emit. Shape is SDK-compatible so
 * `McpError.fromError(code, message, data)` reconstructs a
 * `UrlElicitationRequiredError` on the client side.
 */
export interface UrlElicitationPayload {
  code: typeof URL_ELICITATION_ERROR_CODE;
  message: string;
  data: {
    elicitations: ElicitRequestURLParams[];
  };
}

export interface FallbackElicitationPayload {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError: true;
}

export type ElicitationPayload =
  | { mode: "url"; error: UrlElicitationPayload }
  | { mode: "fallback"; result: FallbackElicitationPayload };

/**
 * Build the elicitation payload for a BackendAuthRequiredError.
 */
export function buildAuthElicitation(
  caps: ClientCapabilities | undefined,
  err: BackendAuthRequiredError
): ElicitationPayload {
  const mode = classifyElicitation(caps);

  if (mode === "url") {
    const elicitation: ElicitRequestURLParams = {
      mode: "url",
      message: `Authorization required for backend '${err.serverName}'. Open the URL to connect, then retry.`,
      elicitationId: randomUUID(),
      url: err.authorizationUrl,
    };
    return {
      mode: "url",
      error: {
        code: URL_ELICITATION_ERROR_CODE,
        message: `Authorization required for backend '${err.serverName}'`,
        data: { elicitations: [elicitation] },
      },
    };
  }

  return {
    mode: "fallback",
    result: {
      content: [
        {
          type: "text",
          text:
            `Authorization required for '${err.serverName}'. ` +
            `Open ${err.authorizationUrl} to connect, then retry the tool call.`,
        },
      ],
      isError: true,
    },
  };
}
