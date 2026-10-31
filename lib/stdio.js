/**
 * stdio adapter for dsh-model-bridge (`dsh-model-bridge-mcp`).
 *
 * Some MCP hosts only spawn stdio servers. This binary is a transparent
 * one-to-one proxy: it connects to the bridge's Streamable HTTP endpoint
 * (started by the plugin inside a running harness) and mirrors its tool list
 * and calls over stdio.
 *
 * Environment:
 *   DSH_BRIDGE_URL    endpoint URL      (default http://127.0.0.1:3091/mcp)
 *   DSH_BRIDGE_TOKEN  bearer token      (default none)
 *
 * If the endpoint is unreachable, the process exits non-zero with a short
 * hint — the harness (or its Web UI) must be running for tools to exist.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
const url = process.env.DSH_BRIDGE_URL ?? 'http://127.0.0.1:3091/mcp';
const token = process.env.DSH_BRIDGE_TOKEN ?? '';
async function connectUpstream() {
    const client = new Client({ name: 'dsh-model-bridge-stdio', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    });
    await client.connect(transport);
    return client;
}
async function main() {
    let upstream;
    try {
        upstream = await connectUpstream();
    }
    catch (error) {
        process.stderr.write(`dsh-model-bridge-mcp: cannot reach the bridge endpoint at ${url} (${String(error)}).\n` +
            'Start the harness with the dsh-model-bridge plugin first, e.g. `dsh web --no-open`.\n');
        process.exit(1);
    }
    const server = new Server({ name: 'dsh-model-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const { tools } = await upstream.listTools();
        return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        return await upstream.callTool({
            name: request.params.name,
            arguments: request.params.arguments ?? {},
        });
    });
    await server.connect(new StdioServerTransport());
    process.stderr.write(`dsh-model-bridge-mcp: bridging tools from ${url}\n`);
}
void main().catch((error) => {
    process.stderr.write(`dsh-model-bridge-mcp: fatal: ${String(error)}\n`);
    process.exit(1);
});
