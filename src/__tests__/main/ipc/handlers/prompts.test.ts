import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

const { registeredHandlers, promptManagerMocks, loggerMock } = vi.hoisted(() => ({
	registeredHandlers: new Map<string, Function>(),
	promptManagerMocks: {
		getPrompt: vi.fn(),
		getAllPrompts: vi.fn(),
		getAllPromptIds: vi.fn(),
		savePrompt: vi.fn(),
		resetPrompt: vi.fn(),
		arePromptsInitialized: vi.fn(),
		getPromptsPath: vi.fn(),
		listPromptFiles: vi.fn(),
		getBundledDefault: vi.fn(),
	},
	loggerMock: {
		info: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: Function) => {
			registeredHandlers.set(channel, handler);
		}),
	},
}));

vi.mock('../../../../main/prompt-manager', () => promptManagerMocks);
vi.mock('../../../../main/utils/logger', () => ({ logger: loggerMock }));

import { registerPromptsHandlers } from '../../../../main/ipc/handlers/prompts';

describe('Prompts IPC handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		promptManagerMocks.arePromptsInitialized.mockReturnValue(true);
		registerPromptsHandlers();
	});

	it('keeps the read-only producer channels available to the prompts preload API', () => {
		expect(ipcMain.handle).toHaveBeenCalledWith('prompts:getPath', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('prompts:listFiles', expect.any(Function));
	});

	it('retains the uninitialized prompt response outside the shared handler', async () => {
		promptManagerMocks.arePromptsInitialized.mockReturnValue(false);
		const handler = registeredHandlers.get('prompts:get')!;

		await expect(handler({}, 'malformed-id')).resolves.toEqual({
			success: false,
			error: 'Prompts not yet initialized',
		});
	});

	it('returns the established path envelope', async () => {
		promptManagerMocks.getPromptsPath.mockReturnValue('/prompts');
		const handler = registeredHandlers.get('prompts:getPath')!;

		await expect(handler({})).resolves.toEqual({ success: true, path: '/prompts' });
	});

	it('retains the error envelope when listing prompt files fails', async () => {
		promptManagerMocks.listPromptFiles.mockRejectedValue(new Error('Prompt directory unavailable'));
		const handler = registeredHandlers.get('prompts:listFiles')!;

		await expect(handler({})).resolves.toEqual({
			success: false,
			error: 'Error: Prompt directory unavailable',
		});
	});
});
