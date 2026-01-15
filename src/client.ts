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
 * Health status of the connection
 */
export type HealthStatus = "healthy" | "degraded";

/**
 * Options for creating an MCPHttpClient
 */
export interface MCPHttpClientOptions {
  /** Unique name for this backend server */
  name: string;
  /** HTTP URL of the MCP server endpoint */
  url: string;
  /** Custom headers to send with requests (e.g., Authorization) */
  headers?: Record<string, string>;
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
  /** Callback when a reconnection attempt starts */
  onReconnecting?: (attempt: number, nextRetryMs: number) => void;
  /** Callback when successfully reconnected */
  onReconnected?: (attemptsTaken: number) => void;
  /** Callback when health degrades (3+ consecutive failures) */
  onHealthDegraded?: (failures: number, lastError: string) => void;
  /** Callback when health is restored after being degraded */
  onHealthRestored?: () => void;
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
// Reconnection constants
const RECONNECT_BASE_DELAY_MS = 1000;      // 1 second
const RECONNECT_MAX_DELAY_MS = 180000;     // 180 seconds (3 minutes)
const RECONNECT_BACKOFF_MULTIPLIER = 2;
const RECONNECT_JITTER_FACTOR = 0.1;       // 10% jitter

// Health check constants
const HEALTH_CHECK_INTERVAL_MS = 120000;   // 120 seconds
const HEALTH_CHECK_JITTER_FACTOR = 0.1;    // 10% jitter
const HEALTH_CHECK_TIMEOUT_MS = 60000;     // 60 seconds
const HEALTH_CHECK_DEGRADED_THRESHOLD = 3; // 3 consecutive failures

export class MCPHttpClient {
  private readonly name: string;
  private readonly url: string;
  private readonly headers: Record<string, string> | undefined;
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
  private readonly onReconnecting:
    | ((attempt: number, nextRetryMs: number) => void)
    | undefined;
  private readonly onReconnected: ((attemptsTaken: number) => void) | undefined;
  private readonly onHealthDegraded:
    | ((failures: number, lastError: string) => void)
    | undefined;
  private readonly onHealthRestored: (() => void) | undefined;

  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private status: BackendServerStatus = "disconnected";
  private errorMessage: string | undefined;
  private capabilities: BackendServerInfo["capabilities"] | undefined;
  private isClosing = false;

  // Reconnection state
  private reconnectAttempt = 0;
  private reconnectTimeoutHandle: NodeJS.Timeout | null = null;
  private nextRetryMs = 0;
  private isReconnecting = false;

  // Health check state
  private healthCheckIntervalHandle: NodeJS.Timeout | null = null;
  private consecutiveHealthFailures = 0;
  private healthStatus: HealthStatus = "healthy";

  constructor(options: MCPHttpClientOptions) {
    this.name = options.name;
    this.url = options.url;
    this.headers = options.headers;
    this.onStatusChange = options.onStatusChange;
    this.onNotification = options.onNotification;
    this.onLog = options.onLog;
    this.onSamplingRequest = options.onSamplingRequest;
    this.onElicitationRequest = options.onElicitationRequest;
    this.onReconnecting = options.onReconnecting;
    this.onReconnected = options.onReconnected;
    this.onHealthDegraded = options.onHealthDegraded;
    this.onHealthRestored = options.onHealthRestored;
  }

  /**
   * Get the transport type for this client
   */
  public getTransportType(): "http" {
    return "http";
  }

