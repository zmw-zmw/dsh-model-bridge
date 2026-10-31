/**
 * Bridge layer: turns MCP tool calls into harness-internal work.
 *
 * - `chat` drives `ctx.llm.stream()` directly for stateless/multi-turn model
 *   access (no agent loop, no tools).
 * - `agentRun` delegates a task to a fresh one-shot dsh agent via
 *   `ctx.agents.create()` and drains its final assistant output.
 * - Chat sessions are kept in memory and mirrored to disk under `stateDir` so
 *   a harness restart does not silently strand external agents' session ids.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
// Side-effect type imports so the `ctx.llm` / `ctx.agents` / `ctx.tools`
// service augmentations (and the `session/event` event) join the program.
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import type {
    ContentBlock,
    GenerateOptions,
    RequestMessage,
    StreamChunk,
    TokenUsage,
} from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

import type { BridgeConfig } from './config.js';
import { JobManager, type JobRecord } from './jobs.js';

/** Minimal logger seam so the bridge is testable without a Cordis context. */
export interface BridgeLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export class BridgeError extends Error {
    constructor(
        message: string,
        /** Stable machine-readable code surfaced to MCP clients. */
        readonly code: string,
    ) {
        super(message);
    }
}

/**
 * Extract the "known global tools" name list from a tools.restrict() error
 * (`...unknown global tools "a", "b"; known global tools: c, d, e`).
 * Returns null when the message does not carry the list.
 */
export function knownToolsFromRestrictError(message: string): Set<string> | null {
    const match = message.match(/known global tools:\s*(.+)$/s);
    if (!match) { return null; }
    const names = match[1]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    return names.length > 0 ? new Set(names) : null;
}

// ---------------------------------------------------------------------------
// Role presets for `dsh_chat`
// ---------------------------------------------------------------------------

export const CHAT_ROLES = {
    default: undefined,
    reviewer:
        'You are a meticulous code and design reviewer. Point out concrete risks, bugs, and ' +
        'simpler alternatives. Be direct and specific; cite the exact text you are judging.',
    architect:
        'You are a pragmatic software architect. Propose the simplest design that satisfies the ' +
        'stated requirements, name the trade-offs you rejected, and keep the answer short.',
    brainstormer:
        'You are a fast, divergent brainstorming partner. Produce many distinct ideas, each in ' +
        'one or two sentences, without filtering for feasibility first.',
} as const;

export type ChatRole = keyof typeof CHAT_ROLES;

// ---------------------------------------------------------------------------
// Chat sessions
// ---------------------------------------------------------------------------

interface ChatSession {
    id: string;
    createdAt: number;
    updatedAt: number;
    /** Full request history replayed on every turn. */
    messages: RequestMessage[];
    /** Route the session was created with (reused unless the caller overrides). */
    provider: string;
    model: string;
}

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

// ---------------------------------------------------------------------------
// Agent delegation
// ---------------------------------------------------------------------------

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

export class ModelBridge {
    private readonly sessions = new Map<string, ChatSession>();
    private readonly stateDir: string;
    /** Background agent jobs (0.2.0 multi-agent collaboration). */
    private readonly jobs: JobManager<AgentRunResult>;

    constructor(
        private readonly ctx: Context,
        private readonly cfg: BridgeConfig,
        private readonly log: BridgeLogger,
    ) {
        this.stateDir = cfg.stateDir || join(homedir(), '.dsh-model-bridge');
        this.jobs = new JobManager<AgentRunResult>({
            maxConcurrent: cfg.agentMaxConcurrent,
            ttlMs: cfg.jobTtlMs,
        });
    }

    // -- route resolution ---------------------------------------------------

