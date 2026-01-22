/**
 * Tests for files preload API
 *
 * Coverage:
 * - createTempfileApi: write, read, delete
 * - createHistoryApi: getAll, getAllPaginated, add, clear, delete, update, updateSessionName,
 *   getFilePath, listSessions, onExternalChange, reload
 * - createCliApi: getActivity, onActivityChange
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createTempfileApi, createHistoryApi, createCliApi } from '../../../main/preload/files';

describe('Files Preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('createTempfileApi', () => {
		let api: ReturnType<typeof createTempfileApi>;

		beforeEach(() => {
			api = createTempfileApi();
		});

		describe('write', () => {
			it('should invoke tempfile:write with content', async () => {
				mockInvoke.mockResolvedValue('/tmp/tempfile-123.txt');

				const result = await api.write('file content');

				expect(mockInvoke).toHaveBeenCalledWith('tempfile:write', 'file content', undefined);
				expect(result).toBe('/tmp/tempfile-123.txt');
			});

			it('should invoke tempfile:write with filename', async () => {
				mockInvoke.mockResolvedValue('/tmp/custom-name.txt');

				const result = await api.write('file content', 'custom-name.txt');

				expect(mockInvoke).toHaveBeenCalledWith(
					'tempfile:write',
					'file content',
					'custom-name.txt'
				);
				expect(result).toBe('/tmp/custom-name.txt');
			});
		});

		describe('read', () => {
			it('should invoke tempfile:read with path', async () => {
				mockInvoke.mockResolvedValue('file content');

				const result = await api.read('/tmp/tempfile-123.txt');

				expect(mockInvoke).toHaveBeenCalledWith('tempfile:read', '/tmp/tempfile-123.txt');
				expect(result).toBe('file content');
			});
		});

		describe('delete', () => {
			it('should invoke tempfile:delete with path', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.delete('/tmp/tempfile-123.txt');

				expect(mockInvoke).toHaveBeenCalledWith('tempfile:delete', '/tmp/tempfile-123.txt');
			});
		});
	});

	describe('createHistoryApi', () => {
		let api: ReturnType<typeof createHistoryApi>;

		beforeEach(() => {
			api = createHistoryApi();
		});

		describe('getAll', () => {
			it('should invoke history:getAll without parameters', async () => {
				mockInvoke.mockResolvedValue([]);

				await api.getAll();

				expect(mockInvoke).toHaveBeenCalledWith('history:getAll', undefined, undefined);
			});

			it('should invoke history:getAll with projectPath', async () => {
				mockInvoke.mockResolvedValue([]);

				await api.getAll('/project');

				expect(mockInvoke).toHaveBeenCalledWith('history:getAll', '/project', undefined);
			});

			it('should invoke history:getAll with sessionId', async () => {
				mockInvoke.mockResolvedValue([]);

				await api.getAll('/project', 'session-123');

				expect(mockInvoke).toHaveBeenCalledWith('history:getAll', '/project', 'session-123');
			});
		});

		describe('getAllPaginated', () => {
			it('should invoke history:getAllPaginated with options', async () => {
				mockInvoke.mockResolvedValue({ entries: [], total: 0 });
				const options = {
					projectPath: '/project',
					sessionId: 'session-123',
					pagination: { limit: 50, offset: 0 },
				};

				await api.getAllPaginated(options);

				expect(mockInvoke).toHaveBeenCalledWith('history:getAllPaginated', options);
			});
		});

		describe('add', () => {
			it('should invoke history:add with entry', async () => {
				mockInvoke.mockResolvedValue({ id: 'entry-123' });
				const entry = {
					id: 'entry-123',
					type: 'USER' as const,
					timestamp: Date.now(),
					summary: 'Test entry',
					projectPath: '/project',
				};

				await api.add(entry);

				expect(mockInvoke).toHaveBeenCalledWith('history:add', entry);
			});
		});

		describe('clear', () => {
			it('should invoke history:clear without projectPath', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.clear();

				expect(mockInvoke).toHaveBeenCalledWith('history:clear', undefined);
			});

			it('should invoke history:clear with projectPath', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.clear('/project');

				expect(mockInvoke).toHaveBeenCalledWith('history:clear', '/project');
			});
		});

		describe('delete', () => {
			it('should invoke history:delete with entryId', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.delete('entry-123');

				expect(mockInvoke).toHaveBeenCalledWith('history:delete', 'entry-123', undefined);
			});

			it('should invoke history:delete with sessionId', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.delete('entry-123', 'session-456');

				expect(mockInvoke).toHaveBeenCalledWith('history:delete', 'entry-123', 'session-456');
			});
		});

		describe('update', () => {
			it('should invoke history:update with updates', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.update('entry-123', { validated: true });

				expect(mockInvoke).toHaveBeenCalledWith(
					'history:update',
					'entry-123',
					{ validated: true },
					undefined
				);
			});

			it('should invoke history:update with sessionId', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.update('entry-123', { validated: false }, 'session-456');

				expect(mockInvoke).toHaveBeenCalledWith(
					'history:update',
					'entry-123',
					{ validated: false },
					'session-456'
				);
			});
		});

		describe('updateSessionName', () => {
			it('should invoke history:updateSessionName', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.updateSessionName('agent-session-123', 'New Session Name');

				expect(mockInvoke).toHaveBeenCalledWith(
					'history:updateSessionName',
					'agent-session-123',
					'New Session Name'
				);
			});
		});

		describe('getFilePath', () => {
			it('should invoke history:getFilePath', async () => {
				mockInvoke.mockResolvedValue('/path/to/history.json');

				const result = await api.getFilePath('session-123');

				expect(mockInvoke).toHaveBeenCalledWith('history:getFilePath', 'session-123');
				expect(result).toBe('/path/to/history.json');
			});
		});

		describe('listSessions', () => {
			it('should invoke history:listSessions', async () => {
				mockInvoke.mockResolvedValue(['session-1', 'session-2']);

				const result = await api.listSessions();

				expect(mockInvoke).toHaveBeenCalledWith('history:listSessions');
				expect(result).toEqual(['session-1', 'session-2']);
			});
		});

		describe('onExternalChange', () => {
			it('should register event listener and return cleanup function', () => {
				const callback = vi.fn();

				const cleanup = api.onExternalChange(callback);

				expect(mockOn).toHaveBeenCalledWith('history:externalChange', expect.any(Function));
				expect(typeof cleanup).toBe('function');
			});

			it('should call callback when event is received', () => {
				const callback = vi.fn();
				let registeredHandler: () => void;

				mockOn.mockImplementation((_channel: string, handler: () => void) => {
					registeredHandler = handler;
				});

				api.onExternalChange(callback);
				registeredHandler!();

				expect(callback).toHaveBeenCalled();
			});

			it('should remove listener when cleanup is called', () => {
				const callback = vi.fn();
				let registeredHandler: () => void;

				mockOn.mockImplementation((_channel: string, handler: () => void) => {
					registeredHandler = handler;
				});

				const cleanup = api.onExternalChange(callback);
				cleanup();

				expect(mockRemoveListener).toHaveBeenCalledWith(
					'history:externalChange',
					registeredHandler!
				);
			});
		});

		describe('reload', () => {
			it('should invoke history:reload', async () => {
				mockInvoke.mockResolvedValue(true);

				await api.reload();

				expect(mockInvoke).toHaveBeenCalledWith('history:reload');
			});
		});
	});

	describe('createCliApi', () => {
		let api: ReturnType<typeof createCliApi>;

		beforeEach(() => {
			api = createCliApi();
		});

		describe('getActivity', () => {
			it('should invoke cli:getActivity', async () => {
				mockInvoke.mockResolvedValue({ active: true, pid: 12345 });

				const result = await api.getActivity();

				expect(mockInvoke).toHaveBeenCalledWith('cli:getActivity');
				expect(result).toEqual({ active: true, pid: 12345 });
			});
		});

		describe('onActivityChange', () => {
			it('should register event listener and return cleanup function', () => {
				const callback = vi.fn();

				const cleanup = api.onActivityChange(callback);

				expect(mockOn).toHaveBeenCalledWith('cli:activityChange', expect.any(Function));
				expect(typeof cleanup).toBe('function');
			});

			it('should call callback when event is received', () => {
				const callback = vi.fn();
				let registeredHandler: () => void;

				mockOn.mockImplementation((_channel: string, handler: () => void) => {
					registeredHandler = handler;
				});

				api.onActivityChange(callback);
				registeredHandler!();

				expect(callback).toHaveBeenCalled();
			});

			it('should remove listener when cleanup is called', () => {
				const callback = vi.fn();
				let registeredHandler: () => void;

				mockOn.mockImplementation((_channel: string, handler: () => void) => {
					registeredHandler = handler;
				});

				const cleanup = api.onActivityChange(callback);
				cleanup();

				expect(mockRemoveListener).toHaveBeenCalledWith('cli:activityChange', registeredHandler!);
			});
		});
	});
});
