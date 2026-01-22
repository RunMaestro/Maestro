/**
 * Tests for debug preload API
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

import { createDebugApi, createDocumentGraphApi } from '../../../main/preload/debug';

describe('Debug Preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('createDebugApi', () => {
		let api: ReturnType<typeof createDebugApi>;

		beforeEach(() => {
			api = createDebugApi();
		});

		describe('createPackage', () => {
			it('should invoke debug:createPackage without options', async () => {
				mockInvoke.mockResolvedValue({ success: true, path: '/tmp/debug-package.zip' });

				const result = await api.createPackage();

				expect(mockInvoke).toHaveBeenCalledWith('debug:createPackage', undefined);
				expect(result).toEqual({ success: true, path: '/tmp/debug-package.zip' });
			});

			it('should invoke debug:createPackage with options', async () => {
				mockInvoke.mockResolvedValue({ success: true, path: '/tmp/debug-package.zip' });
				const options = {
					includeLogs: true,
					includeErrors: true,
					includeSessions: false,
					includeGroupChats: false,
					includeBatchState: true,
				};

				const result = await api.createPackage(options);

				expect(mockInvoke).toHaveBeenCalledWith('debug:createPackage', options);
				expect(result.success).toBe(true);
			});

			it('should handle errors', async () => {
				mockInvoke.mockResolvedValue({ success: false, error: 'Failed to create package' });

				const result = await api.createPackage();

				expect(result.success).toBe(false);
			});
		});

		describe('previewPackage', () => {
			it('should invoke debug:previewPackage', async () => {
				const preview = {
					logs: 150,
					errors: 5,
					sessions: 10,
					groupChats: 2,
					estimatedSize: '5.2 MB',
				};
				mockInvoke.mockResolvedValue(preview);

				const result = await api.previewPackage();

				expect(mockInvoke).toHaveBeenCalledWith('debug:previewPackage');
				expect(result).toEqual(preview);
			});
		});
	});

	describe('createDocumentGraphApi', () => {
		let api: ReturnType<typeof createDocumentGraphApi>;

		beforeEach(() => {
			api = createDocumentGraphApi();
		});

		describe('watchFolder', () => {
			it('should invoke documentGraph:watchFolder', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				const result = await api.watchFolder('/project');

				expect(mockInvoke).toHaveBeenCalledWith('documentGraph:watchFolder', '/project');
				expect(result).toEqual({ success: true });
			});
		});

		describe('unwatchFolder', () => {
			it('should invoke documentGraph:unwatchFolder', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				const result = await api.unwatchFolder('/project');

				expect(mockInvoke).toHaveBeenCalledWith('documentGraph:unwatchFolder', '/project');
				expect(result).toEqual({ success: true });
			});
		});

		describe('onFilesChanged', () => {
			it('should register event listener and return cleanup function', () => {
				const callback = vi.fn();

				const cleanup = api.onFilesChanged(callback);

				expect(mockOn).toHaveBeenCalledWith('documentGraph:filesChanged', expect.any(Function));
				expect(typeof cleanup).toBe('function');
			});

			it('should call callback when event is received', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, data: unknown) => void;

				mockOn.mockImplementation(
					(_channel: string, handler: (event: unknown, data: unknown) => void) => {
						registeredHandler = handler;
					}
				);

				api.onFilesChanged(callback);

				const data = {
					rootPath: '/project',
					changes: [
						{ filePath: '/project/file1.ts', eventType: 'add' as const },
						{ filePath: '/project/file2.ts', eventType: 'change' as const },
					],
				};
				registeredHandler!({}, data);

				expect(callback).toHaveBeenCalledWith(data);
			});

			it('should remove listener when cleanup is called', () => {
				const callback = vi.fn();
				let registeredHandler: (event: unknown, data: unknown) => void;

				mockOn.mockImplementation(
					(_channel: string, handler: (event: unknown, data: unknown) => void) => {
						registeredHandler = handler;
					}
				);

				const cleanup = api.onFilesChanged(callback);
				cleanup();

				expect(mockRemoveListener).toHaveBeenCalledWith(
					'documentGraph:filesChanged',
					registeredHandler!
				);
			});
		});
	});
});
