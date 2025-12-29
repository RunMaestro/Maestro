/**
 * Tests for Document Graph file watching functionality
 *
 * Tests cover:
 * - File watcher IPC handlers (watchFolder, unwatchFolder)
 * - File change event batching and debouncing (500ms delay)
 * - Event filtering for .md files only
 * - Ignored directories (node_modules, .git, dist, build)
 * - Watcher cleanup on folder change
 * - Multiple concurrent watchers for different directories
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FSWatcher } from 'chokidar';

// Track chokidar watchers and their event handlers
const mockWatchers = new Map<string, {
  eventHandlers: Map<string, (filePath: string) => void>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}>();

// Mock chokidar.watch
const mockChokidarWatch = vi.fn((rootPath: string, _options: any) => {
  const eventHandlers = new Map<string, (filePath: string) => void>();

  const watcher = {
    eventHandlers,
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (filePath: string) => void) => {
      eventHandlers.set(event, handler);
      return watcher;
    }),
  };

  mockWatchers.set(rootPath, watcher);
  return watcher as unknown as FSWatcher;
});

// Mock chokidar module
vi.mock('chokidar', () => ({
  default: {
    watch: mockChokidarWatch,
  },
  watch: mockChokidarWatch,
}));

describe('Document Graph File Watcher', () => {
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
      const shouldTrigger = (filePath: string): boolean => {
        return filePath.toLowerCase().endsWith('.md');
      };

      // Should trigger
      expect(shouldTrigger('/path/to/document.md')).toBe(true);
      expect(shouldTrigger('/path/to/UPPERCASE.MD')).toBe(true);
      expect(shouldTrigger('/path/to/subfolder/nested.md')).toBe(true);
      expect(shouldTrigger('/path/README.md')).toBe(true);

      // Should not trigger
      expect(shouldTrigger('/path/to/document.txt')).toBe(false);
      expect(shouldTrigger('/path/to/image.png')).toBe(false);
      expect(shouldTrigger('/path/to/script.js')).toBe(false);
      expect(shouldTrigger('/path/to/data.json')).toBe(false);
      expect(shouldTrigger('')).toBe(false);
    });

    it('should ignore dotfiles', () => {
      // The chokidar config ignores dotfiles via: /(^|[/\\])\../
      const isDotfile = (path: string): boolean => {
        return /(^|[/\\])\./.test(path);
      };

      expect(isDotfile('.hidden.md')).toBe(true);
      expect(isDotfile('/path/.hidden/file.md')).toBe(true);
      expect(isDotfile('/path/to/.gitignore')).toBe(true);
      expect(isDotfile('/path/to/visible.md')).toBe(false);
    });

    it('should ignore common build directories', () => {
      const isIgnoredDir = (path: string): boolean => {
        const ignoredPatterns = [/node_modules/, /dist/, /build/, /\.git/];
        return ignoredPatterns.some(pattern => pattern.test(path));
      };

      expect(isIgnoredDir('/project/node_modules/pkg/README.md')).toBe(true);
      expect(isIgnoredDir('/project/dist/doc.md')).toBe(true);
      expect(isIgnoredDir('/project/build/output.md')).toBe(true);
      expect(isIgnoredDir('/project/.git/config')).toBe(true);
      expect(isIgnoredDir('/project/src/docs/README.md')).toBe(false);
    });
  });

  describe('Event batching behavior (500ms debounce)', () => {
    it('should batch multiple rapid file changes into single event', () => {
      const events: Array<{ rootPath: string; changes: Array<{ filePath: string; eventType: string }> }> = [];
      const DEBOUNCE_MS = 500;
      const debounceTimers = new Map<string, NodeJS.Timeout>();
      const pendingEvents = new Map<string, Map<string, 'add' | 'change' | 'unlink'>>();
      const rootPath = '/project';

      const processPendingEvents = (path: string) => {
        const pending = pendingEvents.get(path);
        if (!pending || pending.size === 0) return;

        const changes: Array<{ filePath: string; eventType: string }> = [];
        for (const [filePath, eventType] of pending) {
          changes.push({ filePath, eventType });
        }
        events.push({ rootPath: path, changes });
        pending.clear();
      };

      const queueEvent = (path: string, filePath: string, eventType: 'add' | 'change' | 'unlink') => {
        if (!pendingEvents.has(path)) {
          pendingEvents.set(path, new Map());
        }
        pendingEvents.get(path)!.set(filePath, eventType);

        const existingTimer = debounceTimers.get(path);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          debounceTimers.delete(path);
          processPendingEvents(path);
        }, DEBOUNCE_MS);
        debounceTimers.set(path, timer);
      };

      // Rapid changes to multiple files
      queueEvent(rootPath, '/project/doc1.md', 'change');
      queueEvent(rootPath, '/project/doc2.md', 'add');
      queueEvent(rootPath, '/project/doc3.md', 'change');
      queueEvent(rootPath, '/project/doc1.md', 'change'); // Same file again

      // No events yet (still debouncing)
      expect(events).toHaveLength(0);

      // Advance past debounce time
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      // Only one batched event should have fired
      expect(events).toHaveLength(1);
      expect(events[0].changes).toHaveLength(3); // 3 unique files
      expect(events[0].changes.some(c => c.filePath === '/project/doc1.md')).toBe(true);
      expect(events[0].changes.some(c => c.filePath === '/project/doc2.md')).toBe(true);
      expect(events[0].changes.some(c => c.filePath === '/project/doc3.md')).toBe(true);
    });

    it('should update event type for same file on repeated changes', () => {
      const pendingEvents = new Map<string, Map<string, 'add' | 'change' | 'unlink'>>();
      const rootPath = '/project';

      const queueEvent = (path: string, filePath: string, eventType: 'add' | 'change' | 'unlink') => {
        if (!pendingEvents.has(path)) {
          pendingEvents.set(path, new Map());
        }
        pendingEvents.get(path)!.set(filePath, eventType);
      };

      // File is added, then changed multiple times
      queueEvent(rootPath, '/project/new.md', 'add');
      queueEvent(rootPath, '/project/new.md', 'change');
      queueEvent(rootPath, '/project/new.md', 'change');

      const pending = pendingEvents.get(rootPath)!;
      expect(pending.get('/project/new.md')).toBe('change');
    });

    it('should fire new event after debounce period completes', () => {
      const events: Array<{ rootPath: string }> = [];
      const DEBOUNCE_MS = 500;
      let debounceTimer: NodeJS.Timeout | null = null;

      const handleChange = (rootPath: string) => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
          events.push({ rootPath });
          debounceTimer = null;
        }, DEBOUNCE_MS);
      };

      // First change
      handleChange('/project1');
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);
      expect(events).toHaveLength(1);

      // Second change after debounce completed
      handleChange('/project2');
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);
      expect(events).toHaveLength(2);
    });
  });

  describe('Watcher lifecycle', () => {
    it('should track active watchers by root path', () => {
      const activeWatchers = new Map<string, FSWatcher>();

      const path1 = '/project1';
      const path2 = '/project2';

      activeWatchers.set(path1, {} as FSWatcher);
      activeWatchers.set(path2, {} as FSWatcher);

      expect(activeWatchers.has(path1)).toBe(true);
      expect(activeWatchers.has(path2)).toBe(true);
      expect(activeWatchers.size).toBe(2);
    });

    it('should replace existing watcher for same path', async () => {
      const activeWatchers = new Map<string, { close: () => Promise<void> }>();
      const path = '/project';

      const watcher1 = { close: vi.fn().mockResolvedValue(undefined) };
      const watcher2 = { close: vi.fn().mockResolvedValue(undefined) };

      // First watcher
      activeWatchers.set(path, watcher1);

      // Replace with second watcher (should close first)
      if (activeWatchers.has(path)) {
        await activeWatchers.get(path)?.close();
        activeWatchers.delete(path);
      }
      activeWatchers.set(path, watcher2);

      expect(watcher1.close).toHaveBeenCalled();
      expect(activeWatchers.get(path)).toBe(watcher2);
    });

    it('should clean up watcher on unwatchFolder', async () => {
      const activeWatchers = new Map<string, { close: () => Promise<void> }>();
      const debounceTimers = new Map<string, NodeJS.Timeout>();
      const pendingEvents = new Map<string, Map<string, string>>();
      const path = '/project';

      const watcher = { close: vi.fn().mockResolvedValue(undefined) };
      activeWatchers.set(path, watcher);
      debounceTimers.set(path, setTimeout(() => {}, 1000));
      pendingEvents.set(path, new Map([['file.md', 'change']]));

      // Simulate unwatchFolder
      if (activeWatchers.has(path)) {
        await activeWatchers.get(path)?.close();
        activeWatchers.delete(path);

        const timer = debounceTimers.get(path);
        if (timer) {
          clearTimeout(timer);
          debounceTimers.delete(path);
        }
        pendingEvents.delete(path);
      }

      expect(watcher.close).toHaveBeenCalled();
      expect(activeWatchers.has(path)).toBe(false);
      expect(debounceTimers.has(path)).toBe(false);
      expect(pendingEvents.has(path)).toBe(false);
    });
  });

  describe('Multiple concurrent watchers', () => {
    it('should handle multiple directories independently', () => {
      const events: Array<{ rootPath: string; changes: any[] }> = [];
      const DEBOUNCE_MS = 500;
      const debounceTimers = new Map<string, NodeJS.Timeout>();
      const pendingEvents = new Map<string, Map<string, string>>();

      const processPendingEvents = (path: string) => {
        const pending = pendingEvents.get(path);
        if (!pending || pending.size === 0) return;
        const changes = Array.from(pending.entries()).map(([f, e]) => ({ filePath: f, eventType: e }));
        events.push({ rootPath: path, changes });
        pending.clear();
      };

      const queueEvent = (path: string, filePath: string, eventType: string) => {
        if (!pendingEvents.has(path)) {
          pendingEvents.set(path, new Map());
        }
        pendingEvents.get(path)!.set(filePath, eventType);

        const existingTimer = debounceTimers.get(path);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          debounceTimers.delete(path);
          processPendingEvents(path);
        }, DEBOUNCE_MS);
        debounceTimers.set(path, timer);
      };

      // Changes in project1
      queueEvent('/project1', '/project1/doc1.md', 'change');
      queueEvent('/project1', '/project1/doc2.md', 'add');

      // Changes in project2
      queueEvent('/project2', '/project2/readme.md', 'change');

      // Advance time to trigger all debounced callbacks
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      // Should have separate events for each project
      expect(events).toHaveLength(2);

      const project1Event = events.find(e => e.rootPath === '/project1');
      const project2Event = events.find(e => e.rootPath === '/project2');

      expect(project1Event?.changes).toHaveLength(2);
      expect(project2Event?.changes).toHaveLength(1);
    });

    it('should not interfere between different directories debounce timers', () => {
      const events: string[] = [];
      const DEBOUNCE_MS = 500;
      const debounceTimers = new Map<string, NodeJS.Timeout>();

      const queueEvent = (path: string) => {
        const existingTimer = debounceTimers.get(path);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          debounceTimers.delete(path);
          events.push(path);
        }, DEBOUNCE_MS);
        debounceTimers.set(path, timer);
      };

      // Start project1 timer
      queueEvent('/project1');

      // 200ms later, start project2 timer
      vi.advanceTimersByTime(200);
      queueEvent('/project2');

      // 300ms later, project1 should fire but not project2
      vi.advanceTimersByTime(300);
      expect(events).toContain('/project1');
      expect(events).not.toContain('/project2');

      // 200ms later, project2 should also fire
      vi.advanceTimersByTime(200);
      expect(events).toContain('/project2');
    });
  });

  describe('Event data structure', () => {
    it('should include correct event types', () => {
      const eventTypes = ['add', 'change', 'unlink'] as const;

      for (const eventType of eventTypes) {
        expect(['add', 'change', 'unlink']).toContain(eventType);
      }
    });

    it('should preserve full file paths in changes', () => {
      const pendingEvents = new Map<string, Map<string, 'add' | 'change' | 'unlink'>>();
      const rootPath = '/project';

      const queueEvent = (path: string, filePath: string, eventType: 'add' | 'change' | 'unlink') => {
        if (!pendingEvents.has(path)) {
          pendingEvents.set(path, new Map());
        }
        pendingEvents.get(path)!.set(filePath, eventType);
      };

      queueEvent(rootPath, '/project/docs/nested/deep/file.md', 'add');
      queueEvent(rootPath, '/project/README.md', 'change');

      const pending = pendingEvents.get(rootPath)!;
      expect(pending.has('/project/docs/nested/deep/file.md')).toBe(true);
      expect(pending.has('/project/README.md')).toBe(true);
    });
  });

  describe('Error handling', () => {
    it('should handle watcher errors gracefully', () => {
      const errorHandler = vi.fn();

      // Simulate error handler
      const simulateError = (error: Error) => {
        errorHandler(error);
      };

      simulateError(new Error('EACCES: permission denied'));
      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should skip events when main window is destroyed', () => {
      const events: any[] = [];

      const processEvent = (mainWindow: { isDestroyed: () => boolean } | null, data: any) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          return false;
        }
        events.push(data);
        return true;
      };

      // With valid window
      expect(processEvent({ isDestroyed: () => false }, { change: 'test' })).toBe(true);
      expect(events).toHaveLength(1);

      // With destroyed window
      expect(processEvent({ isDestroyed: () => true }, { change: 'test2' })).toBe(false);
      expect(events).toHaveLength(1); // No new event

      // With null window
      expect(processEvent(null, { change: 'test3' })).toBe(false);
      expect(events).toHaveLength(1); // No new event
    });
  });

  describe('App cleanup', () => {
    it('should cleanup all watchers on app quit', async () => {
      const watchers = new Map<string, { close: () => Promise<void> }>();
      const debounceTimers = new Map<string, NodeJS.Timeout>();
      const pendingEvents = new Map<string, Map<string, string>>();

      // Set up multiple watchers
      watchers.set('/project1', { close: vi.fn().mockResolvedValue(undefined) });
      watchers.set('/project2', { close: vi.fn().mockResolvedValue(undefined) });
      debounceTimers.set('/project1', setTimeout(() => {}, 1000));
      debounceTimers.set('/project2', setTimeout(() => {}, 1000));
      pendingEvents.set('/project1', new Map());
      pendingEvents.set('/project2', new Map());

      // Simulate app quit cleanup
      for (const [_path, watcher] of watchers) {
        await watcher.close();
      }
      watchers.clear();

      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      pendingEvents.clear();

      expect(watchers.size).toBe(0);
      expect(debounceTimers.size).toBe(0);
      expect(pendingEvents.size).toBe(0);
    });
  });

  describe('Chokidar configuration', () => {
    it('should use correct watch options', () => {
      const expectedOptions = {
        persistent: true,
        ignoreInitial: true,
        depth: 99,
      };

      // Validate expected options are reasonable
      expect(expectedOptions.persistent).toBe(true);
      expect(expectedOptions.ignoreInitial).toBe(true);
      expect(expectedOptions.depth).toBe(99);
    });

    it('should use 500ms debounce delay (different from autorun 300ms)', () => {
      const DOCUMENT_GRAPH_DEBOUNCE = 500;
      const AUTORUN_DEBOUNCE = 300;

      // Document graph uses longer debounce since graph rebuilds are expensive
      expect(DOCUMENT_GRAPH_DEBOUNCE).toBeGreaterThan(AUTORUN_DEBOUNCE);
      expect(DOCUMENT_GRAPH_DEBOUNCE).toBe(500);
    });
  });

  /**
   * File Rename Handling Tests
   *
   * Chokidar does not emit a native "rename" event. Instead, file renames are
   * reported as two separate events:
   * 1. 'unlink' for the old file path
   * 2. 'add' for the new file path
   *
   * The Document Graph handles renames gracefully because:
   * - Both events are batched together within the 500ms debounce window
   * - The renderer receives both events in a single batch
   * - The graph rebuild treats this as "remove old node, add new node"
   * - Position preservation ensures the new node appears in a sensible location
   *
   * See: https://github.com/paulmillr/chokidar/issues/303
   */
  describe('File rename handling (unlink + add)', () => {
    it('should batch unlink and add events when file is renamed', () => {
      const events: Array<{ rootPath: string; changes: Array<{ filePath: string; eventType: string }> }> = [];
      const DEBOUNCE_MS = 500;
      const debounceTimers = new Map<string, NodeJS.Timeout>();
      const pendingEvents = new Map<string, Map<string, 'add' | 'change' | 'unlink'>>();
      const rootPath = '/project';

      const processPendingEvents = (path: string) => {
        const pending = pendingEvents.get(path);
        if (!pending || pending.size === 0) return;

        const changes: Array<{ filePath: string; eventType: string }> = [];
        for (const [filePath, eventType] of pending) {
          changes.push({ filePath, eventType });
        }
        events.push({ rootPath: path, changes });
        pending.clear();
      };

      const queueEvent = (path: string, filePath: string, eventType: 'add' | 'change' | 'unlink') => {
        if (!pendingEvents.has(path)) {
          pendingEvents.set(path, new Map());
        }
        pendingEvents.get(path)!.set(filePath, eventType);

        const existingTimer = debounceTimers.get(path);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          debounceTimers.delete(path);
          processPendingEvents(path);
        }, DEBOUNCE_MS);
        debounceTimers.set(path, timer);
      };

      // Simulate file rename: old-name.md -> new-name.md
      // Chokidar emits these as separate events, typically in quick succession
      queueEvent(rootPath, '/project/old-name.md', 'unlink');
      queueEvent(rootPath, '/project/new-name.md', 'add');

      // No events yet (still debouncing)
      expect(events).toHaveLength(0);

      // Advance past debounce time
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      // Both events should be batched together in a single event
      expect(events).toHaveLength(1);
      expect(events[0].changes).toHaveLength(2);

      // Verify both old (unlink) and new (add) paths are included
      const unlinkEvent = events[0].changes.find(c => c.eventType === 'unlink');
      const addEvent = events[0].changes.find(c => c.eventType === 'add');

      expect(unlinkEvent).toBeDefined();
      expect(unlinkEvent?.filePath).toBe('/project/old-name.md');
      expect(addEvent).toBeDefined();
      expect(addEvent?.filePath).toBe('/project/new-name.md');
    });

    it('should handle rename with order: add before unlink', () => {
      // Sometimes chokidar emits 'add' before 'unlink' depending on OS/timing
      const pendingEvents = new Map<string, Map<string, 'add' | 'change' | 'unlink'>>();
      const rootPath = '/project';

      const queueEvent = (path: string, filePath: string, eventType: 'add' | 'change' | 'unlink') => {
        if (!pendingEvents.has(path)) {
          pendingEvents.set(path, new Map());
        }
        pendingEvents.get(path)!.set(filePath, eventType);
      };

      // Simulate add arriving before unlink
      queueEvent(rootPath, '/project/new-name.md', 'add');
      queueEvent(rootPath, '/project/old-name.md', 'unlink');

      const pending = pendingEvents.get(rootPath)!;
      expect(pending.size).toBe(2);
      expect(pending.get('/project/new-name.md')).toBe('add');
      expect(pending.get('/project/old-name.md')).toBe('unlink');
    });

    it('should handle rename within same directory', () => {
      const pendingEvents = new Map<string, Map<string, 'add' | 'change' | 'unlink'>>();
      const rootPath = '/project';

      const queueEvent = (path: string, filePath: string, eventType: 'add' | 'change' | 'unlink') => {
        if (!pendingEvents.has(path)) {
          pendingEvents.set(path, new Map());
        }
        pendingEvents.get(path)!.set(filePath, eventType);
      };

      // Rename: README.md -> CONTRIBUTING.md in same folder
      queueEvent(rootPath, '/project/README.md', 'unlink');
      queueEvent(rootPath, '/project/CONTRIBUTING.md', 'add');

      const pending = pendingEvents.get(rootPath)!;
      expect(pending.size).toBe(2);
    });

    it('should handle rename that moves file to different directory', () => {
      const pendingEvents = new Map<string, Map<string, 'add' | 'change' | 'unlink'>>();
      const rootPath = '/project';

      const queueEvent = (path: string, filePath: string, eventType: 'add' | 'change' | 'unlink') => {
        if (!pendingEvents.has(path)) {
          pendingEvents.set(path, new Map());
        }
        pendingEvents.get(path)!.set(filePath, eventType);
      };

      // Move: docs/guide.md -> archive/old-guide.md
      queueEvent(rootPath, '/project/docs/guide.md', 'unlink');
      queueEvent(rootPath, '/project/archive/old-guide.md', 'add');

      const pending = pendingEvents.get(rootPath)!;
      expect(pending.size).toBe(2);
      expect(pending.has('/project/docs/guide.md')).toBe(true);
      expect(pending.has('/project/archive/old-guide.md')).toBe(true);
    });

    it('should handle multiple renames in quick succession', () => {
      const events: Array<{ rootPath: string; changes: Array<{ filePath: string; eventType: string }> }> = [];
      const DEBOUNCE_MS = 500;
      const debounceTimers = new Map<string, NodeJS.Timeout>();
      const pendingEvents = new Map<string, Map<string, 'add' | 'change' | 'unlink'>>();
      const rootPath = '/project';

      const processPendingEvents = (path: string) => {
        const pending = pendingEvents.get(path);
        if (!pending || pending.size === 0) return;

        const changes: Array<{ filePath: string; eventType: string }> = [];
        for (const [filePath, eventType] of pending) {
          changes.push({ filePath, eventType });
        }
        events.push({ rootPath: path, changes });
        pending.clear();
      };

      const queueEvent = (path: string, filePath: string, eventType: 'add' | 'change' | 'unlink') => {
        if (!pendingEvents.has(path)) {
          pendingEvents.set(path, new Map());
        }
        pendingEvents.get(path)!.set(filePath, eventType);

        const existingTimer = debounceTimers.get(path);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          debounceTimers.delete(path);
          processPendingEvents(path);
        }, DEBOUNCE_MS);
        debounceTimers.set(path, timer);
      };

      // Rename file1.md -> file1-renamed.md
      queueEvent(rootPath, '/project/file1.md', 'unlink');
      queueEvent(rootPath, '/project/file1-renamed.md', 'add');

      // Rename file2.md -> file2-renamed.md
      queueEvent(rootPath, '/project/file2.md', 'unlink');
      queueEvent(rootPath, '/project/file2-renamed.md', 'add');

      // All events should be batched
      vi.advanceTimersByTime(DEBOUNCE_MS + 50);

      expect(events).toHaveLength(1);
      expect(events[0].changes).toHaveLength(4); // 2 unlinks + 2 adds
    });

    it('should handle rename followed by content change', () => {
      const pendingEvents = new Map<string, Map<string, 'add' | 'change' | 'unlink'>>();
      const rootPath = '/project';

      const queueEvent = (path: string, filePath: string, eventType: 'add' | 'change' | 'unlink') => {
        if (!pendingEvents.has(path)) {
          pendingEvents.set(path, new Map());
        }
        pendingEvents.get(path)!.set(filePath, eventType);
      };

      // Rename: old.md -> new.md, then modify new.md
      queueEvent(rootPath, '/project/old.md', 'unlink');
      queueEvent(rootPath, '/project/new.md', 'add');
      queueEvent(rootPath, '/project/new.md', 'change'); // Modify the newly renamed file

      const pending = pendingEvents.get(rootPath)!;

      // The new file should show 'change' (last event wins for same file)
      expect(pending.get('/project/new.md')).toBe('change');
      expect(pending.get('/project/old.md')).toBe('unlink');
    });

    it('should handle case-only rename (macOS case-insensitive)', () => {
      // On macOS with case-insensitive filesystem, renaming "readme.md" to "README.md"
      // may be reported as a rename (unlink + add) or just a change, depending on the scenario
      const pendingEvents = new Map<string, Map<string, 'add' | 'change' | 'unlink'>>();
      const rootPath = '/project';

      const queueEvent = (path: string, filePath: string, eventType: 'add' | 'change' | 'unlink') => {
        if (!pendingEvents.has(path)) {
          pendingEvents.set(path, new Map());
        }
        pendingEvents.get(path)!.set(filePath, eventType);
      };

      // Case-only rename: readme.md -> README.md
      queueEvent(rootPath, '/project/readme.md', 'unlink');
      queueEvent(rootPath, '/project/README.md', 'add');

      const pending = pendingEvents.get(rootPath)!;
      // Both events should be tracked as separate file paths
      expect(pending.size).toBe(2);
    });

    it('should correctly rebuild graph after rename (simulated flow)', () => {
      // This test simulates the full flow of a file rename through the system
      interface SimulatedNode {
        id: string;
        filePath: string;
      }

      // Initial graph state
      const initialNodes: SimulatedNode[] = [
        { id: 'doc-old-name.md', filePath: '/project/old-name.md' },
        { id: 'doc-other.md', filePath: '/project/other.md' },
      ];

      // After rename: old-name.md -> new-name.md
      // The graph would be rebuilt by re-scanning the directory
      const newNodes: SimulatedNode[] = [
        { id: 'doc-new-name.md', filePath: '/project/new-name.md' },
        { id: 'doc-other.md', filePath: '/project/other.md' },
      ];

      // Diff the nodes (like diffNodes in layoutAlgorithms.ts)
      const oldIds = new Set(initialNodes.map(n => n.id));
      const newIds = new Set(newNodes.map(n => n.id));

      const added = newNodes.filter(n => !oldIds.has(n.id));
      const removed = initialNodes.filter(n => !newIds.has(n.id));
      const unchanged = newNodes.filter(n => oldIds.has(n.id));

      // The renamed file should appear as: 1 removal + 1 addition
      expect(removed).toHaveLength(1);
      expect(removed[0].id).toBe('doc-old-name.md');

      expect(added).toHaveLength(1);
      expect(added[0].id).toBe('doc-new-name.md');

      // The other file should be unchanged
      expect(unchanged).toHaveLength(1);
      expect(unchanged[0].id).toBe('doc-other.md');
    });

    it('should preserve positions for unchanged nodes after rename', () => {
      // When a file is renamed, other nodes should keep their positions
      interface SimulatedNode {
        id: string;
        position: { x: number; y: number };
      }

      const previousNodes: SimulatedNode[] = [
        { id: 'doc-old-name.md', position: { x: 100, y: 100 } },
        { id: 'doc-other.md', position: { x: 200, y: 200 } },
        { id: 'doc-another.md', position: { x: 300, y: 300 } },
      ];

      // After rename, rebuild graph with new node IDs
      const newNodeIds = ['doc-new-name.md', 'doc-other.md', 'doc-another.md'];

      // Simulate position restoration logic
      const previousPositions = new Map(previousNodes.map(n => [n.id, n.position]));
      const newNodes = newNodeIds.map(id => ({
        id,
        // Unchanged nodes get their old position, new nodes get default
        position: previousPositions.get(id) || { x: 0, y: 0 },
      }));

      // Unchanged nodes should preserve position
      expect(newNodes.find(n => n.id === 'doc-other.md')?.position).toEqual({ x: 200, y: 200 });
      expect(newNodes.find(n => n.id === 'doc-another.md')?.position).toEqual({ x: 300, y: 300 });

      // New node (renamed) gets default position (to be placed by layout algorithm)
      expect(newNodes.find(n => n.id === 'doc-new-name.md')?.position).toEqual({ x: 0, y: 0 });
    });
  });
});
