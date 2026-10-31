/**
 * MCP Streamable HTTP server exposing the bridge as four tools.
 *
 * Protocol handling uses the official `@modelcontextprotocol/sdk` in its
 * stateful mode (one `StreamableHTTPServerTransport` per MCP session), which
 * is what dsh's own `mcp-client` transport (`streamable-http`) and every
 * mainstream MCP client (ZCode, Claude Code, Cursor, ...) speak.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BridgeError } from './bridge.js';
function tokenMatches(expected, supplied) {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(supplied, 'utf8');
    if (a.length !== b.length) {
        // Still burn comparable time so length is not observable.
        timingSafeEqual(a, a);
        return false;
    }
    return timingSafeEqual(a, b);
}
function authorized(req, cfg) {
    if (!cfg.authToken)
        return true;
    const header = req.headers.authorization ?? '';
    return header.startsWith('Bearer ') && tokenMatches(cfg.authToken, header.slice('Bearer '.length));
}
function errorResult(error) {
    const code = error instanceof BridgeError ? error.code : 'BRIDGE_ERROR';
    const message = error instanceof Error ? error.message : String(error);
    return {
        isError: true,
        content: [{ type: 'text', text: `${code}: ${message}` }],
    };
}
function textResult(value) {
    return {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    };
}
/** Register the four bridge tools on an MCP server instance. */
function registerTools(mcp, bridge) {
    mcp.registerTool('dsh_chat', {
        title: 'Chat with a DeepSeek Harness model',
        description: 'Send a prompt to a model served by the local DeepSeek Harness (dsh). Pass the ' +
            'returned session_id back in follow-up calls to keep a multi-turn conversation. ' +
            'Use role presets for review/architecture/brainstorm collaboration.',
        inputSchema: {
            prompt: z.string().describe('The message to send to the model.'),
            session_id: z.string().optional().describe('Session id from a previous dsh_chat result for multi-turn context.'),
            system: z.string().optional().describe('Optional system prompt for this session (applies when the session is new).'),
            role: z.enum(['default', 'reviewer', 'architect', 'brainstormer']).optional()
                .describe('Collaboration preset: reviewer / architect / brainstormer.'),
            model: z.string().optional().describe('Model id override (default: plugin defaultModel).'),
            provider: z.string().optional().describe('Provider route override.'),
            max_tokens: z.number().int().positive().optional(),
            temperature: z.number().min(0).max(2).optional(),
        },
    }, async (args) => {
        try {
            const result = await bridge.chat({
                prompt: args.prompt,
                sessionId: args.session_id,
                system: args.system,
                role: (args.role ?? 'default'),
                model: args.model,
                provider: args.provider,
                maxTokens: args.max_tokens,
                temperature: args.temperature,
            });
            return textResult(result);
        }
        catch (error) {
            return errorResult(error);
        }
    });
    mcp.registerTool('dsh_model_list', {
        title: 'List DeepSeek Harness models',
        description: 'List every model provider registered in the local DeepSeek Harness (official ' +
            'DeepSeek, WorkBuddy-connected models, ...) with their model ids and capabilities. ' +
            'Use a returned (provider, id) pair in dsh_chat or dsh_agent_run to select a model.',
        inputSchema: {},
    }, async () => {
        try {
            return textResult({ providers: await bridge.listModels() });
        }
        catch (error) {
            return errorResult(error);
        }
    });
    mcp.registerTool('dsh_agent_run', {
        title: 'Delegate a task to a DeepSeek Harness agent',
        description: 'Run a task on a fresh one-shot DeepSeek Harness agent that can use harness tools ' +
            '(read-only by default) against the given working directory, and return its final ' +
            'answer. Use for second opinions, code review of workspace files, or delegated work.',
        inputSchema: {
            task: z.string().describe('Complete, self-contained task description for the agent.'),
            cwd: z.string().optional().describe('Working directory the agent operates in (default: harness cwd).'),
            model: z.string().optional(),
            provider: z.string().optional(),
            max_tokens: z.number().int().positive().optional(),
            timeout_ms: z.number().int().positive().optional()
                .describe('Wall-clock budget in ms (default: plugin agentTimeoutMs).'),
        },
    }, async (args) => {
        try {
            const result = await bridge.agentRun({
                task: args.task,
                cwd: args.cwd,
                model: args.model,
                provider: args.provider,
                maxTokens: args.max_tokens,
                timeoutMs: args.timeout_ms,
            });
            return textResult(result);
        }
        catch (error) {
            return errorResult(error);
        }
    });
    mcp.registerTool('dsh_agent_start', {
        title: 'Start a background DeepSeek Harness agent',
        description: 'Submit a task to a fresh one-shot DeepSeek Harness agent WITHOUT blocking: you get a '
            + 'jobId immediately and the agent runs in the background (at most '
            + '`agentMaxConcurrent` at once, extras queue). Fan out several tasks, then poll '
            + 'dsh_agent_status / dsh_agent_list and collect results. For a simple blocking '
            + 'run use dsh_agent_run instead.',
        inputSchema: {
            task: z.string().describe('Complete, self-contained task description for the agent.'),
            label: z.string().optional().describe('Short name shown in dsh_agent_list (default: task prefix).'),
            cwd: z.string().optional().describe('Working directory the agent operates in (default: harness cwd).'),
            model: z.string().optional(),
            provider: z.string().optional(),
            max_tokens: z.number().int().positive().optional(),
            timeout_ms: z.number().int().positive().optional()
                .describe('Wall-clock budget in ms (default: plugin agentTimeoutMs).'),
        },
    }, async (args) => {
        try {
            const { jobId, queued } = bridge.agentStart({
                task: args.task,
                cwd: args.cwd,
                model: args.model,
                provider: args.provider,
                maxTokens: args.max_tokens,
                timeoutMs: args.timeout_ms,
            });
            return textResult({ jobId, queued, hint: 'poll dsh_agent_status with this jobId' });
        }
        catch (error) {
            return errorResult(error);
        }
    });
    mcp.registerTool('dsh_agent_status', {
        title: 'Check a background agent job',
        description: 'State machine: queued -> running -> done | error | cancelled. When done, the full '
            + 'agent result (final answer, token-free) is included.',
        inputSchema: {
            job_id: z.string().describe('JobId returned by dsh_agent_start.'),
        },
    }, async (args) => {
        try {
            const job = bridge.agentJobStatus(args.job_id);
            if (!job) {
                return textResult({ found: false, note: 'unknown or expired (finished jobs are kept ~1h)' });
            }
            return textResult({ found: true, ...job });
        }
        catch (error) {
            return errorResult(error);
        }
    });
    mcp.registerTool('dsh_agent_list', {
        title: 'List background agent jobs',
        description: 'All known jobs, newest first, with states (queued/running/done/error/cancelled).',
        inputSchema: {},
    }, async () => {
        try {
            return textResult({ jobs: bridge.agentJobsList() });
        }
        catch (error) {
            return errorResult(error);
        }
    });
    mcp.registerTool('dsh_agent_cancel', {
        title: 'Cancel a background agent job',
        description: 'Abort a queued or running job. Returns true when a job was actually cancelled.',
        inputSchema: {
            job_id: z.string().describe('JobId returned by dsh_agent_start.'),
        },
    }, async (args) => {
        try {
            return textResult({ cancelled: bridge.agentJobCancel(args.job_id), jobId: args.job_id });
        }
        catch (error) {
            return errorResult(error);
        }
    });
    mcp.registerTool('dsh_session_list', {
        title: 'List bridge chat sessions',
        description: 'List active dsh-model-bridge chat sessions with their ids and turn counts.',
        inputSchema: {},
    }, async () => {
        try {
            return textResult({ sessions: bridge.listSessions() });
        }
        catch (error) {
            return errorResult(error);
        }
    });
    mcp.registerTool('dsh_session_close', {
        title: 'Close a bridge chat session',
        description: 'Drop a dsh-model-bridge chat session and its stored history.',
        inputSchema: {
            session_id: z.string().describe('Session id to close.'),
        },
    }, async (args) => {
        try {
            const closed = bridge.closeSession(args.session_id);
            return textResult({ closed, sessionId: args.session_id });
        }
        catch (error) {
            return errorResult(error);
        }
    });
}
/**
 * Start the bridge MCP endpoint. One HTTP session per MCP initialize; tools
 * are registered per-session so each MCP client gets its own McpServer.
 */
