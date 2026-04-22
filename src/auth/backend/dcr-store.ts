/**
 * Persistent store of OAuth Dynamic Client Registration (RFC 7591) entries.
 *
 * Keyed by issuer URL (normalized) rather than by backend server name, because
 * multiple upstream servers can share the same authorization server and we
 * should not DCR-register twice per issuer.
 *
 * Writes are atomic (tmp file + rename) and the file is chmod 0600. A corrupt
 * file is renamed to `<path>.corrupt-<ts>` rather than blocking startup.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { StructuredLogger } from "../../logging.js";

export interface DcrStore {
  get(issuerUrl: string): OAuthClientInformationFull | undefined;
  put(issuerUrl: string, info: OAuthClientInformationFull): void;
  delete(issuerUrl: string): void;
  size(): number;
}

interface DcrFileShape {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
}

/**
 * Resolve an environment-style path, expanding a leading `~`.
 */
export function resolveDcrStorePath(input?: string): string {
  const raw = input ?? "~/.emceepee/dcr-clients.json";
  if (raw.startsWith("~/")) {
    return resolve(homedir(), raw.slice(2));
  }
  if (raw === "~") {
    return homedir();
  }
  return resolve(raw);
}

/**
 * Normalize an issuer URL to a canonical key. Strips trailing slash and
 * lowercases the host; leaves pathname (if any) intact except for trailing
 * slash.
 */
export function normalizeIssuer(issuer: string): string {
  try {
    const u = new URL(issuer);
    u.hash = "";
    u.search = "";
    u.hostname = u.hostname.toLowerCase();
    let out = u.toString();
    if (out.endsWith("/")) {
      out = out.slice(0, -1);
    }
    return out;
  } catch {
    return issuer;
  }
}

export class FileDcrStore implements DcrStore {
  private readonly path: string;
  private readonly logger: StructuredLogger | undefined;
  private clients: Record<string, OAuthClientInformationFull>;

  constructor(options: { path?: string; logger?: StructuredLogger } = {}) {
    this.path = resolveDcrStorePath(options.path);
    this.logger = options.logger;
    this.clients = this.load();
  }

  public get(issuerUrl: string): OAuthClientInformationFull | undefined {
    return this.clients[normalizeIssuer(issuerUrl)];
  }

  public put(issuerUrl: string, info: OAuthClientInformationFull): void {
    this.clients[normalizeIssuer(issuerUrl)] = info;
    this.persist();
  }

  public delete(issuerUrl: string): void {
    const key = normalizeIssuer(issuerUrl);
    if (Object.prototype.hasOwnProperty.call(this.clients, key)) {
      const { [key]: _removed, ...rest } = this.clients;
      void _removed;
      this.clients = rest;
      this.persist();
    }
  }

  public size(): number {
    return Object.keys(this.clients).length;
  }

  public getPath(): string {
    return this.path;
  }

  private load(): Record<string, OAuthClientInformationFull> {
    if (!existsSync(this.path)) {
      return {};
    }
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch (err) {
      this.logger?.warn("dcr_store_read_failed", {
        path: this.path,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { version?: unknown }).version === 1 &&
        typeof (parsed as { clients?: unknown }).clients === "object" &&
        (parsed as { clients?: unknown }).clients !== null
      ) {
        const { clients } = parsed as DcrFileShape;
        return { ...clients };
      }
      throw new Error("unexpected file shape");
    } catch (err) {
      // Move the corrupt file aside and start fresh.
      const backup = `${this.path}.corrupt-${String(Date.now())}`;
      try {
        renameSync(this.path, backup);
      } catch {
        // Ignore - we still want to keep running.
      }
      this.logger?.warn("dcr_store_corrupt_reset", {
        path: this.path,
        backup,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  private persist(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const body: DcrFileShape = { version: 1, clients: this.clients };
    const tmp = `${this.path}.tmp-${String(process.pid)}-${String(Date.now())}`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), { encoding: "utf-8", mode: 0o600 });

    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Non-fatal: on some filesystems chmod may not apply.
    }

    renameSync(tmp, this.path);

    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Non-fatal.
    }
  }
}
