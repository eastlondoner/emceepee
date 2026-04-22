/**
 * Event System
 *
 * Per-session event storage with exactly-once delivery semantics for tool responses
 * and at-least-once delivery for SSE replay.
 *
 * See SESSION_STATE_DESIGN.md for full design rationale.
 */

import { ulid } from "ulid";
import type { StructuredLogger } from "../logging.js";

/**
 * Event types that can be stored in the EventSystem
 */
export type ProxyEventType =
  // Task lifecycle
  | "task_created"
  | "task_completed"
  | "task_failed"
  | "task_cancelled"
  | "task_expired"
  // Pending requests
  | "elicitation_request"
  | "elicitation_expired"
  | "elicitation_completed"
  | "sampling_request"
  | "sampling_expired"
  // Backend notifications
  | "notification"
  // Server lifecycle
  | "server_connected"
  | "server_disconnected"
  | "server_reconnecting"
  | "server_reconnected"
  | "server_added"
  | "server_removed"
  // Health check events
  | "server_health_degraded"
  | "server_health_restored"
  // Stdio process lifecycle events
  | "server_process_crashed"
  | "server_restart_failed"
  // Timer events
  | "timer_expired";

/**
 * A stored event with metadata
 */
export interface StoredEvent {
  /** ULID - time-sortable, unique */
  id: string;
  /** Event type */
  type: ProxyEventType;
  /** Server this event relates to */
  server: string;
  /** Event-specific data */
  data: unknown;
  /** When the event was created */
  createdAt: Date;
  /** Whether this event has been sent via SSE (for replay tracking) */
  sentViaSSE: boolean;
}

/**
 * Configuration for the EventSystem
 */
export interface EventSystemConfig {
  /** Maximum number of events to retain (default: 1000) */
  maxEvents: number;
  /** How long to retain events in ms (default: 30 minutes) */
  retentionMs: number;
  /** Cleanup interval in ms (default: 5 minutes) */
  cleanupIntervalMs: number;
}

const DEFAULT_CONFIG: EventSystemConfig = {
  maxEvents: 1000,
  retentionMs: 30 * 60 * 1000, // 30 minutes
  cleanupIntervalMs: 5 * 60 * 1000, // 5 minutes
};

/**
 * Per-session event system for storing and delivering events.
 *
 * Each session owns its own EventSystem instance. This ensures:
 * - Clean event routing (no streamId tagging needed)
 * - Simple cleanup on session end (just discard the EventSystem)
 * - Isolated delivery tracking
 */
export class EventSystem {
  private readonly events: StoredEvent[] = [];
  private readonly config: EventSystemConfig;
  private readonly logger?: StructuredLogger;

  /** ID of the last event delivered via getNewEvents() */
  private lastDeliveredId: string | null = null;

  /** Waiters for new events (used by await_activity) */
  private waiters: {
    resolve: (event: StoredEvent | null) => void;
    timeoutHandle: NodeJS.Timeout;
  }[] = [];

  /** Cleanup interval handle */
  private cleanupIntervalHandle: NodeJS.Timeout | null = null;

  constructor(config: Partial<EventSystemConfig> = {}, logger?: StructuredLogger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
    this.startCleanupInterval();
  }

  /**
   * Add an event to this session's event store.
   * Wakes any waiters blocked on waitForActivity().
   *
   * @returns The event ID (ULID)
   */
  public addEvent(type: ProxyEventType, server: string, data: unknown): string {
    const id = ulid();
    const event: StoredEvent = {
      id,
      type,
      server,
      data,
      createdAt: new Date(),
      sentViaSSE: false,
    };

    this.events.push(event);

    // Enforce max events (evict oldest)
    while (this.events.length > this.config.maxEvents) {
      this.events.shift();
    }

    this.logger?.debug("event_added", { id, type, server });

    // Wake any waiters
    this.wakeWaiters(event);

    return id;
  }