  /**
   * Get the server URL
   */
  public getUrl(): string {
    return this.url;
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
   * Get reconnection state if currently reconnecting
   */
  public getReconnectionState(): { attempt: number; nextRetryMs: number } | null {
    if (this.status !== "reconnecting") {
      return null;
    }
    return {
      attempt: this.reconnectAttempt,
      nextRetryMs: this.nextRetryMs,
    };
  }

  /**
   * Get health status
   */
  public getHealthStatus(): HealthStatus {
    return this.healthStatus;
  }

  /**
   * Get consecutive health check failures count
   */
  public getConsecutiveHealthFailures(): number {
    return this.consecutiveHealthFailures;
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
      // Create the transport with optional custom headers
      const transportOptions: { requestInit?: { headers: Record<string, string> } } = {};
      if (this.headers) {
        transportOptions.requestInit = { headers: this.headers };
      }
      this.transport = new StreamableHTTPClientTransport(new URL(this.url), transportOptions);

      // Create the client with capabilities for receiving server requests
      this.client = new Client(
        {
          name: "emceepee",
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
        // Only handle if not already closing (avoid duplicate handling)
        if (!this.isClosing) {
          this.handleUnexpectedDisconnect();
        }
      };

      this.transport.onerror = (error): void => {
        // Ignore AbortError during/after intentional disconnect
        const isAbortError = error.name === "AbortError" || error.message.includes("AbortError");
        if (isAbortError && (this.isClosing || this.status === "disconnected")) {
          return;
        }
        this.errorMessage = error.message;
        this.handleUnexpectedDisconnect();
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
        resourceSubscriptions: serverCapabilities?.resources?.subscribe === true,
      };

      this.setStatus("connected");

      // Start health checks
      this.startHealthChecks();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("error", message);
      throw err;
    }
  }

  /**
   * Disconnect from the backend MCP server (intentional disconnect)
   */
  public async disconnect(): Promise<void> {
    this.isClosing = true;

    // Stop health checks
    this.stopHealthChecks();

    // Cancel any pending reconnection
    this.cancelReconnection();

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
   * Force reconnection to the backend server.
   * Works on connected, disconnected, or reconnecting servers.
   */
  public async forceReconnect(): Promise<void> {
    // Stop health checks
    this.stopHealthChecks();

    // Cancel any pending reconnection
    this.cancelReconnection();

    // Close existing connection if any
    if (this.transport) {
      this.isClosing = true;
      try {
        await this.transport.close();
      } catch {
        // Ignore close errors
      }
      this.isClosing = false;
    }

    this.client = null;
    this.transport = null;

    // Reset reconnection state
    this.reconnectAttempt = 0;
    this.nextRetryMs = 0;

    // Reset health state
    this.consecutiveHealthFailures = 0;
    this.healthStatus = "healthy";

    // Connect (this will throw if it fails)
    await this.connect();
  }

  /**
   * Cancel any scheduled reconnection attempt
   */
  public cancelReconnection(): void {
    if (this.reconnectTimeoutHandle) {
      clearTimeout(this.reconnectTimeoutHandle);
      this.reconnectTimeoutHandle = null;
    }
    this.isReconnecting = false;
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
   * Subscribe to updates for a specific resource.
   * The server will send notifications/resources/updated when the resource changes.
   * @throws Error if the server doesn't support resource subscriptions
   */
  public async subscribeResource(uri: string): Promise<void> {
    const client = this.getConnectedClient();

    if (!this.capabilities?.resourceSubscriptions) {
      throw new Error(
        `Server '${this.name}' does not support resource subscriptions`
      );
    }

    await client.subscribeResource({ uri });
  }

  /**
   * Unsubscribe from updates for a specific resource.
   * @throws Error if the server doesn't support resource subscriptions
   */
  public async unsubscribeResource(uri: string): Promise<void> {
    const client = this.getConnectedClient();

    if (!this.capabilities?.resourceSubscriptions) {
      throw new Error(
        `Server '${this.name}' does not support resource subscriptions`
      );
    }

    await client.unsubscribeResource({ uri });
  }

  /**
   * Check if the server supports resource subscriptions
   */
  public supportsResourceSubscriptions(): boolean {
    return this.capabilities?.resourceSubscriptions === true;
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
   * Handle unexpected disconnection from the backend server.
   * Starts the reconnection process.
   */
  private handleUnexpectedDisconnect(): void {
    // Prevent multiple reconnection attempts
    if (this.isReconnecting || this.isClosing) {
      return;
    }

    // Stop health checks while disconnected
    this.stopHealthChecks();

    // Clean up current connection
    this.client = null;
    this.transport = null;

    // Start reconnection process
    this.isReconnecting = true;
    this.reconnectAttempt = 0;
    this.setStatus("reconnecting", this.errorMessage);

    // Schedule first reconnection attempt
    this.scheduleReconnection();
  }

  /**
   * Schedule the next reconnection attempt with exponential backoff.
   */
  private scheduleReconnection(): void {
    if (this.isClosing) {
      return;
    }

    this.reconnectAttempt++;
    const delay = this.calculateBackoff(this.reconnectAttempt);
    this.nextRetryMs = delay;

    // Notify callback
    if (this.onReconnecting) {
      this.onReconnecting(this.reconnectAttempt, delay);
    }

    this.reconnectTimeoutHandle = setTimeout(() => {
      void this.attemptReconnection();
    }, delay);
  }

  /**
   * Attempt to reconnect to the backend server.
   */
  private async attemptReconnection(): Promise<void> {
    if (this.isClosing) {
      return;
    }

    try {
      // Create new transport with optional custom headers
      const transportOptions: { requestInit?: { headers: Record<string, string> } } = {};
      if (this.headers) {
        transportOptions.requestInit = { headers: this.headers };
      }
      this.transport = new StreamableHTTPClientTransport(new URL(this.url), transportOptions);

      // Create new client
      this.client = new Client(
        {
          name: "emceepee",
          version: "0.1.0",
        },
        {
          capabilities: {
            sampling: {},
            elicitation: {
              form: {},
            },
          },
        }
      );

      // Set up notification handler before connecting
      this.setupNotificationHandler();

      // Set up transport event handlers for future disconnects
      this.transport.onclose = (): void => {
        if (!this.isClosing) {
          this.handleUnexpectedDisconnect();
        }
      };

      this.transport.onerror = (error): void => {
        const isAbortError = error.name === "AbortError" || error.message.includes("AbortError");
        if (isAbortError && (this.isClosing || this.status === "disconnected")) {
          return;
        }
        this.errorMessage = error.message;
        this.handleUnexpectedDisconnect();
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
        resourceSubscriptions: serverCapabilities?.resources?.subscribe === true,
      };

      // Success! Reset reconnection state
      const attemptsTaken = this.reconnectAttempt;
      this.reconnectAttempt = 0;
      this.nextRetryMs = 0;
      this.isReconnecting = false;

      // Reset health state
      this.consecutiveHealthFailures = 0;
      this.healthStatus = "healthy";

      this.setStatus("connected");

      // Notify callback
      if (this.onReconnected) {
        this.onReconnected(attemptsTaken);
      }

      // Start health checks
      this.startHealthChecks();
    } catch (err) {
      // Clean up failed attempt
      this.client = null;
      this.transport = null;
      this.errorMessage = err instanceof Error ? err.message : String(err);

      // Schedule next attempt
      this.scheduleReconnection();
    }
  }

  /**
   * Calculate reconnection delay with exponential backoff and jitter.
   */
  private calculateBackoff(attempt: number): number {
    // Calculate base delay with exponential backoff
    const exponentialDelay =
      RECONNECT_BASE_DELAY_MS * Math.pow(RECONNECT_BACKOFF_MULTIPLIER, attempt - 1);

    // Cap at max delay
    const cappedDelay = Math.min(exponentialDelay, RECONNECT_MAX_DELAY_MS);

    // Add jitter (±10%)
    const jitter = cappedDelay * RECONNECT_JITTER_FACTOR * (Math.random() * 2 - 1);

    return Math.round(cappedDelay + jitter);
  }

  /**
   * Start periodic health checks.
   */
  private startHealthChecks(): void {
    // Clear any existing interval
    this.stopHealthChecks();

    // Schedule first health check with jitter
    const scheduleNextCheck = (): void => {
      const jitter = HEALTH_CHECK_INTERVAL_MS * HEALTH_CHECK_JITTER_FACTOR * (Math.random() * 2 - 1);
      const interval = Math.round(HEALTH_CHECK_INTERVAL_MS + jitter);

      this.healthCheckIntervalHandle = setTimeout(() => {
        void this.performHealthCheck();
        scheduleNextCheck();
      }, interval);
    };

    scheduleNextCheck();
  }

  /**
   * Stop periodic health checks.
   */
  private stopHealthChecks(): void {
    if (this.healthCheckIntervalHandle) {
      clearTimeout(this.healthCheckIntervalHandle);
      this.healthCheckIntervalHandle = null;
    }
  }

  /**
   * Perform a single health check using tools/list.
   * Health check failures increment a counter and emit events when degraded,
   * but do NOT trigger reconnection (to preserve SSE session for network recovery).
   */
  private async performHealthCheck(): Promise<void> {
    if (!this.client || !this.isConnected()) {
      return;
    }

    try {
      // Use AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, HEALTH_CHECK_TIMEOUT_MS);

      try {
        // Try to list tools as health check
        await this.client.listTools();

        // Success - reset failure counter
        clearTimeout(timeoutId);

        if (this.consecutiveHealthFailures > 0) {
          const wasDegraaded = this.healthStatus === "degraded";
          this.consecutiveHealthFailures = 0;
          this.healthStatus = "healthy";

          if (wasDegraaded && this.onHealthRestored) {
            this.onHealthRestored();
          }
        }
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      }
    } catch (err) {
      this.consecutiveHealthFailures++;
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Check if we've crossed the degraded threshold
      if (
        this.consecutiveHealthFailures >= HEALTH_CHECK_DEGRADED_THRESHOLD &&
        this.healthStatus !== "degraded"
      ) {
        this.healthStatus = "degraded";
        if (this.onHealthDegraded) {
          this.onHealthDegraded(this.consecutiveHealthFailures, errorMessage);
        }
      }
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
