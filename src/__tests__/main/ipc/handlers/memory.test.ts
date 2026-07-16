import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

const { registeredHandlers, memoryManagerMocks, loggerMock } = vi.hoisted(() => ({
	registeredHandlers: new Map<string, Function>(),
	memoryManagerMocks: {
		listMemoryEntries: vi.fn(),
		readMemoryEntry: vi.fn(),
		writeMemoryEntry: vi.fn(),
		createMemoryEntry: vi.fn(),
		deleteMemoryEntry: vi.fn(),
		getMemoryDirectoryPath: vi.fn(),
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

vi.mock('../../../../main/memory-manager', () => memoryManagerMocks);
vi.mock('../../../../main/utils/logger', () => ({ logger: loggerMock }));

import { registerMemoryHandlers } from '../../../../main/ipc/handlers/memory';

describe('Memory IPC handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		registerMemoryHandlers();
	});

	it('keeps the read-only producer channels available to the memory preload API', () => {
		expect(ipcMain.handle).toHaveBeenCalledWith('memory:list', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('memory:read', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('memory:getPath', expect.any(Function));
	});

	it('returns the existing list envelope for concurrent project requests', async () => {
		memoryManagerMocks.listMemoryEntries.mockImplementation(async (projectPath: string) => ({
			directoryPath: projectPath,
			exists: true,
			entries: [{ name: `${projectPath}.md` }],
		}));
		const handler = registeredHandlers.get('memory:list')!;

		const [first, second] = await Promise.all([
			handler({}, '/projects/first', 'claude-code'),
			handler({}, '/projects/second', 'codex'),
		]);

		expect(first).toEqual({
			success: true,
			directoryPath: '/projects/first',
			exists: true,
			entries: [{ name: '/projects/first.md' }],
		});
		expect(second).toEqual({
			success: true,
			directoryPath: '/projects/second',
			exists: true,
			entries: [{ name: '/projects/second.md' }],
		});
		expect(memoryManagerMocks.listMemoryEntries).toHaveBeenNthCalledWith(
			1,
			'/projects/first',
			'claude-code'
		);
		expect(memoryManagerMocks.listMemoryEntries).toHaveBeenNthCalledWith(
			2,
			'/projects/second',
			'codex'
		);
	});

	it('retains the error envelope for malformed memory read input', async () => {
		memoryManagerMocks.readMemoryEntry.mockRejectedValue(new Error('Invalid memory filename'));
		const handler = registeredHandlers.get('memory:read')!;

		const result = await handler({}, '/project', '' as string, 'claude-code');

		expect(result).toEqual({ success: false, error: 'Error: Invalid memory filename' });
	});

	it('returns the memory path in the established response shape', async () => {
		memoryManagerMocks.getMemoryDirectoryPath.mockReturnValue('/project/.claude/memory');
		const handler = registeredHandlers.get('memory:getPath')!;

		await expect(handler({}, '/project', 'claude-code')).resolves.toEqual({
			success: true,
			path: '/project/.claude/memory',
		});
	});
});
