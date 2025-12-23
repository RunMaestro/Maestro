/**
 * Tests for the History IPC handlers
 *
 * These tests verify the per-session history persistence operations
 * using the HistoryManager for scalable session-based storage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerHistoryHandlers } from '../../../../main/ipc/handlers/history';
import * as historyManagerModule from '../../../../main/history-manager';
import type { HistoryManager } from '../../../../main/history-manager';
import type { HistoryEntry } from '../../../../shared/types';

// Mock electron's ipcMain
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

// Mock the history-manager module
vi.mock('../../../../main/history-manager', () => ({
  getHistoryManager: vi.fn(),
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('history IPC handlers', () => {
  let handlers: Map<string, Function>;
  let mockHistoryManager: Partial<HistoryManager>;

  // Sample history entries for testing
  const createMockEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
    id: 'entry-1',
    type: 'ai_message',
    sessionId: 'session-1',
    projectPath: '/test/project',
    timestamp: Date.now(),
    summary: 'Test entry',
    ...overrides,
  });

  beforeEach(() => {
    // Clear mocks
    vi.clearAllMocks();

    // Create mock history manager
    mockHistoryManager = {
      getEntries: vi.fn().mockReturnValue([]),
      getEntriesByProjectPath: vi.fn().mockReturnValue([]),
      getAllEntries: vi.fn().mockReturnValue([]),
      getEntriesPaginated: vi.fn().mockReturnValue({
        entries: [],
        total: 0,
        limit: 100,
        offset: 0,
        hasMore: false,
      }),
      getEntriesByProjectPathPaginated: vi.fn().mockReturnValue({
        entries: [],
        total: 0,
        limit: 100,
        offset: 0,
        hasMore: false,
      }),
      getAllEntriesPaginated: vi.fn().mockReturnValue({
        entries: [],
        total: 0,
        limit: 100,
        offset: 0,
        hasMore: false,
      }),
      addEntry: vi.fn(),
      clearSession: vi.fn(),
      clearByProjectPath: vi.fn(),
      clearAll: vi.fn(),
      deleteEntry: vi.fn().mockReturnValue(false),
      updateEntry: vi.fn().mockReturnValue(false),
      updateSessionNameByClaudeSessionId: vi.fn().mockReturnValue(0),
      getHistoryFilePath: vi.fn().mockReturnValue(null),
      listSessionsWithHistory: vi.fn().mockReturnValue([]),
    };

    vi.mocked(historyManagerModule.getHistoryManager).mockReturnValue(
      mockHistoryManager as unknown as HistoryManager
    );

    // Capture all registered handlers
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });

    // Register handlers
    registerHistoryHandlers();
  });

  afterEach(() => {
    handlers.clear();
  });

  describe('registration', () => {
    it('should register all history handlers', () => {
      const expectedChannels = [
        'history:getAll',
        'history:getAllPaginated',
        'history:reload',
        'history:add',
        'history:clear',
        'history:delete',
        'history:update',
        'history:updateSessionName',
        'history:getFilePath',
        'history:listSessions',
      ];

      for (const channel of expectedChannels) {
        expect(handlers.has(channel)).toBe(true);
      }
    });
  });

  describe('history:getAll', () => {
    it('should return all entries for a specific session', async () => {
      const mockEntries = [
        createMockEntry({ id: 'entry-1', timestamp: 2000 }),
        createMockEntry({ id: 'entry-2', timestamp: 1000 }),
      ];
      vi.mocked(mockHistoryManager.getEntries).mockReturnValue(mockEntries);

      const handler = handlers.get('history:getAll');
      const result = await handler!({} as any, undefined, 'session-1');

      expect(mockHistoryManager.getEntries).toHaveBeenCalledWith('session-1');
      expect(result).toEqual([
        mockEntries[0], // Higher timestamp first
        mockEntries[1],
      ]);
    });

    it('should return entries filtered by project path', async () => {
      const mockEntries = [createMockEntry()];
      vi.mocked(mockHistoryManager.getEntriesByProjectPath).mockReturnValue(mockEntries);

      const handler = handlers.get('history:getAll');
      const result = await handler!({} as any, '/test/project');

      expect(mockHistoryManager.getEntriesByProjectPath).toHaveBeenCalledWith('/test/project');
      expect(result).toEqual(mockEntries);
    });

    it('should return all entries when no filters provided', async () => {
      const mockEntries = [createMockEntry()];
      vi.mocked(mockHistoryManager.getAllEntries).mockReturnValue(mockEntries);

      const handler = handlers.get('history:getAll');
      const result = await handler!({} as any);

      expect(mockHistoryManager.getAllEntries).toHaveBeenCalled();
      expect(result).toEqual(mockEntries);
    });

    it('should return empty array when session has no history', async () => {
      vi.mocked(mockHistoryManager.getEntries).mockReturnValue([]);

      const handler = handlers.get('history:getAll');
      const result = await handler!({} as any, undefined, 'session-1');

      expect(result).toEqual([]);
    });
  });

  describe('history:getAllPaginated', () => {
    it('should return paginated entries for a specific session', async () => {
      const mockResult = {
        entries: [createMockEntry()],
        total: 50,
        limit: 10,
        offset: 0,
        hasMore: true,
      };
      vi.mocked(mockHistoryManager.getEntriesPaginated).mockReturnValue(mockResult);

      const handler = handlers.get('history:getAllPaginated');
      const result = await handler!({} as any, {
        sessionId: 'session-1',
        pagination: { limit: 10, offset: 0 },
      });

      expect(mockHistoryManager.getEntriesPaginated).toHaveBeenCalledWith('session-1', {
        limit: 10,
        offset: 0,
      });
      expect(result).toEqual(mockResult);
    });

    it('should return paginated entries filtered by project path', async () => {
      const mockResult = {
        entries: [createMockEntry()],
        total: 30,
        limit: 20,
        offset: 0,
        hasMore: true,
      };
      vi.mocked(mockHistoryManager.getEntriesByProjectPathPaginated).mockReturnValue(mockResult);

      const handler = handlers.get('history:getAllPaginated');
      const result = await handler!({} as any, {
        projectPath: '/test/project',
        pagination: { limit: 20 },
      });

      expect(mockHistoryManager.getEntriesByProjectPathPaginated).toHaveBeenCalledWith(
        '/test/project',
        { limit: 20 }
      );
      expect(result).toEqual(mockResult);
    });

    it('should return all paginated entries when no filters provided', async () => {
      const mockResult = {
        entries: [createMockEntry()],
        total: 100,
        limit: 100,
        offset: 0,
        hasMore: false,
      };
      vi.mocked(mockHistoryManager.getAllEntriesPaginated).mockReturnValue(mockResult);

      const handler = handlers.get('history:getAllPaginated');
      const result = await handler!({} as any, {});

      expect(mockHistoryManager.getAllEntriesPaginated).toHaveBeenCalledWith(undefined);
      expect(result).toEqual(mockResult);
    });

    it('should handle undefined options', async () => {
      const mockResult = {
        entries: [],
        total: 0,
        limit: 100,
        offset: 0,
        hasMore: false,
      };
      vi.mocked(mockHistoryManager.getAllEntriesPaginated).mockReturnValue(mockResult);

      const handler = handlers.get('history:getAllPaginated');
      const result = await handler!({} as any, undefined);

      expect(mockHistoryManager.getAllEntriesPaginated).toHaveBeenCalledWith(undefined);
      expect(result).toEqual(mockResult);
    });
  });

  describe('history:reload', () => {
    it('should return true (no-op for per-session storage)', async () => {
      const handler = handlers.get('history:reload');
      const result = await handler!({} as any);

      expect(result).toBe(true);
    });
  });

  describe('history:add', () => {
    it('should add entry to session history', async () => {
      const entry = createMockEntry({ sessionId: 'session-1', projectPath: '/test' });

      const handler = handlers.get('history:add');
      const result = await handler!({} as any, entry);

      expect(mockHistoryManager.addEntry).toHaveBeenCalledWith('session-1', '/test', entry);
      expect(result).toBe(true);
    });

    it('should use orphaned session ID when sessionId is missing', async () => {
      const entry = createMockEntry({ sessionId: undefined, projectPath: '/test' });

      const handler = handlers.get('history:add');
      const result = await handler!({} as any, entry);

      expect(mockHistoryManager.addEntry).toHaveBeenCalledWith('_orphaned', '/test', entry);
      expect(result).toBe(true);
    });

    it('should handle entry with all fields', async () => {
      const entry = createMockEntry({
        id: 'unique-id',
        type: 'ai_message',
        sessionId: 'my-session',
        projectPath: '/project/path',
        timestamp: 1234567890,
        summary: 'Detailed summary',
        agentSessionId: 'agent-123',
        sessionName: 'My Session',
      });

      const handler = handlers.get('history:add');
      await handler!({} as any, entry);

      expect(mockHistoryManager.addEntry).toHaveBeenCalledWith('my-session', '/project/path', entry);
    });
  });

  describe('history:clear', () => {
    it('should clear history for specific session', async () => {
      const handler = handlers.get('history:clear');
      const result = await handler!({} as any, undefined, 'session-1');

      expect(mockHistoryManager.clearSession).toHaveBeenCalledWith('session-1');
      expect(result).toBe(true);
    });

    it('should clear history for project path', async () => {
      const handler = handlers.get('history:clear');
      const result = await handler!({} as any, '/test/project');

      expect(mockHistoryManager.clearByProjectPath).toHaveBeenCalledWith('/test/project');
      expect(result).toBe(true);
    });

    it('should clear all history when no filters provided', async () => {
      const handler = handlers.get('history:clear');
      const result = await handler!({} as any);

      expect(mockHistoryManager.clearAll).toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });

  describe('history:delete', () => {
    it('should delete entry from specific session', async () => {
      vi.mocked(mockHistoryManager.deleteEntry).mockReturnValue(true);

      const handler = handlers.get('history:delete');
      const result = await handler!({} as any, 'entry-123', 'session-1');

      expect(mockHistoryManager.deleteEntry).toHaveBeenCalledWith('session-1', 'entry-123');
      expect(result).toBe(true);
    });

    it('should return false when entry not found in session', async () => {
      vi.mocked(mockHistoryManager.deleteEntry).mockReturnValue(false);

      const handler = handlers.get('history:delete');
      const result = await handler!({} as any, 'non-existent', 'session-1');

      expect(result).toBe(false);
    });

    it('should search all sessions when sessionId not provided', async () => {
      vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1', 'session-2']);
      vi.mocked(mockHistoryManager.deleteEntry)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      const handler = handlers.get('history:delete');
      const result = await handler!({} as any, 'entry-123');

      expect(mockHistoryManager.listSessionsWithHistory).toHaveBeenCalled();
      expect(mockHistoryManager.deleteEntry).toHaveBeenCalledWith('session-1', 'entry-123');
      expect(mockHistoryManager.deleteEntry).toHaveBeenCalledWith('session-2', 'entry-123');
      expect(result).toBe(true);
    });

    it('should return false when entry not found in any session', async () => {
      vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1', 'session-2']);
      vi.mocked(mockHistoryManager.deleteEntry).mockReturnValue(false);

      const handler = handlers.get('history:delete');
      const result = await handler!({} as any, 'non-existent');

      expect(result).toBe(false);
    });
  });

  describe('history:update', () => {
    it('should update entry in specific session', async () => {
      vi.mocked(mockHistoryManager.updateEntry).mockReturnValue(true);

      const updates = { validated: true };
      const handler = handlers.get('history:update');
      const result = await handler!({} as any, 'entry-123', updates, 'session-1');

      expect(mockHistoryManager.updateEntry).toHaveBeenCalledWith('session-1', 'entry-123', updates);
      expect(result).toBe(true);
    });

    it('should return false when entry not found in session', async () => {
      vi.mocked(mockHistoryManager.updateEntry).mockReturnValue(false);

      const handler = handlers.get('history:update');
      const result = await handler!({} as any, 'non-existent', { validated: true }, 'session-1');

      expect(result).toBe(false);
    });

    it('should search all sessions when sessionId not provided', async () => {
      vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1', 'session-2']);
      vi.mocked(mockHistoryManager.updateEntry)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      const updates = { summary: 'Updated summary' };
      const handler = handlers.get('history:update');
      const result = await handler!({} as any, 'entry-123', updates);

      expect(mockHistoryManager.updateEntry).toHaveBeenCalledWith('session-1', 'entry-123', updates);
      expect(mockHistoryManager.updateEntry).toHaveBeenCalledWith('session-2', 'entry-123', updates);
      expect(result).toBe(true);
    });

    it('should return false when entry not found in any session', async () => {
      vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
      vi.mocked(mockHistoryManager.updateEntry).mockReturnValue(false);

      const handler = handlers.get('history:update');
      const result = await handler!({} as any, 'non-existent', { validated: true });

      expect(result).toBe(false);
    });
  });

  describe('history:updateSessionName', () => {
    it('should update session name for matching entries', async () => {
      vi.mocked(mockHistoryManager.updateSessionNameByClaudeSessionId).mockReturnValue(5);

      const handler = handlers.get('history:updateSessionName');
      const result = await handler!({} as any, 'agent-session-123', 'New Session Name');

      expect(mockHistoryManager.updateSessionNameByClaudeSessionId).toHaveBeenCalledWith(
        'agent-session-123',
        'New Session Name'
      );
      expect(result).toBe(5);
    });

    it('should return 0 when no matching entries found', async () => {
      vi.mocked(mockHistoryManager.updateSessionNameByClaudeSessionId).mockReturnValue(0);

      const handler = handlers.get('history:updateSessionName');
      const result = await handler!({} as any, 'non-existent-agent', 'Name');

      expect(result).toBe(0);
    });
  });

  describe('history:getFilePath', () => {
    it('should return file path for existing session', async () => {
      vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(
        '/path/to/history/session-1.json'
      );

      const handler = handlers.get('history:getFilePath');
      const result = await handler!({} as any, 'session-1');

      expect(mockHistoryManager.getHistoryFilePath).toHaveBeenCalledWith('session-1');
      expect(result).toBe('/path/to/history/session-1.json');
    });

    it('should return null for non-existent session', async () => {
      vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(null);

      const handler = handlers.get('history:getFilePath');
      const result = await handler!({} as any, 'non-existent');

      expect(result).toBe(null);
    });
  });

  describe('history:listSessions', () => {
    it('should return list of sessions with history', async () => {
      vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([
        'session-1',
        'session-2',
        'session-3',
      ]);

      const handler = handlers.get('history:listSessions');
      const result = await handler!({} as any);

      expect(mockHistoryManager.listSessionsWithHistory).toHaveBeenCalled();
      expect(result).toEqual(['session-1', 'session-2', 'session-3']);
    });

    it('should return empty array when no sessions have history', async () => {
      vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([]);

      const handler = handlers.get('history:listSessions');
      const result = await handler!({} as any);

      expect(result).toEqual([]);
    });
  });
});
