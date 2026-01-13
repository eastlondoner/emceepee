/**
 * Stdio MCP Client
 *
 * Provides a client for connecting to MCP servers via stdio transport.
 * Spawns a child process and communicates via stdin/stdout.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  Tool,
  Resource,
  Prompt,
  ResourceTemplate,
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  JSONRPCNotification,
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
import type { Readable } from "stream";
import type {
  IMCPClient,
  HealthStatus,
  MCPClientOptionsBase,
  MCPStdioClientOptionsExtension,
} from "./client-interface.js";
import type {
  BackendServerStatus,
  BackendServerInfo,
  BufferedNotification,
  BufferedLog,
  PendingSamplingRequest,
  PendingElicitationRequest,
  StdioRestartConfig,
  StdioLifecycleEvent,
  StdioLifecycleEventData,
} from "./types.js";

// Default restart configuration
const DEFAULT_RESTART_CONFIG: StdioRestartConfig = {
  enabled: true,
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
  resetAfterMs: 300000, // 5 minutes
};

// Health check constants (same as HTTP client)
const HEALTH_CHECK_INTERVAL_MS = 120000;
const HEALTH_CHECK_JITTER_FACTOR = 0.1;
const HEALTH_CHECK_TIMEOUT_MS = 60000;
const HEALTH_CHECK_DEGRADED_THRESHOLD = 3;

/**
 * Options for creating an MCPStdioClient
 */
export interface MCPStdioClientOptions
  extends MCPClientOptionsBase,
    MCPStdioClientOptionsExtension {
  /** Command to execute */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the process */
  env?: Record<string, string>;
  /** Working directory for the process */
  cwd?: string;
  /** Restart configuration */
  restartConfig?: Partial<StdioRestartConfig>;
}

/**
 * Stdio MCP Client for connecting to backend MCP servers via process stdio.
 */
export class MCPStdioClient implements IMCPClient {
  private readonly name: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly env?: Record<string, string>;
  private readonly cwd?: string;
  private readonly restartConfig: StdioRestartConfig;

  // Callbacks
  private readonly onStatusChange?: (status: BackendServerStatus, error?: string) => void;
  private readonly onNotification?: (notification: BufferedNotification) => void;
  private readonly onLog?: (log: BufferedLog) => void;
  private readonly onSamplingRequest?: (request: PendingSamplingRequest) => void;
  private readonly onElicitationRequest?: (request: PendingElicitationRequest) => void;
  private readonly onReconnecting?: (attempt: number, nextRetryMs: number) => void;
  private readonly onReconnected?: (attemptsTaken: number) => void;
  private readonly onHealthDegraded?: (failures: number, lastError: string) => void;
  private readonly onHealthRestored?: () => void;
  private readonly onRestartFailed?: (attempts: number, lastError: string) => void;
  private readonly onLifecycleEvent?: (event: StdioLifecycleEventData) => void;

  // Client state
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private status: BackendServerStatus = "disconnected";
  private errorMessage: string | undefined;
  private capabilities: BackendServerInfo["capabilities"] | undefined;
  private isClosing = false;
  private startTime: Date | null = null;

  // Restart state
  private restartAttempt = 0;
  private restartTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private nextRetryMs = 0;
  private isRestarting = false;
  private lastRestartTime: Date | null = null;
  private lastError: string | undefined;

  // Health check state
  private healthCheckIntervalHandle: ReturnType<typeof setTimeout> | null = null;
  private consecutiveHealthFailures = 0;
  private healthStatus: HealthStatus = "healthy";

  // Process output buffers
  private stderrBuffer: string[] = [];
  private readonly maxBufferSize = 1000;

