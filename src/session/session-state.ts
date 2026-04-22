/**
 * Session State
 *
 * Per-session state container holding backend connections, state managers,
 * and its own EventSystem. Each session is isolated and manages its own:
 * - Backend MCP client connections
 * - Event system (for SSE replay and await_activity)
 * - Task manager (for timeout-promoted tasks)
 * - Pending requests (elicitation/sampling)
 * - Buffer manager (notifications/logs)
 */

import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { IMCPClient } from "../client-interface.js";
import type { StructuredLogger } from "../logging.js";
import {
  EventSystem,
  type EventSystemConfig,
} from "../state/event-system.js";
import {
  TaskManager,
  type TaskManagerConfig,
} from "../state/task-manager.js";
import {
  BufferManager,
  type BufferManagerConfig,
} from "../state/buffer-manager.js";
import {
  PendingRequestsManager,
  type PendingRequestsConfig,
} from "../state/pending-requests.js";
import {
  TimerManager,
  type TimerManagerConfig,
} from "../state/timer-manager.js";

/**
 * Configuration for session state
 */
export interface SessionStateConfig {
  /** Task manager configuration */
  taskConfig?: Partial<TaskManagerConfig>;
  /** Pending requests configuration */
  requestConfig?: Partial<PendingRequestsConfig>;
  /** Buffer manager configuration */
  bufferConfig?: Partial<BufferManagerConfig>;
  /** Event system configuration */
  eventSystemConfig?: Partial<EventSystemConfig>;
  /** Timer manager configuration */
  timerConfig?: Partial<TimerManagerConfig>;
}

/**
 * Status of a backend server connection within this session
 */
export type BackendConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting" | "error";

/**
 * A backend MCP server connection owned by this session
 */
export interface BackendConnection {
  /** The MCP client for this connection */
  client: IMCPClient;
  /** Current connection status */
  status: BackendConnectionStatus;
  /** When the connection was established */
  connectedAt?: Date;
  /** Last error message if status is 'error' */
  lastError?: string;
}

/**
 * Per-session state container.
 *
 * Each session has its own:
 * - Backend connections (serverName → connection)
 * - EventSystem (for exactly-once delivery and SSE replay)
 * - TaskManager (for timeout-promoted proxy tasks)
 * - PendingRequestsManager (for elicitation/sampling)
 * - BufferManager (for notifications/logs)
 * - TimerManager (for scheduled notifications)
 */
export class SessionState {
  /** Unique session identifier (ULID) */
  public readonly sessionId: string;

  /** When this session was created */
  public readonly createdAt: Date;

  /** Last activity timestamp (for timeout) */
  public lastActivityAt: Date;

  /** Per-session backend connections (serverName → connection) */
  public readonly backendConnections = new Map<string, BackendConnection>();

  /** Per-session EventSystem (owned by this session) */
  public readonly eventSystem: EventSystem;

  /** Per-session TaskManager (uses this session's EventSystem) */
  public readonly taskManager: TaskManager;

  /** Per-session PendingRequestsManager (uses this session's EventSystem) */
  public readonly pendingRequests: PendingRequestsManager;

  /** Per-session BufferManager (uses this session's EventSystem) */
  public readonly bufferManager: BufferManager;

  /** Per-session TimerManager (uses this session's EventSystem) */
  public readonly timerManager: TimerManager;

  /**
   * Capabilities advertised by the calling MCP client. Populated lazily on
   * first use (e.g. when a tool handler decides how to format an elicitation).
   */
  public clientCapabilities: ClientCapabilities | undefined;

  /** Logger for this session */
  private readonly logger?: StructuredLogger;

  constructor(
    sessionId: string,
    config: SessionStateConfig = {},
    logger?: StructuredLogger
  ) {
    this.sessionId = sessionId;
    this.createdAt = new Date();
    this.lastActivityAt = new Date();
    this.logger = logger;

    // Create per-session EventSystem (owned by this session)
    this.eventSystem = new EventSystem(config.eventSystemConfig, logger);

    // Create per-session state managers (all use this session's EventSystem)
    this.taskManager = new TaskManager(this.eventSystem, config.taskConfig);
    this.pendingRequests = new PendingRequestsManager(this.eventSystem, config.requestConfig);
    this.bufferManager = new BufferManager(this.eventSystem, config.bufferConfig);
    this.timerManager = new TimerManager(this.eventSystem, config.timerConfig);
  }

  /**
   * Update last activity timestamp.
   * Called on every request to prevent session timeout.
   */
  public touch(): void {
    this.lastActivityAt = new Date();
  }

  /**
   * Get connection for a server, if it exists.
   */
  public getConnection(serverName: string): BackendConnection | undefined {
    return this.backendConnections.get(serverName);
  }

  /**
   * Check if session has an active connection to a server.
   */
  public isConnectedTo(serverName: string): boolean {
    const conn = this.backendConnections.get(serverName);
    return conn?.status === "connected";
  }

  /**
   * List all servers this session is connected to.
   */
  public listConnectedServers(): string[] {
    return Array.from(this.backendConnections.entries())
      .filter(([, conn]) => conn.status === "connected")
      .map(([name]) => name);
  }

  /**
   * List all backend connections with their status.
   */
  public listConnections(): {
    name: string;
    status: BackendConnectionStatus;
    connectedAt?: Date;
    lastError?: string;
  }[] {
    return Array.from(this.backendConnections.entries()).map(([name, conn]) => ({
      name,
      status: conn.status,
      connectedAt: conn.connectedAt,
      lastError: conn.lastError,
    }));
  }

  /**
   * Set connection status for a server.
   */
  public setConnectionStatus(
    serverName: string,
    status: BackendConnectionStatus,
    error?: string
  ): void {
    const conn = this.backendConnections.get(serverName);
    if (conn) {
      conn.status = status;
      if (status === "connected") {
        conn.connectedAt = new Date();
        conn.lastError = undefined;
      } else if (status === "error" && error) {
        conn.lastError = error;
      }
    }
  }

  /**
   * Add a backend connection.
   */
  public addConnection(serverName: string, client: IMCPClient): void {
    this.backendConnections.set(serverName, {
      client,
      status: "connecting",
    });
  }

  /**
   * Remove a backend connection.
   */
  public removeConnection(serverName: string): boolean {
    return this.backendConnections.delete(serverName);
  }

  /**
   * Clean up all session resources.
   * Called when session is destroyed (timeout or explicit close).
   */
  public async cleanup(): Promise<void> {
    this.logger?.info("session_cleanup_start", { sessionId: this.sessionId });

    // 1. Reject pending elicitations/sampling
    this.pendingRequests.shutdown();

    // 2. Shutdown task manager (clears timers)
    this.taskManager.shutdown();

    // 3. Shutdown timer manager (clears timeouts)
    this.timerManager.shutdown();

    // 4. Shutdown event system (clears timers, resolves waiters)
    this.eventSystem.shutdown();

    // 5. Disconnect all backend connections
    for (const [name, conn] of this.backendConnections) {
      try {
        await conn.client.disconnect();
        this.logger?.debug("session_backend_disconnected", {
          sessionId: this.sessionId,
          server: name,
        });
      } catch (error) {
        // Ignore disconnect errors during cleanup
        this.logger?.debug("session_backend_disconnect_error", {
          sessionId: this.sessionId,
          server: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.backendConnections.clear();

    this.logger?.info("session_cleanup_complete", { sessionId: this.sessionId });
  }
}
