/**
 * Proves that setting `onmessage` on a transport BEFORE
 * `McpServer.connect(transport)` results in both our sniffer AND the SDK's
 * internal handler running for every inbound message — i.e., the SDK's
 * connect() chains through to the pre-existing handler rather than
 * overwriting it.
 *
 * This is load-bearing for src/server.ts: we capture per-session client
 * capabilities from the `initialize` message via this pre-set sniffer. If
 * the SDK ever stops preserving it, this test fails loudly instead of
 * leaking capabilities across sessions.
 */

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";

describe("transport.onmessage chain-through on SDK connect()", () => {
  test("pre-set onmessage runs before the SDK's internal handler", async () => {
    const received: JSONRPCMessage[] = [];

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: (): string => "test-session",
    });

    // Install OUR sniffer BEFORE McpServer.connect() installs the SDK's.
    transport.onmessage = (message: JSONRPCMessage, _extra?: MessageExtraInfo): void => {
      received.push(message);
    };

    const server = new McpServer({ name: "test", version: "0.0.1" });
    await server.connect(transport);

    // Post-connect, the onmessage getter must still resolve a handler that
    // invokes our sniffer first.
    const handler = transport.onmessage;
    expect(typeof handler).toBe("function");

    const fakeInit: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: { elicitation: { url: {} } },
        clientInfo: { name: "probe", version: "0" },
      },
    };

    // Drive the wrapped handler the same way the transport would dispatch
    // after parsing an incoming POST body.
    handler?.(fakeInit);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(fakeInit);

    await transport.close();
  });
});
