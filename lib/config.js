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
];
export const Config = z
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
});
