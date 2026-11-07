import { configureBoardFeatures } from '../../../main/board/board-feature';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: any[]) => Promise<any>>(),
	workers: [] as any[],
	live: ['agent'],
	event: {} as any,
}));
vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: any[]) => Promise<any>) =>
			state.handlers.set(channel, handler),
	},
	ipcRenderer: {
		invoke: (channel: string, ...args: unknown[]) =>
			state.handlers.get(channel)!(state.event, ...args),
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
vi.mock('../../../main/board/board-storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/board/board-storage')>()),
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
	setBoardWorkerOptions: (command: { agentId: string; patch: unknown }) => {
		state.workers.find((w) => w.agentId === command.agentId).payload.executionOptions =
			command.patch;
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
	configureBoardFeatures({ get: () => ({ board: true, maestroCue: true }) });
	const webContents = { mainFrame: {} };
	state.event = { sender: webContents, senderFrame: webContents.mainFrame };
	registerBoardHandlers({
		getCueEngine: () => null,
		getMainWindow: () => ({ isDestroyed: () => false, webContents }) as any,
	});
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
		expect(
			await api.setWorkerOptions({
				agentId: 'agent',
				expectedPayload: '{}',
				patch: { customArgs: '--quoted "a b"' },
			})
		).toMatchObject([{ payload: { executionOptions: { customArgs: '--quoted "a b"' } } }]);
		for (const input of [
			{ agentId: 'missing', expectedPayload: '{}', patch: {} },
			{ agentId: 'agent', expectedPayload: '{}', patch: { roleRefs: [] } },
			{ agentId: 'agent', expectedPayload: '{}', patch: { customModel: 3 } },
			{ agentId: 'agent', expectedPayload: '{}', patch: {}, paused: false },
		])
			await expect(api.setWorkerOptions(input as never)).rejects.toThrow();
	});
});

it.each([
	'board:setWorkerOptions',
	'board:registerWorker',
	'board:setWorkerAccess',
	'board:enableWorker',
	'board:pauseWorker',
])('%s refuses secondary frames and removed agents before mutation', async (channel) => {
	const native = state.event;
	state.event = { ...native, senderFrame: {} };
	await expect(
		state.handlers.get(channel)!(state.event, {
			agentId: 'agent',
			expectedPayload: '{}',
			patch: {},
		})
	).rejects.toThrow('main frame');
	expect(state.workers).toEqual([]);
	state.event = native;
	state.live = [];
	await expect(
		state.handlers.get(channel)!(state.event, {
			agentId: 'agent',
			expectedPayload: '{}',
			patch: {},
		})
	).rejects.toThrow('Live agent not found');
	expect(state.workers).toEqual([]);
});

it.each([
	{ board: false, maestroCue: false },
	{ board: true, maestroCue: false },
	{ board: false, maestroCue: true },
])(
	'every registered Board IPC refuses disabled flags before its implementation: %j',
	async (flags) => {
		configureBoardFeatures({ get: () => flags });
		for (const handler of state.handlers.values())
			await expect(handler(state.event, {})).rejects.toThrow(
				flags.board ? 'CueDisabled' : 'BoardDisabled'
			);
		expect(state.workers).toEqual([]);
	}
);
