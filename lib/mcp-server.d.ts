import type { ModelBridge } from './bridge.js';
import type { BridgeConfig } from './config.js';
export interface RunningMcpServer {
    port: number;
    close(): Promise<void>;
}
/**
 * Start the bridge MCP endpoint. One HTTP session per MCP initialize; tools
 * are registered per-session so each MCP client gets its own McpServer.
 */
export declare function startMcpHttpServer(bridge: ModelBridge, cfg: BridgeConfig): Promise<RunningMcpServer>;
