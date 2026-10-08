/**
 * @file Unit tests for the CLI MCP bridge core (transport injected): list mapping
 * + name de-collision, call result mapping (ok / error / risk-blocked), the long
 * call timeout, and graceful behavior when the app is unreachable.
 */
import { describe, it, expect, vi } from 'vitest';
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
});
