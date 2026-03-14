/**
 * Tests for the BMAD IPC handlers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerBmadHandlers } from '../../../../main/ipc/handlers/bmad';
import * as bmadManager from '../../../../main/bmad-manager';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

vi.mock('../../../../main/bmad-manager', () => ({
	getBmadMetadata: vi.fn(),
	getBmadPrompts: vi.fn(),
	getBmadCommandBySlash: vi.fn(),
	saveBmadPrompt: vi.fn(),
	resetBmadPrompt: vi.fn(),
	refreshBmadPrompts: vi.fn(),
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('bmad IPC handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});
		registerBmadHandlers();
	});

	afterEach(() => {
		handlers.clear();
	});

	it('registers all BMAD handlers', () => {
		for (const channel of [
			'bmad:getMetadata',
			'bmad:getPrompts',
			'bmad:getCommand',
			'bmad:savePrompt',
			'bmad:resetPrompt',
			'bmad:refresh',
		]) {
			expect(handlers.has(channel)).toBe(true);
		}
	});

	it('returns metadata from the manager', async () => {
		const metadata = {
			lastRefreshed: '2026-03-14T00:00:00Z',
			commitSha: 'ac769b2',
			sourceVersion: '6.1.0',
			sourceUrl: 'https://github.com/bmad-code-org/BMAD-METHOD',
		};
		vi.mocked(bmadManager.getBmadMetadata).mockResolvedValue(metadata);

		const result = await handlers.get('bmad:getMetadata')!({} as any);

		expect(result).toEqual({ success: true, metadata });
	});

	it('returns all commands from the manager', async () => {
		const commands = [
			{
				id: 'help',
				command: '/bmad-help',
				description: 'Get help',
				prompt: '# Help',
				isCustom: false,
				isModified: false,
			},
		];
		vi.mocked(bmadManager.getBmadPrompts).mockResolvedValue(commands);

		const result = await handlers.get('bmad:getPrompts')!({} as any);

		expect(result).toEqual({ success: true, commands });
	});

	it('returns a command by slash command', async () => {
		const command = {
			id: 'help',
			command: '/bmad-help',
			description: 'Get help',
			prompt: '# Help',
			isCustom: false,
			isModified: false,
		};
		vi.mocked(bmadManager.getBmadCommandBySlash).mockResolvedValue(command);

		const result = await handlers.get('bmad:getCommand')!({} as any, '/bmad-help');

		expect(bmadManager.getBmadCommandBySlash).toHaveBeenCalledWith('/bmad-help');
		expect(result).toEqual({ success: true, command });
	});

	it('saves a prompt customization', async () => {
		vi.mocked(bmadManager.saveBmadPrompt).mockResolvedValue(undefined);

		const result = await handlers.get('bmad:savePrompt')!({} as any, 'help', '# Custom');

		expect(bmadManager.saveBmadPrompt).toHaveBeenCalledWith('help', '# Custom');
		expect(result).toEqual({ success: true });
	});

	it('resets a prompt to its default', async () => {
		vi.mocked(bmadManager.resetBmadPrompt).mockResolvedValue('# Default');

		const result = await handlers.get('bmad:resetPrompt')!({} as any, 'help');

		expect(bmadManager.resetBmadPrompt).toHaveBeenCalledWith('help');
		expect(result).toEqual({ success: true, prompt: '# Default' });
	});

	it('refreshes prompts from GitHub', async () => {
		const metadata = {
			lastRefreshed: '2026-03-14T00:00:00Z',
			commitSha: 'ac769b2',
			sourceVersion: '6.1.0',
			sourceUrl: 'https://github.com/bmad-code-org/BMAD-METHOD',
		};
		vi.mocked(bmadManager.refreshBmadPrompts).mockResolvedValue(metadata);

		const result = await handlers.get('bmad:refresh')!({} as any);

		expect(result).toEqual({ success: true, metadata });
	});
});
