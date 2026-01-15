/**
 * Session Manager
 *
 * Central manager for all client sessions. Handles:
 * - Session lifecycle (create, get, touch, destroy)
 * - Server configuration (add, remove, list - global)
 * - Backend connections (per-session)
 * - Session timeout cleanup
 * - Graceful shutdown
 */

import { ulid } from "ulid";
import type { StructuredLogger } from "../logging.js";
import {
  ServerConfigRegistry,
  type ServerConfig,
  type ServerConfigRegistryOptions,
  isHttpConfig,
  isStdioConfig,
} from "./server-config.js";
import {
  SessionState,
  type SessionStateConfig,
  type BackendConnection,
} from "./session-state.js";
import { MCPHttpClient } from "../client.js";
import { MCPStdioClient, type LogSource } from "../stdio-client.js";
import type { IMCPClient } from "../client-interface.js";
import type { ServerInfo, StdioRestartConfig } from "../types.js";

/**
 * Configuration for SessionManager
 */
export interface SessionManagerConfig {
  /** Session timeout in ms (default: 30 minutes) */
  sessionTimeoutMs: number;
  /** Cleanup interval in ms (default: 5 minutes) */
  cleanupIntervalMs: number;
  /** Configuration for new sessions */
  sessionStateConfig?: SessionStateConfig;
  /** Logger for structured logging */
  logger?: StructuredLogger;
}

const DEFAULT_CONFIG: SessionManagerConfig = {
  sessionTimeoutMs: 24 * 60 * 60 * 1000, // 24 hours (effectively infinite for dev sessions)
  cleanupIntervalMs: 5 * 60 * 1000, // 5 minutes
};

