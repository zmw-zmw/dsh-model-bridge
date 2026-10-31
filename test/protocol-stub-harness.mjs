/**
 * Shared stub harness for dsh-model-bridge tests (extracted from protocol-test).
 * A fake Cordis context: fake llm.stream / agents.create / session events.
 * The stub agent publishes an assistant message then goes idle ~5ms later.
 */
import assert from 'node:assert/strict';

const logged = [];

// ---------------------------------------------------------------------------
// Stub harness
// ---------------------------------------------------------------------------

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
                        setTimeout(idleResolve, stubTiming.idleDelayMs);
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

export const stubTiming = { idleDelayMs: 5 };
export { makeStubCtx, events, logged };
