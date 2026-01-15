/**
 * Server Config Registry
 *
 * Shared registry of server configurations (name → URL/command mapping).
 * All sessions can use these configs to establish backend connections.
 *
 * This is separate from actual connections - connections are per-session,
 * but configs are shared across all sessions.
 */

import type { StructuredLogger } from "../logging.js";
import type { StdioRestartConfig } from "../types.js";

/**
 * Configuration for a backend HTTP MCP server
 */
export interface HttpServerConfig {
  /** Unique name to identify this server */
  name: string;
  /** Transport type */
  type: "http";
  /** HTTP URL of the MCP server endpoint */
  url: string;
  /** Custom headers to send with requests (e.g., Authorization) */
  headers?: Record<string, string>;
  /** When this config was added */
  addedAt: Date;
  /** Session ID that added this config (for logging) */
  addedBy?: string;
}

/**
 * Configuration for a backend stdio MCP server
 */
export interface StdioServerConfigInternal {
  /** Unique name to identify this server */
  name: string;
  /** Transport type */
  type: "stdio";
  /** Command to spawn */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Restart configuration */
  restartConfig?: StdioRestartConfig;
  /** When this config was added */
  addedAt: Date;
  /** Session ID that added this config (for logging) */
  addedBy?: string;
}

/**
 * Configuration for a backend MCP server (HTTP or stdio)
 */
export type ServerConfig = HttpServerConfig | StdioServerConfigInternal;

/**
 * Type guard for HTTP server config
 */
export function isHttpConfig(config: ServerConfig): config is HttpServerConfig {
  return config.type === "http";
}

/**
 * Type guard for stdio server config
 */
export function isStdioConfig(config: ServerConfig): config is StdioServerConfigInternal {
  return config.type === "stdio";
}

/**
 * Options for creating a ServerConfigRegistry
 */
export interface ServerConfigRegistryOptions {
  /** Logger for structured logging */
  logger?: StructuredLogger;
}

/**
 * Shared registry of server configurations.
 *
 * This is a simple in-memory store of server configurations.
 * Sessions use this to know which servers to connect to.
 */
export class ServerConfigRegistry {
  private readonly configs = new Map<string, ServerConfig>();
  private readonly logger?: StructuredLogger;

  constructor(options: ServerConfigRegistryOptions = {}) {
    this.logger = options.logger;
  }

  /**
   * Add an HTTP server configuration.
   *
   * @param name - Unique name for this server
   * @param url - HTTP URL of the MCP server endpoint
   * @param options - Optional configuration options
   * @param addedBy - Optional session ID that added this config
   * @returns true if new config, false if updated existing
   */
  public addConfig(
    name: string,
    url: string,
    options?: { headers?: Record<string, string> },
    addedBy?: string
  ): boolean {
    const existing = this.configs.has(name);
    this.configs.set(name, {
      name,
      type: "http",
      url,
      headers: options?.headers,
      addedAt: new Date(),
      addedBy,
    });

    this.logger?.info(existing ? "server_config_updated" : "server_config_added", {
      server: name,
      type: "http",
      url,
      hasHeaders: options?.headers !== undefined,
      addedBy,
    });

    return !existing;
  }

  /**
   * Add a stdio server configuration.
   *
   * @param name - Unique name for this server
   * @param command - Command to spawn
   * @param args - Command arguments
   * @param options - Additional options (env, cwd, restartConfig)
   * @param addedBy - Optional session ID that added this config
   * @returns true if new config, false if updated existing
   */
  public addStdioConfig(
    name: string,
    command: string,
    args?: string[],
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      restartConfig?: StdioRestartConfig;
    },
    addedBy?: string
  ): boolean {
    const existing = this.configs.has(name);
    this.configs.set(name, {
      name,
      type: "stdio",
      command,
      args,
      env: options?.env,
      cwd: options?.cwd,
      restartConfig: options?.restartConfig,
      addedAt: new Date(),
      addedBy,
    });

    this.logger?.info(existing ? "server_config_updated" : "server_config_added", {
      server: name,
      type: "stdio",
      command,
      args,
      addedBy,
    });

    return !existing;
  }

  /**
   * Get a server configuration by name.
   */
  public getConfig(name: string): ServerConfig | undefined {
    return this.configs.get(name);
  }

  /**
   * List all server configurations.
   */
  public listConfigs(): ServerConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * Remove a server configuration.
   *
   * @returns true if the config existed and was removed
   */
  public removeConfig(name: string): boolean {
    const existed = this.configs.delete(name);
    if (existed) {
      this.logger?.info("server_config_removed", { server: name });
    }
    return existed;
  }

  /**
   * Check if a server configuration exists.
   */
  public hasConfig(name: string): boolean {
    return this.configs.has(name);
  }

  /**
   * Get the number of configured servers.
   */
  public get size(): number {
    return this.configs.size;
  }

  /**
   * Clear all configurations.
   */
  public clear(): void {
    this.configs.clear();
    this.logger?.info("server_configs_cleared", {});
  }
}
