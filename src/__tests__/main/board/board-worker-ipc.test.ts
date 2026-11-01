import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: any[]) => Promise<any>>(),
	workers: [] as any[],
	live: ['agent'],
}));
vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: any[]) => Promise<any>) =>
			state.handlers.set(channel, handler),
	},
	ipcRenderer: {
		invoke: (channel: string, ...args: unknown[]) => state.handlers.get(channel)!(null, ...args),
	},
}));
vi.mock('../../../main/utils/ipcHandler', () => ({
	withIpcErrorLogging:
		(_options: unknown, handler: (...args: any[]) => unknown) =>
		(_event: unknown, ...args: unknown[]) =>
			handler(...args),
}));
vi.mock('../../../main/stores/getters', () => ({
	getLiveSessions: () => state.live.map((id) => ({ id })),
}));
vi.mock('../../../main/board/board-storage', () => ({
	listBoardWorkers: () => structuredClone(state.workers),
	listBoardWorkerAccessOptions: () => ({ roles: [], repositories: [] }),
	registerBoardWorker: (agentId: string) => {
		if (!state.workers.some((w) => w.agentId === agentId))
			state.workers.push({ agentId, enabled: true, paused: false, payload: {} });
	},
	setBoardWorkerPaused: (id: string, paused: boolean) => {
		state.workers.find((w) => w.agentId === id).paused = paused;
	},
	setBoardWorkerEnabled: (id: string, enabled: boolean) => {
		state.workers.find((w) => w.agentId === id).enabled = enabled;
	},
	setBoardWorkerAccess: () => {
		throw new Error('Board worker role not found');
	},
}));
vi.mock('../../../main/board/board-dispatcher', () => ({ applyCardCancel: vi.fn() }));
vi.mock('../../../main/board/board-pr', () => ({ startCardPr: vi.fn() }));
import { registerBoardHandlers } from '../../../main/ipc/handlers/board';
import { createBoardApi } from '../../../main/preload/board';

beforeEach(() => {
	state.handlers.clear();
	state.workers = [];
	state.live = ['agent'];
	registerBoardHandlers({ getCueEngine: () => null });
});
describe('Board worker IPC bridge', () => {
	it('routes registration and state changes, and returns validation errors', async () => {
		const api = createBoardApi();
		await expect(api.registerWorker('missing')).rejects.toThrow('Live agent not found');
		expect(await api.registerWorker('agent')).toMatchObject([
			{ agentId: 'agent', enabled: true, paused: false },
		]);
		await api.pauseWorker('agent', true);
		await api.registerWorker('agent');
		expect(await api.enableWorker('agent', false)).toMatchObject([
			{ enabled: false, paused: true },
		]);
		await expect(
			api.setWorkerAccess('agent', [{ namespace: 'n', profileId: 'bad' }], [])
		).rejects.toThrow('role not found');
	});
});
