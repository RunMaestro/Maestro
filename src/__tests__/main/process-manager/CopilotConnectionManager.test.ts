import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CopilotConnectionManager } from '../../../main/process-manager/spawners/CopilotConnectionManager';
import type { ProcessConfig } from '../../../main/process-manager/types';

const state = vi.hoisted(() => ({
	clients: 0,
	stops: 0,
	disconnects: 0,
	sessions: [] as string[],
	startGate: null as Promise<void> | null,
	stopGate: null as Promise<void> | null,
}));

vi.mock('@github/copilot-sdk', () => {
	class FakeSession {
		constructor(readonly sessionId: string) {}
		async disconnect() {
			state.disconnects += 1;
		}
	}
	class FakeClient {
		constructor() {
			state.clients += 1;
		}
		async start() {
			if (state.startGate) await state.startGate;
		}
		async createSession() {
			const id = `session-${state.sessions.length + 1}`;
			state.sessions.push(id);
			return new FakeSession(id);
		}
		async resumeSession(id: string) {
			return new FakeSession(id);
		}
		async forceStop() {
			if (state.stopGate) await state.stopGate;
			state.stops += 1;
		}
	}
	return {
		CopilotClient: FakeClient,
		RuntimeConnection: { forStdio: vi.fn(() => ({})) },
	};
});

function config(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'maestro-turn',
		toolType: 'copilot-cli',
		cwd: process.cwd(),
		command: 'copilot',
		args: [],
		tabId: 'tab-a',
		harnessControlMode: 'native',
		...overrides,
	};
}

function handlers() {
	return {
		onPermissionRequest: vi.fn(),
		onUserInputRequest: vi.fn(),
		onElicitationRequest: vi.fn(),
	};
}

describe('CopilotConnectionManager', () => {
	beforeEach(() => {
		state.clients = 0;
		state.startGate = null;
		state.stopGate = null;
		state.stops = 0;
		state.disconnects = 0;
		state.sessions = [];
	});

	it('retains one runtime across 100 sequential turns and closes it once', async () => {
		const manager = new CopilotConnectionManager();
		let providerSessionId: string | undefined;
		for (let turn = 0; turn < 100; turn += 1) {
			const nextHandlers = handlers();
			const lease = await manager.acquire(
				config({ agentSessionId: providerSessionId, sessionId: `turn-${turn}` }),
				nextHandlers
			);
			providerSessionId = lease.session.sessionId;
			expect(lease.handlers).toBe(nextHandlers);
			expect(lease.refs).toBe(1);
			manager.release(lease);
			expect(lease.refs).toBe(0);
		}
		expect({ clients: state.clients, stops: state.stops, disconnects: state.disconnects }).toEqual({
			clients: 1,
			stops: 0,
			disconnects: 0,
		});
		await manager.closeAll();
		expect({ stops: state.stops, disconnects: state.disconnects }).toEqual({
			stops: 1,
			disconnects: 0,
		});
	});

	it('rejects overlapping turns and isolates tab or workspace identity', async () => {
		const manager = new CopilotConnectionManager();
		const first = await manager.acquire(config(), handlers());
		await expect(manager.acquire(config(), handlers())).rejects.toThrow('still running');
		manager.release(first);
		const otherTab = await manager.acquire(config({ tabId: 'tab-b' }), handlers());
		expect(otherTab.session.sessionId).not.toBe(first.session.sessionId);
		const otherWorkspace = await manager.acquire(config({ cwd: 'C:\\other' }), handlers());
		expect(otherWorkspace.session.sessionId).not.toBe(first.session.sessionId);
		expect(state.stops).toBe(1);
		await manager.closeAll();
	});

	it('serializes initialization and preserves identical configurations across tabs', async () => {
		const manager = new CopilotConnectionManager();
		const gate = Promise.withResolvers<void>();
		state.startGate = gate.promise;
		const initializing = manager.acquire(config(), handlers());
		await expect(manager.acquire(config(), handlers())).rejects.toThrow('still running');
		gate.resolve();
		const first = await initializing;
		manager.release(first);
		const other = await manager.acquire(config({ tabId: 'tab-b' }), handlers());
		manager.release(other);
		const firstAgain = await manager.acquire(config(), handlers());
		expect(firstAgain.session.sessionId).toBe(first.session.sessionId);
		expect(firstAgain.session.sessionId).not.toBe(other.session.sessionId);
		await manager.closeAll();
		expect(state.stops).toBe(2);
	});

	it('reuses a connection when environment insertion order differs', async () => {
		const manager = new CopilotConnectionManager();
		const first = await manager.acquire(
			config({
				customEnvVars: { B: '2', A: '1' },
				shellEnvVars: { Z: 'last', Y: 'first' },
			}),
			handlers()
		);
		manager.release(first);
		const reordered = await manager.acquire(
			config({
				customEnvVars: { A: '1', B: '2' },
				shellEnvVars: { Y: 'first', Z: 'last' },
			}),
			handlers()
		);
		expect(reordered.session.sessionId).toBe(first.session.sessionId);
		await manager.closeAll();
	});

	it('reserves replacement during shutdown and disposes retained leases by agent', async () => {
		const manager = new CopilotConnectionManager();
		const first = await manager.acquire(config(), handlers());
		manager.release(first);
		const stopGate = Promise.withResolvers<void>();
		state.stopGate = stopGate.promise;
		const replacement = manager.acquire(config({ modelId: 'different-model' }), handlers());
		await expect(manager.acquire(config(), handlers())).rejects.toThrow('still running');
		stopGate.resolve();
		const next = await replacement;
		expect(next.session.sessionId).not.toBe(first.session.sessionId);
		await manager.closeAgent('maestro-turn');
		expect(state.stops).toBe(2);
	});
});