export function startMcpHttpServer(bridge, cfg) {
    const httpSessions = new Map();
    const httpServer = createServer((req, res) => {
        void handleRequest(req, res).catch((error) => {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(error) }, id: null }));
        });
    });
    async function handleRequest(req, res) {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        if (url.pathname !== cfg.httpPath) {
            res.writeHead(404).end();
            return;
        }
        if (!authorized(req, cfg)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }));
            return;
        }
        const mcpSessionId = req.headers['mcp-session-id'];
        const existing = typeof mcpSessionId === 'string' ? httpSessions.get(mcpSessionId) : undefined;
        if (req.method === 'POST') {
            const body = await readJsonBody(req);
            if (existing) {
                await existing.transport.handleRequest(req, res, body);
                return;
            }
            if (isInitializeRequest(body)) {
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (id) => {
                        httpSessions.set(id, { transport, server: mcp });
                    },
                    enableDnsRebindingProtection: false,
                });
                const mcp = new McpServer({ name: 'dsh-model-bridge', version: '0.1.0' });
                registerTools(mcp, bridge);
                transport.onclose = () => {
                    const id = [...httpSessions.entries()].find(([, s]) => s.transport === transport)?.[0];
                    if (id)
                        httpSessions.delete(id);
                };
                await mcp.connect(transport);
                await transport.handleRequest(req, res, body);
                return;
            }
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'server only accepts initialize requests without an MCP session id' },
                id: null,
            }));
            return;
        }
        if (req.method === 'GET' || req.method === 'DELETE') {
            if (!existing) {
                res.writeHead(404).end();
                return;
            }
            await existing.transport.handleRequest(req, res);
            return;
        }
        res.writeHead(405, { Allow: 'GET, POST, DELETE' }).end();
    }
    function readJsonBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                try {
                    const text = Buffer.concat(chunks).toString('utf8');
                    resolve(text ? JSON.parse(text) : undefined);
                }
                catch (error) {
                    reject(error);
                }
            });
            req.on('error', reject);
        });
    }
    return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(cfg.port, cfg.host, () => {
            const address = httpServer.address();
            const boundPort = typeof address === 'object' && address !== null ? address.port : cfg.port;
            resolve({
                port: boundPort,
                close: () => new Promise((resolveClose) => {
                    for (const session of httpSessions.values()) {
                        void session.transport.close().catch(() => { });
                    }
                    httpSessions.clear();
                    httpServer.close(() => resolveClose());
                }),
            });
        });
    });
}
