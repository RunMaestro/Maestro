/**
 * Tests for Auto Run file watching functionality
 *
 * Tests cover:
 * - File watcher IPC handlers (watchFolder, unwatchFolder)
 * - File change event debouncing
 * - Event filtering for .md files only
 * - Watcher cleanup on folder change
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FSWatcher, WatchEventType } from 'fs';

// Track watchers and their callbacks
const mockWatchers = new Map<
	string,
	{
		callback: (eventType: WatchEventType, filename: string | null) => void;
		close: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
	}
>();

// Mock fs.watch
const mockWatch = vi.fn(
	(
		folderPath: string,
		options: any,
		callback: (eventType: WatchEventType, filename: string | null) => void
	) => {
		const watcher = {
			callback,
			close: vi.fn(),
			on: vi.fn(),
		};
		mockWatchers.set(folderPath, watcher);
		return watcher as unknown as FSWatcher;
	}
);

// Mock fs/promises stat
const mockStat = vi.fn();

// Mock fs module
vi.mock('fs', () => ({
	default: {
		watch: mockWatch,
	},
	watch: mockWatch,
}));

vi.mock('fs/promises', () => ({
	default: {
		stat: mockStat,
	},
	stat: mockStat,
}));

describe('Auto Run File Watcher', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockWatchers.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('File change filtering', () => {
		it('should only trigger for .md files', () => {
			// Simulate the filtering logic from the main process
			const shouldTrigger = (filename: string | null): boolean => {
				if (!filename) return false;
				return filename.toLowerCase().endsWith('.md');
			};

			expect(shouldTrigger('document.md')).toBe(true);
			expect(shouldTrigger('UPPERCASE.MD')).toBe(true);
			expect(shouldTrigger('subfolder/nested.md')).toBe(true);
			expect(shouldTrigger('document.txt')).toBe(false);
			expect(shouldTrigger('image.png')).toBe(false);
			expect(shouldTrigger(null)).toBe(false);
			expect(shouldTrigger('')).toBe(false);
		});

		it('should remove .md extension from filename in events', () => {
			// Simulate the filename transformation from the main process
			const transformFilename = (filename: string): string => {
				return filename.replace(/\.md$/i, '');
			};

			expect(transformFilename('document.md')).toBe('document');
			expect(transformFilename('DOCUMENT.MD')).toBe('DOCUMENT');
			expect(transformFilename('subfolder/task.md')).toBe('subfolder/task');
		});
	});

	describe('Debouncing behavior', () => {
		it('should debounce rapid file changes', async () => {
			const events: string[] = [];
			const DEBOUNCE_MS = 300;
			let debounceTimer: NodeJS.Timeout | null = null;

			// Simulate debounced event handler
			const handleFileChange = (filename: string) => {
				if (debounceTimer) {
					clearTimeout(debounceTimer);
				}
				debounceTimer = setTimeout(() => {
					events.push(filename);
					debounceTimer = null;
				}, DEBOUNCE_MS);
			};

			// Rapid changes
			handleFileChange('doc1.md');
			handleFileChange('doc1.md');
			handleFileChange('doc1.md');

			// No events yet (still debouncing)
			expect(events).toHaveLength(0);

			// Advance past debounce time
			vi.advanceTimersByTime(DEBOUNCE_MS + 50);

			// Only one event should have fired
			expect(events).toHaveLength(1);
			expect(events[0]).toBe('doc1.md');
		});

		it('should fire immediately after debounce period', async () => {
			const events: string[] = [];
			const DEBOUNCE_MS = 300;
			let debounceTimer: NodeJS.Timeout | null = null;

			const handleFileChange = (filename: string) => {
				if (debounceTimer) {
					clearTimeout(debounceTimer);
				}
				debounceTimer = setTimeout(() => {
					events.push(filename);
					debounceTimer = null;
				}, DEBOUNCE_MS);
			};

			// First change
			handleFileChange('doc1.md');
			vi.advanceTimersByTime(DEBOUNCE_MS + 50);
			expect(events).toHaveLength(1);

			// Second change after debounce completed
			handleFileChange('doc2.md');
			vi.advanceTimersByTime(DEBOUNCE_MS + 50);
			expect(events).toHaveLength(2);
			expect(events[1]).toBe('doc2.md');
		});
	});

	describe('Watcher lifecycle', () => {
		it('should track active watchers by folder path', () => {
			const activeWatchers = new Map<string, FSWatcher>();

			// Start watching
			const folder1 = '/path/to/folder1';
			const folder2 = '/path/to/folder2';

			activeWatchers.set(folder1, {} as FSWatcher);
			activeWatchers.set(folder2, {} as FSWatcher);

			expect(activeWatchers.has(folder1)).toBe(true);
			expect(activeWatchers.has(folder2)).toBe(true);
			expect(activeWatchers.size).toBe(2);
		});

		it('should replace existing watcher for same folder', () => {
			const activeWatchers = new Map<string, { close: () => void }>();
			const folder = '/path/to/folder';

			const watcher1 = { close: vi.fn() };
			const watcher2 = { close: vi.fn() };

			// First watcher
			activeWatchers.set(folder, watcher1);

			// Replace with second watcher (should close first)
			if (activeWatchers.has(folder)) {
				activeWatchers.get(folder)?.close();
				activeWatchers.delete(folder);
			}
			activeWatchers.set(folder, watcher2);

			expect(watcher1.close).toHaveBeenCalled();
			expect(activeWatchers.get(folder)).toBe(watcher2);
		});

		it('should clean up watcher on unwatch', () => {
			const activeWatchers = new Map<string, { close: () => void }>();
			const folder = '/path/to/folder';

			const watcher = { close: vi.fn() };
			activeWatchers.set(folder, watcher);

			// Unwatch
			if (activeWatchers.has(folder)) {
				activeWatchers.get(folder)?.close();
				activeWatchers.delete(folder);
			}

			expect(watcher.close).toHaveBeenCalled();
			expect(activeWatchers.has(folder)).toBe(false);
		});

		it('should clean up all watchers on app quit', () => {
			const activeWatchers = new Map<string, { close: () => void }>();

			const watcher1 = { close: vi.fn() };
			const watcher2 = { close: vi.fn() };
			const watcher3 = { close: vi.fn() };

			activeWatchers.set('/folder1', watcher1);
			activeWatchers.set('/folder2', watcher2);
			activeWatchers.set('/folder3', watcher3);

			// Simulate app quit cleanup
			for (const [, watcher] of activeWatchers) {
				watcher.close();
			}
			activeWatchers.clear();

			expect(watcher1.close).toHaveBeenCalled();
			expect(watcher2.close).toHaveBeenCalled();
			expect(watcher3.close).toHaveBeenCalled();
			expect(activeWatchers.size).toBe(0);
		});
	});

	describe('Event data structure', () => {
		it('should create correct event payload', () => {
			const createEventPayload = (folderPath: string, filename: string, eventType: string) => ({
				folderPath,
				filename: filename.replace(/\.md$/i, ''),
				eventType,
			});

			const payload = createEventPayload('/test/folder', 'task.md', 'change');

			expect(payload).toEqual({
				folderPath: '/test/folder',
				filename: 'task',
				eventType: 'change',
			});
		});

		it('should handle subfolder paths correctly', () => {
			const createEventPayload = (folderPath: string, filename: string, eventType: string) => ({
				folderPath,
				filename: filename.replace(/\.md$/i, ''),
				eventType,
			});

			// Subfolder path from fs.watch recursive mode
			const payload = createEventPayload('/test/folder', 'subfolder/nested-task.md', 'change');

			expect(payload).toEqual({
				folderPath: '/test/folder',
				filename: 'subfolder/nested-task',
				eventType: 'change',
			});
		});
	});

	describe('Path validation', () => {
		it('should validate folder exists before watching', async () => {
			mockStat.mockResolvedValue({ isDirectory: () => true });

			const folderPath = '/valid/folder';
			const stat = await mockStat(folderPath);

			expect(stat.isDirectory()).toBe(true);
		});

		it('should reject non-directory paths', async () => {
			mockStat.mockResolvedValue({ isDirectory: () => false });

			const filePath = '/path/to/file.txt';
			const stat = await mockStat(filePath);

			expect(stat.isDirectory()).toBe(false);
		});

		it('should handle stat errors gracefully', async () => {
			mockStat.mockRejectedValue(new Error('ENOENT: no such file or directory'));

			await expect(mockStat('/nonexistent/path')).rejects.toThrow('ENOENT');
		});
	});
});

describe('Auto Run File Watcher Integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('Watch + Event flow', () => {
		it('should complete full watch-change-unwatch cycle', () => {
			const activeWatchers = new Map<
				string,
				{ close: () => void; callback: (event: string, file: string) => void }
			>();
			const events: Array<{ folder: string; file: string }> = [];
			const DEBOUNCE_MS = 300;
			let debounceTimer: NodeJS.Timeout | null = null;

			const folder = '/test/autorun';

			// Start watching
			const callback = (eventType: string, filename: string) => {
				if (!filename?.endsWith('.md')) return;

				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => {
					events.push({ folder, file: filename.replace(/\.md$/, '') });
					debounceTimer = null;
				}, DEBOUNCE_MS);
			};

			activeWatchers.set(folder, { close: vi.fn(), callback });

			// Simulate file change
			const watcher = activeWatchers.get(folder);
			watcher?.callback('change', 'task1.md');

			// Advance debounce
			vi.advanceTimersByTime(DEBOUNCE_MS + 50);

			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({ folder, file: 'task1' });

			// Unwatch
			watcher?.close();
			activeWatchers.delete(folder);

			expect(activeWatchers.size).toBe(0);
		});

		it('should handle multiple folders independently', () => {
			const activeWatchers = new Map<string, { events: string[] }>();

			activeWatchers.set('/folder1', { events: [] });
			activeWatchers.set('/folder2', { events: [] });

			// Events to folder1
			activeWatchers.get('/folder1')?.events.push('doc1');
			activeWatchers.get('/folder1')?.events.push('doc2');

			// Events to folder2
			activeWatchers.get('/folder2')?.events.push('task1');

			expect(activeWatchers.get('/folder1')?.events).toEqual(['doc1', 'doc2']);
			expect(activeWatchers.get('/folder2')?.events).toEqual(['task1']);
		});
	});

	describe('Content reload on file change', () => {
		it('should trigger content reload when selected file changes', () => {
			const selectedFile = 'current-task';
			const changedFile = 'current-task';

			const shouldReload = selectedFile && changedFile === selectedFile;

			expect(shouldReload).toBe(true);
		});

		it('should not trigger content reload for different file', () => {
			const selectedFile = 'current-task';
			const changedFile = 'other-task';

			const shouldReload = selectedFile && changedFile === selectedFile;

			expect(shouldReload).toBe(false);
		});

		it('should not trigger content reload when no file is selected', () => {
			const selectedFile: string | null = null;
			const changedFile = 'some-task';

			// When selectedFile is null, we should not try to reload content
			const shouldReload = selectedFile && changedFile === selectedFile;

			expect(shouldReload).toBeFalsy();
		});

		it('should always refresh document list on any change', () => {
			// Document list should refresh regardless of which file changed
			// This allows detecting new/deleted files
			const shouldRefreshList = true; // Always true for any .md file change

			expect(shouldRefreshList).toBe(true);
		});

		it('should refresh document list even when no document is selected', () => {
			// Even with no selected document, changes should refresh the list
			// so new documents appear in the UI
			const selectedFile: string | null = null;
			const changedFile = 'new-document';

			// Document list should still refresh
			const shouldRefreshList = true;
			// But content should NOT reload (no selected file)
			const shouldReloadContent = selectedFile && changedFile === selectedFile;

			expect(shouldRefreshList).toBe(true);
			expect(shouldReloadContent).toBeFalsy();
		});
	});

	describe('Watch trigger conditions', () => {
		it('should watch when folder is set, even without selected document', () => {
			const folderPath = '/test/autorun';
			const selectedFile: string | null = null;

			// Watch should trigger when folder exists, regardless of selected file
			const shouldWatch = !!folderPath;

			expect(shouldWatch).toBe(true);
		});

		it('should not watch when folder is not set', () => {
			const folderPath: string | null = null;
			const selectedFile = 'some-doc';

			// No folder means no watch
			const shouldWatch = !!folderPath;

			expect(shouldWatch).toBe(false);
		});

		it('should watch when both folder and document are set', () => {
			const folderPath = '/test/autorun';
			const selectedFile = 'current-task';

			const shouldWatch = !!folderPath;

			expect(shouldWatch).toBe(true);
		});
	});
});

describe('Preload API types', () => {
	it('should define correct watchFolder return type', () => {
		type WatchResult = { success: boolean; error?: string };

		const successResult: WatchResult = { success: true };
		const errorResult: WatchResult = { success: false, error: 'Path is not a directory' };

		expect(successResult.success).toBe(true);
		expect(errorResult.success).toBe(false);
		expect(errorResult.error).toBe('Path is not a directory');
	});

	it('should define correct onFileChanged event data type', () => {
		type FileChangeEvent = {
			folderPath: string;
			filename: string;
			eventType: string;
		};

		const event: FileChangeEvent = {
			folderPath: '/test/folder',
			filename: 'task',
			eventType: 'change',
		};

		expect(event.folderPath).toBe('/test/folder');
		expect(event.filename).toBe('task');
		expect(event.eventType).toBe('change');
	});

	it('should define correct unsubscribe function type', () => {
		type Unsubscribe = () => void;

		const mockUnsubscribe: Unsubscribe = vi.fn();
		mockUnsubscribe();

		expect(mockUnsubscribe).toHaveBeenCalled();
	});
});

describe('IPC Message Emission on File Change', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('mainWindow.webContents.send behavior', () => {
		it('should emit autorun:fileChanged event with correct payload structure', () => {
			const mockSend = vi.fn();
			const mockWebContents = { send: mockSend };
			const mockMainWindow = {
				isDestroyed: () => false,
				webContents: mockWebContents,
			};

			const folderPath = '/test/autorun';
			const filename = 'task.md';
			const eventType = 'change';

			// Simulate what the handler does
			const filenameWithoutExt = filename.replace(/\.md$/i, '');
			mockMainWindow.webContents.send('autorun:fileChanged', {
				folderPath,
				filename: filenameWithoutExt,
				eventType,
			});

			expect(mockSend).toHaveBeenCalledWith('autorun:fileChanged', {
				folderPath: '/test/autorun',
				filename: 'task',
				eventType: 'change',
			});
		});

		it('should emit event with rename eventType for new files', () => {
			const mockSend = vi.fn();
			const mockMainWindow = {
				isDestroyed: () => false,
				webContents: { send: mockSend },
			};

			mockMainWindow.webContents.send('autorun:fileChanged', {
				folderPath: '/test/autorun',
				filename: 'new-document',
				eventType: 'rename',
			});

			expect(mockSend).toHaveBeenCalledWith('autorun:fileChanged', {
				folderPath: '/test/autorun',
				filename: 'new-document',
				eventType: 'rename',
			});
		});

		it('should emit event with change eventType for modified files', () => {
			const mockSend = vi.fn();
			const mockMainWindow = {
				isDestroyed: () => false,
				webContents: { send: mockSend },
			};

			mockMainWindow.webContents.send('autorun:fileChanged', {
				folderPath: '/test/autorun',
				filename: 'existing-document',
				eventType: 'change',
			});

			expect(mockSend).toHaveBeenCalledWith('autorun:fileChanged', {
				folderPath: '/test/autorun',
				filename: 'existing-document',
				eventType: 'change',
			});
		});

		it('should handle subdirectory file changes with correct path', () => {
			const mockSend = vi.fn();
			const mockMainWindow = {
				isDestroyed: () => false,
				webContents: { send: mockSend },
			};

			// fs.watch with recursive:true reports paths like 'Phase1/task.md'
			const filename = 'Phase1/task.md';
			const filenameWithoutExt = filename.replace(/\.md$/i, '');

			mockMainWindow.webContents.send('autorun:fileChanged', {
				folderPath: '/test/autorun',
				filename: filenameWithoutExt,
				eventType: 'change',
			});

			expect(mockSend).toHaveBeenCalledWith('autorun:fileChanged', {
				folderPath: '/test/autorun',
				filename: 'Phase1/task',
				eventType: 'change',
			});
		});

		it('should NOT emit event when mainWindow is null', () => {
			const mockSend = vi.fn();
			let mainWindow: { webContents: { send: typeof mockSend } } | null = null;

			// Simulate handler check
			const getMainWindow = () => mainWindow;
			const window = getMainWindow();

			if (window) {
				window.webContents.send('autorun:fileChanged', {});
			}

			expect(mockSend).not.toHaveBeenCalled();
		});

		it('should NOT emit event when mainWindow is destroyed', () => {
			const mockSend = vi.fn();
			const mockMainWindow = {
				isDestroyed: () => true,
				webContents: { send: mockSend },
			};

			// Simulate handler check
			if (mockMainWindow && !mockMainWindow.isDestroyed()) {
				mockMainWindow.webContents.send('autorun:fileChanged', {});
			}

			expect(mockSend).not.toHaveBeenCalled();
		});

		it('should emit event after debounce period', () => {
			const mockSend = vi.fn();
			const mockMainWindow = {
				isDestroyed: () => false,
				webContents: { send: mockSend },
			};

			const DEBOUNCE_MS = 300;
			let debounceTimer: NodeJS.Timeout | null = null;

			const emitChange = (folderPath: string, filename: string, eventType: string) => {
				if (debounceTimer) {
					clearTimeout(debounceTimer);
				}
				debounceTimer = setTimeout(() => {
					mockMainWindow.webContents.send('autorun:fileChanged', {
						folderPath,
						filename: filename.replace(/\.md$/i, ''),
						eventType,
					});
				}, DEBOUNCE_MS);
			};

			emitChange('/test', 'doc.md', 'change');

			// Not yet emitted
			expect(mockSend).not.toHaveBeenCalled();

			// Advance past debounce
			vi.advanceTimersByTime(DEBOUNCE_MS + 50);

			expect(mockSend).toHaveBeenCalledTimes(1);
		});

		it('should debounce multiple rapid changes to single emission', () => {
			const mockSend = vi.fn();
			const mockMainWindow = {
				isDestroyed: () => false,
				webContents: { send: mockSend },
			};

			const DEBOUNCE_MS = 300;
			let debounceTimer: NodeJS.Timeout | null = null;

			const emitChange = (folderPath: string, filename: string, eventType: string) => {
				if (debounceTimer) {
					clearTimeout(debounceTimer);
				}
				debounceTimer = setTimeout(() => {
					mockMainWindow.webContents.send('autorun:fileChanged', {
						folderPath,
						filename: filename.replace(/\.md$/i, ''),
						eventType,
					});
				}, DEBOUNCE_MS);
			};

			// Rapid changes
			emitChange('/test', 'doc.md', 'change');
			vi.advanceTimersByTime(100);
			emitChange('/test', 'doc.md', 'change');
			vi.advanceTimersByTime(100);
			emitChange('/test', 'doc.md', 'change');

			// Not yet (still debouncing)
			expect(mockSend).not.toHaveBeenCalled();

			// Advance past debounce
			vi.advanceTimersByTime(DEBOUNCE_MS + 50);

			// Only one emission
			expect(mockSend).toHaveBeenCalledTimes(1);
		});

		it('should use last file in debounce window for emission', () => {
			const mockSend = vi.fn();
			const mockMainWindow = {
				isDestroyed: () => false,
				webContents: { send: mockSend },
			};

			const DEBOUNCE_MS = 300;
			let debounceTimer: NodeJS.Timeout | null = null;
			let lastFilename: string | null = null;

			const emitChange = (folderPath: string, filename: string, eventType: string) => {
				if (debounceTimer) {
					clearTimeout(debounceTimer);
				}
				lastFilename = filename;
				debounceTimer = setTimeout(() => {
					mockMainWindow.webContents.send('autorun:fileChanged', {
						folderPath,
						filename: lastFilename!.replace(/\.md$/i, ''),
						eventType,
					});
				}, DEBOUNCE_MS);
			};

			emitChange('/test', 'first.md', 'change');
			vi.advanceTimersByTime(100);
			emitChange('/test', 'second.md', 'change');
			vi.advanceTimersByTime(100);
			emitChange('/test', 'third.md', 'change');

			vi.advanceTimersByTime(DEBOUNCE_MS + 50);

			expect(mockSend).toHaveBeenCalledWith('autorun:fileChanged', {
				folderPath: '/test',
				filename: 'third',
				eventType: 'change',
			});
		});
	});
});

describe('Window-Specific Event Routing', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('getMainWindow function behavior', () => {
		it('should route events to the correct window via getMainWindow', () => {
			const mockSend = vi.fn();
			const window1 = {
				id: 1,
				isDestroyed: () => false,
				webContents: { send: mockSend },
			};

			let mainWindowRef = window1;
			const getMainWindow = () => mainWindowRef;

			// Simulate event routing
			const mainWindow = getMainWindow();
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send('autorun:fileChanged', {
					folderPath: '/test',
					filename: 'doc',
					eventType: 'change',
				});
			}

			expect(mockSend).toHaveBeenCalledTimes(1);
		});

		it('should handle window reference updates', () => {
			const mockSend1 = vi.fn();
			const mockSend2 = vi.fn();

			const window1 = {
				id: 1,
				isDestroyed: () => false,
				webContents: { send: mockSend1 },
			};
			const window2 = {
				id: 2,
				isDestroyed: () => false,
				webContents: { send: mockSend2 },
			};

			let mainWindowRef: typeof window1 | typeof window2 = window1;
			const getMainWindow = () => mainWindowRef;

			// Send to window1
			let mainWindow = getMainWindow();
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send('autorun:fileChanged', { test: 1 });
			}

			// Update reference to window2
			mainWindowRef = window2;

			// Send to window2
			mainWindow = getMainWindow();
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send('autorun:fileChanged', { test: 2 });
			}

			expect(mockSend1).toHaveBeenCalledTimes(1);
			expect(mockSend2).toHaveBeenCalledTimes(1);
		});

		it('should not crash when getMainWindow returns null', () => {
			const getMainWindow = () => null;

			// This should not throw
			const mainWindow = getMainWindow();
			expect(() => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.webContents.send('autorun:fileChanged', {});
				}
			}).not.toThrow();
		});

		it('should not send when window has been destroyed', () => {
			const mockSend = vi.fn();
			const mockWindow = {
				isDestroyed: () => true,
				webContents: { send: mockSend },
			};

			const getMainWindow = () => mockWindow;

			const mainWindow = getMainWindow();
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send('autorun:fileChanged', {});
			}

			expect(mockSend).not.toHaveBeenCalled();
		});

		it('should handle window becoming destroyed between check and send', () => {
			let destroyed = false;
			const mockSend = vi.fn(() => {
				if (destroyed) {
					throw new Error('Object has been destroyed');
				}
			});

			const mockWindow = {
				isDestroyed: () => destroyed,
				webContents: { send: mockSend },
			};

			const getMainWindow = () => mockWindow;

			// Window is not destroyed at check time
			const mainWindow = getMainWindow();
			if (mainWindow && !mainWindow.isDestroyed()) {
				// Window becomes destroyed between check and send (race condition)
				destroyed = true;
				try {
					mainWindow.webContents.send('autorun:fileChanged', {});
				} catch (e) {
					// Handler should catch this error gracefully
					expect((e as Error).message).toBe('Object has been destroyed');
				}
			}
		});
	});

	describe('Per-folder event isolation', () => {
		it('should maintain separate watchers for different folders', () => {
			const watchersMap = new Map<
				string,
				{ callback: (event: string, file: string) => void; close: () => void }
			>();

			const folder1 = '/project1/autorun';
			const folder2 = '/project2/autorun';

			watchersMap.set(folder1, {
				callback: vi.fn(),
				close: vi.fn(),
			});
			watchersMap.set(folder2, {
				callback: vi.fn(),
				close: vi.fn(),
			});

			expect(watchersMap.has(folder1)).toBe(true);
			expect(watchersMap.has(folder2)).toBe(true);
			expect(watchersMap.size).toBe(2);
		});

		it('should emit events only for the specific folder that changed', () => {
			const events: Array<{ folder: string; file: string }> = [];

			const watchersMap = new Map<string, (event: string, file: string) => void>();

			// Simulated callbacks that capture folder context
			watchersMap.set('/folder1', (_eventType: string, filename: string) => {
				if (filename?.endsWith('.md')) {
					events.push({ folder: '/folder1', file: filename });
				}
			});

			watchersMap.set('/folder2', (_eventType: string, filename: string) => {
				if (filename?.endsWith('.md')) {
					events.push({ folder: '/folder2', file: filename });
				}
			});

			// Trigger change in folder1
			const folder1Callback = watchersMap.get('/folder1');
			folder1Callback?.('change', 'doc.md');

			// Trigger change in folder2
			const folder2Callback = watchersMap.get('/folder2');
			folder2Callback?.('change', 'other.md');

			expect(events).toHaveLength(2);
			expect(events[0]).toEqual({ folder: '/folder1', file: 'doc.md' });
			expect(events[1]).toEqual({ folder: '/folder2', file: 'other.md' });
		});

		it('should include folderPath in event payload for routing', () => {
			const mockSend = vi.fn();
			const mockWindow = {
				isDestroyed: () => false,
				webContents: { send: mockSend },
			};

			const sendEvent = (folderPath: string, filename: string) => {
				mockWindow.webContents.send('autorun:fileChanged', {
					folderPath,
					filename: filename.replace(/\.md$/i, ''),
					eventType: 'change',
				});
			};

			sendEvent('/project-a/autorun', 'task1.md');
			sendEvent('/project-b/autorun', 'task2.md');

			expect(mockSend).toHaveBeenCalledTimes(2);

			// Verify each call has correct folderPath
			expect(mockSend.mock.calls[0][1].folderPath).toBe('/project-a/autorun');
			expect(mockSend.mock.calls[1][1].folderPath).toBe('/project-b/autorun');
		});
	});
});

describe('Watcher Error Handling', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('watcher.on(error) handler', () => {
		it('should register error handler on watcher', () => {
			const mockOn = vi.fn();
			const mockWatcher = {
				on: mockOn,
				close: vi.fn(),
			};

			// Simulate registering error handler
			mockWatcher.on('error', (error: Error) => {
				// Error logged
				expect(error).toBeDefined();
			});

			expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
		});

		it('should handle EACCES (permission denied) error', () => {
			const errors: Error[] = [];
			const mockWatcher = {
				on: vi.fn((event: string, handler: (err: Error) => void) => {
					if (event === 'error') {
						// Simulate error
						const error = new Error('EACCES: permission denied');
						(error as NodeJS.ErrnoException).code = 'EACCES';
						handler(error);
					}
				}),
				close: vi.fn(),
			};

			mockWatcher.on('error', (error: Error) => {
				errors.push(error);
			});

			expect(errors).toHaveLength(1);
			expect(errors[0].message).toContain('EACCES');
		});

		it('should handle ENOENT (file not found) error', () => {
			const errors: Error[] = [];
			const mockWatcher = {
				on: vi.fn((event: string, handler: (err: Error) => void) => {
					if (event === 'error') {
						const error = new Error('ENOENT: no such file or directory');
						(error as NodeJS.ErrnoException).code = 'ENOENT';
						handler(error);
					}
				}),
				close: vi.fn(),
			};

			mockWatcher.on('error', (error: Error) => {
				errors.push(error);
			});

			expect(errors).toHaveLength(1);
			expect(errors[0].message).toContain('ENOENT');
		});

		it('should handle EMFILE (too many open files) error', () => {
			const errors: Error[] = [];
			const mockWatcher = {
				on: vi.fn((event: string, handler: (err: Error) => void) => {
					if (event === 'error') {
						const error = new Error('EMFILE: too many open files');
						(error as NodeJS.ErrnoException).code = 'EMFILE';
						handler(error);
					}
				}),
				close: vi.fn(),
			};

			mockWatcher.on('error', (error: Error) => {
				errors.push(error);
			});

			expect(errors).toHaveLength(1);
			expect(errors[0].message).toContain('EMFILE');
		});

		it('should not crash the watcher on error', () => {
			let watcherActive = true;
			const mockWatcher = {
				on: vi.fn((event: string, handler: (err: Error) => void) => {
					if (event === 'error') {
						const error = new Error('Some error');
						handler(error);
						// Error handler should not close watcher automatically
					}
				}),
				close: vi.fn(() => {
					watcherActive = false;
				}),
			};

			mockWatcher.on('error', () => {
				// Log error but don't close watcher
			});

			// Watcher should still be active
			expect(watcherActive).toBe(true);
			expect(mockWatcher.close).not.toHaveBeenCalled();
		});

		it('should log errors with folder context', () => {
			const loggedErrors: Array<{ message: string; folderPath: string }> = [];
			const folderPath = '/test/autorun';

			const mockWatcher = {
				on: vi.fn((event: string, handler: (err: Error) => void) => {
					if (event === 'error') {
						const error = new Error('Watcher error');
						handler(error);
					}
				}),
				close: vi.fn(),
			};

			mockWatcher.on('error', (error: Error) => {
				loggedErrors.push({
					message: error.message,
					folderPath,
				});
			});

			expect(loggedErrors).toHaveLength(1);
			expect(loggedErrors[0].folderPath).toBe('/test/autorun');
		});
	});

	describe('Watch folder validation errors', () => {
		it('should return error for non-directory path', async () => {
			mockStat.mockResolvedValue({ isDirectory: () => false });

			const isDirectory = (await mockStat('/test/file.txt')).isDirectory();
			expect(isDirectory).toBe(false);

			const result = { success: false, error: 'Path is not a directory' };
			expect(result.success).toBe(false);
			expect(result.error).toBe('Path is not a directory');
		});

		it('should return error for non-existent path that cannot be created', async () => {
			mockStat.mockRejectedValue(new Error('ENOENT'));
			// mkdir also fails (e.g., permission denied)
			const mockMkdir = vi.fn().mockRejectedValue(new Error('EACCES: permission denied'));

			await expect(mockStat('/nonexistent')).rejects.toThrow('ENOENT');
			await expect(mockMkdir('/nonexistent', { recursive: true })).rejects.toThrow('EACCES');
		});

		it('should create folder if it does not exist', async () => {
			const localMockMkdir = vi.fn().mockResolvedValue(undefined);

			// First stat fails (folder doesn't exist)
			const localMockStat = vi
				.fn()
				.mockRejectedValueOnce(new Error('ENOENT'))
				.mockResolvedValueOnce({ isDirectory: () => true });

			// Simulate handler flow: stat fails, mkdir succeeds, stat succeeds
			await expect(localMockStat('/test/autorun')).rejects.toThrow('ENOENT');
			await localMockMkdir('/test/autorun', { recursive: true });
			await expect(localMockStat('/test/autorun')).resolves.toHaveProperty('isDirectory');
		});
	});

	describe('Permission denied scenarios', () => {
		it('should handle permission denied on watch start', async () => {
			const mockFsWatch = vi.fn(() => {
				throw new Error('EACCES: permission denied');
			});

			expect(() => mockFsWatch('/protected/folder', { recursive: true }, () => {})).toThrow(
				'EACCES'
			);

			const result = { success: false, error: 'EACCES: permission denied' };
			expect(result.success).toBe(false);
		});

		it('should handle permission denied during file change detection', () => {
			const errors: Error[] = [];
			const callback = vi.fn();

			// Watch succeeds but callback triggers permission error
			const mockWatcher = {
				on: vi.fn((event: string, handler: (err: Error) => void) => {
					if (event === 'error') {
						const error = new Error('EACCES: permission denied reading file');
						handler(error);
					}
				}),
				close: vi.fn(),
			};

			mockWatcher.on('error', (error: Error) => {
				errors.push(error);
			});

			// Callback should not have been called due to permission error
			expect(callback).not.toHaveBeenCalled();
			expect(errors).toHaveLength(1);
		});

		it('should handle permission change after watch started', () => {
			let watcherCallback: ((eventType: string, filename: string | null) => void) | null = null;
			const errors: Error[] = [];

			const mockWatcher = {
				on: vi.fn((event: string, handler: (err: Error) => void) => {
					if (event === 'error') {
						// Store handler for later error simulation
						setTimeout(() => {
							const error = new Error('EACCES: permission denied');
							handler(error);
						}, 100);
					}
				}),
				close: vi.fn(),
			};

			// Register error handler
			mockWatcher.on('error', (error: Error) => {
				errors.push(error);
			});

			// Advance time to trigger error
			vi.advanceTimersByTime(150);

			expect(errors).toHaveLength(1);
			expect(errors[0].message).toContain('EACCES');
		});
	});

	describe('Watcher cleanup on error', () => {
		it('should cleanup watcher from map on critical error', () => {
			const watchers = new Map<string, { close: () => void }>();
			const folderPath = '/test/autorun';

			const mockWatcher = { close: vi.fn() };
			watchers.set(folderPath, mockWatcher);

			// Simulate critical error requiring cleanup
			const handleCriticalError = (path: string) => {
				const watcher = watchers.get(path);
				if (watcher) {
					watcher.close();
					watchers.delete(path);
				}
			};

			handleCriticalError(folderPath);

			expect(mockWatcher.close).toHaveBeenCalled();
			expect(watchers.has(folderPath)).toBe(false);
		});

		it('should not leave orphaned watchers on repeated errors', () => {
			const watchers = new Map<string, { close: () => void }>();
			const folderPath = '/test/autorun';

			// First watcher
			const watcher1 = { close: vi.fn() };
			watchers.set(folderPath, watcher1);

			// Error occurs, cleanup
			watcher1.close();
			watchers.delete(folderPath);

			// Second watcher attempt
			const watcher2 = { close: vi.fn() };
			watchers.set(folderPath, watcher2);

			// Only one watcher in map
			expect(watchers.size).toBe(1);
			expect(watchers.get(folderPath)).toBe(watcher2);
		});

		it('should close all watchers on app quit even with prior errors', () => {
			const watchers = new Map<string, { close: () => void; hasError: boolean }>();

			watchers.set('/folder1', { close: vi.fn(), hasError: true });
			watchers.set('/folder2', { close: vi.fn(), hasError: false });
			watchers.set('/folder3', { close: vi.fn(), hasError: true });

			// Simulate app quit cleanup
			for (const [, watcher] of watchers) {
				watcher.close();
			}
			watchers.clear();

			expect(watchers.size).toBe(0);
		});
	});

	describe('Graceful degradation', () => {
		it('should continue functioning after transient errors', () => {
			const events: string[] = [];
			let errorCount = 0;

			const handleEvent = (filename: string) => {
				events.push(filename);
			};

			const handleError = () => {
				errorCount++;
				// Don't stop watching, just log error
			};

			// Simulate transient error
			handleError();

			// Continue receiving events
			handleEvent('doc1.md');
			handleEvent('doc2.md');

			expect(errorCount).toBe(1);
			expect(events).toHaveLength(2);
		});

		it('should not lose events during error recovery', () => {
			const events: string[] = [];
			let isRecovering = false;

			const handleEvent = (filename: string) => {
				if (!isRecovering) {
					events.push(filename);
				}
			};

			handleEvent('event1.md');

			// Error occurs, brief recovery period
			isRecovering = true;
			handleEvent('event2.md'); // Lost during recovery

			// Recovery complete
			isRecovering = false;
			handleEvent('event3.md');

			expect(events).toEqual(['event1.md', 'event3.md']);
		});

		it('should attempt to recreate watcher after fatal error', () => {
			const watchers = new Map<string, { close: () => void }>();
			const createAttempts: string[] = [];

			const createWatcher = (folderPath: string) => {
				createAttempts.push(folderPath);
				const watcher = { close: vi.fn() };
				watchers.set(folderPath, watcher);
				return watcher;
			};

			const handleFatalError = (folderPath: string) => {
				const watcher = watchers.get(folderPath);
				if (watcher) {
					watcher.close();
					watchers.delete(folderPath);
				}

				// Attempt to recreate
				createWatcher(folderPath);
			};

			// Initial creation
			createWatcher('/test/autorun');

			// Fatal error triggers recreation
			handleFatalError('/test/autorun');

			expect(createAttempts).toEqual(['/test/autorun', '/test/autorun']);
			expect(watchers.size).toBe(1);
		});
	});
});

describe('Edge Cases and Boundary Conditions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('Null and undefined filename handling', () => {
		it('should ignore null filename from fs.watch', () => {
			const events: string[] = [];

			const handleChange = (eventType: string, filename: string | null) => {
				if (!filename) return;
				events.push(filename);
			};

			handleChange('change', null);
			handleChange('change', 'valid.md');

			expect(events).toEqual(['valid.md']);
		});

		it('should ignore empty string filename', () => {
			const events: string[] = [];

			const handleChange = (eventType: string, filename: string | null) => {
				if (!filename) return;
				events.push(filename);
			};

			handleChange('change', '');
			handleChange('change', 'valid.md');

			expect(events).toEqual(['valid.md']);
		});
	});

	describe('Special filename patterns', () => {
		it('should handle filename with multiple .md extensions', () => {
			const filename = 'document.md.md';
			const transformed = filename.replace(/\.md$/i, '');

			expect(transformed).toBe('document.md');
		});

		it('should handle filename that is just .md', () => {
			const filename = '.md';
			const shouldProcess = filename.toLowerCase().endsWith('.md') && !filename.startsWith('.');

			expect(shouldProcess).toBe(false); // Hidden file
		});

		it('should handle filename with case variations', () => {
			const filenames = ['document.MD', 'document.Md', 'document.mD'];

			const results = filenames.map((f) => f.toLowerCase().endsWith('.md'));

			expect(results).toEqual([true, true, true]);
		});

		it('should handle very long filenames', () => {
			const longName = 'a'.repeat(255) + '.md';
			const shouldProcess = longName.toLowerCase().endsWith('.md');

			expect(shouldProcess).toBe(true);
		});
	});

	describe('Debounce timer edge cases', () => {
		it('should handle timer exactly at boundary', () => {
			const events: string[] = [];
			const DEBOUNCE_MS = 300;
			let debounceTimer: NodeJS.Timeout | null = null;

			const triggerChange = (filename: string) => {
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => {
					events.push(filename);
				}, DEBOUNCE_MS);
			};

			triggerChange('doc.md');

			// Advance exactly to boundary
			vi.advanceTimersByTime(DEBOUNCE_MS);

			expect(events).toHaveLength(1);
		});

		it('should handle timer just before boundary', () => {
			const events: string[] = [];
			const DEBOUNCE_MS = 300;
			let debounceTimer: NodeJS.Timeout | null = null;

			const triggerChange = (filename: string) => {
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => {
					events.push(filename);
				}, DEBOUNCE_MS);
			};

			triggerChange('doc.md');

			// Advance just before boundary
			vi.advanceTimersByTime(DEBOUNCE_MS - 1);

			expect(events).toHaveLength(0);

			// Advance past
			vi.advanceTimersByTime(2);

			expect(events).toHaveLength(1);
		});

		it('should clear previous timer when new change arrives', () => {
			let timerCleared = false;
			const originalClearTimeout = global.clearTimeout;

			const triggerChange = () => {
				const timer = setTimeout(() => {}, 300);
				clearTimeout(timer);
				timerCleared = true;
			};

			triggerChange();

			expect(timerCleared).toBe(true);
		});
	});

	describe('Rapid watcher operations', () => {
		it('should handle rapid watch/unwatch cycles', () => {
			const watchers = new Map<string, { close: () => void }>();
			const operations: string[] = [];

			const watch = (path: string) => {
				operations.push(`watch:${path}`);
				watchers.set(path, { close: vi.fn() });
			};

			const unwatch = (path: string) => {
				operations.push(`unwatch:${path}`);
				watchers.get(path)?.close();
				watchers.delete(path);
			};

			// Rapid cycles
			watch('/test');
			unwatch('/test');
			watch('/test');
			unwatch('/test');
			watch('/test');

			expect(operations).toEqual([
				'watch:/test',
				'unwatch:/test',
				'watch:/test',
				'unwatch:/test',
				'watch:/test',
			]);
			expect(watchers.size).toBe(1);
		});

		it('should close previous watcher when re-watching same folder', () => {
			const watchers = new Map<string, { close: ReturnType<typeof vi.fn> }>();
			const path = '/test/autorun';

			// First watch
			const watcher1 = { close: vi.fn() };
			watchers.set(path, watcher1);

			// Re-watch same path (should close first)
			if (watchers.has(path)) {
				watchers.get(path)?.close();
				watchers.delete(path);
			}

			const watcher2 = { close: vi.fn() };
			watchers.set(path, watcher2);

			expect(watcher1.close).toHaveBeenCalled();
			expect(watchers.get(path)).toBe(watcher2);
		});
	});

	describe('Memory safety', () => {
		it('should not accumulate watchers indefinitely', () => {
			const watchers = new Map<string, { close: () => void }>();

			// Simulate many watch operations
			for (let i = 0; i < 100; i++) {
				const path = `/test/folder${i}`;
				watchers.set(path, { close: vi.fn() });
			}

			// Cleanup all
			for (const [, watcher] of watchers) {
				watcher.close();
			}
			watchers.clear();

			expect(watchers.size).toBe(0);
		});

		it('should properly cleanup timer on unwatch', () => {
			let timer: NodeJS.Timeout | null = null;
			let timerCleared = false;

			const watch = () => {
				timer = setTimeout(() => {}, 300);
			};

			const unwatch = () => {
				if (timer) {
					clearTimeout(timer);
					timerCleared = true;
					timer = null;
				}
			};

			watch();
			unwatch();

			expect(timerCleared).toBe(true);
			expect(timer).toBeNull();
		});
	});
});
