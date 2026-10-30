/**
 * @file sketch-mcp-bridge.test.ts
 *
 * The `maestro-sketch` bridge router, driven without a socket. Properties
 * worth protecting:
 *
 *   - **Identity comes from the handshake only**: no call runs before `hello`,
 *     a claimed id the process tree contradicts is refused, a `ppid` that maps
 *     to no agent is refused, and nothing falls back to an active session.
 *   - **Local agents only** (Q12): an SSH agent is refused at `hello` and on a
 *     call made after it moved to SSH.
 *   - **Ownership**: a tool that names a sketch runs only when the sketch's
 *     `ownerAgentId` is the connection's agent; a foreign and a missing sketch
 *     get the same refusal.
 *   - **Routing**: the tool service gets the checked agent and sketch; an
 *     unknown method and an unserved tool are refused by name.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sketch-bridge-test-userdata' } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/sketch/sketch-service', () => ({
	findSketchOwnerAgent: vi.fn(() => null),
	getSketchService: vi.fn(() => ({ getSketch: vi.fn(async () => null) })),
}));

import {
	SKETCH_BRIDGE_ERRORS,
	createSketchBridgeDispatcher,
	type SketchBridgeConnection,
	type SketchBridgeDispatcherDeps,
	type SketchToolCall,
	type SketchToolService,
} from '../../../main/sketch/sketch-mcp-bridge';
import { SKETCH_TOOL_NAMES } from '../../../main/sketch/sketch-mcp-types';
import type { SketchOwnerAgent } from '../../../main/sketch/sketch-service';
import type { SketchRecord } from '../../../shared/sketch/types';

const AGENTS: Record<string, SketchOwnerAgent> = {
	alpha: { id: 'alpha', name: 'Alpha', sshRemote: false },
	beta: { id: 'beta', name: 'Beta', sshRemote: false },
	remote: { id: 'remote', name: 'Remote Box', sshRemote: true },
};

function record(sketchId: string, ownerAgentId: string): SketchRecord {
	return {
		sketchId,
		ownerAgentId,
		name: `Sketch ${sketchId}`,
		filePath: `/sketches/${ownerAgentId}/${sketchId}.excalidraw`,
		createdAt: 1,
		share: null,
		guestEdited: false,
	};
}

const SKETCHES: Record<string, SketchRecord> = {
	'sk-alpha': record('sk-alpha', 'alpha'),
	'sk-beta': record('sk-beta', 'beta'),
};

function setup(overrides: SketchBridgeDispatcherDeps = {}) {
	const agents = { ...AGENTS };
	const tools: SketchToolService = {
		sketch_list: vi.fn(async ({ agent }: SketchToolCall) => ({ owner: agent.id })),
		sketch_read_scene: vi.fn(async ({ sketch }: SketchToolCall) => ({ read: sketch?.sketchId })),
	};
	const dispatch = createSketchBridgeDispatcher({
		findAgent: (id) => agents[id] ?? null,
		getSketch: async (id) => SKETCHES[id] ?? null,
		resolveAgentFromPid: async () => null,
		tools,
		...overrides,
	});
	const connection: SketchBridgeConnection = { agentId: null };
	let nextId = 1;
	const call = (method: string, params?: Record<string, unknown>) =>
		dispatch(connection, { id: nextId++, method, params });
	return { agents, tools, connection, call };
}

function errorOf(response: unknown): { code: number; message: string } {
	const value = response as { error?: { code: number; message: string } };
	if (!value.error) throw new Error(`expected an error, got ${JSON.stringify(response)}`);
	return value.error;
}

describe('sketch MCP bridge handshake', () => {
	it('refuses every tool before hello', async () => {
		const { call, tools } = setup();
		const error = errorOf(await call('sketch_list'));
		expect(error.code).toBe(SKETCH_BRIDGE_ERRORS.handshakeRequired);
		expect(tools.sketch_list).not.toHaveBeenCalled();
	});

	it('binds the claimed agent id', async () => {
		const { call, connection } = setup();
		expect(await call('hello', { agentId: 'alpha' })).toEqual({ id: 1, result: { ok: true } });
		expect(connection.agentId).toBe('alpha');
	});

	it('refuses a claimed id the process tree contradicts', async () => {
		const { call, connection } = setup({ resolveAgentFromPid: async () => 'beta' });
		const error = errorOf(await call('hello', { agentId: 'alpha', ppid: 4242 }));
		expect(error.code).toBe(SKETCH_BRIDGE_ERRORS.invalidParams);
		expect(error.message).toMatch(/does not match/);
		expect(connection.agentId).toBeNull();
	});

	it('binds through the ppid walk when no id is sent', async () => {
		const resolveAgentFromPid = vi.fn(async () => 'beta');
		const { call, connection } = setup({ resolveAgentFromPid });
		await call('hello', { ppid: 777 });
		expect(resolveAgentFromPid).toHaveBeenCalledWith(777);
		expect(connection.agentId).toBe('beta');
	});

	it('fails closed when the ppid maps to no agent', async () => {
		const { call, connection } = setup();
		const error = errorOf(await call('hello', { ppid: 777 }));
		expect(error.message).toMatch(/could not resolve/);
		expect(connection.agentId).toBeNull();
	});

	it('fails closed with neither an id nor a ppid', async () => {
		const { call } = setup();
		expect(errorOf(await call('hello', {})).message).toMatch(/required for hello/);
	});

	it('refuses an SSH-remote agent at hello (Q12)', async () => {
		const { call, connection } = setup();
		const error = errorOf(await call('hello', { agentId: 'remote' }));
		expect(error.code).toBe(SKETCH_BRIDGE_ERRORS.refused);
		expect(error.message).toMatch(/local agents only.*Remote Box.*SSH/);
		expect(connection.agentId).toBeNull();
	});

	it('refuses an agent that is not live', async () => {
		const { call } = setup();
		expect(errorOf(await call('hello', { agentId: 'ghost' })).message).toMatch(
			/not a live Maestro agent/
		);
	});
});

describe('sketch MCP bridge routing', () => {
	it('runs an agent-scoped tool with the bound agent', async () => {
		const { call, tools } = setup();
		await call('hello', { agentId: 'alpha' });
		expect(await call('sketch_list')).toEqual({ id: 2, result: { owner: 'alpha' } });
		expect(tools.sketch_list).toHaveBeenCalledWith({ agent: AGENTS.alpha, params: {} });
	});

	it('hands the owned sketch to the tool', async () => {
		const { call, tools } = setup();
		await call('hello', { agentId: 'alpha' });
		const response = await call('sketch_read_scene', { sketchId: 'sk-alpha' });
		expect(response).toEqual({ id: 2, result: { read: 'sk-alpha' } });
		expect(tools.sketch_read_scene).toHaveBeenCalledWith({
			agent: AGENTS.alpha,
			params: { sketchId: 'sk-alpha' },
			sketch: SKETCHES['sk-alpha'],
		});
	});

	it("refuses another agent's sketch and a missing one with the same answer", async () => {
		const { call, tools } = setup();
		await call('hello', { agentId: 'alpha' });
		const foreign = errorOf(await call('sketch_read_scene', { sketchId: 'sk-beta' }));
		const missing = errorOf(await call('sketch_read_scene', { sketchId: 'sk-nope' }));
		expect(foreign.code).toBe(SKETCH_BRIDGE_ERRORS.refused);
		expect(foreign.message).toBe('sketch bridge: this agent owns no sketch with the id "sk-beta".');
		expect(missing.message).toBe('sketch bridge: this agent owns no sketch with the id "sk-nope".');
		expect(tools.sketch_read_scene).not.toHaveBeenCalled();
	});

	it('reports each checked call on a sketch before the tool runs, and nothing else', async () => {
		const onToolCall = vi.fn();
		const order: string[] = [];
		onToolCall.mockImplementation(() => order.push('activity'));
		const { call } = setup({
			onToolCall,
			tools: {
				sketch_list: async () => ({}),
				sketch_read_scene: async () => order.push('read'),
				sketch_add_elements: async () => ({}),
			},
		});
		await call('hello', { agentId: 'alpha' });
		await call('sketch_list');
		await call('sketch_read_scene', { sketchId: 'sk-beta' });
		await call('sketch_from_mermaid', { sketchId: 'sk-alpha' });
		expect(onToolCall).not.toHaveBeenCalled();

		await call('sketch_read_scene', { sketchId: 'sk-alpha' });
		await call('sketch_add_elements', { sketchId: 'sk-alpha' });
		expect(order).toEqual(['activity', 'read', 'activity']);
		expect(onToolCall.mock.calls).toEqual([
			[{ agentId: 'alpha', sketchId: 'sk-alpha', writes: false }],
			[{ agentId: 'alpha', sketchId: 'sk-alpha', writes: true }],
		]);
	});

	it('requires a sketchId on every sketch-scoped tool', async () => {
		const { call } = setup();
		await call('hello', { agentId: 'alpha' });
		for (const tool of SKETCH_TOOL_NAMES) {
			if (tool === 'sketch_list' || tool === 'sketch_create') continue;
			const error = errorOf(await call(tool, {}));
			expect(error.code).toBe(SKETCH_BRIDGE_ERRORS.invalidParams);
		}
	});

	it('refuses a call after the agent moved to SSH', async () => {
		const { call, agents, tools } = setup();
		await call('hello', { agentId: 'alpha' });
		agents.alpha = { ...AGENTS.alpha, sshRemote: true };
		expect(errorOf(await call('sketch_list')).code).toBe(SKETCH_BRIDGE_ERRORS.refused);
		expect(tools.sketch_list).not.toHaveBeenCalled();
	});

	it('refuses an unknown method and an unserved tool by name', async () => {
		const { call } = setup();
		await call('hello', { agentId: 'alpha' });
		expect(errorOf(await call('rm_rf')).code).toBe(SKETCH_BRIDGE_ERRORS.unknownMethod);
		const unserved = errorOf(await call('sketch_create'));
		expect(unserved.code).toBe(SKETCH_BRIDGE_ERRORS.unknownMethod);
		expect(unserved.message).toMatch(/sketch_create is not available/);
	});

	it('reports a tool failure without dropping the connection state', async () => {
		const { call, connection } = setup({
			tools: {
				sketch_list: async () => {
					throw new Error('Sketch Book is off.');
				},
			},
		});
		await call('hello', { agentId: 'alpha' });
		const error = errorOf(await call('sketch_list'));
		expect(error.code).toBe(SKETCH_BRIDGE_ERRORS.toolFailed);
		expect(error.message).toBe('Sketch Book is off.');
		expect(connection.agentId).toBe('alpha');
	});
});
