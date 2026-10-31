/**
 * Protocol-level test for dsh-model-bridge without a running harness.
 *
 * Builds a ModelBridge over a stub Cordis context (fake llm.stream and
 * agents.create), starts the real MCP HTTP server, and drives it with the
 * official MCP client — the same transport dsh's mcp-client uses.
 *
 * Run: node test/protocol-test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ModelBridge } from '../lib/bridge.js';
import { startMcpHttpServer } from '../lib/mcp-server.js';

// ---------------------------------------------------------------------------
// Stub harness
// ---------------------------------------------------------------------------

const logged = [];

function makeStream(text) {
    return async function* stream(options) {
        assert.equal(options.provider, 'deepseek-official');
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'usage', index: 0, usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } };
        yield { type: 'finish', index: 0, reason: { kind: 'stop' } };
    };
}

function makeStubCtx() {
    let createdAgents = 0;
    return {
        llm: {
            listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'workbuddy-ai', name: 'WorkBuddy AI' }],
            listModels: async (provider) =>
                provider === 'workbuddy-ai'
                    ? [{ provider, id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', inputModalities: ['text', 'image'] }]
                    : [{ provider, id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }],
            stream: (options) => {
                const last = [...options.messages].pop();
                const userText = last.content[0].text;
                return makeStream(`echo:${userText}`)(options);
            },
        },
        agents: {
            create: async ({ sessionId, setup }) => {
                createdAgents += 1;
                let idleResolve;
                const idle = new Promise((r) => (idleResolve = r));
                const agent = {
                    id: sessionId,
                    followup: (msg) => {
                        logged.push(`agent-task: ${msg.content[0].text}`);
                        // Simulate the loop publishing an assistant message via session events.
                        events.dispatch(sessionId, {
                            type: 'assistant/message',
                            data: { message: { content: [{ type: 'text', text: `done: ${msg.content[0].text}` }] } },
                        });
                        setTimeout(idleResolve, 5);
                    },
                    whenIdle: () => idle,
                    cancel: () => {},
                };
                const disposers = [];
                const agentCtx = {
                    tools: { restrict: (r) => { logged.push(`restrict: ${JSON.stringify(r)}`); disposers.push(() => {}); } },
                };
                await setup(agentCtx);
                return {
                    agent,
                    dispose: async () => {
                        createdAgents -= 1;
                    },
                };
            },
        },
        on: (event, listener) => {
            const entry = { event, listener };
            events.listeners.push(entry);
            return () => {
                events.listeners = events.listeners.filter((l) => l !== entry);
            };
        },
        logger: { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) },
        _createdAgents: () => createdAgents,
    };
}

const events = {
    listeners: [],
    dispatch(sessionId, event) {
        for (const l of this.listeners) l.listener({ id: sessionId }, event);
    },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-test-'));

async function withServer(cfgOverrides, fn) {
    const cfg = {
        host: '127.0.0.1',
        port: 0,
        httpPath: '/mcp',
        authToken: '',
        defaultProvider: '',
        defaultModel: 'deepseek-chat',
        agentAllowTools: [],
        agentDenyTools: ['bash', 'pwsh'],
        agentTimeoutMs: 5000,
        stateDir,
        ...cfgOverrides,
    };
    const ctx = makeStubCtx();
    const bridge = new ModelBridge(ctx, cfg, ctx.logger);
    const running = await startMcpHttpServer(bridge, cfg);
    try {
        return await fn(running.port, ctx);
    } finally {
        await running.close();
    }
}

async function connectClient(port, token) {
    const client = new Client({ name: 'protocol-test', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    });
    await client.connect(transport);
    return client;
}

let failures = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        failures += 1;
        console.error(`FAIL - ${name}\n  ${error?.stack ?? error}`);
    }
}

await test('tools/list exposes the four bridge tools', async () => {
    await withServer({}, async (port) => {
        const client = await connectClient(port);
        const { tools } = await client.listTools();
        assert.deepEqual(
            tools.map((t) => t.name).sort(),
            ['dsh_agent_run', 'dsh_chat', 'dsh_model_list', 'dsh_session_close', 'dsh_session_list'],
        );
        await client.close();
    });
});

await test('dsh_chat returns model text and a session id', async () => {
    await withServer({}, async (port) => {
        const client = await connectClient(port);
        const result = await client.callTool({ name: 'dsh_chat', arguments: { prompt: 'hello' } });
        const payload = JSON.parse(result.content[0].text);
        assert.equal(payload.text, 'echo:hello');
        assert.equal(payload.provider, 'deepseek-official');
        assert.ok(payload.sessionId);
        await client.close();
    });
});

await test('dsh_chat multi-turn keeps context in the same session', async () => {
    await withServer({}, async (port) => {
        const client = await connectClient(port);
        const first = await client.callTool({ name: 'dsh_chat', arguments: { prompt: 'one' } });
        const sid = JSON.parse(first.content[0].text).sessionId;
        const second = await client.callTool({ name: 'dsh_chat', arguments: { prompt: 'two', session_id: sid } });
        const payload = JSON.parse(second.content[0].text);
        assert.equal(payload.sessionId, sid);
        // The stub echoes only the last user message; session persistence is
        // asserted via the stored history file below.
        await client.close();
        const raw = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(stateDir, 'sessions', `${sid}.json`), 'utf8')));
        assert.equal(raw.messages.length, 4); // 2 user + 2 assistant
    });
});

await test('dsh_agent_run returns the delegated agent output and applies the tool policy', async () => {
    await withServer({}, async (port, ctx) => {
        const client = await connectClient(port);
        const result = await client.callTool({
            name: 'dsh_agent_run',
            arguments: { task: 'summarize README', cwd: 'C:\\tmp' },
        });
        const payload = JSON.parse(result.content[0].text);
        assert.equal(payload.text, 'done: summarize README');
        assert.equal(payload.assistantMessages, 1);
        assert.ok(logged.some((m) => m === 'restrict: {"deny":["bash","pwsh"]}'));
        assert.equal(ctx._createdAgents(), 0, 'agent handle must be disposed');
        await client.close();
    });
});

await test('dsh_agent_run allow-list mode wins over deny list', async () => {
    await withServer({ agentAllowTools: ['read', 'glob'] }, async (port) => {
        const client = await connectClient(port);
        await client.callTool({ name: 'dsh_agent_run', arguments: { task: 'x' } });
        assert.ok(logged.some((m) => m === 'restrict: {"allow":["read","glob"]}'));
        await client.close();
    });
});

await test('dsh_session_list and dsh_session_close work', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'dsh-bridge-sessions-'));
    try {
    await withServer({ stateDir: isolated }, async (port) => {
        const client = await connectClient(port);
        await client.callTool({ name: 'dsh_chat', arguments: { prompt: 'persist me' } });
        const list = JSON.parse((await client.callTool({ name: 'dsh_session_list', arguments: {} })).content[0].text);
        assert.equal(list.sessions.length, 1);
        const id = list.sessions[0].id;
        const closed = JSON.parse((await client.callTool({ name: 'dsh_session_close', arguments: { session_id: id } })).content[0].text);
        assert.equal(closed.closed, true);
        const after = JSON.parse((await client.callTool({ name: 'dsh_session_list', arguments: {} })).content[0].text);
        assert.equal(after.sessions.length, 0);
        await client.close();
    });
    } finally {
        rmSync(isolated, { recursive: true, force: true });
    }
});


await test('dsh_model_list discovers providers and models', async () => {
    await withServer({}, async (port) => {
        const client = await connectClient(port);
        const result = await client.callTool({ name: 'dsh_model_list', arguments: {} });
        const payload = JSON.parse(result.content[0].text);
        assert.equal(payload.providers.length, 2);
        const wb = payload.providers.find((p) => p.provider === 'workbuddy-ai');
        assert.equal(wb.models[0].id, 'deepseek-v4.1-flash');
        assert.deepEqual(wb.models[0].input, ['text', 'image']);
        await client.close();
    });
});

await test('bearer token is enforced', async () => {
    await withServer({ authToken: 'sekrit' }, async (port) => {
        const bad = new Client({ name: 't', version: '0' });
        await assert.rejects(
            () => bad.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))),
            /401|Error/i,
        );
        const good = await connectClient(port, 'sekrit');
        const { tools } = await good.listTools();
        assert.equal(tools.length, 5);
        await good.close();
    });
});

await test('wrong path 404s and unknown tool errors cleanly', async () => {
    await withServer({}, async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/nope`, { method: 'POST', body: '{}' });
        assert.equal(res.status, 404);
        const client = await connectClient(port);
        const result = await client.callTool({ name: 'dsh_chat', arguments: {} }); // missing prompt
        assert.equal(result.isError, true);
        await client.close();
    });
});

rmSync(stateDir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
