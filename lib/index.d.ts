/**
 * dsh-model-bridge — DeepSeek Harness plugin.
 *
 * Mounts an MCP Streamable HTTP server inside the harness process and exposes
 * the harness's own models and one-shot agents to ANY external MCP client
 * agent (ZCode, Claude Code, Cursor, Cline, ...).
 *
 * Cordis plugin contract (same shape as @deepseek-ai/dsh-mcp-client):
 * named exports `name`, `inject`, `Config`, and an async `apply(ctx, config)`.
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config, type BridgeConfig } from './config.js';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "model-bridge";
/** Services required by this plugin (resolved through the composition root). */
export declare const inject: string[];
export { Config };
export type { BridgeConfig };
export { ModelBridge, BridgeError } from './bridge.js';
export type { ChatRole, CHAT_ROLES } from './bridge.js';
/** Authorization header value for HTTP clients; empty when auth is disabled. */
export declare function resolveAuthToken(config: BridgeConfig): string;
/**
 * Start the bridge MCP endpoint and keep it running for the plugin's lifetime.
 * The listener is registered as a Cordis effect and unwinds on unload/HMR.
 */
export declare function apply(ctx: Context, config: BridgeConfig): Promise<void>;
