/**
 * @file Unit tests for the CLI MCP bridge core (transport injected): list mapping
 * + name de-collision, call result mapping (ok / error / risk-blocked), the long
 * call timeout, and graceful behavior when the app is unreachable.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { createMcpBridge, MCP_CALL_TIMEOUT_MS } from '../../../cli/services/mcp-bridge';

const serverInfo = { name: 'maestro-plugins', version: '1.0.0' };
const log = (): void => {};

describe('createMcpBridge - listTools', () => {
	it('maps app tool entries to MCP defs with a default inputSchema', async () => {
		const request = vi.fn(async () => ({
			tools: [{ name: 'p__a', toolId: 'p/a', description: 'd' }],
		}));
		const tools = await createMcpBridge({ serverInfo, request, log }).listTools();
		expect(tools).toEqual([{ name: 'p__a', description: 'd', inputSchema: { type: 'object' } }]);
	});

	it('de-collides duplicate sanitized names and routes the call to the right toolId', async () => {
		const request = vi.fn();
		request.mockResolvedValueOnce({
			tools: [
				{ name: 'p__a', toolId: 'p/a' },
				{ name: 'p__a', toolId: 'p/a2' },
			],
		});
		const bridge = createMcpBridge({ serverInfo, request, log });
		const tools = await bridge.listTools();
		expect(tools.map((t) => t.name)).toEqual(['p__a', 'p__a__2']);

		request.mockResolvedValueOnce({ ok: true, result: 'R' });
		await bridge.callTool('p__a__2', {});
		expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
			type: 'plugins_call_tool',
			toolId: 'p/a2',
		});
	});

	it('advertises zero tools when the app is unreachable', async () => {
		const request = vi.fn(async () => {
			throw new Error('Not connected to Maestro');
		});
		const tools = await createMcpBridge({ serverInfo, request, log }).listTools();
		expect(tools).toEqual([]);
	});
});

describe('createMcpBridge - callTool', () => {
	it('maps a risk-gate block to an isError result', async () => {
		const request = vi.fn();
		request.mockResolvedValueOnce({ tools: [{ name: 'p__a', toolId: 'p/a' }] });
		const bridge = createMcpBridge({ serverInfo, request, log });
		await bridge.listTools();
		request.mockResolvedValueOnce({ ok: false, blocked: true, reason: 'high-risk prompt' });
		const r = await bridge.callTool('p__a', {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain('risk gate');
	});

	it('maps a tool failure to an isError result', async () => {
		const request = vi.fn();
		request.mockResolvedValueOnce({ tools: [{ name: 'p__a', toolId: 'p/a' }] });
		const bridge = createMcpBridge({ serverInfo, request, log });
		await bridge.listTools();
		request.mockResolvedValueOnce({ ok: false, error: 'boom' });
		const r = await bridge.callTool('p__a', {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain('boom');
	});

	it('rejects an unmapped tool name without calling the app', async () => {
		const request = vi.fn();
		const r = await createMcpBridge({ serverInfo, request, log }).callTool('never-listed', {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain('Unknown tool');
		expect(request).not.toHaveBeenCalled();
	});

	it('maps a success to text content, with mapped toolId and the long call timeout', async () => {
		const request = vi.fn();
		request.mockResolvedValueOnce({ tools: [{ name: 'p__a', toolId: 'p/a' }] });
		const bridge = createMcpBridge({ serverInfo, request, log });
		await bridge.listTools();

		request.mockResolvedValueOnce({ ok: true, result: { v: 1 } });
		const r = await bridge.callTool('p__a', { q: 2 });
		expect(r.isError).toBeUndefined();
		expect(r.content[0].text).toBe(JSON.stringify({ v: 1 }));

		const lastCall = request.mock.calls.at(-1);
		expect(lastCall?.[0]).toMatchObject({
			type: 'plugins_call_tool',
			toolId: 'p/a',
			args: { q: 2 },
		});
		expect(lastCall?.[2]).toBe(MCP_CALL_TIMEOUT_MS);
	});

	it('forwards the opaque run proof separately from model arguments', async () => {
		const request = vi.fn();
		request.mockResolvedValueOnce({ tools: [{ name: 'p__send', toolId: 'p/send' }] });
		const bridge = createMcpBridge({ serverInfo, request, log, runToken: 'a'.repeat(64) });
		await bridge.listTools();
		request.mockResolvedValueOnce({ ok: true, result: 'sent' });
		await bridge.callTool('p__send', { agentId: 'forged' });
		expect(request.mock.calls.at(-1)?.[0]).toEqual({
			type: 'plugins_call_tool',
			toolId: 'p/send',
			args: { agentId: 'forged' },
			runToken: 'a'.repeat(64),
		});
	});
});

describe('actual mcpServe proof configuration', () => {
	it.each([
		{ file: undefined, content: undefined, configured: false, token: undefined },
		{ file: '/synthetic/proof', content: 'a'.repeat(64), configured: true, token: 'a'.repeat(64) },
		{ file: '/synthetic/missing', content: new Error('ENOENT'), configured: true, token: null },
		{ file: '/synthetic/denied', content: new Error('EACCES'), configured: true, token: null },
		{ file: '/synthetic/empty', content: '', configured: true, token: '' },
		{ file: '/synthetic/malformed', content: 'malformed', configured: true, token: 'malformed' },
	])(
		'separates absent configuration from unusable proof $file',
		async ({ file, content, configured, token }) => {
			const source = fs.readFileSync(path.join(__dirname, '../../../cli/commands/mcp.ts'), 'utf8');
			const sf = ts.createSourceFile('mcp.ts', source, ts.ScriptTarget.Latest, true);
			let argument: ts.Expression | undefined;
			const visit = (node: ts.Node): void => {
				if (ts.isCallExpression(node) && node.expression.getText(sf) === 'createMcpBridge')
					argument = node.arguments[0];
				ts.forEachChild(node, visit);
			};
			visit(sf);
			expect(argument).toBeDefined();
			const request = vi.fn().mockResolvedValue({ tools: [{ name: 'p__a', toolId: 'p/a' }] });
			const readFileSync = vi.fn(() => {
				if (content instanceof Error) throw content;
				return content;
			});
			const js = ts.transpileModule(`const captured = ${argument!.getText(sf)};`, {
				compilerOptions: { target: ts.ScriptTarget.ES2024 },
			}).outputText;
			const deps = new Function('process', 'fs', 'client', 'log', `${js};return captured;`)(
				{ env: file ? { MAESTRO_PLUGIN_RUN_TOKEN_FILE: file } : {} },
				{ readFileSync },
				{ sendCommand: request },
				log
			) as Parameters<typeof createMcpBridge>[0];
			expect(Object.prototype.hasOwnProperty.call(deps, 'runToken')).toBe(configured);
			expect(deps.runToken).toBe(token);
			expect(readFileSync).toHaveBeenCalledTimes(file ? 1 : 0);
			const bridge = createMcpBridge(deps);
			await bridge.listTools();
			request.mockResolvedValue({ ok: true, result: 'synthetic' });
			const result = await bridge.callTool('p__a', {});
			const invalid = configured && (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token));
			expect(result.isError === true).toBe(invalid);
			expect(request).toHaveBeenCalledTimes(invalid ? 1 : 2);
			if (!configured) expect(request.mock.calls.at(-1)?.[0]).not.toHaveProperty('runToken');
		}
	);
});