  /**
   * Check if there are undelivered events.
   * Does NOT mark events as delivered.
   */
  public hasNewEvents(): boolean {
    if (this.lastDeliveredId === null) {
      return this.events.length > 0;
    }

    const lastIndex = this.events.findIndex((e) => e.id === this.lastDeliveredId);
    if (lastIndex === -1) {
      // Last delivered event was evicted - all events are "new"
      return this.events.length > 0;
    }

    return lastIndex < this.events.length - 1;
  }

  /**
   * Get new events since last delivery, marking them as delivered.
   * This is the primary method for tool response event delivery (exactly-once).
   *
   * @returns Events that haven't been delivered yet
   */
  public getNewEvents(): StoredEvent[] {
    if (this.events.length === 0) {
      return [];
    }

    let startIndex = 0;

    if (this.lastDeliveredId !== null) {
      const lastIndex = this.events.findIndex((e) => e.id === this.lastDeliveredId);
      if (lastIndex !== -1) {
        startIndex = lastIndex + 1;
      }
      // If not found, event was evicted - start from beginning
    }

    const newEvents = this.events.slice(startIndex);

    // Update delivery cursor
    if (newEvents.length > 0) {
      const lastEvent = newEvents[newEvents.length - 1];
      if (lastEvent) {
        this.lastDeliveredId = lastEvent.id;
      }
    }

    return newEvents;
  }

  /**
   * Get events after a specific event ID (for SSE replay).
   * Does NOT update delivery tracking - this is for transport-level retry.
   *
   * @param lastEventId - The last event ID the client received, or null for all events
   * @returns Events after the given ID
   */
  public getEventsAfter(lastEventId: string | null): StoredEvent[] {
    if (lastEventId === null) {
      return [...this.events];
    }

    const index = this.events.findIndex((e) => e.id === lastEventId);
    if (index === -1) {
      // Event not found (evicted or invalid) - return all events
      return [...this.events];
    }

    return this.events.slice(index + 1);
  }

  /**
   * Mark an event as sent via SSE (for replay tracking).
   */
  public markSent(eventId: string): void {
    const event = this.events.find((e) => e.id === eventId);
    if (event) {
      event.sentViaSSE = true;
    }
  }

  /**
   * Wait for new activity (new event or timeout).
   * Used by await_activity tool.
   *
   * @param timeoutMs - Maximum time to wait
   * @returns The triggering event, or null if timeout
   */
  public waitForActivity(timeoutMs: number): Promise<StoredEvent | null> {
    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        // Remove this waiter from the list
        const index = this.waiters.findIndex((w) => w.timeoutHandle === timeoutHandle);
        if (index !== -1) {
          this.waiters.splice(index, 1);
        }
        resolve(null);
      }, timeoutMs);

      this.waiters.push({ resolve, timeoutHandle });
    });
  }

  /**
   * Wake all waiters with a new event.
   */
  private wakeWaiters(event: StoredEvent): void {
    const waitersToWake = this.waiters;
    this.waiters = [];

    for (const waiter of waitersToWake) {
      clearTimeout(waiter.timeoutHandle);
      waiter.resolve(event);
    }
  }

  /**
   * Start the background cleanup interval.
   */
  private startCleanupInterval(): void {
    this.cleanupIntervalHandle = setInterval(() => {
      this.runCleanup();
    }, this.config.cleanupIntervalMs);
  }

  /**
   * Remove old events that exceed the retention period.
   */
  private runCleanup(): void {
    const cutoff = Date.now() - this.config.retentionMs;
    let removed = 0;

    while (this.events.length > 0) {
      const event = this.events[0];
      if (event && event.createdAt.getTime() < cutoff) {
        this.events.shift();
        removed++;
      } else {
        break; // Events are ordered by time, so we can stop
      }
    }

    if (removed > 0) {
      this.logger?.debug("events_cleaned", { removed, remaining: this.events.length });
    }
  }

  /**
   * Shutdown the event system.
   * Clears cleanup interval and wakes all waiters with null.
   */
  public shutdown(): void {
    if (this.cleanupIntervalHandle) {
      clearInterval(this.cleanupIntervalHandle);
      this.cleanupIntervalHandle = null;
    }

    // Wake all waiters with null
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeoutHandle);
      waiter.resolve(null);
    }
    this.waiters = [];
  }
}
