/**
 * E2E test for the stdio adapter: start the real bridge HTTP server over a
 * stub harness, spawn `lib/stdio.js` as a subprocess, and drive it with an
 * MCP stdio client.
 *
 * Run: node test/stdio-test.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { ModelBridge } from '../lib/bridge.js';
import { startMcpHttpServer } from '../lib/mcp-server.js';

const here = dirname(fileURLToPath(import.meta.url));

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-stdio-'));
const cfg = {
    host: '127.0.0.1',
    port: 0,
    httpPath: '/mcp',
    authToken: 'stdio-token',
    defaultProvider: '',
    defaultModel: 'deepseek-chat',
    agentAllowTools: [],
    agentDenyTools: ['bash', 'pwsh'],
    agentTimeoutMs: 5000,
    stateDir,
};

const ctx = {
    llm: {
        listProviders: () => [{ id: 'p1', name: 'P1' }],
        listModels: async () => [{ provider: 'p1', id: 'm1', name: 'M1' }],
        stream: (options) => (async function* () {
            yield { type: 'text-delta', index: 0, text: 'hi from dsh' };
            yield { type: 'finish', index: 0, reason: { kind: 'stop' } };
        })(),
    },
    agents: { create: async () => { throw new Error('not exercised'); } },
    on: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
};

const bridge = new ModelBridge(ctx, cfg, ctx.logger);
const running = await startMcpHttpServer(bridge, cfg);

const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, '..', 'lib', 'stdio.js')],
    env: {
        ...process.env,
        DSH_BRIDGE_URL: `http://127.0.0.1:${running.port}/mcp`,
        DSH_BRIDGE_TOKEN: 'stdio-token',
    },
});

let failures = 0;
try {
    const client = new Client({ name: 'stdio-test', version: '0.0.1' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert.deepEqual(
        tools.map((t) => t.name).sort(),
        ['dsh_agent_run', 'dsh_chat', 'dsh_model_list', 'dsh_session_close', 'dsh_session_list'],
    );
    console.log('ok - stdio proxy lists upstream tools');

    const result = await client.callTool({ name: 'dsh_chat', arguments: { prompt: 'ping' } });
    assert.equal(JSON.parse(result.content[0].text).text, 'hi from dsh');
    console.log('ok - stdio proxy forwards tool calls with auth');
    await client.close();
} catch (error) {
    failures = 1;
    console.error('FAIL:', error?.stack ?? error);
} finally {
    await transport.close().catch(() => {});
    await running.close();
    rmSync(stateDir, { recursive: true, force: true });
}

console.log(failures === 0 ? 'STDIO PASS' : 'STDIO FAIL');
process.exit(failures);