  constructor(options: MCPStdioClientOptions) {
    this.name = options.name;
    this.command = options.command;
    this.args = options.args ?? [];
    this.env = options.env;
    this.cwd = options.cwd;
    this.restartConfig = { ...DEFAULT_RESTART_CONFIG, ...options.restartConfig };

    // Callbacks
    this.onStatusChange = options.onStatusChange;
    this.onNotification = options.onNotification;
    this.onLog = options.onLog;
    this.onSamplingRequest = options.onSamplingRequest;
    this.onElicitationRequest = options.onElicitationRequest;
    this.onReconnecting = options.onReconnecting;
    this.onReconnected = options.onReconnected;
    this.onHealthDegraded = options.onHealthDegraded;
    this.onHealthRestored = options.onHealthRestored;
    this.onRestartFailed = options.onRestartFailed;
    this.onLifecycleEvent = options.onLifecycleEvent;
  }

  // ---------------------------------------------------------------------------
  // IMCPClient Implementation - Status & Information
  // ---------------------------------------------------------------------------

  public getName(): string {
    return this.name;
  }

  public getTransportType(): "stdio" {
    return "stdio";
  }

  public getStatus(): BackendServerStatus {
    return this.status;
  }

  public isConnected(): boolean {
    return this.status === "connected";
  }

  public getInfo(): BackendServerInfo {
    const info: BackendServerInfo = {
      name: this.name,
      transportType: "stdio",
      command: this.command,
      args: this.args,
      pid: this.transport?.pid ?? undefined,
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

  public getHealthStatus(): HealthStatus {
    return this.healthStatus;
  }

  public getConsecutiveHealthFailures(): number {
    return this.consecutiveHealthFailures;
  }

  public getReconnectionState(): { attempt: number; nextRetryMs: number } | null {
    if (this.status !== "restarting") {
      return null;
    }
    return {
      attempt: this.restartAttempt,
      nextRetryMs: this.nextRetryMs,
    };
  }

  /**
   * Get the process ID (if running)
   */
  public getPid(): number | null {
    return this.transport?.pid ?? null;
  }

  /**
   * Get the command used to start the server
   */
  public getCommand(): string {
    return this.command;
  }

  /**
   * Get the arguments passed to the command
   */
  public getArgs(): string[] {
    return [...this.args];
  }

  /**
   * Get uptime in milliseconds (if running)
   */
  public getUptimeMs(): number | null {
    if (!this.startTime || !this.isConnected()) {
      return null;
    }
    return Date.now() - this.startTime.getTime();
  }

  /**
   * Get the stderr buffer
   */
  public getStderrBuffer(): string[] {
    return [...this.stderrBuffer];
  }

  /**
   * Get stderr buffer size
   */
  public getStderrBufferSize(): number {
    return this.stderrBuffer.length;
  }

  // ---------------------------------------------------------------------------
  // IMCPClient Implementation - Connection Management
  // ---------------------------------------------------------------------------

  public async connect(): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") {
      return;
    }

    this.setStatus("connecting");

    try {
      this.createTransport();
      await this.initializeMCP();

      // Set up stderr capture after process is running
      this.setupStderrCapture();

      this.startTime = new Date();
      this.setStatus("connected");

      // Emit lifecycle event
      this.emitLifecycleEvent("process_started", {
        pid: this.transport?.pid ?? undefined,
        command: this.command,
        args: this.args,
      });

      // Start health checks
      this.startHealthChecks();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("error", message);
      throw err;
    }
  }

  public async disconnect(): Promise<void> {
    this.isClosing = true;
    const pid = this.transport?.pid;
    const uptimeMs = this.getUptimeMs();

    // Stop health checks
    this.stopHealthChecks();

    // Cancel any pending restart
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
    this.startTime = null;
    this.setStatus("disconnected");

    // Emit lifecycle event
    this.emitLifecycleEvent("process_stopped", {
      pid: pid ?? undefined,
      uptimeMs: uptimeMs ?? undefined,
    });
  }

  public async forceReconnect(): Promise<void> {
    // Stop health checks
    this.stopHealthChecks();

    // Cancel any pending restart
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

    // Reset restart state
    this.restartAttempt = 0;
    this.nextRetryMs = 0;

    // Reset health state
    this.consecutiveHealthFailures = 0;
    this.healthStatus = "healthy";

    // Connect (this will throw if it fails)
    await this.connect();
  }

