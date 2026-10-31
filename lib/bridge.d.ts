import type { Context } from '@deepseek-ai/cordis';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { BridgeConfig } from './config.js';
import { type JobRecord } from './jobs.js';
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
/**
 * Extract the "known global tools" name list from a tools.restrict() error
 * (`...unknown global tools "a", "b"; known global tools: c, d, e`).
 * Returns null when the message does not carry the list.
 */
export declare function knownToolsFromRestrictError(message: string): Set<string> | null;
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
    /** 仅在 text 为空而 reasoning 有内容时出现(推理模型预算耗尽的显式提示)。 */
    note?: string;
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
    /** 回退/降级说明(0.2.2)。 */
    note?: string;
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
    /** Background agent jobs (0.2.0 multi-agent collaboration). */
    private readonly jobs;
    constructor(ctx: Context, cfg: BridgeConfig, log: BridgeLogger);
    /** Resolve a provider/model route, discovering the harness's provider when unset. */
    private resolveRoute;
    /**
     * Every registered provider with its advertised models, so MCP agents can
     * discover valid (provider, model) pairs instead of guessing ids.
     */
    listModels(): Promise<ModelListRow[]>;
    chat(input: ChatTurnInput): Promise<ChatTurnResult>;
    chatOnce(input: ChatTurnInput): Promise<ChatTurnResult>;
    private getOrCreateSession;
    agentRun(input: AgentRunInput): Promise<AgentRunResult>;
    agentRunOnce(input: AgentRunInput): Promise<AgentRunResult>;
    /**
     * Submit an agent run to the background pool and return a jobId at once.
     * The caller fans out N tasks, then polls `agentJobStatus` — that is the
     * whole multi-agent collaboration primitive: the external agent stays the
     * orchestrator, the bridge only caps concurrency (`agentMaxConcurrent`)
     * and keeps per-job state.
     */
    agentStart(input: AgentRunInput): {
        jobId: string;
        queued: boolean;
    };
    agentJobStatus(jobId: string): JobRecord<AgentRunResult> | null;
    agentJobsList(): Array<JobRecord<AgentRunResult>>;
    agentJobCancel(jobId: string): boolean;
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
