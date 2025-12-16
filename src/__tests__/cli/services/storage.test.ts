/**
 * @file storage.test.ts
 * @description Tests for the CLI storage service
 *
 * Tests all functionality of the storage service including:
 * - Platform-specific config directory detection
 * - Reading sessions, groups, history, settings, agent configs
 * - Partial ID resolution for agents and groups
 * - Session lookup by ID and group
 * - History entry writing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import type { Group, SessionInfo, HistoryEntry } from '../../../shared/types';

// Store original env values
const originalEnv = { ...process.env };

// Mock the fs module
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock the os module
vi.mock('os', () => ({
  platform: vi.fn(),
  homedir: vi.fn(),
}));

import {
  readSessions,
  readGroups,
  readHistory,
  readSettings,
  readAgentConfigs,
  getAgentCustomPath,
  resolveAgentId,
  resolveGroupId,
  getSessionById,
  getSessionsByGroup,
  getConfigDirectory,
  addHistoryEntry,
} from '../../../cli/services/storage';

describe('storage service', () => {
  const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
    id: 'session-123',
    name: 'Test Session',
    toolType: 'claude-code',
    cwd: '/path/to/project',
    projectRoot: '/path/to/project',
    ...overrides,
  });

  const mockGroup = (overrides: Partial<Group> = {}): Group => ({
    id: 'group-123',
    name: 'Test Group',
    emoji: '🚀',
    collapsed: false,
    ...overrides,
  });

  const mockHistoryEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
    id: 'entry-123',
    type: 'AUTO',
    timestamp: Date.now(),
    summary: 'Test entry',
    projectPath: '/path/to/project',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment
    process.env = { ...originalEnv };
    // Default to macOS
    vi.mocked(os.platform).mockReturnValue('darwin');
    vi.mocked(os.homedir).mockReturnValue('/Users/testuser');
    // Default to legacy mode (not migrated) by returning false for migration marker
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getConfigDirectory', () => {
    it('should return macOS config path on darwin', () => {
      vi.mocked(os.platform).mockReturnValue('darwin');
      vi.mocked(os.homedir).mockReturnValue('/Users/testuser');

      const result = getConfigDirectory();

      expect(result).toBe('/Users/testuser/Library/Application Support/Maestro');
    });

    it('should return Windows config path with APPDATA', () => {
      vi.mocked(os.platform).mockReturnValue('win32');
      vi.mocked(os.homedir).mockReturnValue('C:\\Users\\testuser');
      process.env.APPDATA = 'C:\\Users\\testuser\\AppData\\Roaming';

      const result = getConfigDirectory();

      expect(result).toContain('Roaming');
      expect(result).toContain('Maestro');
    });

    it('should return Windows config path fallback without APPDATA', () => {
      vi.mocked(os.platform).mockReturnValue('win32');
      vi.mocked(os.homedir).mockReturnValue('C:\\Users\\testuser');
      delete process.env.APPDATA;

      const result = getConfigDirectory();

      expect(result).toContain('testuser');
      expect(result).toContain('Maestro');
    });

    it('should return Linux config path with XDG_CONFIG_HOME', () => {
      vi.mocked(os.platform).mockReturnValue('linux');
      vi.mocked(os.homedir).mockReturnValue('/home/testuser');
      process.env.XDG_CONFIG_HOME = '/home/testuser/.custom-config';

      const result = getConfigDirectory();

      expect(result).toBe('/home/testuser/.custom-config/Maestro');
    });

    it('should return Linux config path fallback without XDG_CONFIG_HOME', () => {
      vi.mocked(os.platform).mockReturnValue('linux');
      vi.mocked(os.homedir).mockReturnValue('/home/testuser');
      delete process.env.XDG_CONFIG_HOME;

      const result = getConfigDirectory();

      expect(result).toBe('/home/testuser/.config/Maestro');
    });

    it('should use Linux path for unknown platforms', () => {
      vi.mocked(os.platform).mockReturnValue('freebsd' as NodeJS.Platform);
      vi.mocked(os.homedir).mockReturnValue('/home/testuser');
      delete process.env.XDG_CONFIG_HOME;

      const result = getConfigDirectory();

      expect(result).toBe('/home/testuser/.config/Maestro');
    });
  });

  describe('readSessions', () => {
    it('should return sessions from file', () => {
      const sessions = [mockSession({ id: 'sess-1' }), mockSession({ id: 'sess-2' })];
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ sessions })
      );

      const result = readSessions();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('sess-1');
    });

    it('should return empty array when file does not exist', () => {
      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw error;
      });

      const result = readSessions();

      expect(result).toEqual([]);
    });

    it('should return empty array when sessions is undefined', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({})
      );

      const result = readSessions();

      expect(result).toEqual([]);
    });

    it('should throw error for non-ENOENT errors', () => {
      const error = new Error('Permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw error;
      });

      expect(() => readSessions()).toThrow('Permission denied');
    });
  });

  describe('readGroups', () => {
    it('should return groups from file', () => {
      const groups = [mockGroup({ id: 'grp-1' }), mockGroup({ id: 'grp-2' })];
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ groups })
      );

      const result = readGroups();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('grp-1');
    });

    it('should return empty array when file does not exist', () => {
      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw error;
      });

      const result = readGroups();

      expect(result).toEqual([]);
    });

    it('should return empty array when groups is undefined', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({})
      );

      const result = readGroups();

      expect(result).toEqual([]);
    });
  });

  describe('readHistory', () => {
    it('should return all entries when no filters provided', () => {
      const entries = [
        mockHistoryEntry({ id: 'e1', projectPath: '/proj1' }),
        mockHistoryEntry({ id: 'e2', projectPath: '/proj2' }),
      ];
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ entries })
      );

      const result = readHistory();

      expect(result).toHaveLength(2);
    });

    it('should filter by projectPath', () => {
      const entries = [
        mockHistoryEntry({ id: 'e1', projectPath: '/proj1' }),
        mockHistoryEntry({ id: 'e2', projectPath: '/proj2' }),
        mockHistoryEntry({ id: 'e3', projectPath: '/proj1' }),
      ];
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ entries })
      );

      const result = readHistory('/proj1');

      expect(result).toHaveLength(2);
      expect(result.every((e) => e.projectPath === '/proj1')).toBe(true);
    });

    it('should filter by sessionId', () => {
      const entries = [
        mockHistoryEntry({ id: 'e1', sessionId: 'sess-1' }),
        mockHistoryEntry({ id: 'e2', sessionId: 'sess-2' }),
        mockHistoryEntry({ id: 'e3', sessionId: 'sess-1' }),
      ];
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ entries })
      );

      const result = readHistory(undefined, 'sess-1');

      expect(result).toHaveLength(2);
      expect(result.every((e) => e.sessionId === 'sess-1')).toBe(true);
    });

    it('should filter by both projectPath and sessionId', () => {
      const entries = [
        mockHistoryEntry({ id: 'e1', projectPath: '/proj1', sessionId: 'sess-1' }),
        mockHistoryEntry({ id: 'e2', projectPath: '/proj1', sessionId: 'sess-2' }),
        mockHistoryEntry({ id: 'e3', projectPath: '/proj2', sessionId: 'sess-1' }),
      ];
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ entries })
      );

      const result = readHistory('/proj1', 'sess-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('e1');
    });

    it('should return empty array when file does not exist', () => {
      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw error;
      });

      const result = readHistory();

      expect(result).toEqual([]);
    });

    it('should return empty array when entries is undefined', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({})
      );

      const result = readHistory();

      expect(result).toEqual([]);
    });
  });

  describe('readSettings', () => {
    it('should return settings from file', () => {
      const settings = { activeThemeId: 'dark', customSetting: 'value' };
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify(settings)
      );

      const result = readSettings();

      expect(result.activeThemeId).toBe('dark');
      expect(result.customSetting).toBe('value');
    });

    it('should return empty object when file does not exist', () => {
      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw error;
      });

      const result = readSettings();

      expect(result).toEqual({});
    });
  });

  describe('readAgentConfigs', () => {
    it('should return agent configs from file', () => {
      const configs = {
        configs: {
          'claude-code': { customPath: '/custom/path' },
          'aider': { setting: 'value' },
        },
      };
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify(configs)
      );

      const result = readAgentConfigs();

      expect(result['claude-code']).toEqual({ customPath: '/custom/path' });
      expect(result['aider']).toEqual({ setting: 'value' });
    });

    it('should return empty object when file does not exist', () => {
      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw error;
      });

      const result = readAgentConfigs();

      expect(result).toEqual({});
    });

    it('should return empty object when configs is undefined', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({})
      );

      const result = readAgentConfigs();

      expect(result).toEqual({});
    });
  });

  describe('getAgentCustomPath', () => {
    it('should return custom path when configured', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          configs: {
            'claude-code': { customPath: '/custom/claude/path' },
          },
        })
      );

      const result = getAgentCustomPath('claude-code');

      expect(result).toBe('/custom/claude/path');
    });

    it('should return undefined when agent not in configs', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          configs: {
            'claude-code': { customPath: '/custom/path' },
          },
        })
      );

      const result = getAgentCustomPath('aider');

      expect(result).toBeUndefined();
    });

    it('should return undefined when customPath is not a string', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          configs: {
            'claude-code': { customPath: 123 },
          },
        })
      );

      const result = getAgentCustomPath('claude-code');

      expect(result).toBeUndefined();
    });

    it('should return undefined when customPath is empty string', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          configs: {
            'claude-code': { customPath: '' },
          },
        })
      );

      const result = getAgentCustomPath('claude-code');

      expect(result).toBeUndefined();
    });

    it('should return undefined when agent config has no customPath', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          configs: {
            'claude-code': { otherSetting: 'value' },
          },
        })
      );

      const result = getAgentCustomPath('claude-code');

      expect(result).toBeUndefined();
    });
  });

  describe('resolveAgentId', () => {
    it('should return exact match', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          sessions: [mockSession({ id: 'exact-session-id' })],
        })
      );

      const result = resolveAgentId('exact-session-id');

      expect(result).toBe('exact-session-id');
    });

    it('should return single prefix match', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          sessions: [
            mockSession({ id: 'unique-abc-123' }),
            mockSession({ id: 'different-xyz-456' }),
          ],
        })
      );

      const result = resolveAgentId('unique');

      expect(result).toBe('unique-abc-123');
    });

    it('should throw when agent not found', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ sessions: [] })
      );

      expect(() => resolveAgentId('nonexistent')).toThrow(
        'Agent not found: nonexistent'
      );
    });

    it('should throw with match list when ambiguous', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          sessions: [
            mockSession({ id: 'test-abc-123', name: 'First Agent' }),
            mockSession({ id: 'test-def-456', name: 'Second Agent' }),
          ],
        })
      );

      expect(() => resolveAgentId('test')).toThrow(
        /Ambiguous agent ID 'test'/
      );
    });

    it('should include agent names and truncated IDs in ambiguous error', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          sessions: [
            mockSession({ id: 'test-abcdefgh-1', name: 'Alpha Agent' }),
            mockSession({ id: 'test-ijklmnop-2', name: 'Beta Agent' }),
          ],
        })
      );

      try {
        resolveAgentId('test');
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('test-abc');
        expect((error as Error).message).toContain('Alpha Agent');
        expect((error as Error).message).toContain('test-ijk');
        expect((error as Error).message).toContain('Beta Agent');
      }
    });

    it('should show Unknown when agent name is missing', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          sessions: [
            { ...mockSession({ id: 'test-123' }), name: undefined },
            mockSession({ id: 'test-456', name: 'Named Agent' }),
          ],
        })
      );

      try {
        resolveAgentId('test');
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('Unknown');
        expect((error as Error).message).toContain('Named Agent');
      }
    });
  });

  describe('resolveGroupId', () => {
    it('should return exact match', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          groups: [mockGroup({ id: 'exact-group-id' })],
        })
      );

      const result = resolveGroupId('exact-group-id');

      expect(result).toBe('exact-group-id');
    });

    it('should return single prefix match', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          groups: [
            mockGroup({ id: 'unique-grp-abc' }),
            mockGroup({ id: 'different-grp-xyz' }),
          ],
        })
      );

      const result = resolveGroupId('unique');

      expect(result).toBe('unique-grp-abc');
    });

    it('should throw when group not found', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ groups: [] })
      );

      expect(() => resolveGroupId('nonexistent')).toThrow(
        'Group not found: nonexistent'
      );
    });

    it('should throw with match list when ambiguous', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          groups: [
            mockGroup({ id: 'test-group-1', name: 'First Group' }),
            mockGroup({ id: 'test-group-2', name: 'Second Group' }),
          ],
        })
      );

      expect(() => resolveGroupId('test')).toThrow(
        /Ambiguous group ID 'test'/
      );
    });

    it('should include group names in ambiguous error', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          groups: [
            mockGroup({ id: 'work-projects', name: 'Work' }),
            mockGroup({ id: 'work-personal', name: 'Personal' }),
          ],
        })
      );

      try {
        resolveGroupId('work');
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('work-projects');
        expect((error as Error).message).toContain('Work');
        expect((error as Error).message).toContain('work-personal');
        expect((error as Error).message).toContain('Personal');
      }
    });

    it('should show Unknown when group name is missing', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          groups: [
            { ...mockGroup({ id: 'test-1' }), name: undefined },
            mockGroup({ id: 'test-2', name: 'Named Group' }),
          ],
        })
      );

      try {
        resolveGroupId('test');
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('Unknown');
        expect((error as Error).message).toContain('Named Group');
      }
    });
  });

  describe('getSessionById', () => {
    it('should return exact match', () => {
      const session = mockSession({ id: 'exact-id-123', name: 'My Session' });
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ sessions: [session] })
      );

      const result = getSessionById('exact-id-123');

      expect(result?.name).toBe('My Session');
    });

    it('should return single prefix match', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          sessions: [
            mockSession({ id: 'unique-abc-123', name: 'Target' }),
            mockSession({ id: 'different-xyz', name: 'Other' }),
          ],
        })
      );

      const result = getSessionById('unique');

      expect(result?.name).toBe('Target');
    });

    it('should return undefined when not found', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ sessions: [] })
      );

      const result = getSessionById('nonexistent');

      expect(result).toBeUndefined();
    });

    it('should return undefined when multiple prefix matches', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          sessions: [
            mockSession({ id: 'test-123' }),
            mockSession({ id: 'test-456' }),
          ],
        })
      );

      const result = getSessionById('test');

      expect(result).toBeUndefined();
    });

    it('should prefer exact match over prefix match', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          sessions: [
            mockSession({ id: 'test', name: 'Exact' }),
            mockSession({ id: 'test-extended', name: 'Extended' }),
          ],
        })
      );

      const result = getSessionById('test');

      expect(result?.name).toBe('Exact');
    });
  });

  describe('getSessionsByGroup', () => {
    it('should return sessions for exact group ID', () => {
      vi.mocked(fs.readFileSync).mockImplementation((filepath) => {
        if (String(filepath).includes('sessions')) {
          return JSON.stringify({
            sessions: [
              mockSession({ id: 's1', groupId: 'group-123' }),
              mockSession({ id: 's2', groupId: 'group-456' }),
              mockSession({ id: 's3', groupId: 'group-123' }),
            ],
          });
        }
        return JSON.stringify({
          groups: [
            mockGroup({ id: 'group-123' }),
            mockGroup({ id: 'group-456' }),
          ],
        });
      });

      const result = getSessionsByGroup('group-123');

      expect(result).toHaveLength(2);
      expect(result.every((s) => s.groupId === 'group-123')).toBe(true);
    });

    it('should return sessions for prefix group ID match', () => {
      vi.mocked(fs.readFileSync).mockImplementation((filepath) => {
        if (String(filepath).includes('sessions')) {
          return JSON.stringify({
            sessions: [
              mockSession({ id: 's1', groupId: 'unique-group-123' }),
              mockSession({ id: 's2', groupId: 'other-group' }),
            ],
          });
        }
        return JSON.stringify({
          groups: [
            mockGroup({ id: 'unique-group-123' }),
            mockGroup({ id: 'other-group' }),
          ],
        });
      });

      const result = getSessionsByGroup('unique');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('s1');
    });

    it('should return empty array when group not found', () => {
      vi.mocked(fs.readFileSync).mockImplementation((filepath) => {
        if (String(filepath).includes('sessions')) {
          return JSON.stringify({ sessions: [mockSession()] });
        }
        return JSON.stringify({ groups: [] });
      });

      const result = getSessionsByGroup('nonexistent');

      expect(result).toEqual([]);
    });

    it('should return empty array when multiple prefix matches', () => {
      vi.mocked(fs.readFileSync).mockImplementation((filepath) => {
        if (String(filepath).includes('sessions')) {
          return JSON.stringify({
            sessions: [
              mockSession({ id: 's1', groupId: 'test-group-1' }),
              mockSession({ id: 's2', groupId: 'test-group-2' }),
            ],
          });
        }
        return JSON.stringify({
          groups: [
            mockGroup({ id: 'test-group-1' }),
            mockGroup({ id: 'test-group-2' }),
          ],
        });
      });

      const result = getSessionsByGroup('test');

      expect(result).toEqual([]);
    });
  });

  describe('addHistoryEntry', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it('should write entry to history file', () => {
      const existingEntries = [mockHistoryEntry({ id: 'existing' })];
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ entries: existingEntries })
      );

      const newEntry = mockHistoryEntry({ id: 'new-entry' });
      addHistoryEntry(newEntry);

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);
      expect(writtenData.entries).toHaveLength(2);
      expect(writtenData.entries[0].id).toBe('new-entry'); // New entry at beginning
      expect(writtenData.entries[1].id).toBe('existing');
    });

    it('should create entries array if file does not exist', () => {
      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw error;
      });

      const newEntry = mockHistoryEntry({ id: 'first-entry' });
      addHistoryEntry(newEntry);

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);
      expect(writtenData.entries).toHaveLength(1);
      expect(writtenData.entries[0].id).toBe('first-entry');
    });

    it('should log error but not throw on write failure', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ entries: [] })
      );
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('Disk full');
      });

      const newEntry = mockHistoryEntry({ id: 'entry' });

      // Should not throw
      expect(() => addHistoryEntry(newEntry)).not.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to write history entry')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Disk full')
      );
    });

    it('should log error with non-Error thrown value', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ entries: [] })
      );
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw 'String error'; // eslint-disable-line no-throw-literal
      });

      const newEntry = mockHistoryEntry({ id: 'entry' });

      expect(() => addHistoryEntry(newEntry)).not.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('String error')
      );
    });

    it('should write to correct file path', () => {
      vi.mocked(os.platform).mockReturnValue('darwin');
      vi.mocked(os.homedir).mockReturnValue('/Users/testuser');
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ entries: [] })
      );

      addHistoryEntry(mockHistoryEntry());

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(writeCall[0]).toContain('maestro-history.json');
      expect(writeCall[0]).toContain('/Users/testuser/Library/Application Support/Maestro');
    });
  });

  describe('edge cases', () => {
    it('should handle sessions with special characters in names', () => {
      const session = mockSession({
        id: 'special-session',
        name: 'Test <>&"\'Session',
      });
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ sessions: [session] })
      );

      const result = getSessionById('special-session');

      expect(result?.name).toBe('Test <>&"\'Session');
    });

    it('should handle unicode in group names', () => {
      const group = mockGroup({
        id: 'unicode-group',
        name: '日本語グループ 🎮',
        emoji: '🚀',
      });
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ groups: [group] })
      );

      const result = readGroups();

      expect(result[0].name).toBe('日本語グループ 🎮');
    });

    it('should handle very long session IDs', () => {
      const longId = 'a'.repeat(200);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          sessions: [mockSession({ id: longId })],
        })
      );

      const result = resolveAgentId(longId);

      expect(result).toBe(longId);
    });

    it('should handle history entries with all optional fields', () => {
      const entry: HistoryEntry = {
        id: 'full-entry',
        type: 'USER',
        timestamp: Date.now(),
        summary: 'Full entry',
        projectPath: '/project',
        fullResponse: 'Full response text',
        claudeSessionId: 'claude-123',
        sessionName: 'My Session',
        sessionId: 'session-123',
        contextUsage: 50000,
        usageStats: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 50,
          totalCostUsd: 0.05,
          contextWindow: 100000,
        },
        success: true,
        elapsedTimeMs: 5000,
        validated: true,
      };
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ entries: [entry] })
      );

      const result = readHistory();

      expect(result[0].fullResponse).toBe('Full response text');
      expect(result[0].usageStats?.inputTokens).toBe(1000);
    });

    it('should handle empty config file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{}');

      expect(readSessions()).toEqual([]);
      expect(readGroups()).toEqual([]);
      expect(readHistory()).toEqual([]);
      expect(readSettings()).toEqual({});
      expect(readAgentConfigs()).toEqual({});
    });
  });

  describe('per-session history (migrated mode)', () => {
    beforeEach(() => {
      // Enable migrated mode by making existsSync return true for migration marker
      vi.mocked(fs.existsSync).mockImplementation((filepath: fs.PathLike) => {
        const pathStr = String(filepath);
        if (pathStr.includes('history-migrated.json')) {
          return true;
        }
        if (pathStr.includes('/history/')) {
          // Check specific session file existence
          return pathStr.includes('session-123.json') || pathStr.includes('session-456.json');
        }
        return false;
      });
    });

    describe('readHistory with per-session storage', () => {
      it('should read from session file when sessionId provided', () => {
        const sessionHistoryData = {
          version: 1,
          sessionId: 'session-123',
          projectPath: '/project/path',
          entries: [
            mockHistoryEntry({ id: 'e1', sessionId: 'session-123' }),
            mockHistoryEntry({ id: 'e2', sessionId: 'session-123' }),
          ],
        };
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(sessionHistoryData));

        const result = readHistory(undefined, 'session-123');

        expect(result).toHaveLength(2);
        expect(result[0].sessionId).toBe('session-123');
      });

      it('should return empty array when session file does not exist', () => {
        vi.mocked(fs.existsSync).mockImplementation((filepath: fs.PathLike) => {
          const pathStr = String(filepath);
          if (pathStr.includes('history-migrated.json')) {
            return true;
          }
          return false; // Session file doesn't exist
        });

        const result = readHistory(undefined, 'nonexistent-session');

        expect(result).toEqual([]);
      });

      it('should aggregate entries by projectPath across all sessions', () => {
        vi.mocked(fs.readdirSync).mockReturnValue([
          'session-123.json',
          'session-456.json',
        ] as unknown as fs.Dirent[]);

        vi.mocked(fs.existsSync).mockImplementation((filepath: fs.PathLike) => {
          const pathStr = String(filepath);
          if (pathStr.includes('history-migrated.json') || pathStr.includes('/history')) {
            return true;
          }
          return false;
        });

        vi.mocked(fs.readFileSync).mockImplementation((filepath) => {
          const pathStr = String(filepath);
          if (pathStr.includes('session-123.json')) {
            return JSON.stringify({
              version: 1,
              sessionId: 'session-123',
              projectPath: '/project/alpha',
              entries: [mockHistoryEntry({ id: 'e1', projectPath: '/project/alpha', timestamp: 2000 })],
            });
          }
          if (pathStr.includes('session-456.json')) {
            return JSON.stringify({
              version: 1,
              sessionId: 'session-456',
              projectPath: '/project/beta',
              entries: [mockHistoryEntry({ id: 'e2', projectPath: '/project/beta', timestamp: 1000 })],
            });
          }
          return '{}';
        });

        const result = readHistory('/project/alpha');

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('e1');
      });

      it('should return all entries sorted by timestamp when no filters', () => {
        vi.mocked(fs.readdirSync).mockReturnValue([
          'session-123.json',
          'session-456.json',
        ] as unknown as fs.Dirent[]);

        vi.mocked(fs.existsSync).mockImplementation((filepath: fs.PathLike) => {
          const pathStr = String(filepath);
          if (pathStr.includes('history-migrated.json') || pathStr.includes('/history')) {
            return true;
          }
          return false;
        });

        vi.mocked(fs.readFileSync).mockImplementation((filepath) => {
          const pathStr = String(filepath);
          if (pathStr.includes('session-123.json')) {
            return JSON.stringify({
              version: 1,
              sessionId: 'session-123',
              projectPath: '/project/alpha',
              entries: [mockHistoryEntry({ id: 'e1', timestamp: 1000 })],
            });
          }
          if (pathStr.includes('session-456.json')) {
            return JSON.stringify({
              version: 1,
              sessionId: 'session-456',
              projectPath: '/project/beta',
              entries: [mockHistoryEntry({ id: 'e2', timestamp: 2000 })],
            });
          }
          return '{}';
        });

        const result = readHistory();

        expect(result).toHaveLength(2);
        // Most recent first
        expect(result[0].id).toBe('e2');
        expect(result[1].id).toBe('e1');
      });
    });

    describe('addHistoryEntry with per-session storage', () => {
      let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      });

      afterEach(() => {
        consoleErrorSpy.mockRestore();
      });

      it('should write entry to session-specific file', () => {
        vi.mocked(fs.existsSync).mockImplementation((filepath: fs.PathLike) => {
          const pathStr = String(filepath);
          if (pathStr.includes('history-migrated.json')) {
            return true;
          }
          if (pathStr.includes('/history/session-123.json')) {
            return true;
          }
          return pathStr.includes('/history');
        });

        const existingData = {
          version: 1,
          sessionId: 'session-123',
          projectPath: '/project',
          entries: [mockHistoryEntry({ id: 'existing' })],
        };
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existingData));

        const newEntry = mockHistoryEntry({
          id: 'new-entry',
          sessionId: 'session-123',
          projectPath: '/project',
        });
        addHistoryEntry(newEntry);

        expect(fs.writeFileSync).toHaveBeenCalled();
        const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
        expect(writeCall[0]).toContain('/history/session-123.json');
        const writtenData = JSON.parse(writeCall[1] as string);
        expect(writtenData.entries).toHaveLength(2);
        expect(writtenData.entries[0].id).toBe('new-entry'); // New entry at beginning
      });

      it('should create history directory if it does not exist', () => {
        vi.mocked(fs.existsSync).mockImplementation((filepath: fs.PathLike) => {
          const pathStr = String(filepath);
          if (pathStr.includes('history-migrated.json')) {
            return true;
          }
          return false; // History directory doesn't exist
        });

        const newEntry = mockHistoryEntry({
          id: 'first-entry',
          sessionId: 'new-session',
          projectPath: '/project',
        });
        addHistoryEntry(newEntry);

        expect(fs.mkdirSync).toHaveBeenCalledWith(
          expect.stringContaining('/history'),
          { recursive: true }
        );
      });

      it('should skip entries without sessionId', () => {
        vi.mocked(fs.existsSync).mockImplementation((filepath: fs.PathLike) => {
          const pathStr = String(filepath);
          if (pathStr.includes('history-migrated.json')) {
            return true;
          }
          return pathStr.includes('/history');
        });

        const newEntry = mockHistoryEntry({
          id: 'orphaned-entry',
          projectPath: '/project',
        });
        // Explicitly remove sessionId
        delete (newEntry as { sessionId?: string }).sessionId;
        addHistoryEntry(newEntry);

        // Should not write anything - entries without sessionId are skipped
        expect(fs.writeFileSync).not.toHaveBeenCalled();
      });

      it('should enforce max entries limit (5000)', () => {
        vi.mocked(fs.existsSync).mockImplementation((filepath: fs.PathLike) => {
          const pathStr = String(filepath);
          if (pathStr.includes('history-migrated.json')) {
            return true;
          }
          return pathStr.includes('/history');
        });

        // Create 5000 existing entries
        const existingEntries = Array.from({ length: 5000 }, (_, i) =>
          mockHistoryEntry({ id: `entry-${i}` })
        );
        const existingData = {
          version: 1,
          sessionId: 'session-123',
          projectPath: '/project',
          entries: existingEntries,
        };
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existingData));

        const newEntry = mockHistoryEntry({
          id: 'new-entry',
          sessionId: 'session-123',
          projectPath: '/project',
        });
        addHistoryEntry(newEntry);

        expect(fs.writeFileSync).toHaveBeenCalled();
        const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
        const writtenData = JSON.parse(writeCall[1] as string);
        expect(writtenData.entries).toHaveLength(5000);
        expect(writtenData.entries[0].id).toBe('new-entry'); // New entry at beginning
        // Last entry should be trimmed
        expect(writtenData.entries[4999].id).toBe('entry-4998');
      });
    });
  });
});
