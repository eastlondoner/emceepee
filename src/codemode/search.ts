/**
 * Codemode Search Tool
 *
 * Implements the codemode_search tool that allows searching for MCP
 * capabilities (tools, resources, prompts, servers) across all connected
 * backend servers.
 */

import type { SessionState } from "../session/session-state.js";
import type { SessionManager } from "../session/session-manager.js";
import type {
  SearchQuery,
  SearchResult,
  SearchToolResult,
  SearchResourceResult,
  SearchPromptResult,
  SearchServerResult,
} from "./types.js";
import { getMatchingClients } from "./api-bindings.js";

// =============================================================================
// Query Matching
// =============================================================================

/**
 * Create a regex from a query string
 * Returns null if the query is invalid
 */
function createQueryRegex(query: string): RegExp | null {
  try {
    return new RegExp(query, "i"); // Case-insensitive
  } catch {
    // If invalid regex, escape special chars and try as literal
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      return new RegExp(escaped, "i");
    } catch {
      return null;
    }
  }
}

/**
 * Check if a string matches a query
 */
function matchesQuery(text: string | undefined, regex: RegExp): boolean {
  if (!text) return false;
  return regex.test(text);
}

/**
 * Check if a server name matches the server filter pattern
 */
function matchesServerFilter(serverName: string, serverPattern?: string): boolean {
  if (!serverPattern) return true;

  try {
    const regex = new RegExp(serverPattern, "i");
    return regex.test(serverName);
  } catch {
    // Fall back to exact match
    return serverName.toLowerCase() === serverPattern.toLowerCase();
  }
}

// =============================================================================
// Search Implementation
// =============================================================================

/**
 * Options for the search function
 */
export interface SearchOptions {
  /** The session state */
  session: SessionState;
  /** The session manager */
  sessionManager: SessionManager;
}

/**
 * Search for MCP capabilities across connected servers
 *
 * @param query - The search query
 * @param options - Session and manager references
 * @returns Search results grouped by type
 */
export async function search(
  query: SearchQuery,
  options: SearchOptions
): Promise<SearchResult> {
  const { session, sessionManager } = options;
  const { query: queryStr, type, server: serverPattern, includeSchemas } = query;

  // Create query regex
  const queryRegex = createQueryRegex(queryStr);
  if (!queryRegex) {
    return {}; // Invalid query returns empty results
  }

  const result: SearchResult = {};

  // Search tools
  if (type === "tools" || type === "all") {
    result.tools = await searchTools(
      session,
      queryRegex,
      serverPattern,
      includeSchemas
    );
  }

  // Search resources
  if (type === "resources" || type === "all") {
    result.resources = await searchResources(session, queryRegex, serverPattern);
  }

  // Search prompts
  if (type === "prompts" || type === "all") {
    result.prompts = await searchPrompts(session, queryRegex, serverPattern);
  }

  // Search servers
  if (type === "servers" || type === "all") {
    result.servers = searchServers(
      session,
      sessionManager,
      queryRegex,
      serverPattern
    );
  }

  return result;
}

// =============================================================================
// Individual Search Functions
// =============================================================================

/**
 * Search for tools matching the query
 */
async function searchTools(
  session: SessionState,
  queryRegex: RegExp,
  serverPattern: string | undefined,
  includeSchemas: boolean | undefined
): Promise<SearchToolResult[]> {
  const results: SearchToolResult[] = [];
  const clients = getMatchingClients(session, serverPattern);

  for (const { name: serverName, client } of clients) {
    if (!matchesServerFilter(serverName, serverPattern)) continue;

    try {
      const tools = await client.listTools();

      for (const tool of tools) {
        // Match against name and description
        if (
          matchesQuery(tool.name, queryRegex) ||
          matchesQuery(tool.description, queryRegex)
        ) {
          const toolResult: SearchToolResult = {
            server: serverName,
            name: tool.name,
            description: tool.description,
          };

          if (includeSchemas) {
            toolResult.inputSchema = tool.inputSchema as Record<string, unknown>;
          }

          results.push(toolResult);
        }
      }
    } catch {
      // Skip servers that fail
    }
  }

  return results;
}

