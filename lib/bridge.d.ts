import type { Context } from '@deepseek-ai/cordis';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { BridgeConfig } from './config.js';
/** Minimal logger seam so the bridge is testable without a Cordis context. */
export interface BridgeLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
export declare class BridgeError extends Error {
    /** Stable machine-readable code surfaced to MCP clients. */
    readonly code: string;
    constructor(message: string, 
    /** Stable machine-readable code surfaced to MCP clients. */
    code: string);
}
export declare const CHAT_ROLES: {
    readonly default: undefined;
    readonly reviewer: string;
    readonly architect: string;
    readonly brainstormer: string;
};
export type ChatRole = keyof typeof CHAT_ROLES;
export interface ChatTurnInput {
    prompt: string;
    sessionId?: string | undefined;
    system?: string | undefined;
    role?: ChatRole | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    maxTokens?: number | undefined;
    temperature?: number | undefined;
    signal?: AbortSignal | undefined;
}
export interface ChatTurnResult {
    sessionId: string;
    provider: string;
    model: string;
    text: string;
    reasoning?: string;
    usage?: TokenUsage;
}
export interface AgentRunInput {
    task: string;
    cwd?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    maxTokens?: number | undefined;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
}
export interface AgentRunResult {
    sessionId: string;
    provider: string;
    model: string;
    text: string;
    /** Durable turns the agent completed (1 unless the driver split the work). */
    assistantMessages: number;
    durationMs: number;
}
export interface ModelListRow {
    provider: string;
    providerName: string;
    models: Array<{
        id: string;
        name: string;
        description?: string;
        input?: string[];
    }>;
    error?: string;
}
export declare class ModelBridge {
    private readonly ctx;
    private readonly cfg;
    private readonly log;
    private readonly sessions;
    private readonly stateDir;
    constructor(ctx: Context, cfg: BridgeConfig, log: BridgeLogger);
    /** Resolve a provider/model route, discovering the harness's provider when unset. */
    private resolveRoute;
    /**
     * Every registered provider with its advertised models, so MCP agents can
     * discover valid (provider, model) pairs instead of guessing ids.
     */
    listModels(): Promise<ModelListRow[]>;
    chat(input: ChatTurnInput): Promise<ChatTurnResult>;
    private getOrCreateSession;
    agentRun(input: AgentRunInput): Promise<AgentRunResult>;
    listSessions(): Array<{
        id: string;
        createdAt: number;
        updatedAt: number;
        turns: number;
    }>;
    closeSession(sessionId: string): boolean;
    private sessionFile;
    private persistSession;
    private listPersistedSessionIds;
    private restoreSession;
}
