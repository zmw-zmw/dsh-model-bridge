import { ModelBridge } from './bridge.js';
import { Config } from './config.js';
import { startMcpHttpServer } from './mcp-server.js';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'model-bridge';
/** Services required by this plugin (resolved through the composition root). */
// 🔴 0.1.1 修正：必须显式声明。此前 `inject: []` 导致 apply 后访问 `ctx.llm` /
// `ctx.agents` 抛 "cannot get property ... without inject"（cordis 的属性访问
// 只对**声明过注入**的 fiber 放行）。服务名来自官方包：
// dsh-llm 注册为 "llm"，dsh-agent 的 AgentRegistry 构造 `super(ctx, "agents")`。
export const inject = ['llm', 'agents'];
export { Config };
export { ModelBridge, BridgeError } from './bridge.js';
/** Authorization header value for HTTP clients; empty when auth is disabled. */
export function resolveAuthToken(config) {
    // The environment wins so tokens never have to live in patch files.
    return process.env.DSH_BRIDGE_TOKEN || config.authToken;
}
/**
 * Start the bridge MCP endpoint and keep it running for the plugin's lifetime.
 * The listener is registered as a Cordis effect and unwinds on unload/HMR.
 */
export async function apply(ctx, config) {
    const cfg = { ...config, authToken: resolveAuthToken(config) };
    const log = {
        info: (m) => ctx.logger.info(m),
        warn: (m) => ctx.logger.warn(m),
        error: (m) => ctx.logger.error(m),
    };
    const bridge = new ModelBridge(ctx, cfg, log);
    const running = await startMcpHttpServer(bridge, cfg);
    // Cordis effects unwind their returned disposer on plugin unload / HMR.
    ctx.effect(() => async () => {
        await running.close();
    });
    const auth = cfg.authToken ? 'token-protected' : 'NO AUTH (loopback only)';
    ctx.logger.info(`dsh-model-bridge: MCP endpoint on http://${cfg.host}${cfg.port === 80 ? '' : `:${cfg.port}`}${cfg.httpPath} (${auth})`);
    ctx.logger.info(`dsh-model-bridge: default model "${cfg.defaultModel}"; agent tool policy: ${cfg.agentAllowTools.length > 0
        ? `allow [${cfg.agentAllowTools.join(', ')}]`
        : `deny [${cfg.agentDenyTools.join(', ')}]`}`);
}
