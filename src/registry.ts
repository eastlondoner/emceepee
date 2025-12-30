/**
 * Backend Server Registry
 *
 * Manages connections to multiple backend MCP servers, handles notifications,
 * and provides aggregated access to tools, resources, and prompts.
 */

import { MCPHttpClient } from "./client.js";
import type {
  BackendServerConfig,
  BackendServerInfo,
  BackendTool,
  BackendResource,
  BackendPrompt,
  BackendResourceTemplate,
  BufferedNotification,
  BufferedLog,
  PendingSamplingRequest,
  PendingElicitationRequest,
  SamplingRequestInfo,
  ElicitationRequestInfo,
} from "./types.js";
import type {
  GetPromptResult,
  ReadResourceResult,
  CreateMessageResult,
  ElicitResult,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Options for creating a ServerRegistry
 */
export interface ServerRegistryOptions {
  /** Callback when any server's status changes */
  onServerStatusChange?: (serverName: string, status: BackendServerInfo) => void;
  /** Timeout in ms for sampling/elicitation requests (default: 5 minutes) */
  requestTimeoutMs?: number;
}

/**
 * Registry for managing multiple backend MCP server connections.
 *
 * Provides methods to:
 * - Add and remove backend servers
 * - List connected servers with their status
 * - Access tools, resources, and prompts from backends
 * - Execute tools on specific backends
 * - Buffer and retrieve notifications
 * - Buffer and respond to sampling/elicitation requests
 */
export class ServerRegistry {
  private readonly clients = new Map<string, MCPHttpClient>();
  private readonly notifications: BufferedNotification[] = [];
  private readonly logs: BufferedLog[] = [];
  private readonly pendingSamplingRequests = new Map<string, PendingSamplingRequest>();
  private readonly pendingElicitationRequests = new Map<string, PendingElicitationRequest>();
  private readonly onServerStatusChange:
    | ((serverName: string, status: BackendServerInfo) => void)
    | undefined;
  private readonly requestTimeoutMs: number;

  constructor(options: ServerRegistryOptions = {}) {
    this.onServerStatusChange = options.onServerStatusChange;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 300000; // 5 minutes default
  }

  /**
   * Add and connect to a new backend server
   *
   * @param config - Server configuration with name and URL
   * @throws Error if a server with this name already exists
   */
  public async addServer(config: BackendServerConfig): Promise<void> {
    if (this.clients.has(config.name)) {
      throw new Error(`Server '${config.name}' already exists`);
    }

    const client = new MCPHttpClient({
      name: config.name,
      url: config.url,
      onStatusChange: (status, error): void => {
        this.handleStatusChange(config.name, status, error);
      },
      onNotification: (notification): void => {
        this.notifications.push(notification);
      },
      onLog: (log): void => {
        this.logs.push(log);
      },
      onSamplingRequest: (request): void => {
        this.handleIncomingSamplingRequest(request);
      },
      onElicitationRequest: (request): void => {
        this.handleIncomingElicitationRequest(request);
      },
    });

    this.clients.set(config.name, client);

    try {
      await client.connect();
    } catch (err) {
      // Keep the client in the registry even if connection fails
      // so user can see the error status
      const message = err instanceof Error ? err.message : String(err);
      this.handleStatusChange(config.name, "error", message);
    }
  }

  /**
   * Remove and disconnect from a backend server
   *
   * @param name - Name of the server to remove
   * @throws Error if server doesn't exist
   */
  public async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`Server '${name}' not found`);
    }

    // Reject any pending sampling requests from this server
    for (const [id, request] of this.pendingSamplingRequests) {
      if (request.server === name) {
        request.reject(new Error(`Server '${name}' disconnected`));
        this.pendingSamplingRequests.delete(id);
      }
    }

    // Reject any pending elicitation requests from this server
    for (const [id, request] of this.pendingElicitationRequests) {
      if (request.server === name) {
        request.reject(new Error(`Server '${name}' disconnected`));
        this.pendingElicitationRequests.delete(id);
      }
    }

    await client.disconnect();
    this.clients.delete(name);
  }

  /**
   * Get information about all registered servers
   */
  public listServers(): BackendServerInfo[] {
    const servers: BackendServerInfo[] = [];
    for (const client of this.clients.values()) {
      servers.push(client.getInfo());
    }
    return servers;
  }

  /**
   * Get information about a specific server
   *
   * @param name - Name of the server
   * @returns Server info or undefined if not found
   */
  public getServer(name: string): BackendServerInfo | undefined {
    const client = this.clients.get(name);
    return client?.getInfo();
  }

  /**
   * Check if a server exists in the registry
   */
  public hasServer(name: string): boolean {
    return this.clients.has(name);
  }

  /**
   * List tools from one or all backend servers
   *
   * @param serverName - Optional server name to filter by
   * @returns Array of tools with their server names
   */
  public async listTools(serverName?: string): Promise<BackendTool[]> {
    const tools: BackendTool[] = [];

    if (serverName !== undefined) {
      const client = this.getConnectedClient(serverName);
      const serverTools = await client.listTools();
      for (const tool of serverTools) {
        tools.push({ ...tool, server: serverName });
      }
    } else {
      for (const [name, client] of this.clients) {
        if (client.isConnected()) {
          try {
            const serverTools = await client.listTools();
            for (const tool of serverTools) {
              tools.push({ ...tool, server: name });
            }
          } catch {
            // Skip servers that fail to list tools
          }
        }
      }
    }

    return tools;
  }

  /**
   * Execute a tool on a specific backend server
   *
   * @param serverName - Name of the server
   * @param toolName - Name of the tool to execute
   * @param args - Arguments to pass to the tool
   */
  public async executeTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<CallToolResult> {
    const client = this.getConnectedClient(serverName);
    return await client.callTool(toolName, args);
  }

  /**
   * List resources from one or all backend servers
   *
   * @param serverName - Optional server name to filter by
   */
  public async listResources(serverName?: string): Promise<BackendResource[]> {
    const resources: BackendResource[] = [];

    if (serverName !== undefined) {
      const client = this.getConnectedClient(serverName);
      const serverResources = await client.listResources();
      for (const resource of serverResources) {
        resources.push({ ...resource, server: serverName });
      }
    } else {
      for (const [name, client] of this.clients) {
        if (client.isConnected()) {
          try {
            const serverResources = await client.listResources();
            for (const resource of serverResources) {
              resources.push({ ...resource, server: name });
            }
          } catch {
            // Skip servers that fail to list resources
          }
        }
      }
    }

    return resources;
  }

  /**
   * List resource templates from one or all backend servers
   *
   * @param serverName - Optional server name to filter by
   */
  public async listResourceTemplates(serverName?: string): Promise<BackendResourceTemplate[]> {
    const templates: BackendResourceTemplate[] = [];

    if (serverName !== undefined) {
      const client = this.getConnectedClient(serverName);
      const serverTemplates = await client.listResourceTemplates();
      for (const template of serverTemplates) {
        templates.push({ ...template, server: serverName });
      }
    } else {
      for (const [name, client] of this.clients) {
        if (client.isConnected()) {
          try {
            const serverTemplates = await client.listResourceTemplates();
            for (const template of serverTemplates) {
              templates.push({ ...template, server: name });
            }
          } catch {
            // Skip servers that fail to list templates
          }
        }
      }
    }

    return templates;
  }

  /**
   * Read a resource from a specific backend server
   *
   * @param serverName - Name of the server
   * @param uri - Resource URI
   */
  public async readResource(serverName: string, uri: string): Promise<ReadResourceResult> {
    const client = this.getConnectedClient(serverName);
    return client.readResource(uri);
  }

  /**
   * List prompts from one or all backend servers
   *
   * @param serverName - Optional server name to filter by
   */
  public async listPrompts(serverName?: string): Promise<BackendPrompt[]> {
    const prompts: BackendPrompt[] = [];

    if (serverName !== undefined) {
      const client = this.getConnectedClient(serverName);
      const serverPrompts = await client.listPrompts();
      for (const prompt of serverPrompts) {
        prompts.push({ ...prompt, server: serverName });
      }
    } else {
      for (const [name, client] of this.clients) {
        if (client.isConnected()) {
          try {
            const serverPrompts = await client.listPrompts();
            for (const prompt of serverPrompts) {
              prompts.push({ ...prompt, server: name });
            }
          } catch {
            // Skip servers that fail to list prompts
          }
        }
      }
    }

    return prompts;
  }

  /**
   * Get a prompt from a specific backend server
   *
   * @param serverName - Name of the server
   * @param promptName - Name of the prompt
   * @param args - Arguments to pass to the prompt
   */
  public async getPrompt(
    serverName: string,
    promptName: string,
    args: Record<string, string> = {}
  ): Promise<GetPromptResult> {
    const client = this.getConnectedClient(serverName);
    return client.getPrompt(promptName, args);
  }

  /**
   * Get and clear all buffered notifications
   *
   * @returns Array of notifications that were buffered since the last call
   */
  public getNotifications(): BufferedNotification[] {
    const notifications = [...this.notifications];
    this.notifications.length = 0;
    return notifications;
  }

  /**
   * Get the count of buffered notifications without clearing
   */
  public getNotificationCount(): number {
    return this.notifications.length;
  }

  /**
   * Disconnect from all backend servers and clear the registry
   */
  public async shutdown(): Promise<void> {
    // Reject all pending requests
    for (const request of this.pendingSamplingRequests.values()) {
      request.reject(new Error("Registry shutting down"));
    }
    this.pendingSamplingRequests.clear();

    for (const request of this.pendingElicitationRequests.values()) {
      request.reject(new Error("Registry shutting down"));
    }
    this.pendingElicitationRequests.clear();

    const disconnectPromises: Promise<void>[] = [];

    for (const client of this.clients.values()) {
      disconnectPromises.push(client.disconnect());
    }

    await Promise.all(disconnectPromises);
    this.clients.clear();
    this.notifications.length = 0;
    this.logs.length = 0;
  }

  // ===========================================================================
  // Logging Methods
  // ===========================================================================

  /**
   * Get and clear all buffered log messages
   *
   * @returns Array of log messages that were buffered since the last call
   */
  public getLogs(): BufferedLog[] {
    const logs = [...this.logs];
    this.logs.length = 0;
    return logs;
  }

  /**
   * Get the count of buffered log messages without clearing
   */
  public getLogCount(): number {
    return this.logs.length;
  }

  // ===========================================================================
  // Sampling Methods
  // ===========================================================================

  /**
   * Get all pending sampling requests (does NOT clear them - they must be responded to)
   *
   * @returns Array of pending sampling request info
   */
  public getPendingSamplingRequests(): SamplingRequestInfo[] {
    return Array.from(this.pendingSamplingRequests.values()).map((r) => ({
      id: r.id,
      server: r.server,
      timestamp: r.timestamp,
      params: r.params,
    }));
  }

  /**
   * Get the count of pending sampling requests
   */
  public getPendingSamplingRequestCount(): number {
    return this.pendingSamplingRequests.size;
  }

  /**
   * Respond to a pending sampling request with an LLM result
   *
   * @param requestId - The ID of the sampling request to respond to
   * @param result - The LLM result to send back to the backend
   * @throws Error if request not found or already completed
   */
  public respondToSamplingRequest(
    requestId: string,
    result: CreateMessageResult
  ): void {
    const pending = this.pendingSamplingRequests.get(requestId);
    if (!pending) {
      throw new Error(`Sampling request '${requestId}' not found or already completed`);
    }

    this.pendingSamplingRequests.delete(requestId);
    pending.resolve(result);
  }

  /**
   * Reject a pending sampling request with an error
   *
   * @param requestId - The ID of the sampling request to reject
   * @param error - Error message to send back
   * @throws Error if request not found or already completed
   */
  public rejectSamplingRequest(requestId: string, error: string): void {
    const pending = this.pendingSamplingRequests.get(requestId);
    if (!pending) {
      throw new Error(`Sampling request '${requestId}' not found or already completed`);
    }

    this.pendingSamplingRequests.delete(requestId);
    pending.reject(new Error(error));
  }

  // ===========================================================================
  // Elicitation Methods
  // ===========================================================================

  /**
   * Get all pending elicitation requests (does NOT clear them - they must be responded to)
   *
   * @returns Array of pending elicitation request info
   */
  public getPendingElicitationRequests(): ElicitationRequestInfo[] {
    return Array.from(this.pendingElicitationRequests.values()).map((r) => ({
      id: r.id,
      server: r.server,
      timestamp: r.timestamp,
      params: r.params,
    }));
  }

  /**
   * Get the count of pending elicitation requests
   */
  public getPendingElicitationRequestCount(): number {
    return this.pendingElicitationRequests.size;
  }

  /**
   * Respond to a pending elicitation request with user input
   *
   * @param requestId - The ID of the elicitation request to respond to
   * @param result - The user's response
   * @throws Error if request not found or already completed
   */
  public respondToElicitationRequest(
    requestId: string,
    result: ElicitResult
  ): void {
    const pending = this.pendingElicitationRequests.get(requestId);
    if (!pending) {
      throw new Error(`Elicitation request '${requestId}' not found or already completed`);
    }

    this.pendingElicitationRequests.delete(requestId);
    pending.resolve(result);
  }

  /**
   * Reject a pending elicitation request with an error
   *
   * @param requestId - The ID of the elicitation request to reject
   * @param error - Error message to send back
   * @throws Error if request not found or already completed
   */
  public rejectElicitationRequest(requestId: string, error: string): void {
    const pending = this.pendingElicitationRequests.get(requestId);
    if (!pending) {
      throw new Error(`Elicitation request '${requestId}' not found or already completed`);
    }

    this.pendingElicitationRequests.delete(requestId);
    pending.reject(new Error(error));
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  /**
   * Handle an incoming sampling request from a backend server
   */
  private handleIncomingSamplingRequest(request: PendingSamplingRequest): void {
    this.pendingSamplingRequests.set(request.id, request);

    // Set up timeout
    setTimeout(() => {
      const pending = this.pendingSamplingRequests.get(request.id);
      if (pending) {
        this.pendingSamplingRequests.delete(request.id);
        pending.reject(new Error(`Sampling request timed out after ${String(this.requestTimeoutMs)}ms`));
      }
    }, this.requestTimeoutMs);
  }

  /**
   * Handle an incoming elicitation request from a backend server
   */
  private handleIncomingElicitationRequest(request: PendingElicitationRequest): void {
    this.pendingElicitationRequests.set(request.id, request);

    // Set up timeout
    setTimeout(() => {
      const pending = this.pendingElicitationRequests.get(request.id);
      if (pending) {
        this.pendingElicitationRequests.delete(request.id);
        pending.reject(new Error(`Elicitation request timed out after ${String(this.requestTimeoutMs)}ms`));
      }
    }, this.requestTimeoutMs);
  }

  /**
   * Get a connected client, throwing if not found or not connected
   */
  private getConnectedClient(name: string): MCPHttpClient {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`Server '${name}' not found`);
    }
    if (!client.isConnected()) {
      throw new Error(`Server '${name}' is not connected`);
    }
    return client;
  }

  /**
   * Handle status changes from clients
   */
  private handleStatusChange(
    serverName: string,
    status: string,
    error?: string
  ): void {
    if (this.onServerStatusChange !== undefined) {
      const client = this.clients.get(serverName);
      if (client) {
        this.onServerStatusChange(serverName, client.getInfo());
      }
    }
    // Log status changes for debugging
    if (error !== undefined) {
      console.error(`[${serverName}] ${status}: ${error}`);
    }
  }
}