/**
 * Search for resources matching the query
 */
async function searchResources(
  session: SessionState,
  queryRegex: RegExp,
  serverPattern: string | undefined
): Promise<SearchResourceResult[]> {
  const results: SearchResourceResult[] = [];
  const clients = getMatchingClients(session, serverPattern);

  for (const { name: serverName, client } of clients) {
    if (!matchesServerFilter(serverName, serverPattern)) continue;

    try {
      const resources = await client.listResources();

      for (const resource of resources) {
        // Match against name, uri, and description
        if (
          matchesQuery(resource.name, queryRegex) ||
          matchesQuery(resource.uri, queryRegex) ||
          matchesQuery(resource.description, queryRegex)
        ) {
          results.push({
            server: serverName,
            uri: resource.uri,
            name: resource.name,
            description: resource.description,
            mimeType: resource.mimeType,
          });
        }
      }
    } catch {
      // Skip servers that fail
    }
  }

  return results;
}

/**
 * Search for prompts matching the query
 */
async function searchPrompts(
  session: SessionState,
  queryRegex: RegExp,
  serverPattern: string | undefined
): Promise<SearchPromptResult[]> {
  const results: SearchPromptResult[] = [];
  const clients = getMatchingClients(session, serverPattern);

  for (const { name: serverName, client } of clients) {
    if (!matchesServerFilter(serverName, serverPattern)) continue;

    try {
      const prompts = await client.listPrompts();

      for (const prompt of prompts) {
        // Match against name and description
        if (
          matchesQuery(prompt.name, queryRegex) ||
          matchesQuery(prompt.description, queryRegex)
        ) {
          results.push({
            server: serverName,
            name: prompt.name,
            description: prompt.description,
            arguments: prompt.arguments?.map((arg) => ({
              name: arg.name,
              required: arg.required,
            })),
          });
        }
      }
    } catch {
      // Skip servers that fail
    }
  }

  return results;
}

/**
 * Search for servers matching the query
 */
function searchServers(
  session: SessionState,
  sessionManager: SessionManager,
  queryRegex: RegExp,
  serverPattern: string | undefined
): SearchServerResult[] {
  const results: SearchServerResult[] = [];
  const servers = sessionManager.listServers(session.sessionId);

  for (const server of servers) {
    // Apply server pattern filter
    if (!matchesServerFilter(server.name, serverPattern)) continue;

    // Match against server name
    if (matchesQuery(server.name, queryRegex)) {
      const connection = session.getConnection(server.name);
      const client = connection?.client;
      const capabilities = client?.getInfo().capabilities;

      results.push({
        name: server.name,
        status: server.status,
        capabilities: {
          tools: capabilities?.tools ?? false,
          resources: capabilities?.resources ?? false,
          prompts: capabilities?.prompts ?? false,
        },
      });
    }
  }

  return results;
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Quick search for a tool by exact name
 */
export async function findToolByName(
  session: SessionState,
  toolName: string,
  serverPattern?: string
): Promise<SearchToolResult | null> {
  const clients = getMatchingClients(session, serverPattern);

  for (const { name: serverName, client } of clients) {
    try {
      const tools = await client.listTools();
      const tool = tools.find((t) => t.name === toolName);

      if (tool) {
        return {
          server: serverName,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        };
      }
    } catch {
      // Skip servers that fail
    }
  }

  return null;
}

/**
 * List all capabilities (tools, resources, prompts) without filtering
 */
export async function listAllCapabilities(
  session: SessionState,
  sessionManager: SessionManager
): Promise<SearchResult> {
  return search(
    { query: ".*", type: "all", includeSchemas: false },
    { session, sessionManager }
  );
}