/**
 * Central manager for all MCP proxy sessions.
 *
 * Key responsibilities:
 * - Session lifecycle management
 * - Shared server configuration registry
 * - Per-session backend connection coordination
 * - Automatic session timeout cleanup
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly serverConfigs: ServerConfigRegistry;
  private readonly config: SessionManagerConfig;
  private readonly logger?: StructuredLogger;
  private cleanupIntervalHandle: NodeJS.Timeout | null = null;

  constructor(config: Partial<SessionManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = config.logger;

    const registryOptions: ServerConfigRegistryOptions = { logger: config.logger };
    this.serverConfigs = new ServerConfigRegistry(registryOptions);

    this.startCleanupInterval();
  }

  // ==================== Session Lifecycle ====================

  /**
   * Create a new session and auto-connect to all configured servers.
   * Each session gets its own EventSystem instance.
   */
  public async createSession(): Promise<SessionState> {
    const sessionId = ulid();
    const session = new SessionState(
      sessionId,
      this.config.sessionStateConfig,
      this.logger
    );

    this.sessions.set(sessionId, session);
    this.logger?.info("session_created", { sessionId });

    // Auto-connect to all configured servers
    const configs = this.serverConfigs.listConfigs();
    for (const serverConfig of configs) {
      try {
        await this.connectSessionToServer(session, serverConfig);
      } catch (err) {
        // Log but don't fail session creation
        this.logger?.warn("session_auto_connect_failed", {
          sessionId,
          server: serverConfig.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return session;
  }

  /**
   * Get an existing session by ID.
   */
  public getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Touch a session (update last activity time).
   */
  public touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.touch();
  }

  /**
   * Destroy a session and clean up all its resources.
   */
  public async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.logger?.info("session_destroying", { sessionId });

    await session.cleanup();
    this.sessions.delete(sessionId);

    this.logger?.info("session_destroyed", { sessionId });
  }

  // ==================== Server Configuration (Global) ====================

  /**
   * Add an HTTP server configuration and connect the calling session.
   * The server config is shared globally; other sessions can connect later.
   *
   * @returns Connection info including capabilities
   */
  public async addServer(
    sessionId: string,
    name: string,
    url: string,
    options?: { headers?: Record<string, string> }
  ): Promise<BackendConnection> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    // 1. Add to global config registry
    const isNew = this.serverConfigs.addConfig(name, url, { headers: options?.headers }, sessionId);

    // 2. Connect THIS session to the server
    const serverConfig = this.serverConfigs.getConfig(name);
    if (!serverConfig) {
      throw new Error(`Failed to add server config for '${name}'`);
    }
    const connection = await this.connectSessionToServer(session, serverConfig);

    // 3. Broadcast server_added event to all OTHER sessions
    if (isNew) {
      for (const [otherId, otherSession] of this.sessions) {
        if (otherId !== sessionId) {
          otherSession.eventSystem.addEvent("server_added", name, {
            name,
            url,
            addedBy: sessionId,
          });
        }
      }
    }

    return connection;
  }

  /**
   * Add a stdio server configuration and connect the calling session.
   * The server config is shared globally; other sessions can connect later.
   *
   * @returns Connection info including capabilities
   */
  public async addStdioServer(
    sessionId: string,
    name: string,
    command: string,
    args?: string[],
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      restartConfig?: StdioRestartConfig;
    }
  ): Promise<BackendConnection> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    // 1. Add to global config registry
    const isNew = this.serverConfigs.addStdioConfig(name, command, args, options, sessionId);

    // 2. Connect THIS session to the server
    const serverConfig = this.serverConfigs.getConfig(name);
    if (!serverConfig) {
      throw new Error(`Failed to add server config for '${name}'`);
    }
    const connection = await this.connectSessionToServer(session, serverConfig);

    // 3. Broadcast server_added event to all OTHER sessions
    if (isNew) {
      for (const [otherId, otherSession] of this.sessions) {
        if (otherId !== sessionId) {
          otherSession.eventSystem.addEvent("server_added", name, {
            name,
            type: "stdio",
            command,
            args,
            addedBy: sessionId,
          });
        }
      }
    }

    return connection;
  }

  /**
   * Remove a server configuration globally.
   * Disconnects all sessions from this server.
   */
  public async removeServer(sessionId: string, name: string): Promise<void> {
    this.logger?.debug("removeServer_start", { sessionId, serverName: name });

    // 1. Remove from global config registry
    const existed = this.serverConfigs.removeConfig(name);
    if (!existed) {
      this.logger?.debug("removeServer_not_found", { sessionId, serverName: name });
      throw new Error(`Server '${name}' not found`);
    }

    // 2. Disconnect ALL sessions from this server
    for (const [sid, session] of this.sessions) {
      this.logger?.debug("removeServer_disconnecting_session", {
        sessionId: sid,
        serverName: name,
        hasConnection: session.getConnection(name) !== undefined,
      });

      await this.disconnectSessionFromServer(session, name);

      // Emit server_removed event to this session's EventSystem
      session.eventSystem.addEvent("server_removed", name, {
        name,
        removedBy: sessionId,
      });
    }

    this.logger?.debug("removeServer_complete", { sessionId, serverName: name });
  }

  /**
   * List all configured servers with connection status for a session.
   */
  public listServers(sessionId: string): ServerInfo[] {
    const session = this.sessions.get(sessionId);
    const configs = this.serverConfigs.listConfigs();

    return configs.map((serverConfig) => {
      const connection = session?.getConnection(serverConfig.name);

      // Get URL for display
      let url: string;
      if (isHttpConfig(serverConfig)) {
        url = serverConfig.url;
      } else if (isStdioConfig(serverConfig)) {
        url = `stdio://${serverConfig.command}`;
      } else {
        url = "unknown";
      }

      const info: ServerInfo = {
        name: serverConfig.name,
        url,
        connected: connection?.status === "connected",
        status: connection?.status ?? "not_connected",
        connectedAt: connection?.connectedAt,
        lastError: connection?.lastError,
      };

      // Add reconnection state if reconnecting
      if (connection?.status === "reconnecting") {
        const reconnState = connection.client.getReconnectionState();
        if (reconnState) {
          info.reconnectAttempt = reconnState.attempt;
          info.nextRetryMs = reconnState.nextRetryMs;
        }
      }

      // Add health status if connected
      if (connection?.status === "connected") {
        info.healthStatus = connection.client.getHealthStatus();
        const healthFailures = connection.client.getConsecutiveHealthFailures();
        if (healthFailures > 0) {
          info.consecutiveHealthFailures = healthFailures;
        }
      }

      return info;
    });
  }

  // ==================== Backend Connection Management ====================

  /**
   * Force reconnect a server for a session.
   * Works on connected, disconnected, or reconnecting servers.
   * Cancels any pending reconnection and immediately attempts a fresh connection.
   */
  public async reconnectServer(sessionId: string, serverName: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const serverConfig = this.serverConfigs.getConfig(serverName);
    if (!serverConfig) {
      throw new Error(`Server '${serverName}' not found`);
    }

    const connection = session.getConnection(serverName);
    if (!connection) {
      // Server config exists but no connection for this session - create one
      await this.connectSessionToServer(session, serverConfig);
      return;
    }

    // Fail pending work before reconnecting (backend state will be lost)
    this.handleBackendDisconnect(session, serverName);

    // Force reconnect the existing client
    await connection.client.forceReconnect();

    // Update connection status
    session.setConnectionStatus(serverName, "connected");

    // Emit reconnected event (with 0 attempts since it was forced)
    session.eventSystem.addEvent("server_reconnected", serverName, {
      name: serverName,
      attemptsTaken: 0,
      forced: true,
    });

    this.logger?.info("session_server_force_reconnected", {
      sessionId: session.sessionId,
      server: serverName,
    });
  }

  /**
   * Get or create a backend connection for a session.
   * Used by execute_tool and other tools that need backend access.
   */
  public async getOrCreateConnection(
    sessionId: string,
    serverName: string
  ): Promise<IMCPClient> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    // Check existing connection
    const existing = session.getConnection(serverName);
    if (existing?.status === "connected") {
      return existing.client;
    }

    // Get config
    const serverConfig = this.serverConfigs.getConfig(serverName);
    if (!serverConfig) {
      throw new Error(`Server '${serverName}' not found`);
    }

    // Connect (or reconnect)
    const connection = await this.connectSessionToServer(session, serverConfig);
    return connection.client;
  }

  /**
   * Get an existing connected client for a session.
   * Returns undefined if not connected.
   */
  public getConnectedClient(
    sessionId: string,
    serverName: string
  ): IMCPClient | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const connection = session.getConnection(serverName);
    if (connection?.status === "connected") {
      return connection.client;
    }
    return undefined;
  }

  /**
   * Connect a session to a server.
   */
  private async connectSessionToServer(
    session: SessionState,
    serverConfig: ServerConfig
  ): Promise<BackendConnection> {
    // Check if already connecting/connected
    const existing = session.backendConnections.get(serverConfig.name);
    if (existing?.status === "connected") {
      return existing;
    }
    if (existing?.status === "connecting") {
      throw new Error(`Already connecting to '${serverConfig.name}'`);
    }

    // Create appropriate client type based on config
    let client: IMCPClient;

    if (isHttpConfig(serverConfig)) {
      client = this.createHttpClient(session, serverConfig);
    } else if (isStdioConfig(serverConfig)) {
      client = this.createStdioClient(session, serverConfig);
    } else {
      // This should be unreachable if ServerConfig is properly typed
      const _exhaustiveCheck: never = serverConfig;
      throw new Error(`Unknown server config type for '${(_exhaustiveCheck as ServerConfig).name}'`);
    }

    // Add connection record before connecting
    session.addConnection(serverConfig.name, client);

    try {
      await client.connect();

      // Update connection status
      session.setConnectionStatus(serverConfig.name, "connected");

      // Emit server_connected event
      session.eventSystem.addEvent("server_connected", serverConfig.name, {
        name: serverConfig.name,
        capabilities: client.getInfo().capabilities,
      });

      this.logger?.info("session_server_connected", {
        sessionId: session.sessionId,
        server: serverConfig.name,
      });

      const connection = session.getConnection(serverConfig.name);
      if (!connection) {
        throw new Error("Connection not found after connect");
      }
      return connection;
    } catch (err) {
      // Update connection with error
      const errorMessage = err instanceof Error ? err.message : String(err);
      session.setConnectionStatus(serverConfig.name, "error", errorMessage);

      this.logger?.warn("session_server_connect_failed", {
        sessionId: session.sessionId,
        server: serverConfig.name,
        error: errorMessage,
      });

      throw err;
    }
  }

  /**
   * Create an HTTP client with session-specific callbacks
   */
  private createHttpClient(
    session: SessionState,
    serverConfig: { name: string; url: string; headers?: Record<string, string> }
  ): MCPHttpClient {
    return new MCPHttpClient({
      name: serverConfig.name,
      url: serverConfig.url,
      headers: serverConfig.headers,
      onStatusChange: (status, error): void => {
        session.setConnectionStatus(serverConfig.name, status, error);
      },
      onNotification: (notification): void => {
        session.bufferManager.addNotification(notification);
      },
      onLog: (log): void => {
        session.bufferManager.addLog(log);
      },
      onSamplingRequest: (request): void => {
        session.pendingRequests.addSamplingRequest(
          request.server,
          request.params,
          request.resolve,
          request.reject
        );
      },
      onElicitationRequest: (request): void => {
        session.pendingRequests.addElicitationRequest(
          request.server,
          request.params,
          request.resolve,
          request.reject
        );
      },
      onReconnecting: (attempt, nextRetryMs): void => {
        if (attempt === 1) {
          this.handleBackendDisconnect(session, serverConfig.name);
        }
        session.eventSystem.addEvent("server_reconnecting", serverConfig.name, {
          name: serverConfig.name,
          attempt,
          nextRetryMs,
        });
        this.logger?.debug("session_server_reconnecting", {
          sessionId: session.sessionId,
          server: serverConfig.name,
          attempt,
          nextRetryMs,
        });
      },
      onReconnected: (attemptsTaken): void => {
        session.setConnectionStatus(serverConfig.name, "connected");
        session.eventSystem.addEvent("server_reconnected", serverConfig.name, {
          name: serverConfig.name,
          attemptsTaken,
        });
        this.logger?.info("session_server_reconnected", {
          sessionId: session.sessionId,
          server: serverConfig.name,
          attemptsTaken,
        });
      },
      onHealthDegraded: (failures, lastError): void => {
        session.eventSystem.addEvent("server_health_degraded", serverConfig.name, {
          name: serverConfig.name,
          consecutiveFailures: failures,
          lastError,
        });
        this.logger?.warn("session_server_health_degraded", {
          sessionId: session.sessionId,
          server: serverConfig.name,
          consecutiveFailures: failures,
          lastError,
        });
      },
      onHealthRestored: (): void => {
        session.eventSystem.addEvent("server_health_restored", serverConfig.name, {
          name: serverConfig.name,
        });
        this.logger?.info("session_server_health_restored", {
          sessionId: session.sessionId,
          server: serverConfig.name,
        });
      },
    });
  }

  /**
   * Create a stdio client with session-specific callbacks
   */
  private createStdioClient(
    session: SessionState,
    serverConfig: {
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      restartConfig?: StdioRestartConfig;
    }
  ): MCPStdioClient {
    return new MCPStdioClient({
      name: serverConfig.name,
      command: serverConfig.command,
      args: serverConfig.args,
      env: serverConfig.env,
      cwd: serverConfig.cwd,
      restartConfig: serverConfig.restartConfig,
      onStatusChange: (status, error): void => {
        session.setConnectionStatus(serverConfig.name, status, error);
      },
      onNotification: (notification): void => {
        session.bufferManager.addNotification(notification);
      },
      onLog: (log: { server: string; timestamp: Date; level: string; logger?: string; data: unknown; source: LogSource }): void => {
        // Pass the log with source information
        session.bufferManager.addLog({
          server: log.server,
          timestamp: log.timestamp,
          level: log.level as "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency",
          logger: log.logger,
          data: log.data,
        });
      },
      onSamplingRequest: (request): void => {
        session.pendingRequests.addSamplingRequest(
          request.server,
          request.params,
          request.resolve,
          request.reject
        );
      },
      onElicitationRequest: (request): void => {
        session.pendingRequests.addElicitationRequest(
          request.server,
          request.params,
          request.resolve,
          request.reject
        );
      },
      onLifecycleEvent: (event): void => {
        // Map lifecycle events to session events
        switch (event.event) {
          case "process_started":
            this.logger?.info("session_stdio_process_started", {
              sessionId: session.sessionId,
              server: serverConfig.name,
            });
            break;
          case "process_crashed":
            this.handleBackendDisconnect(session, serverConfig.name);
            session.eventSystem.addEvent("server_process_crashed", serverConfig.name, {
              name: serverConfig.name,
              exitCode: event.exitCode,
              signal: event.signal,
            });
            this.logger?.warn("session_stdio_process_crashed", {
              sessionId: session.sessionId,
              server: serverConfig.name,
              exitCode: event.exitCode,
              signal: event.signal,
            });
            break;
          case "restarting":
            session.eventSystem.addEvent("server_reconnecting", serverConfig.name, {
              name: serverConfig.name,
              attempt: event.attempt,
              nextRetryMs: event.nextRetryMs,
            });
            this.logger?.debug("session_stdio_restarting", {
              sessionId: session.sessionId,
              server: serverConfig.name,
              attempt: event.attempt,
              nextRetryMs: event.nextRetryMs,
            });
            break;
          case "restarted":
            session.setConnectionStatus(serverConfig.name, "connected");
            session.eventSystem.addEvent("server_reconnected", serverConfig.name, {
              name: serverConfig.name,
              attemptsTaken: event.attempt,
            });
            this.logger?.info("session_stdio_restarted", {
              sessionId: session.sessionId,
              server: serverConfig.name,
              attemptsTaken: event.attempt,
            });
            break;
          case "restart_failed":
            session.setConnectionStatus(serverConfig.name, "error", event.error);
            session.eventSystem.addEvent("server_restart_failed", serverConfig.name, {
              name: serverConfig.name,
              error: event.error,
            });
            this.logger?.error("session_stdio_restart_failed", {
              sessionId: session.sessionId,
              server: serverConfig.name,
              error: event.error,
            });
            break;
          case "process_stopped":
            this.logger?.info("session_stdio_process_stopped", {
              sessionId: session.sessionId,
              server: serverConfig.name,
            });
            break;
        }
      },
    });
  }

  /**
   * Disconnect a session from a server.
   */
  private async disconnectSessionFromServer(
    session: SessionState,
    serverName: string
  ): Promise<void> {
    const connection = session.getConnection(serverName);
    if (!connection) {
      this.logger?.debug("disconnectSessionFromServer_no_connection", {
        sessionId: session.sessionId,
        serverName,
      });
      return;
    }

    this.logger?.debug("disconnectSessionFromServer_start", {
      sessionId: session.sessionId,
      serverName,
      connectionStatus: connection.status,
    });

    // Fail tasks for this server
    const tasks = session.taskManager.getTasksForServer(serverName);
    for (const task of tasks) {
      if (task.status === "working") {
        session.taskManager.failTask(task.taskId, "Server removed");
      }
    }

    // Reject pending requests for this server
    session.pendingRequests.rejectRequestsForServer(serverName, "Server removed");

    // Disconnect client
    try {
      this.logger?.debug("disconnectSessionFromServer_calling_disconnect", {
        sessionId: session.sessionId,
        serverName,
      });
      await connection.client.disconnect();
      this.logger?.debug("disconnectSessionFromServer_disconnect_complete", {
        sessionId: session.sessionId,
        serverName,
      });
    } catch (err) {
      // Log but ignore disconnect errors
      this.logger?.debug("disconnectSessionFromServer_disconnect_error", {
        sessionId: session.sessionId,
        serverName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    session.removeConnection(serverName);
    this.logger?.debug("disconnectSessionFromServer_complete", {
      sessionId: session.sessionId,
      serverName,
    });
  }

  /**
   * Handle backend server disconnect event.
   */
  private handleBackendDisconnect(session: SessionState, serverName: string): void {
    // Fail working tasks
    const tasks = session.taskManager.getTasksForServer(serverName);
    for (const task of tasks) {
      if (task.status === "working") {
        session.taskManager.failTask(task.taskId, "Server disconnected");
      }
    }

    // Reject pending requests
    session.pendingRequests.rejectRequestsForServer(serverName, "Server disconnected");

    // Emit event
    session.eventSystem.addEvent("server_disconnected", serverName, {
      name: serverName,
    });

    this.logger?.info("session_server_disconnected", {
      sessionId: session.sessionId,
      server: serverName,
    });
  }

  // ==================== Cleanup ====================

  /**
   * Start the background cleanup interval for abandoned sessions.
   */
  private startCleanupInterval(): void {
    this.cleanupIntervalHandle = setInterval(() => {
      this.runSessionCleanup();
    }, this.config.cleanupIntervalMs);
  }

  /**
   * Check for and clean up abandoned sessions.
   */
  private runSessionCleanup(): void {
    const now = Date.now();
    const toCleanup: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      const idle = now - session.lastActivityAt.getTime();
      if (idle >= this.config.sessionTimeoutMs) {
        toCleanup.push(sessionId);
      }
    }

    for (const sessionId of toCleanup) {
      this.logger?.info("session_timeout_cleanup", { sessionId });
      void this.destroySession(sessionId);
    }
  }

  /**
   * Graceful shutdown - clean up all sessions and resources.
   */
  public async shutdown(): Promise<void> {
    this.logger?.info("session_manager_shutdown_start", {
      sessionCount: this.sessions.size,
    });

    // Stop cleanup interval
    if (this.cleanupIntervalHandle) {
      clearInterval(this.cleanupIntervalHandle);
      this.cleanupIntervalHandle = null;
    }

    // Destroy all sessions
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.destroySession(sessionId);
    }

    this.logger?.info("session_manager_shutdown_complete", {});
  }

  // ==================== Accessors ====================

  /**
   * Get the server config registry.
   */
  public getServerConfigs(): ServerConfigRegistry {
    return this.serverConfigs;
  }

  /**
   * Get all active session IDs.
   */
  public listSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get the number of active sessions.
   */
  public get sessionCount(): number {
    return this.sessions.size;
  }
}
