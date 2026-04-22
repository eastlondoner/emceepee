/**
 * Registry of pending OAuth authorization flows.
 *
 * A "flow" is the window between `redirectToAuthorization(url)` being called
 * (during an upstream auth attempt) and `/oauth/callback` being hit by the
 * user's browser. Flows are indexed by OAuth `state` (primary) and by
 * backend server name (for single-flight dedupe).
 */

import { randomUUID } from "node:crypto";
import type { StructuredLogger } from "../../logging.js";

export interface PendingFlow {
  /** OAuth `state` parameter — primary key. */
  state: string;
  /** Backend server name (e.g. "disk"). */
  serverName: string;
  /**
   * Sessions waiting on this flow's outcome. The set grows when single-
   * flight dedupe reuses an in-flight flow for a second caller — both
   * callers must be notified when the callback completes, or the later
   * caller's session would hang.
   */
  sessionIds: Set<string>;
  /** Normalized authorization-server issuer URL (for DCR key lookup). */
  issuerUrl: string;
  /** Full authorization URL the user agent needs to visit. */
  authorizationUrl: string;
  /** PKCE code verifier — held here so the callback handler can run the code exchange. */
  codeVerifier: string;
  /** ms since epoch. */
  createdAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

export interface PendingFlowRegistryOptions {
  ttlMs?: number;
  sweepIntervalMs?: number;
  logger?: StructuredLogger;
  /**
   * Injectable clock for tests. Defaults to `Date.now`.
   */
  now?: () => number;
}

export class PendingFlowRegistry {
  private readonly byState = new Map<string, PendingFlow>();
  private readonly byServer = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly logger: StructuredLogger | undefined;
  private sweeperHandle: NodeJS.Timeout | null = null;

  constructor(options: PendingFlowRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;

    const sweepMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweeperHandle = setInterval(() => {
      this.sweep();
    }, sweepMs);
    // Don't hold the event loop open just for the sweeper.
    this.sweeperHandle.unref();
  }

  /**
   * Generate a fresh OAuth state value.
   */
  public newState(): string {
    return randomUUID();
  }

  public register(flow: Omit<PendingFlow, "createdAt">): PendingFlow {
    const stored: PendingFlow = {
      ...flow,
      // Defensive copy so the caller can't mutate the registry's internal set.
      sessionIds: new Set(flow.sessionIds),
      createdAt: this.now(),
    };

    // If a flow was already pending for this server, evict it — we're
    // starting a new one from the same server. The older one can still
    // complete via state if the user finishes that tab first.
    const existingState = this.byServer.get(flow.serverName);
    if (existingState && existingState !== flow.state) {
      const existing = this.byState.get(existingState);
      if (existing) {
        this.byState.delete(existingState);
      }
    }

    this.byState.set(flow.state, stored);
    this.byServer.set(flow.serverName, flow.state);
    this.logger?.debug("pending_flow_registered", {
      serverName: flow.serverName,
      state: flow.state,
      sessionCount: stored.sessionIds.size,
    });
    return stored;
  }

  /**
   * Attach an additional session subscriber to an in-flight flow. Used by
   * single-flight dedupe in redirectToAuthorization: when caller B reuses
   * caller A's pending authorize URL, caller B's session must also be
   * notified when the callback completes.
   */
  public addSubscriber(serverName: string, sessionId: string): boolean {
    const flow = this.findByServer(serverName);
    if (!flow) return false;
    flow.sessionIds.add(sessionId);
    return true;
  }

  public findByServer(serverName: string): PendingFlow | undefined {
    const state = this.byServer.get(serverName);
    if (!state) return undefined;
    const flow = this.byState.get(state);
    if (!flow) return undefined;
    if (this.isExpired(flow)) {
      this.deleteInternal(flow);
      return undefined;
    }
    return flow;
  }

  public findByState(state: string): PendingFlow | undefined {
    const flow = this.byState.get(state);
    if (!flow) return undefined;
    if (this.isExpired(flow)) {
      this.deleteInternal(flow);
      return undefined;
    }
    return flow;
  }

  /**
   * Atomically look up + remove a flow by state. Returns undefined if the
   * state is unknown or expired.
   */
  public consumeByState(state: string): PendingFlow | undefined {
    const flow = this.byState.get(state);
    if (!flow) return undefined;
    this.deleteInternal(flow);
    if (this.isExpired(flow)) return undefined;
    return flow;
  }

  public size(): number {
    return this.byState.size;
  }

  public shutdown(): void {
    if (this.sweeperHandle) {
      clearInterval(this.sweeperHandle);
      this.sweeperHandle = null;
    }
    this.byState.clear();
    this.byServer.clear();
  }

  /**
   * Run a sweep of expired flows. Exposed for tests.
   */
  public sweep(): void {
    const toDrop: PendingFlow[] = [];
    for (const flow of this.byState.values()) {
      if (this.isExpired(flow)) {
        toDrop.push(flow);
      }
    }
    for (const flow of toDrop) {
      this.deleteInternal(flow);
    }
    if (toDrop.length > 0) {
      this.logger?.debug("pending_flows_swept", { expired: toDrop.length });
    }
  }

  private isExpired(flow: PendingFlow): boolean {
    return this.now() - flow.createdAt > this.ttlMs;
  }

  private deleteInternal(flow: PendingFlow): void {
    this.byState.delete(flow.state);
    const stateForServer = this.byServer.get(flow.serverName);
    if (stateForServer === flow.state) {
      this.byServer.delete(flow.serverName);
    }
  }
}