  public cancelReconnection(): void {
    if (this.restartTimeoutHandle) {
      clearTimeout(this.restartTimeoutHandle);
      this.restartTimeoutHandle = null;
    }
    this.isRestarting = false;
  }

  // ---------------------------------------------------------------------------
  // IMCPClient Implementation - MCP Operations
  // ---------------------------------------------------------------------------

  public async listTools(): Promise<Tool[]> {
    const client = this.getConnectedClient();
    if (!this.capabilities?.tools) {
      return [];
    }
    const result = await client.listTools();
    return result.tools;
  }

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

  public async listResources(): Promise<Resource[]> {
    const client = this.getConnectedClient();
    if (!this.capabilities?.resources) {
      return [];
    }
    const result = await client.listResources();
    return result.resources;
  }

  public async listResourceTemplates(): Promise<ResourceTemplate[]> {
    const client = this.getConnectedClient();
    if (!this.capabilities?.resourceTemplates) {
      return [];
    }
    const result = await client.listResourceTemplates();
    return result.resourceTemplates;
  }

  public async readResource(uri: string): Promise<ReadResourceResult> {
    const client = this.getConnectedClient();
    const result = await client.readResource({ uri });
    return result;
  }

  public async subscribeResource(uri: string): Promise<void> {
    const client = this.getConnectedClient();
    if (!this.capabilities?.resourceSubscriptions) {
      throw new Error(
        `Server '${this.name}' does not support resource subscriptions`
      );
    }
    await client.subscribeResource({ uri });
  }

  public async unsubscribeResource(uri: string): Promise<void> {
    const client = this.getConnectedClient();
    if (!this.capabilities?.resourceSubscriptions) {
      throw new Error(
        `Server '${this.name}' does not support resource subscriptions`
      );
    }
    await client.unsubscribeResource({ uri });
  }

  public supportsResourceSubscriptions(): boolean {
    return this.capabilities?.resourceSubscriptions === true;
  }

  public async listPrompts(): Promise<Prompt[]> {
    const client = this.getConnectedClient();
    if (!this.capabilities?.prompts) {
      return [];
    }
    const result = await client.listPrompts();
    return result.prompts;
  }

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

  // ---------------------------------------------------------------------------
  // Private Methods - Process Management
  // ---------------------------------------------------------------------------

