import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExposeInMainWorld = vi.fn();
const mockInvoke = vi.fn();
const mockSend = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	contextBridge: {
		exposeInMainWorld: (...args: unknown[]) => mockExposeInMainWorld(...args),
	},
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		send: (...args: unknown[]) => mockSend(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

describe('preload index', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	it('exposes the composed Maestro API with newer preload namespaces', async () => {
		mockInvoke.mockResolvedValue('generated-name');

		const preload = await import('../../../main/preload/index');

		expect(mockExposeInMainWorld).toHaveBeenCalledTimes(1);
		expect(mockExposeInMainWorld).toHaveBeenCalledWith(
			'maestro',
			expect.objectContaining({
				autorun: expect.any(Object),
				directorNotes: expect.any(Object),
				platform: process.platform,
				tabNaming: expect.any(Object),
				wakatime: expect.any(Object),
			})
		);
		expect(preload.createTabNamingApi).toEqual(expect.any(Function));
		expect(preload.createDirectorNotesApi).toEqual(expect.any(Function));
		expect(preload.createWakatimeApi).toEqual(expect.any(Function));

		const exposedApi = mockExposeInMainWorld.mock.calls[0][1] as {
			tabNaming: ReturnType<typeof preload.createTabNamingApi>;
		};
		const config = { userMessage: 'Name this tab', agentType: 'codex', cwd: '/repo' };

		await expect(exposedApi.tabNaming.generateTabName(config)).resolves.toBe('generated-name');
		expect(mockInvoke).toHaveBeenCalledWith('tabNaming:generateTabName', config);
	});
});
