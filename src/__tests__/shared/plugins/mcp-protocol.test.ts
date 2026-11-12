/**
 * @file Unit tests for the pure MCP server core - real JSON-RPC frames exercise
 * the initialize handshake, notifications, tools/list, tools/call, and errors.
 */
import { describe, it, expect } from 'vitest';
import {
	createMcpToolServer,
	MCP_PROTOCOL_VERSION,
	type McpToolDef,
	type McpToolServerDeps,
} from '../../../shared/plugins/mcp-protocol';

const serverInfo = { name: 'test-server', version: '9.9.9' };

function makeServer(over: Partial<Pick<McpToolServerDeps, 'listTools' | 'callTool'>> = {}) {
	return createMcpToolServer({
		serverInfo,
		listTools: over.listTools ?? (async () => []),
		callTool: over.callTool ?? (async () => ({ content: [{ type: 'text', text: 'ok' }] })),
	});
}

type RpcResponse = {
	jsonrpc?: string;
	id?: unknown;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

describe('createMcpToolServer - initialize handshake', () => {
	it('responds with protocolVersion, tools capability, and serverInfo', async () => {
		const res = (await makeServer().handleMessage({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'c', version: '1' },
			},
		})) as RpcResponse;
		expect(res.jsonrpc).toBe('2.0');
		expect(res.id).toBe(1);
		expect(res.result?.protocolVersion).toBe('2025-06-18');
		expect(res.result?.capabilities).toMatchObject({ tools: {} });
		expect(res.result?.serverInfo).toEqual(serverInfo);
	});

	it('echoes a supported requested protocol version', async () => {
		const res = (await makeServer().handleMessage({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2024-11-05' },
		})) as RpcResponse;
		expect(res.result?.protocolVersion).toBe('2024-11-05');
	});

	it('falls back to our version for an unsupported requested version', async () => {
		const res = (await makeServer().handleMessage({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '1999-01-01' },
		})) as RpcResponse;
		expect(res.result?.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
	});
});

describe('createMcpToolServer - notifications', () => {
	it('returns null for notifications/initialized (no id => no response)', async () => {
		const res = await makeServer().handleMessage({
			jsonrpc: '2.0',
			method: 'notifications/initialized',
		});
		expect(res).toBeNull();
	});
});

describe('createMcpToolServer - tools/list', () => {
	it('returns the advertised tools', async () => {
		const tools: McpToolDef[] = [
			{ name: 'p__do', description: 'd', inputSchema: { type: 'object' } },
		];
		const res = (await makeServer({ listTools: async () => tools }).handleMessage({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
		})) as RpcResponse;
		expect(res.result?.tools).toEqual(tools);
	});

	it('maps a listTools rejection to an internal error', async () => {
		const res = (await makeServer({
			listTools: async () => {
				throw new Error('boom');
			},
		}).handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as RpcResponse;
		expect(res.error?.code).toBe(-32603);
	});
});

describe('createMcpToolServer - tools/call', () => {
	it('passes name + arguments through and returns the tool result', async () => {
		let seen: { name: string; args: unknown } | null = null;
		const res = (await makeServer({
			callTool: async (name, args) => {
				seen = { name, args };
				return { content: [{ type: 'text', text: 'R' }] };
			},
		}).handleMessage({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'p__do', arguments: { x: 1 } },
		})) as RpcResponse;
		expect(seen).toEqual({ name: 'p__do', args: { x: 1 } });
		expect((res.result?.content as Array<{ text: string }>)[0].text).toBe('R');
	});

	it('converts a thrown tool error into an isError result, not a protocol error', async () => {
		const res = (await makeServer({
			callTool: async () => {
				throw new Error('nope');
			},
		}).handleMessage({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'x' },
		})) as RpcResponse;
		expect(res.error).toBeUndefined();
		expect(res.result?.isError).toBe(true);
	});

	it('rejects a missing tool name with INVALID_PARAMS', async () => {
		const res = (await makeServer().handleMessage({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: {},
		})) as RpcResponse;
		expect(res.error?.code).toBe(-32602);
	});
});

describe('createMcpToolServer - misc', () => {
	it('answers ping with an empty result', async () => {
		const res = (await makeServer().handleMessage({
			jsonrpc: '2.0',
			id: 9,
			method: 'ping',
		})) as RpcResponse;
		expect(res.result).toEqual({});
	});

	it('returns method-not-found for an unknown method', async () => {
		const res = (await makeServer().handleMessage({
			jsonrpc: '2.0',
			id: 9,
			method: 'nope/nope',
		})) as RpcResponse;
		expect(res.error?.code).toBe(-32601);
	});

	it('drops a non-object message', async () => {
		expect(await makeServer().handleMessage('not an object')).toBeNull();
	});
});
