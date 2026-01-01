/**
 * SSE Event Store for Transport-Level Resumability
 *
 * This store implements the MCP SDK's EventStore interface to enable SSE stream
 * resumability via the Last-Event-ID header mechanism.
 *
 * ## Why This Is Separate from EventSystem
 *
 * This store and EventSystem serve different purposes:
 *
 * | Aspect          | SSEEventStore                    | EventSystem                          |
 * |-----------------|----------------------------------|--------------------------------------|
 * | **Purpose**     | Transport-level SSE replay       | Application-level domain events      |
 * | **What it stores** | Raw JSON-RPC messages         | Domain events (task_completed, etc.) |
 * | **Used by**     | SDK's StreamableHTTPServerTransport | await_activity tool, session state |
 * | **Stream ID**   | Required (POST vs GET streams)   | Not used (per-session isolation)     |
 * | **Delivery**    | At-least-once (reconnect replay) | Exactly-once (tool responses)        |
 *
 * The SDK transport sends SSE messages (JSON-RPC responses, notifications) and needs
 * to replay them if a client reconnects with Last-Event-ID. This is purely a transport
 * concern - the client already received these messages via tool responses, but the SSE
 * connection dropped before acknowledgment.
 *
 * EventSystem stores higher-level domain events (server connected, task completed) that
 * drive application logic like await_activity. These are different data types with
 * different lifecycles.
 *
 * Keeping them separate ensures:
 * - Clean separation of transport vs application concerns
 * - No streamId complexity in EventSystem
 * - Independent retention/cleanup policies
 * - Simpler reasoning about each system's guarantees
 */

import { ulid } from "ulid";
import type { StructuredLogger } from "../logging.js";

// Re-export types for convenience - these come from the SDK
export type StreamId = string;
export type EventId = string;

// JSONRPCMessage is a union type from the SDK, but we just need to store it opaquely
export type JSONRPCMessage = Record<string, unknown>;

/**
 * EventStore interface from MCP SDK
 * (Defined here to avoid import path issues with SDK internals)
 */
export interface EventStore {
  /**
   * Store an event for later retrieval
   * @param streamId ID of the stream the event belongs to
   * @param message The JSON-RPC message to store
   * @returns The generated event ID for the stored event
   */
  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId>;

  /**
   * Get the stream ID associated with a given event ID.
   * @param eventId The event ID to look up
   * @returns The stream ID, or undefined if not found
   */
  getStreamIdForEventId?(eventId: EventId): Promise<StreamId | undefined>;

  /**
   * Replay events after a given event ID by calling send() for each.
   * @param lastEventId The last event ID the client received
   * @param send Callback to send each replayed event
   * @returns The stream ID for stream mapping/conflict checking
   */
  replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
  ): Promise<StreamId>;
}

/**
 * Configuration for SSEEventStore
 */
export interface SSEEventStoreConfig {
  /** Maximum number of events to retain (default: 1000) */
  maxEvents: number;
  /** How long to retain events in ms (default: 5 minutes) */
  retentionMs: number;
  /** Optional logger for debugging */
  logger?: StructuredLogger;
}

const DEFAULT_CONFIG: SSEEventStoreConfig = {
  maxEvents: 1000,
  retentionMs: 5 * 60 * 1000, // 5 minutes - shorter than EventSystem since this is just for reconnect
};

/**
 * Per-transport event store for SSE resumability.
 *
 * Stores JSON-RPC messages sent via SSE so they can be replayed if a client
 * reconnects with Last-Event-ID header. Uses ULIDs for event IDs to enable
 * chronological sorting without additional timestamp tracking.
 */
export class SSEEventStore implements EventStore {
  private readonly events = new Map<EventId, { streamId: StreamId; message: JSONRPCMessage; createdAt: number }>();
  private readonly config: SSEEventStoreConfig;
  private readonly logger?: StructuredLogger;

  constructor(config: Partial<SSEEventStoreConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = config.logger;
  }

  /**
   * Store an SSE event for potential replay.
   */
  public storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = ulid(); // ULID encodes timestamp, enables chronological sorting

    this.events.set(eventId, {
      streamId,
      message,
      createdAt: Date.now(),
    });

    this.logger?.debug("sse_event_stored", { eventId, streamId, messageId: (message as { id?: unknown }).id });

    // Enforce limits
    this.enforceLimit();
    this.cleanupOldEvents();

    return Promise.resolve(eventId);
  }

  /**
   * Get the stream ID for an event (used by SDK for conflict checking).
   */
  public getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return Promise.resolve(this.events.get(eventId)?.streamId);
  }

  /**
   * Replay all events after lastEventId for the same stream.
   * Called when a client reconnects with Last-Event-ID header.
   */
  public async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
  ): Promise<StreamId> {
    this.logger?.debug("sse_replay_requested", { lastEventId, totalEvents: this.events.size });

    const startEntry = this.events.get(lastEventId);
    if (!startEntry) {
      // Event not found (expired or invalid) - can't replay
      this.logger?.debug("sse_replay_event_not_found", { lastEventId });
      return "";
    }

    const streamId = startEntry.streamId;
    let foundStart = false;
    let replayedCount = 0;

    // ULIDs sort lexicographically = chronologically
    const sortedIds = [...this.events.keys()].sort();
    this.logger?.debug("sse_replay_scanning", { streamId, sortedIdsCount: sortedIds.length });

    for (const eventId of sortedIds) {
      if (eventId === lastEventId) {
        foundStart = true;
        continue; // Skip the last event itself, replay events AFTER it
      }

      if (foundStart) {
        const entry = this.events.get(eventId);
        // Only replay events from the same stream
        if (entry?.streamId === streamId) {
          this.logger?.debug("sse_replaying_event", { eventId, streamId });
          await send(eventId, entry.message);
          replayedCount++;
        } else {
          this.logger?.debug("sse_skip_different_stream", { eventId, eventStreamId: entry?.streamId, targetStreamId: streamId });
        }
      }
    }

    this.logger?.debug("sse_replay_complete", { streamId, replayedCount });
    return streamId;
  }

  /**
   * Enforce maximum event limit by removing oldest events.
   */
  private enforceLimit(): void {
    if (this.events.size <= this.config.maxEvents) {
      return;
    }

    // ULIDs sort chronologically - delete oldest
    const sortedIds = [...this.events.keys()].sort();
    const toDelete = sortedIds.slice(0, this.events.size - this.config.maxEvents);

    for (const id of toDelete) {
      this.events.delete(id);
    }
  }

  /**
   * Remove events older than retention period.
   */
  private cleanupOldEvents(): void {
    const cutoff = Date.now() - this.config.retentionMs;

    for (const [eventId, entry] of this.events) {
      if (entry.createdAt < cutoff) {
        this.events.delete(eventId);
      }
    }
  }

  /**
   * Get the number of stored events (for debugging/monitoring).
   */
  public getEventCount(): number {
    return this.events.size;
  }

  /**
   * Clear all events (called on transport close).
   */
  public clear(): void {
    this.events.clear();
  }
}
