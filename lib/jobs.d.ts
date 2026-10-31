/**
 * Background job manager for multi-agent collaboration (0.2.0).
 *
 * `dsh_agent_start` hands work to this manager instead of blocking the MCP
 * tool call: the caller gets a jobId immediately, polls `dsh_agent_status`,
 * and can fan out N agents at once. A semaphore caps how many run at a time
 * (`agentMaxConcurrent`); the rest queue and start in submission order.
 *
 * Pure orchestration — no harness imports, fully injectable clock for tests.
 */
export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export interface JobRecord<R = unknown> {
    id: string;
    /** First characters of the task — lets the caller tell jobs apart in `dsh_agent_list`. */
    label: string;
    state: JobState;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    durationMs?: number;
    result?: R;
    error?: {
        message: string;
        code: string;
    };
    /** 提交时的静态元数据(如 provider/model),失败时也可见。 */
    meta?: Record<string, string>;
    /** True when the caller asked for cancellation while the runner was still going. */
    cancelRequested?: boolean;
}
export interface JobManagerOptions {
    /** How many jobs may run at once (>= 1). */
    maxConcurrent: number;
    /** Finished jobs are dropped this many ms after completion (housekeeping). */
    ttlMs: number;
    /** Injectable clock for tests. */
    now?: () => number;
    /** Injectable id generator for tests. */
    idFactory?: () => string;
}
export declare class JobManager<R> {
    private readonly jobs;
    private readonly waiting;
    private readonly maxConcurrent;
    private readonly ttlMs;
    private readonly now;
    private readonly idFactory;
    private running;
    constructor(options: JobManagerOptions);
    /** Submit work. Returns immediately; the runner starts when a slot frees up. */
    start(label: string, runner: (signal: AbortSignal) => Promise<R>, meta?: Record<string, string>): {
        id: string;
        queued: boolean;
    };
    /** Move waiting jobs into free slots (FIFO). */
    private pump;
    status(id: string): JobRecord<R> | null;
    list(): Array<JobRecord<R>>;
    /**
     * Cancel a queued or running job. Queued jobs become `cancelled` at once;
     * running jobs get an abort signal — the state flips to `cancelled` when
     * the runner honours it (an ignored abort leaves the job `running` and
     * `cancelRequested` visible to the caller).
     */
    cancel(id: string): boolean;
    /** Drop finished jobs past their TTL. Returns how many were removed. */
    sweep(now?: number): number;
    private snapshot;
}
