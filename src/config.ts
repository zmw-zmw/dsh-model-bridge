/**
 * Plugin configuration for dsh-model-bridge.
 *
 * Resolved from the user's `cordis.patch.yml` entry (`id: model-bridge`,
 * `config: {...}`). Values here are safe defaults; `authToken` should normally
 * be left empty and supplied via the `DSH_BRIDGE_TOKEN` environment variable.
 */
import z from '@deepseek-ai/schemastery';

/** Tools the bridged one-shot agent may not use by default (write/execute). */
export const DEFAULT_AGENT_DENY_TOOLS = [
    'bash',
    'bash_persistent',
    'pwsh',
    'pwsh_persistent',
    'str_replace_editor',
    'write',
] as const;

export interface BridgeConfig {
    /** Bind address for the MCP Streamable HTTP endpoint. Keep loopback unless you know the risk. */
    host: string;
    /** TCP port for the MCP Streamable HTTP endpoint. */
    port: number;
    /** Endpoint path served by the MCP HTTP server. */
    httpPath: string;
    /**
     * Required bearer token for HTTP clients. Empty string disables auth —
     * acceptable for loopback-only single-user machines. Non-empty values are
     * compared with a constant-time check.
     */
    authToken: string;
    /** Provider route for model calls; empty picks the harness's first registered provider. */
    defaultProvider: string;
    /** Default model id for `dsh_chat` and `dsh_agent_run`. */
    defaultModel: string;
    /**
     * Non-empty: the bridged agent sees ONLY these tools (allow-list mode).
     * Takes precedence over `agentDenyTools`.
     */
    agentAllowTools: string[];
    /** Tools the bridged one-shot agent must not see (deny-list mode). Ignored when allow-list is set. */
    agentDenyTools: string[];
    /** Wall-clock budget for one `dsh_agent_run` delegation in milliseconds. */
    agentTimeoutMs: number;
    /**
     * Directory for bridge chat-session history (`.dsh-model-bridge` under the
     * harness home when empty).
     */
    stateDir: string;
}

type BridgeConfigInput = Partial<BridgeConfig>;

export const Config: z<BridgeConfigInput, BridgeConfig> = z
    .object({
        host: z.string().default('127.0.0.1'),
        port: z.number().default(3091),
        httpPath: z.string().default('/mcp'),
        authToken: z.string().default(''),
        defaultProvider: z.string().default(''),
        defaultModel: z.string().default('deepseek-flash'),
        agentAllowTools: z.array(z.string()).default([]),
        agentDenyTools: z.array(z.string()).default([...DEFAULT_AGENT_DENY_TOOLS]),
        agentTimeoutMs: z.number().default(600_000),
        stateDir: z.string().default(''),
    }) as z<BridgeConfigInput, BridgeConfig>;
