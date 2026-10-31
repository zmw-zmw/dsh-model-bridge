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
    error?: { message: string; code: string };
    /** True when the caller asked for cancellation while the runner was still going. */
    cancelRequested?: boolean;
}

interface InternalJob<R> extends JobRecord<R> {
    controller: AbortController;
    promise?: Promise<void>;
    resolveGate?: () => void;
    /** Set when the dispatcher actually handed this job a concurrency slot. */
    dispatched?: boolean;
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

interface ErrorCodeCarrier {
    code?: string;
}

function errorCode(error: unknown): { message: string; code: string } {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as ErrorCodeCarrier | null)?.code;
    return { message, code: typeof code === 'string' ? code : 'JOB_ERROR' };
}

export class JobManager<R> {
    private readonly jobs = new Map<string, InternalJob<R>>();
    private readonly waiting: Array<InternalJob<R>> = [];
    private readonly maxConcurrent: number;
    private readonly ttlMs: number;
    private readonly now: () => number;
    private readonly idFactory: () => string;
    private running = 0;

    constructor(options: JobManagerOptions) {
        this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent) || 1);
        this.ttlMs = Math.max(10, options.ttlMs);
        this.now = options.now ?? Date.now;
        this.idFactory = options.idFactory ?? (() => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6));
    }

    /** Submit work. Returns immediately; the runner starts when a slot frees up. */
    start(label: string, runner: (signal: AbortSignal) => Promise<R>): { id: string; queued: boolean } {
        this.sweep();
        const id = this.idFactory();
        const job: InternalJob<R> = {
            id,
            label: label.length > 120 ? `${label.slice(0, 117)}...` : label,
            state: 'queued',
            createdAt: this.now(),
            controller: new AbortController(),
        };
        this.jobs.set(id, job);

        const gate = new Promise<void>((resolve) => (job.resolveGate = resolve));
        job.promise = gate.then(async () => {
            if (job.state !== 'queued') { return; } // cancelled while queued
            job.state = 'running';
            job.startedAt = this.now();
            try {
                job.result = await runner(job.controller.signal);
                job.state = 'done';
            } catch (error) {
                const err = errorCode(error);
                // ABORTED covers a caller cancel; the queued-cancel path never
                // reaches this callback (its gate is never resolved).
                job.state = err.code === 'ABORTED' ? 'cancelled' : 'error';
                job.error = err;
            } finally {
                job.finishedAt = this.now();
                job.durationMs = job.finishedAt - (job.startedAt ?? job.createdAt);
                this.running -= 1;
                this.pump();
            }
        });

        this.waiting.push(job);
        this.pump();
        // `queued` = the dispatcher did NOT hand this job a slot right away.
        return { id, queued: !job.dispatched };
    }

    /** Move waiting jobs into free slots (FIFO). */
    private pump(): void {
        while (this.running < this.maxConcurrent) {
            const job = this.waiting.shift();
            if (!job) { break; }
            if (job.state !== 'queued') { continue; } // cancelled while queued
            this.running += 1;
            job.dispatched = true;
            job.resolveGate?.();
        }
    }

    status(id: string): JobRecord<R> | null {
        this.sweep();
        const job = this.jobs.get(id);
        return job ? this.snapshot(job) : null;
    }

    list(): Array<JobRecord<R>> {
        this.sweep();
        return [...this.jobs.values()]
            .map((j) => this.snapshot(j))
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * Cancel a queued or running job. Queued jobs become `cancelled` at once;
     * running jobs get an abort signal — the state flips to `cancelled` when
     * the runner honours it (an ignored abort leaves the job `running` and
     * `cancelRequested` visible to the caller).
     */
    cancel(id: string): boolean {
        const job = this.jobs.get(id);
        if (!job || job.state === 'done' || job.state === 'error' || job.state === 'cancelled') {
            return false;
        }
        if (job.state === 'queued') {
            job.state = 'cancelled';
            job.finishedAt = this.now();
            job.error = { message: 'cancelled while queued', code: 'ABORTED' };
            return true;
        }
        job.cancelRequested = true;
        job.controller.abort();
        return true;
    }

    /** Drop finished jobs past their TTL. Returns how many were removed. */
    sweep(now = this.now()): number {
        let swept = 0;
        for (const [id, job] of this.jobs) {
            const terminal = job.state === 'done' || job.state === 'error' || job.state === 'cancelled';
            if (terminal && job.finishedAt !== undefined && now - job.finishedAt > this.ttlMs) {
                this.jobs.delete(id);
                swept += 1;
            }
        }
        return swept;
    }

    private snapshot(job: InternalJob<R>): JobRecord<R> {
        const { controller, promise, resolveGate, dispatched, ...record } = job;
        void controller; void promise; void resolveGate; void dispatched;
        return record;
    }
}
