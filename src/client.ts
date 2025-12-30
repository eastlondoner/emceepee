/**
 * HTTP MCP Client Wrapper
 *
 * Provides a wrapper around the MCP SDK Client with StreamableHTTPClientTransport
 * for connecting to backend MCP servers over HTTP.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  Tool,
  Resource,
  Prompt,
  ResourceTemplate,
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  JSONRPCNotification,
  CreateMessageResult,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
  LoggingMessageNotificationSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  BackendServerStatus,
  BackendServerInfo,
  BufferedNotification,
  BufferedLog,
  PendingSamplingRequest,
  PendingElicitationRequest,
} from "./types.js";

/**
 * Options for creating an MCPHttpClient
 */
export interface MCPHttpClientOptions {
  /** Unique name for this backend server */
  name: string;
  /** HTTP URL of the MCP server endpoint */
  url: string;
  /** Callback when the connection status changes */
  onStatusChange?: (status: BackendServerStatus, error?: string) => void;
  /** Callback when a notification is received from the server */
  onNotification?: (notification: BufferedNotification) => void;
  /** Callback when a log message is received from the server */
  onLog?: (log: BufferedLog) => void;
  /** Callback when a sampling request is received from the server */
  onSamplingRequest?: (request: PendingSamplingRequest) => void;
  /** Callback when an elicitation request is received from the server */
  onElicitationRequest?: (request: PendingElicitationRequest) => void;
}

/**
 * HTTP MCP Client wrapper for connecting to backend MCP servers.
 *
 * This class wraps the MCP SDK's Client and StreamableHTTPClientTransport
 * to provide a simpler interface for:
 * - Connecting to HTTP MCP servers
 * - Listing and calling tools
 * - Listing and reading resources
 * - Listing and getting prompts
 * - Handling notifications
 */
export class MCPHttpClient {
  private readonly name: string;
  private readonly url: string;
  private readonly onStatusChange:
    | ((status: BackendServerStatus, error?: string) => void)
    | undefined;
  private readonly onNotification:
    | ((notification: BufferedNotification) => void)
    | undefined;
  private readonly onLog: ((log: BufferedLog) => void) | undefined;
  private readonly onSamplingRequest:
    | ((request: PendingSamplingRequest) => void)
    | undefined;
  private readonly onElicitationRequest:
    | ((request: PendingElicitationRequest) => void)
    | undefined;

  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private status: BackendServerStatus = "disconnected";
  private errorMessage: string | undefined;
  private capabilities: BackendServerInfo["capabilities"] | undefined;
  private isClosing = false;

  constructor(options: MCPHttpClientOptions) {
    this.name = options.name;
    this.url = options.url;
    this.onStatusChange = options.onStatusChange;
    this.onNotification = options.onNotification;
    this.onLog = options.onLog;
    this.onSamplingRequest = options.onSamplingRequest;
    this.onElicitationRequest = options.onElicitationRequest;
  }

  /**
   * Get the current status of this client
   */
  public getInfo(): BackendServerInfo {
    const info: BackendServerInfo = {
      name: this.name,
      url: this.url,
      status: this.status,
    };

    if (this.errorMessage !== undefined) {
      info.error = this.errorMessage;
    }

    if (this.capabilities !== undefined) {
      info.capabilities = this.capabilities;
    }

    return info;
  }

  /**
   * Get the server name
   */
  public getName(): string {
    return this.name;
  }

  /**
   * Get the current connection status
   */
  public getStatus(): BackendServerStatus {
    return this.status;
  }

  /**
   * Check if the client is connected
   */
  public isConnected(): boolean {
    return this.status === "connected";
  }

