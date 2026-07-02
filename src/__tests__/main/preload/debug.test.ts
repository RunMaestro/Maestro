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

		describe('getAppStats', () => {
			it('should invoke debug:getAppStats and pass through the snapshot', async () => {
				const snapshot = {
					timestamp: 1234,
					platform: 'darwin' as NodeJS.Platform,
					main: { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 },
					electronProcesses: [],
					managedProcesses: [],
				};
				mockInvoke.mockResolvedValue(snapshot);

				const result = await api.getAppStats();

				expect(mockInvoke).toHaveBeenCalledWith('debug:getAppStats');
				expect(result).toEqual(snapshot);
			});
		});

		describe('profiling', () => {
			it('should invoke debug:getProfilingStatus and pass through the status', async () => {
				const status = {
					success: true,
					active: true,
					startedAt: 1000,
					elapsedMs: 4200,
					categories: ['toplevel', 'v8'],
				};
				mockInvoke.mockResolvedValue(status);

				const result = await api.getProfilingStatus();

				expect(mockInvoke).toHaveBeenCalledWith('debug:getProfilingStatus');
				expect(result).toEqual(status);
			});

			it('should invoke debug:startProfiling', async () => {
				mockInvoke.mockResolvedValue({
					success: true,
					active: true,
					startedAt: 1000,
					elapsedMs: 0,
					categories: ['toplevel'],
				});

				const result = await api.startProfiling();

				expect(mockInvoke).toHaveBeenCalledWith('debug:startProfiling');
				expect(result.active).toBe(true);
			});

			it('should invoke debug:stopProfiling and pass through the bundle result', async () => {
				const stopResult = {
					success: true,
					path: '/Users/me/Desktop/maestro-profile.zip',
					cancelled: false,
					bundleSizeBytes: 2048,
					traceSizeBytes: 20480,
					durationMs: 5000,
				};
				mockInvoke.mockResolvedValue(stopResult);

				const result = await api.stopProfiling();

				expect(mockInvoke).toHaveBeenCalledWith('debug:stopProfiling');
				expect(result).toEqual(stopResult);
			});

			it('should subscribe to debug:profilingProgress and forward events', () => {
				const callback = vi.fn();
				let registered: ((event: unknown, data: unknown) => void) | undefined;
				mockOn.mockImplementation((_channel: string, handler: typeof registered) => {
					registered = handler;
				});

				const cleanup = api.onProfilingProgress(callback);

				expect(mockOn).toHaveBeenCalledWith('debug:profilingProgress', expect.any(Function));

				// The wrapped handler should strip the IpcRendererEvent and pass data only.
				const payload = { phase: 'compressing', percent: 42 };
				registered?.({}, payload);
				expect(callback).toHaveBeenCalledWith(payload);

				// Cleanup removes the listener.
				cleanup();
				expect(mockRemoveListener).toHaveBeenCalledWith(
					'debug:profilingProgress',
					expect.any(Function)
				);
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
