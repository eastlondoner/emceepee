/**
 * Process-global, in-memory store of upstream OAuth token sets keyed by
 * backend server name.
 *
 * This is intentionally not persisted. emceepee is a local-dev, single-user,
 * localhost-only tool; losing tokens on restart is acceptable. DCR client
 * registrations ARE persisted separately (see dcr-store.ts) so the user isn't
 * prompted to redo the consent flow on every restart.
 */

import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Everything we track for a single upstream OAuth flow.
 *
 * - `tokens` is populated after a successful authorization_code or refresh.
 * - `codeVerifier`, `pendingState`, `issuerUrl`, `resourceUrl` are populated
 *   during an active flow. The SDK's `auth()` orchestrator reads/writes
 *   `codeVerifier` via the provider, and we use `pendingState` to correlate
 *   the redirect with its originating pending flow.
 */
export interface UpstreamTokenSet {
  tokens?: OAuthTokens;
  codeVerifier?: string;
  pendingState?: string;
  issuerUrl?: string;
  resourceUrl?: string;
}

/**
 * In-memory registry of upstream token sets.
 */
export class BackendTokenStore {
  private readonly entries = new Map<string, UpstreamTokenSet>();

  public get(serverName: string): UpstreamTokenSet | undefined {
    return this.entries.get(serverName);
  }

  public getOrCreate(serverName: string): UpstreamTokenSet {
    let entry = this.entries.get(serverName);
    if (!entry) {
      entry = {};
      this.entries.set(serverName, entry);
    }
    return entry;
  }

  public update(serverName: string, patch: Partial<UpstreamTokenSet>): void {
    const entry = this.getOrCreate(serverName);
    Object.assign(entry, patch);
  }

  public clear(serverName: string): void {
    this.entries.delete(serverName);
  }

  /**
   * Drop tokens (access + refresh) but keep DCR/issuer/resource info.
   * Corresponds to invalidateCredentials('tokens').
   */
  public clearTokens(serverName: string): void {
    const entry = this.entries.get(serverName);
    if (entry) {
      delete entry.tokens;
    }
  }

  /**
   * Drop the in-flight PKCE verifier + state.
   * Corresponds to invalidateCredentials('verifier').
   */
  public clearVerifier(serverName: string): void {
    const entry = this.entries.get(serverName);
    if (entry) {
      delete entry.codeVerifier;
      delete entry.pendingState;
    }
  }

  public clearAll(): void {
    this.entries.clear();
  }

  public size(): number {
    return this.entries.size;
  }
}