  /**
   * Create the transport for the server process
   * Note: The process is actually spawned when client.connect() is called
   */
  private createTransport(): void {
    // Create the transport with stderr capture
    this.transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: this.env,
      cwd: this.cwd,
      stderr: "pipe", // Capture stderr
    });

    // Set up process event handlers (stderr capture is set up after connect)
    this.transport.onclose = (): void => {
      if (!this.isClosing) {
        this.handleProcessCrash();
      }
    };

    this.transport.onerror = (error): void => {
      if (this.isClosing || this.status === "disconnected") {
        return;
      }
      this.lastError = error.message;
      this.errorMessage = error.message;
      this.handleProcessCrash();
    };

    // Note: Don't call transport.start() here - Client.connect() will do that
  }

  /**
   * Initialize the MCP connection
   */
  private async initializeMCP(): Promise<void> {
    if (!this.transport) {
      throw new Error("Transport not initialized");
    }

    // Create the client
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
  }

  /**
   * Set up stderr capture
   */
  private setupStderrCapture(): void {
    const stderr = this.transport?.stderr as Readable | null;
    if (!stderr) return;

    stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;

      // Split by newlines
      const lines = text.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        // Add to buffer (ring buffer)
        this.stderrBuffer.push(line);
        if (this.stderrBuffer.length > this.maxBufferSize) {
          this.stderrBuffer.shift();
        }

        // Forward to log system
        if (this.onLog) {
          this.onLog({
            server: this.name,
            timestamp: new Date(),
            level: "debug",
            logger: "process:stderr",
            data: line,
            source: "stderr",
          });
        }
      }
    });
  }

  /**
   * Set up notification handlers
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

    // Handle resources/updated
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
            source: "protocol",
          });
        }
      }
    );

    // Handle sampling/createMessage requests
    this.client.setRequestHandler(
      CreateMessageRequestSchema,
      (request) => {
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
    this.client.setRequestHandler(
      ElicitRequestSchema,
      (request) => {
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

  // ---------------------------------------------------------------------------
  // Private Methods - Crash Handling & Restart
  // ---------------------------------------------------------------------------

  /**
   * Handle unexpected process crash
   */
  private handleProcessCrash(): void {
    if (this.isRestarting || this.isClosing) {
      return;
    }

    const pid = this.transport?.pid;

    // Stop health checks
    this.stopHealthChecks();

    // Emit crash event
    this.emitLifecycleEvent("process_crashed", {
      pid: pid ?? undefined,
      lastError: this.lastError,
    });

    // Clean up
    this.client = null;
    this.transport = null;
    this.startTime = null;

    // Check if auto-restart is enabled
    if (!this.restartConfig.enabled) {
      this.setStatus("error", this.lastError ?? "Process crashed (auto-restart disabled)");
      return;
    }

    // Check if we should reset attempt counter (stable for resetAfterMs)
    if (this.lastRestartTime) {
      const stableTime = Date.now() - this.lastRestartTime.getTime();
      if (stableTime > this.restartConfig.resetAfterMs) {
        this.restartAttempt = 0;
      }
    }

    // Check if we've exceeded max attempts
    if (this.restartAttempt >= this.restartConfig.maxAttempts) {
      this.setStatus(
        "error",
        `Process crashed and max restart attempts (${String(this.restartConfig.maxAttempts)}) exceeded`
      );
      this.emitLifecycleEvent("restart_failed", {
        attemptsTaken: this.restartAttempt,
        lastError: this.lastError,
      });
      if (this.onRestartFailed) {
        this.onRestartFailed(this.restartAttempt, this.lastError ?? "Unknown error");
      }
      return;
    }

    // Start restart process
    this.isRestarting = true;
    this.scheduleRestart();
  }

  /**
   * Schedule a restart attempt
   */
  private scheduleRestart(): void {
    if (this.isClosing) {
      return;
    }

    this.restartAttempt++;
    const delay = this.calculateRestartDelay();
    this.nextRetryMs = delay;

    // Update status
    this.setStatus("restarting", this.lastError);

    // Emit restarting event
    this.emitLifecycleEvent("restarting", {
      attempt: this.restartAttempt,
      maxAttempts: this.restartConfig.maxAttempts,
      nextRetryMs: delay,
      lastError: this.lastError,
    });

    // Notify callback
    if (this.onReconnecting) {
      this.onReconnecting(this.restartAttempt, delay);
    }

    // Schedule restart
    this.restartTimeoutHandle = setTimeout(() => {
      void this.attemptRestart();
    }, delay);
  }

  /**
   * Attempt to restart the process
   */
  private async attemptRestart(): Promise<void> {
    if (this.isClosing) {
      return;
    }

    this.lastRestartTime = new Date();

    try {
      // Spawn new process
      this.createTransport();

      // Initialize MCP
      await this.initializeMCP();

      // Set up stderr capture after process is running
      this.setupStderrCapture();

      // Success!
      const attemptsTaken = this.restartAttempt;
      this.restartAttempt = 0;
      this.nextRetryMs = 0;
      this.isRestarting = false;
      this.startTime = new Date();

      // Reset health state
      this.consecutiveHealthFailures = 0;
      this.healthStatus = "healthy";

      this.setStatus("connected");

      // Emit restarted event
      this.emitLifecycleEvent("restarted", {
        attemptsTaken,
        newPid: this.transport?.pid ?? undefined,
      });

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
      this.lastError = err instanceof Error ? err.message : String(err);
      this.isRestarting = false;

      // Check if we've exceeded max attempts
      if (this.restartAttempt >= this.restartConfig.maxAttempts) {
        this.setStatus(
          "error",
          `Process crashed and max restart attempts (${String(this.restartConfig.maxAttempts)}) exceeded`
        );
        this.emitLifecycleEvent("restart_failed", {
          attemptsTaken: this.restartAttempt,
          lastError: this.lastError,
        });
        if (this.onRestartFailed) {
          this.onRestartFailed(this.restartAttempt, this.lastError);
        }
      } else {
        // Schedule next attempt
        this.isRestarting = true;
        this.scheduleRestart();
      }
    }
  }

  /**
   * Calculate restart delay with exponential backoff
   */
  private calculateRestartDelay(): number {
    const exponentialDelay =
      this.restartConfig.baseDelayMs *
      Math.pow(this.restartConfig.backoffMultiplier, this.restartAttempt - 1);

    const cappedDelay = Math.min(exponentialDelay, this.restartConfig.maxDelayMs);

    // Add jitter (±10%)
    const jitter = cappedDelay * 0.1 * (Math.random() * 2 - 1);

    return Math.round(cappedDelay + jitter);
  }

  // ---------------------------------------------------------------------------
  // Private Methods - Health Checks
  // ---------------------------------------------------------------------------

  private startHealthChecks(): void {
    this.stopHealthChecks();

    const scheduleNextCheck = (): void => {
      const jitter =
        HEALTH_CHECK_INTERVAL_MS * HEALTH_CHECK_JITTER_FACTOR * (Math.random() * 2 - 1);
      const interval = Math.round(HEALTH_CHECK_INTERVAL_MS + jitter);

      this.healthCheckIntervalHandle = setTimeout(() => {
        void this.performHealthCheck();
        scheduleNextCheck();
      }, interval);
    };

    scheduleNextCheck();
  }

  private stopHealthChecks(): void {
    if (this.healthCheckIntervalHandle) {
      clearTimeout(this.healthCheckIntervalHandle);
      this.healthCheckIntervalHandle = null;
    }
  }

  private async performHealthCheck(): Promise<void> {
    if (!this.client || !this.isConnected()) {
      return;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, HEALTH_CHECK_TIMEOUT_MS);

      try {
        await this.client.listTools();
        clearTimeout(timeoutId);

        if (this.consecutiveHealthFailures > 0) {
          const wasDegraded = this.healthStatus === "degraded";
          this.consecutiveHealthFailures = 0;
          this.healthStatus = "healthy";

          if (wasDegraded && this.onHealthRestored) {
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

  // ---------------------------------------------------------------------------
  // Private Methods - Helpers
  // ---------------------------------------------------------------------------

  private setStatus(status: BackendServerStatus, error?: string): void {
    this.status = status;

    if (status === "error" && error !== undefined) {
      this.errorMessage = error;
    } else if (status !== "restarting") {
      this.errorMessage = undefined;
    }

    if (this.onStatusChange !== undefined) {
      this.onStatusChange(status, error);
    }
  }

  private getConnectedClient(): Client {
    if (!this.isConnected() || !this.client) {
      throw new Error(`Client '${this.name}' is not connected`);
    }
    return this.client;
  }

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

  private emitLifecycleEvent(
    event: StdioLifecycleEvent,
    data: Partial<StdioLifecycleEventData> = {}
  ): void {
    const eventData: StdioLifecycleEventData = {
      server: this.name,
      event,
      timestamp: new Date(),
      ...data,
    };

    // Emit via callback
    if (this.onLifecycleEvent) {
      this.onLifecycleEvent(eventData);
    }

    // Also emit as a log entry for visibility
    if (this.onLog) {
      this.onLog({
        server: this.name,
        timestamp: new Date(),
        level: event === "restart_failed" || event === "process_crashed" ? "error" : "info",
        logger: "process:lifecycle",
        data: eventData,
        source: "protocol", // Lifecycle events are protocol-level
      });
    }
  }
}