  /**
   * Connect to the backend MCP server
   */
  public async connect(): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") {
      return;
    }

    this.setStatus("connecting");

    try {
      // Create the transport
      this.transport = new StreamableHTTPClientTransport(new URL(this.url));

      // Create the client with capabilities for receiving server requests
      this.client = new Client(
        {
          name: "mcp-proxy",
          version: "0.1.0",
        },
        {
          capabilities: {
            // Advertise support for sampling (server can request LLM completions)
            sampling: {},
            // Advertise support for elicitation (server can request user input)
            elicitation: {
              form: {},
            },
          },
        }
      );

      // Set up notification handler before connecting
      this.setupNotificationHandler();

      // Set up transport event handlers
      this.transport.onclose = (): void => {
        // Only set disconnected if not already closing (avoid duplicate status)
        if (!this.isClosing) {
          this.setStatus("disconnected");
        }
      };

      this.transport.onerror = (error): void => {
        // Ignore AbortError during/after intentional disconnect
        const isAbortError = error.name === "AbortError" || error.message.includes("AbortError");
        if (isAbortError && (this.isClosing || this.status === "disconnected")) {
          return;
        }
        this.setStatus("error", error.message);
      };

      // Connect and initialize
      await this.client.connect(this.transport);

      // Get server capabilities
      const serverCapabilities = this.client.getServerCapabilities();
      this.capabilities = {
        tools: serverCapabilities?.tools !== undefined,
        resources: serverCapabilities?.resources !== undefined,
        prompts: serverCapabilities?.prompts !== undefined,
        resourceTemplates: serverCapabilities?.resources !== undefined,
      };

      this.setStatus("connected");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("error", message);
      throw err;
    }
  }

  /**
   * Disconnect from the backend MCP server
   */
  public async disconnect(): Promise<void> {
    this.isClosing = true;

    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Ignore close errors
      }
    }

    this.client = null;
    this.transport = null;
    this.isClosing = false;
    this.setStatus("disconnected");
  }

  /**
   * List all tools available on the backend server
   */
  public async listTools(): Promise<Tool[]> {
    const client = this.getConnectedClient();
    if (!this.capabilities?.tools) {
      return [];
    }

    const result = await client.listTools();
    return result.tools;
  }

  /**
   * Call a tool on the backend server
   */
  public async callTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<CallToolResult> {
    const client = this.getConnectedClient();

    const result = await client.callTool({
      name,
      arguments: args,
    });

    return result as CallToolResult;
  }

  /**
   * List all resources available on the backend server
   */
  public async listResources(): Promise<Resource[]> {
    const client = this.getConnectedClient();
    if (!this.capabilities?.resources) {
      return [];
    }

    const result = await client.listResources();
    return result.resources;
  }

  /**
   * List all resource templates available on the backend server
   */
  public async listResourceTemplates(): Promise<ResourceTemplate[]> {
    const client = this.getConnectedClient();
    if (!this.capabilities?.resourceTemplates) {
      return [];
    }

    const result = await client.listResourceTemplates();
    return result.resourceTemplates;
  }

  /**
   * Read a resource from the backend server
   */
  public async readResource(uri: string): Promise<ReadResourceResult> {
    const client = this.getConnectedClient();

    const result = await client.readResource({ uri });
    return result;
  }

  /**
   * List all prompts available on the backend server
   */
  public async listPrompts(): Promise<Prompt[]> {
    const client = this.getConnectedClient();
    if (!this.capabilities?.prompts) {
      return [];
    }

    const result = await client.listPrompts();
    return result.prompts;
  }

  /**
   * Get a prompt from the backend server
   */
  public async getPrompt(
    name: string,
    args: Record<string, string> = {}
  ): Promise<GetPromptResult> {
    const client = this.getConnectedClient();

    const result = await client.getPrompt({
      name,
      arguments: args,
    });

    return result;
  }

  /**
   * Set up notification and request handlers for the client
   */
  private setupNotificationHandler(): void {
    if (!this.client) return;

    // Handle tools/list_changed
    this.client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      () => {
        this.emitNotification("notifications/tools/list_changed");
      }
    );

    // Handle resources/list_changed
    this.client.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      () => {
        this.emitNotification("notifications/resources/list_changed");
      }
    );

    // Handle resources/updated (individual resource content changed)
    this.client.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      (notification) => {
        this.emitNotification("notifications/resources/updated", notification.params);
      }
    );

    // Handle prompts/list_changed
    this.client.setNotificationHandler(
      PromptListChangedNotificationSchema,
      () => {
        this.emitNotification("notifications/prompts/list_changed");
      }
    );

    // Handle logging/message notifications
    this.client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      (notification) => {
        if (this.onLog) {
          this.onLog({
            server: this.name,
            timestamp: new Date(),
            level: notification.params.level,
            logger: notification.params.logger,
            data: notification.params.data,
          });
        }
      }
    );

    // Handle sampling/createMessage requests
    // This is a SERVER -> CLIENT request where the server asks us to generate an LLM response
    this.client.setRequestHandler(
      CreateMessageRequestSchema,
      (request): Promise<CreateMessageResult> => {
        return new Promise((resolve, reject) => {
          if (this.onSamplingRequest) {
            this.onSamplingRequest({
              id: crypto.randomUUID(),
              server: this.name,
              timestamp: new Date(),
              params: request.params,
              resolve,
              reject,
            });
          } else {
            reject(new Error("Sampling not supported: no handler registered"));
          }
        });
      }
    );

    // Handle elicitation/create requests
    // This is a SERVER -> CLIENT request where the server asks us for user input
    this.client.setRequestHandler(
      ElicitRequestSchema,
      (request): Promise<ElicitResult> => {
        return new Promise((resolve, reject) => {
          if (this.onElicitationRequest) {
            this.onElicitationRequest({
              id: crypto.randomUUID(),
              server: this.name,
              timestamp: new Date(),
              params: request.params,
              resolve,
              reject,
            });
          } else {
            reject(new Error("Elicitation not supported: no handler registered"));
          }
        });
      }
    );
  }

  /**
   * Emit a notification to the callback
   */
  private emitNotification(
    method: string,
    params?: JSONRPCNotification["params"]
  ): void {
    if (this.onNotification !== undefined) {
      this.onNotification({
        server: this.name,
        timestamp: new Date(),
        method,
        params,
      });
    }
  }

  /**
   * Update the connection status and notify the callback
   */
  private setStatus(status: BackendServerStatus, error?: string): void {
    this.status = status;

    if (status === "error" && error !== undefined) {
      this.errorMessage = error;
    } else {
      this.errorMessage = undefined;
    }

    if (this.onStatusChange !== undefined) {
      this.onStatusChange(status, error);
    }
  }

  /**
   * Get the connected client, throwing if not connected
   */
  private getConnectedClient(): Client {
    if (!this.isConnected() || !this.client) {
      throw new Error(`Client '${this.name}' is not connected`);
    }
    return this.client;
  }
}
