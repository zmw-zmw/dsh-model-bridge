/**
 * Multi-agent job tests (0.2.0): JobManager semantics + MCP-level
 * dsh_agent_start/status/list/cancel over the real HTTP server (stub harness).
 *
 * Run: node test/jobs-test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { JobManager } from '../lib/jobs.js';
import { ModelBridge } from '../lib/bridge.js';
import { startMcpHttpServer } from '../lib/mcp-server.js';
import { stubTiming } from './protocol-stub-harness.mjs';
import { BridgeError } from '../lib/bridge.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { passed += 1; console.log(`ok - ${name}`); })
        .catch((e) => { console.error(`FAIL - ${name}\n${e && e.stack || e}`); process.exitCode = 1; });
}

// ---------------------------------------------------------------- JobManager

await ok('concurrency: max 1 -> second job queues, starts after first finishes', async () => {
    const jm = new JobManager({ maxConcurrent: 1, ttlMs: 60_000 });
    const events = [];
    const gates = {};
    const runner = (name) => (signal) => new Promise((resolve, reject) => {
        events.push(`${name}:started`);
        gates[name] = { resolve: () => resolve(`${name}-result`), reject, signal };
        signal.addEventListener('abort', () => reject(new BridgeError('aborted', 'ABORTED')));
    });
    const a = jm.start('task-a', runner('a'));
    const b = jm.start('task-b', runner('b'));
    assert.equal(a.queued, false);
    assert.equal(b.queued, true);
    await sleep(10);
    assert.equal(jm.status(b.id).state, 'queued');
    gates.a.resolve();
    await sleep(30);
    assert.equal(jm.status(a.id).state, 'done');
    assert.equal(jm.status(a.id).result, 'a-result');
    assert.equal(jm.status(b.id).state, 'running', 'queued job starts when slot frees');
    gates.b.resolve();
    await sleep(30);
    assert.equal(jm.status(b.id).state, 'done');
    assert.deepEqual(events, ['a:started', 'b:started']);
});

await ok('cancel running -> ABORTED maps to cancelled state', async () => {
    const jm = new JobManager({ maxConcurrent: 2, ttlMs: 60_000 });
    const j = jm.start('task', (signal) => new Promise((_r, reject) => {
        signal.addEventListener('abort', () => reject(new BridgeError('aborted', 'ABORTED')));
    }));
    await sleep(5);
    assert.equal(jm.status(j.id).state, 'running');
    assert.equal(jm.cancel(j.id), true);
    await sleep(20);
    assert.equal(jm.status(j.id).state, 'cancelled');
});

await ok('cancel queued -> cancelled immediately, runner never starts', async () => {
    const jm = new JobManager({ maxConcurrent: 1, ttlMs: 60_000 });
    let startedB = false;
    jm.start('a', () => new Promise((r) => setTimeout(r, 80)));
    const b = jm.start('b', () => { startedB = true; return Promise.resolve('x'); });
    assert.equal(jm.cancel(b.id), true);
    await sleep(100);
    assert.equal(startedB, false, 'queued-cancelled job must not run');
    assert.equal(jm.status(b.id).state, 'cancelled');
});

await ok('errors keep their BridgeError code', async () => {
    const jm = new JobManager({ maxConcurrent: 2, ttlMs: 60_000 });
    const j = jm.start('boom', async () => { throw new BridgeError('budget blown', 'AGENT_TIMEOUT'); });
    await sleep(10);
    const s = jm.status(j.id);
    assert.equal(s.state, 'error');
    assert.equal(s.error.code, 'AGENT_TIMEOUT');
});

await ok('TTL sweep drops only finished jobs past their age', async () => {
    let clock = 1000;
    const jm = new JobManager({ maxConcurrent: 2, ttlMs: 100, now: () => clock });
    const j = jm.start('t', async () => 42);
    await sleep(5);
    clock += 500; // job finished at ~1000(+ε); 500ms later, ttl 100 -> sweep
    jm.sweep();
    assert.equal(jm.status(j.id), null);
});

// ------------------------------------------------- MCP-level (real server)

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-jobs-'));
const cfg = {
    host: '127.0.0.1', port: 0, httpPath: '/mcp', authToken: '',
    defaultProvider: '', defaultModel: 'deepseek-chat',
    agentAllowTools: [], agentDenyTools: ['bash', 'working_directory'],
    agentTimeoutMs: 5000, agentMaxConcurrent: 2, jobTtlMs: 60_000,
    stateDir,
};
const ctxStub = (await import('./protocol-stub-harness.mjs')).makeStubCtx();
const bridge = new ModelBridge(ctxStub, cfg, ctxStub.logger);
const running = await startMcpHttpServer(bridge, cfg);

const client = new Client({ name: 'jobs-test', version: '0.0.1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)));

await ok('MCP: dsh_agent_start returns jobId, status walks to done with result', async () => {
    const start = await client.callTool({ name: 'dsh_agent_start', arguments: { task: 'review src/bridge.ts' } });
    const parsed = JSON.parse(start.content[0].text);
    assert.ok(parsed.jobId, 'start returns jobId');
    let job = null;
    for (let i = 0; i < 50; i++) {
        await sleep(20);
        const st = await client.callTool({ name: 'dsh_agent_status', arguments: { job_id: parsed.jobId } });
        job = JSON.parse(st.content[0].text);
        if (job.state === 'done' || job.state === 'error') { break; }
    }
    assert.equal(job.found, true);
    assert.equal(job.state, 'done');
    assert.ok(job.result.text.includes('done: review src/bridge.ts'), `stub agent echoes task, got: ${job.result.text}`);
});

await ok('MCP: parallel fan-out respects agentMaxConcurrent', async () => {
    // Stub agent 人为放慢 -> 窗口期内观察真实并发分布
    stubTiming.idleDelayMs = 400;
    try {
        const started = [];
        for (let i = 0; i < 3; i++) {
            const r = await client.callTool({ name: 'dsh_agent_start', arguments: { task: `fanout-${i}` } });
            started.push(JSON.parse(r.content[0].text));
        }
        await sleep(80); // stub 400ms 后才完成，此刻 3 个都已提交
        const states = [];
        for (const s of started) {
            const st = await client.callTool({ name: 'dsh_agent_status', arguments: { job_id: s.jobId } });
            states.push(JSON.parse(st.content[0].text).state);
        }
        assert.equal(states.filter((s) => s === 'running').length, 2, `maxConcurrent=2 应有 2 个 running，实际 ${states.join(',')}`);
        assert.equal(states.filter((s) => s === 'queued').length, 1, `第 3 个应排队，实际 ${states.join(',')}`);
    } finally {
        stubTiming.idleDelayMs = 5;
    }
    let done = 0;
    for (let i = 0; i < 100; i++) {
        await sleep(40);
        const list = await client.callTool({ name: 'dsh_agent_list', arguments: {} });
        const jobs = JSON.parse(list.content[0].text).jobs;
        done = jobs.filter((j) => j.state === 'done' && j.label.startsWith('fanout-')).length;
        if (done >= 3) { break; }
    }
    assert.ok(done >= 3, `排队的第 3 个最终完成（got ${done}）`);
});

await ok('MCP: status of unknown/expired id reports found=false', async () => {
    const st = await client.callTool({ name: 'dsh_agent_status', arguments: { job_id: 'nope' } });
    const parsed = JSON.parse(st.content[0].text);
    assert.equal(parsed.found, false);
});

await ok('MCP: tools/list includes the four collaboration tools', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const t of ['dsh_agent_start', 'dsh_agent_status', 'dsh_agent_list', 'dsh_agent_cancel']) {
        assert.ok(names.includes(t), `missing ${t}`);
    }
});

await client.close();
await running.close();
rmSync(stateDir, { recursive: true, force: true });

console.log(process.exitCode ? '\nSOME TESTS FAILED' : `\nALL PASS (${passed} + MCP suite)`);

// ---------------------------------------------- restrict 自适应过滤（0.2.x）

const { knownToolsFromRestrictError } = await import('../lib/bridge.js');

await ok('knownToolsFromRestrictError: 解析 rc.5 报错里的已知工具名单', () => {
    const msg = 'tools.restrict() names unknown global tools "bash", "write"; known global tools: list_mcp_resources, working_directory';
    const known = knownToolsFromRestrictError(msg);
    assert.ok(known);
    assert.equal(known.size, 2);
    assert.ok(known.has('working_directory'));
    assert.equal(knownToolsFromRestrictError('some unrelated error'), null);
});

await ok('restrict 抛未知工具错误 -> 自动求交集重试（agent 照常完成）', async () => {
    // 本地 stub：restrict 第一次按原名单抛 rc.5 式错误，第二次记下收窄后的名单
    const restrictCalls = [];
    const mkCtx = () => {
        const eventsLocal = { listeners: [] };
        return {
            llm: {
                listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
                listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-flash', name: 'X' }],
                stream: async function* () {
                    yield { type: 'text-delta', index: 0, text: 'ok' };
                    yield { type: 'usage', index: 0, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
                    yield { type: 'finish', index: 0, reason: { kind: 'stop' } };
                },
            },
            agents: {
                create: async ({ sessionId, setup }) => {
                    let idleResolve;
                    const idle = new Promise((r) => (idleResolve = r));
                    const agent = {
                        id: sessionId,
                        followup: (msg) => {
                            eventsLocal.listeners.forEach((l) => l({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `done: ${msg.content[0].text}` }] }, interrupted: false } }));
                            setTimeout(idleResolve, 5);
                        },
                        whenIdle: () => idle,
                        cancel: () => {},
                    };
                    const agentCtx = {
                        tools: {
                            restrict: (r) => {
                                restrictCalls.push(r);
                                const unknown = (r.deny ?? []).filter((t) => !['read_only_probe', 'working_directory'].includes(t));
                                if (unknown.length) {
                                    throw new Error(`tools.restrict() names unknown global tools ${unknown.map((t) => `"${t}"`).join(', ')}; known global tools: read_only_probe, working_directory`);
                                }
                            },
                        },
                    };
                    await setup(agentCtx);
                    return { agent, dispose: async () => {} };
                },
            },
            on: (event, listener) => { eventsLocal.listeners.push(listener); return () => {}; },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
        };
    };
    const stateDir2 = mkdtempSync(join(tmpdir(), 'dsh-bridge-restrict-'));
    const ctx = mkCtx();
    const b = new ModelBridge(ctx, { ...cfg, stateDir: stateDir2 }, ctx.logger);
    const res = await b.agentRun({ task: 'probe restrict fallback' });
    assert.ok(res.text.includes('done: probe restrict fallback'));
    assert.equal(restrictCalls.length, 2, '第一次失败后按交集重试了一次');
    assert.deepEqual(restrictCalls[1].deny, ['working_directory'], 'deny 收窄为 harness 已知工具');
    rmSync(stateDir2, { recursive: true, force: true });
});

// ---------------------------------------------- 429 感知回退路由（0.2.2）

await ok('chat: 首选模型空流 -> 自动回退 fallbackModels 出答案', async () => {
    const eventsLocal = { listeners: [] };
    const ctx2 = {
        llm: {
            listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
            listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-flash', name: 'X' }],
            // deepseek-flash 空流(模拟上游限流);hy3 正常出文本
            stream: async function* (options) {
                if (options.model === 'deepseek-flash') { return; }
                yield { type: 'text-delta', index: 0, text: 'fallback-answer' };
                yield { type: 'usage', index: 0, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
                yield { type: 'finish', index: 0, reason: { kind: 'stop' } };
            },
        },
        agents: { create: async () => { throw new Error('unused'); } },
        on: (event, listener) => { eventsLocal.listeners.push(listener); return () => {}; },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const stateDir3 = mkdtempSync(join(tmpdir(), 'dsh-bridge-fb-'));
    const b = new ModelBridge(ctx2, {
        ...cfg, stateDir: stateDir3,
        defaultProvider: 'deepseek-official', defaultModel: 'deepseek-flash',
        fallbackModels: ['hy3'],
    }, ctx2.logger);
    const r = await b.chat({ prompt: 'hello' });
    assert.equal(r.text, 'fallback-answer');
    assert.equal(r.model, 'hy3');
    assert.ok(r.note.includes('deepseek-flash'), 'note 应说明回退来源');
    rmSync(stateDir3, { recursive: true, force: true });
});

await ok('agent: 首选模型无产出 -> 回退重跑拿到正文', async () => {
    const eventsLocal = { listeners: [] };
    const ctx2 = {
        llm: {
            listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
            listModels: async () => [{ provider: 'deepseek-official', id: 'deepseek-flash', name: 'X' }],
            stream: async function* () { yield { type: 'text-delta', index: 0, text: 'x' }; },
        },
        agents: {
            create: async ({ sessionId, setup }) => {
                let idleResolve;
                const idle = new Promise((r) => (idleResolve = r));
                const agent = {
                    id: sessionId,
                    followup: (msg) => {
                        const task = msg.content[0].text;
                        // flash 模型:不产生任何 assistant message(模拟 429 重试耗尽);其他模型正常出话
                        if (ctx2._lastModel === 'deepseek-flash') { setTimeout(idleResolve, 5); return; }
                        eventsLocal.listeners.forEach((l) => l({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done: ' + task }] }, interrupted: false } }));
                        setTimeout(idleResolve, 5);
                    },
                    whenIdle: () => idle,
                    cancel: () => {},
                };
                const agentCtx = { tools: { restrict: () => {} } };
                await setup(agentCtx);
                return { agent, dispose: async () => {} };
            },
        },
        on: (event, listener) => { eventsLocal.listeners.push(listener); return () => {}; },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        _lastModel: 'deepseek-flash',
    };
    // create 时记录当前模型
    ctx2.agents.create = (orig => async (args) => { ctx2._lastModel = args.agentOptions.model; return orig(args); })(ctx2.agents.create);
    const stateDir3 = mkdtempSync(join(tmpdir(), 'dsh-bridge-agfb-'));
    const b = new ModelBridge(ctx2, {
        ...cfg, stateDir: stateDir3,
        defaultProvider: 'deepseek-official', defaultModel: 'deepseek-flash',
        fallbackModels: ['hy3'],
    }, ctx2.logger);
    const r = await b.agentRun({ task: 'fanout-check' });
    assert.ok(r.assistantMessages > 0, '回退后应有 assistant message');
    assert.equal(r.model, 'hy3');
    assert.ok(r.note.includes('deepseek-flash'));
    assert.ok(r.text.includes('done: fanout-check'));
    rmSync(stateDir3, { recursive: true, force: true });
});
