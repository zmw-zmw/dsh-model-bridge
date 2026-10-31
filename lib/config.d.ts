/**
 * Plugin configuration for dsh-model-bridge.
 *
 * Resolved from the user's `cordis.patch.yml` entry (`id: model-bridge`,
 * `config: {...}`). Values here are safe defaults; `authToken` should normally
 * be left empty and supplied via the `DSH_BRIDGE_TOKEN` environment variable.
 */
import z from '@deepseek-ai/schemastery';
/** Tools the bridged one-shot agent may not use by default (write/execute). */
export declare const DEFAULT_AGENT_DENY_TOOLS: readonly ["bash", "bash_persistent", "pwsh", "pwsh_persistent", "str_replace_editor", "write", "shell", "shell_command", "run_command", "mcp__ssh__ssh_send", "mcp__ssh__ssh_open", "edit_file", "create_file"];
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
    /** Max one-shot agents running at the same time; extras queue (0.2.0 multi-agent). */
    agentMaxConcurrent: number;
    /** Finished background-agent jobs are forgotten this many ms after completion. */
    jobTtlMs: number;
    /**
     * 429/空流时的自动回退模型（0.2.2）：首选模型被上游限流时，同 provider 内按序
     * 各试一次这份名单。默认 ['hy3'] —— 免费推理模型，与 deepseek-flash 配额独立。
     */
    fallbackModels: string[];
    /**
     * Directory for bridge chat-session history (`.dsh-model-bridge` under the
     * harness home when empty).
     */
    stateDir: string;
}
type BridgeConfigInput = Partial<BridgeConfig>;
export declare const Config: z<BridgeConfigInput, BridgeConfig>;
export {};