    /** Resolve a provider/model route, discovering the harness's provider when unset. */
    private resolveRoute(provider?: string | undefined, model?: string | undefined) {
        const providers = this.ctx.llm.listProviders();
        const route = provider || this.cfg.defaultProvider || providers[0]?.id;
        if (!route) {
            throw new BridgeError(
                'no LLM provider is registered in this harness; configure a provider first',
                'NO_PROVIDER',
            );
        }
        if (providers.length > 0 && !providers.some((p) => p.id === route)) {
            throw new BridgeError(
                `unknown provider "${route}"; registered providers: ${providers.map((p) => p.id).join(', ')}`,
                'UNKNOWN_PROVIDER',
            );
        }
        return { provider: route, model: model || this.cfg.defaultModel };
    }

    // -- model discovery ---------------------------------------------------------

    /**
     * Every registered provider with its advertised models, so MCP agents can
     * discover valid (provider, model) pairs instead of guessing ids.
     */
    async listModels(): Promise<ModelListRow[]> {
        const providers = this.ctx.llm.listProviders();
        const rows: ModelListRow[] = [];
        for (const p of providers) {
            try {
                const models = await this.ctx.llm.listModels(p.id);
                rows.push({
                    provider: p.id,
                    providerName: p.name,
                    models: models.map((m) => ({
                        id: m.id,
                        name: m.name,
                        ...(m.description ? { description: m.description } : {}),
                        ...(m.inputModalities ? { input: [...m.inputModalities] } : {}),
                    })),
                });
            } catch (error) {
                rows.push({
                    provider: p.id,
                    providerName: p.name,
                    models: [],
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return rows;
    }

    // -- dsh_chat ------------------------------------------------------------

    async chat(input: ChatTurnInput): Promise<ChatTurnResult> {
        // 0.2.2：EMPTY_STREAM（上游 429/凭据问题的典型症状）时按 fallbackModels
        // 同 provider 回退重试一次。推理模型预算耗尽的「空 text」不是回退条件 ——
        // 那种情况 usage>0 且答案在 reasoning 字段里。
        try {
            return await this.chatOnce(input);
        } catch (error) {
            if ((error as BridgeError).code !== 'EMPTY_STREAM') { throw error; }
            const tried = this.resolveRoute(input.provider, input.model);
            for (const fb of this.cfg.fallbackModels || []) {
                if (fb === tried.model) { continue; }
                this.log.warn(`chat: "${tried.model}" 空流(上游限流?),回退模型 "${fb}"`);
                const retry = await this.chatOnce({ ...input, model: fb });
                return { ...retry, note: `首选模型 "${tried.model}" 空流,已自动回退到 "${fb}"` };
            }
            throw error;
        }
    }

    async chatOnce(input: ChatTurnInput): Promise<ChatTurnResult> {
        const { provider, model } = this.resolveRoute(input.provider, input.model);
        const session = this.getOrCreateSession(input.sessionId, provider, model);

        const preset = input.role && input.role !== 'default' ? CHAT_ROLES[input.role] : undefined;
        const system = [input.system, preset].filter(Boolean).join('\n\n') || undefined;

        const userBlock: ContentBlock = { type: 'text', text: input.prompt };
        const options: GenerateOptions = {
            provider,
            model,
            messages: [...session.messages, { role: 'user', content: [userBlock] }],
            system,
            maxTokens: input.maxTokens,
            temperature: input.temperature,
            signal: input.signal,
        };

        let text = '';
        let reasoning: string | undefined;
        let usage: TokenUsage | undefined;
        for await (const chunk of this.ctx.llm.stream(options)) {
            if (chunk.type === 'text-delta') {
                text += chunk.text;
            } else if (chunk.type === 'reasoning-delta') {
                reasoning = (reasoning ?? '') + chunk.text;
            } else if (chunk.type === 'usage') {
                usage = chunk.usage;
            } else if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') {
                throw new BridgeError('model call aborted', 'ABORTED');
            }
        }

        // 0.1.1：零产出要显式报错，不能静默返回空串 —— 实测未登录的 provider
        // （deepseek-official / deepseek-account）会"正常完成"但一个 delta 都没有，
        // 调用方看到空文本只会以为模型坏了。把凭据问题的锅还给 provider 层。
        if (!text && !usage) {
            throw new BridgeError(
                `provider "${provider}" 返回了空流（无任何文本/用量事件）——`
                + '该 provider 大概率未登录或凭据无效；在 dsh 界面完成登录后重试',
                'EMPTY_STREAM',
            );
        }

        // Fold this turn back into the session history. The assistant side is a
        // plain identified message; replay does not depend on adapter state.
        const assistant = createAssistantMessage({
            content: [{ type: 'text', text }] as readonly ContentBlock[],
            source: { provider, model },
        });
        session.messages.push(
            { role: 'user', content: [userBlock] },
            assistant,
        );
        session.updatedAt = Date.now();
        this.persistSession(session);

        return {
            sessionId: session.id,
            provider,
            model,
            // 0.2.1：推理模型(hy3 等)可能把全部预算花在思考上,正文为空 ——
            // 用 note 显式告知调用方,避免「模型坏了」的误判。
            note: !text && reasoning
                ? 'text 为空:该模型的输出全部在 reasoning 通道(预算内没走到正文)。提高 max_tokens 或阅读 reasoning 字段。'
                : undefined,
            text,
            reasoning,
            usage,
        };
    }

    private getOrCreateSession(sessionId: string | undefined, provider: string, model: string) {
        if (!sessionId) {
            const session: ChatSession = {
                id: randomUUID(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messages: [],
                provider,
                model,
            };
            this.sessions.set(session.id, session);
            return session;
        }
        const existing = this.sessions.get(sessionId);
        if (existing) return existing;
        const restored = this.restoreSession(sessionId);
        if (restored) {
            this.sessions.set(sessionId, restored);
            return restored;
        }
        // Unknown id: start a fresh session under the caller's id instead of failing.
        this.log.warn(`bridge chat session "${sessionId}" not found; starting a new one`);
        const session: ChatSession = {
            id: sessionId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
            provider,
            model,
        };
        this.sessions.set(session.id, session);
        return session;
    }

    // -- dsh_agent_run ---------------------------------------------------------

    async agentRun(input: AgentRunInput): Promise<AgentRunResult> {
        const first = await this.agentRunOnce(input);
        // 0.2.2：agent 一次 assistant message 都没拿到(典型=上游 429 重试耗尽)时,
        // 按 fallbackModels 回退重跑一次。拿到正文立刻返回,失败原因附在最终结果里。
        if (first.assistantMessages > 0 || input.signal?.aborted) { return first; }
        const tried = this.resolveRoute(input.provider, input.model);
        for (const fb of this.cfg.fallbackModels || []) {
            if (fb === tried.model) { continue; }
            this.log.warn('agent: "' + tried.model + '" 无产出(' + first.text.slice(0, 60) + '),回退模型 "' + fb + '"');
            const retry = await this.agentRunOnce({ ...input, model: fb });
            if (retry.assistantMessages > 0) {
                return { ...retry, note: '首选模型 "' + tried.model + '" 无产出,已自动回退到 "' + fb + '"' };
            }
        }
        return first;
    }

    async agentRunOnce(input: AgentRunInput): Promise<AgentRunResult> {
        const { provider, model } = this.resolveRoute(input.provider, input.model);
        const id = randomUUID();
        const started = Date.now();
        const timeoutMs = input.timeoutMs ?? this.cfg.agentTimeoutMs;

        // Collect the child agent's durable assistant messages off the global
        // session/event bus, exactly like the ACP bridge does.
        let text = '';
        let assistantMessages = 0;
        // 0.2.0：记录最后一次 llm/retry 的失败原因 —— agent 重试耗尽仍拿不到模型响应时
        // （典型：上游 429 限流），调用方该看到「为什么空」，而不是一句含糊的 no-final-message。
        let lastLlmFailure = '';
        const onSessionEvent = (session: { id: string }, event: SessionEvent) => {
            if (session.id !== id) return;
            const eventType = String(event.type);
            if (eventType === 'llm/retry') {
                const failure = (event.data as { failure?: { message?: string } } | undefined)?.failure;
                if (failure?.message) { lastLlmFailure = failure.message.slice(0, 200); }
                return;
            }
            if (eventType === 'assistant/message' && !(event.data as { interrupted?: boolean } | undefined)?.interrupted) {
                assistantMessages += 1;
                for (const block of (event.data as { message: { content: Array<{ type: string; text?: string }> } }).message.content) {
                    if (block.type === 'text') text += (text ? '\n\n' : '') + block.text;
                }
            }
        };
        const offEvent = this.ctx.on('session/event', onSessionEvent);

        const handle = await this.ctx.agents.create({
            sessionId: SessionId(id),
            meta: {
                cwd: input.cwd || process.cwd(),
                origin: 'subagent',
                delegationDepth: 0,
            },
            agentOptions: { provider, model, maxTokens: input.maxTokens },
            setup: (agentCtx) => {
                // Default posture: read-only. An explicit allow-list wins over
                // the deny-list.
                const restriction = this.cfg.agentAllowTools.length > 0
                    ? { allow: this.cfg.agentAllowTools }
                    : { deny: this.cfg.agentDenyTools };
                try {
                    agentCtx.tools.restrict(restriction);
                } catch (error) {
                    // 🔴 0.2.1 实测：harness 升级会重命名全局工具（rc.5 桌面端已无 bash/pwsh），
                    //    restrict() 对未知名字整体抛错。从报错里取「known global tools」名单，
                    //    与配置求交集后重试 —— 名单永远跟 harness 对齐，配置不用追着版本改。
                    //    仍失败就中止本次委派（绝不裸跑一个没限权的 agent）。
                    const known = knownToolsFromRestrictError(String((error as Error)?.message ?? ''));
                    if (!known) { throw error; }
                    if (this.cfg.agentAllowTools.length > 0) {
                        const allow = this.cfg.agentAllowTools.filter((t) => known.has(t));
                        this.log.warn(`agent tool allow-list narrowed to harness-known tools (allow[${allow.length}])`);
                        agentCtx.tools.restrict({ allow });
                    } else {
                        const deny = this.cfg.agentDenyTools.filter((t) => known.has(t));
                        // 🔴 安全底线：deny 收窄后为空 = 没有任何已知工具可拒 = 无法保证只读姿态。
                        //    宁可中止本次委派，也绝不静默放行一个未限权的 agent。
                        if (deny.length === 0) {
                            throw new BridgeError(
                                '配置的 agentDenyTools 与 harness 已知工具无交集，无法施加只读限制；'
                                + `harness 已知: ${[...known].join(', ')}。请更新 agentDenyTools 后重试`,
                                'RESTRICT_IMPOSSIBLE',
                            );
                        }
                        this.log.warn(`agent tool deny-list narrowed to harness-known tools (deny[${deny.length}])`);
                        agentCtx.tools.restrict({ deny });
                    }
                }
            },
        });

        try {
            const agent = handle.agent;
            agent.followup(
                createUserMessage({
                    content: [{ type: 'text', text: input.task }] as readonly ContentBlock[],
                    source: { kind: 'user' },
                }),
            );

            const timeout = new Promise<never>((_, reject) => {
                const timer = setTimeout(
                    () =>
                        reject(
                            new BridgeError(
                                `agent run exceeded ${timeoutMs}ms; the agent was cancelled`,
                                'AGENT_TIMEOUT',
                            ),
                        ),
                    timeoutMs,
                );
                input.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new BridgeError('agent run cancelled by caller', 'ABORTED'));
                }, { once: true });
            });
            await Promise.race([agent.whenIdle(), timeout]);

            return {
                sessionId: id,
                provider,
                model,
                text: text || (lastLlmFailure
                    ? `(agent 未能获得模型响应 —— 上游最后失败: ${lastLlmFailure}。稍后重试或更换 provider/model)`
                    : '(agent completed without a final assistant message)'),
                assistantMessages,
                durationMs: Date.now() - started,
            };
        } finally {
            try {
                handle.agent.cancel({ kind: 'parent' }, { keepInbox: false });
            } catch {
                // Already idle/disposed — cancellation is a documented no-op then.
            }
            offEvent?.();
            await handle.dispose();
        }
    }

    // -- background agent jobs (0.2.0 multi-agent collaboration) ---------------

    /**
     * Submit an agent run to the background pool and return a jobId at once.
     * The caller fans out N tasks, then polls `agentJobStatus` — that is the
     * whole multi-agent collaboration primitive: the external agent stays the
     * orchestrator, the bridge only caps concurrency (`agentMaxConcurrent`)
     * and keeps per-job state.
     */
    agentStart(input: AgentRunInput): { jobId: string; queued: boolean } {
        // 先解析路由:失败作业的 status 也能看到 provider/model(0.2.2)
        const route = this.resolveRoute(input.provider, input.model);
        const { id: jobId, queued } = this.jobs.start(
            input.task,
            (signal) => this.agentRun({ ...input, provider: route.provider, model: route.model, signal }),
            { provider: route.provider, model: route.model },
        );
        return { jobId, queued };
    }

    agentJobStatus(jobId: string): JobRecord<AgentRunResult> | null {
        return this.jobs.status(jobId);
    }

    agentJobsList(): Array<JobRecord<AgentRunResult>> {
        return this.jobs.list();
    }

    agentJobCancel(jobId: string): boolean {
        return this.jobs.cancel(jobId);
    }

    // -- session management ----------------------------------------------------

    listSessions(): Array<{ id: string; createdAt: number; updatedAt: number; turns: number }> {
        const ids = new Set([...this.sessions.keys(), ...this.listPersistedSessionIds()]);
        const rows: Array<{ id: string; createdAt: number; updatedAt: number; turns: number }> = [];
        for (const id of ids) {
            const s = this.sessions.get(id) ?? this.restoreSession(id);
            if (s) {
                rows.push({ id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, turns: Math.floor(s.messages.length / 2) });
            }
        }
        return rows.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    closeSession(sessionId: string): boolean {
        const existed = this.sessions.delete(sessionId);
        const file = this.sessionFile(sessionId);
        if (existsSync(file)) {
            try {
                rmSync(file);
            } catch {
                this.log.warn(`failed to remove persisted session file for "${sessionId}"`);
            }
            return true;
        }
        return existed;
    }

    // -- persistence -------------------------------------------------------------

    private sessionFile(id: string) {
        // Ids are UUIDs (ours) or caller-supplied; keep the file name safe either way.
        const safe = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
        return join(this.stateDir, 'sessions', `${safe}.json`);
    }

    private persistSession(session: ChatSession) {
        try {
            mkdirSync(join(this.stateDir, 'sessions'), { recursive: true });
            const file = this.sessionFile(session.id);
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(session), 'utf8');
            renameSync(tmp, file);
        } catch (error) {
            this.log.warn(`failed to persist chat session "${session.id}": ${String(error)}`);
        }
    }

    private listPersistedSessionIds(): string[] {
        const dir = join(this.stateDir, 'sessions');
        if (!existsSync(dir)) return [];
        try {
            return readdirSync(dir)
                .filter((f) => f.endsWith('.json'))
                .map((f) => f.replace(/\.json$/, ''));
        } catch {
            return [];
        }
    }

    private restoreSession(id: string): ChatSession | undefined {
        const file = this.sessionFile(id);
        if (!existsSync(file)) return undefined;
        try {
            const raw = JSON.parse(readFileSync(file, 'utf8')) as ChatSession;
            return raw;
        } catch (error) {
            this.log.warn(`failed to restore chat session "${id}": ${String(error)}`);
            return undefined;
        }
    }
}
