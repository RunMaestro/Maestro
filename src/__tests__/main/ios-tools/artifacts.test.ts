/**
 * Tests for src/main/ios-tools/artifacts.ts
 *
 * Tests cover artifact directory management for iOS tools.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user-data'),
  },
}));

// Mock fs/promises
const mockMkdir = vi.fn();
const mockReaddir = vi.fn();
const mockRm = vi.fn();
const mockStat = vi.fn();
vi.mock('fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  rm: (...args: unknown[]) => mockRm(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  default: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
    rm: (...args: unknown[]) => mockRm(...args),
    stat: (...args: unknown[]) => mockStat(...args),
  },
}));

import {
  getArtifactDirectory,
  getSnapshotDirectory,
  generateSnapshotId,
  listSessionArtifacts,
  pruneSessionArtifacts,
  getSessionArtifactsSize,
} from '../../../main/ios-tools/artifacts';

describe('artifacts.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    mockRm.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 1000 });
  });

  // =============================================================================
  // getArtifactDirectory
  // =============================================================================

  describe('getArtifactDirectory', () => {
    it('creates and returns session artifact directory', async () => {
      const result = await getArtifactDirectory('session-123');

      expect(result).toBe('/mock/user-data/ios-artifacts/session-123');
      expect(mockMkdir).toHaveBeenCalledWith(
        '/mock/user-data/ios-artifacts/session-123',
        { recursive: true }
      );
    });

    it('handles different session IDs', async () => {
      const result1 = await getArtifactDirectory('session-abc');
      const result2 = await getArtifactDirectory('session-xyz');

      expect(result1).toBe('/mock/user-data/ios-artifacts/session-abc');
      expect(result2).toBe('/mock/user-data/ios-artifacts/session-xyz');
    });

    it('throws when directory creation fails', async () => {
      mockMkdir.mockRejectedValue(new Error('Permission denied'));

      await expect(getArtifactDirectory('session-123')).rejects.toThrow('Permission denied');
    });
  });

  // =============================================================================
  // getSnapshotDirectory
  // =============================================================================

  describe('getSnapshotDirectory', () => {
    it('creates and returns snapshot subdirectory', async () => {
      const result = await getSnapshotDirectory('session-123', 'snapshot-001');

      expect(result).toBe('/mock/user-data/ios-artifacts/session-123/snapshot-001');
      expect(mockMkdir).toHaveBeenCalledTimes(2);
    });

    it('creates parent session directory first', async () => {
      await getSnapshotDirectory('session-123', 'snapshot-001');

      // First call should be for session directory
      expect(mockMkdir.mock.calls[0][0]).toBe('/mock/user-data/ios-artifacts/session-123');
      // Second call should be for snapshot directory
      expect(mockMkdir.mock.calls[1][0]).toBe('/mock/user-data/ios-artifacts/session-123/snapshot-001');
    });

    it('throws when snapshot directory creation fails', async () => {
      mockMkdir.mockResolvedValueOnce(undefined); // Session dir succeeds
      mockMkdir.mockRejectedValueOnce(new Error('Disk full')); // Snapshot dir fails

      await expect(getSnapshotDirectory('session-123', 'snapshot-001')).rejects.toThrow('Disk full');
    });
  });

  // =============================================================================
  // generateSnapshotId
  // =============================================================================

  describe('generateSnapshotId', () => {
    it('generates ID with correct format', () => {
      const id = generateSnapshotId();

      expect(id).toMatch(/^snapshot-\d{14}-\d{3}$/);
    });

    it('generates IDs with timestamp component', () => {
      const id1 = generateSnapshotId();
      const id2 = generateSnapshotId();

      // Both should have the same format
      expect(id1).toMatch(/^snapshot-\d{14}-\d{3}$/);
      expect(id2).toMatch(/^snapshot-\d{14}-\d{3}$/);

      // The IDs should contain date-like patterns
      const datePart1 = id1.split('-')[1];
      const datePart2 = id2.split('-')[1];
      expect(datePart1.length).toBe(14);
      expect(datePart2.length).toBe(14);
    });

    it('starts with "snapshot-" prefix', () => {
      const id = generateSnapshotId();

      expect(id.startsWith('snapshot-')).toBe(true);
    });
  });

  // =============================================================================
  // listSessionArtifacts
  // =============================================================================

  describe('listSessionArtifacts', () => {
    it('returns list of snapshot directories', async () => {
      mockReaddir.mockResolvedValue([
        { name: 'snapshot-001', isDirectory: () => true },
        { name: 'snapshot-002', isDirectory: () => true },
        { name: 'snapshot-003', isDirectory: () => true },
      ]);

      const result = await listSessionArtifacts('session-123');

      expect(result).toEqual(['snapshot-001', 'snapshot-002', 'snapshot-003']);
    });

    it('filters out files (only returns directories)', async () => {
      mockReaddir.mockResolvedValue([
        { name: 'snapshot-001', isDirectory: () => true },
        { name: 'metadata.json', isDirectory: () => false },
        { name: 'snapshot-002', isDirectory: () => true },
      ]);

      const result = await listSessionArtifacts('session-123');

      expect(result).toEqual(['snapshot-001', 'snapshot-002']);
    });

    it('returns empty array when directory does not exist', async () => {
      mockReaddir.mockRejectedValue({ code: 'ENOENT' });

      const result = await listSessionArtifacts('nonexistent-session');

      expect(result).toEqual([]);
    });

    it('returns empty array on read error', async () => {
      mockReaddir.mockRejectedValue(new Error('Permission denied'));

      const result = await listSessionArtifacts('session-123');

      expect(result).toEqual([]);
    });
  });

  // =============================================================================
  // pruneSessionArtifacts
  // =============================================================================

  describe('pruneSessionArtifacts', () => {
    it('removes oldest artifacts beyond keep count', async () => {
      mockReaddir.mockResolvedValue([
        { name: 'snapshot-001', isDirectory: () => true },
        { name: 'snapshot-002', isDirectory: () => true },
        { name: 'snapshot-003', isDirectory: () => true },
        { name: 'snapshot-004', isDirectory: () => true },
        { name: 'snapshot-005', isDirectory: () => true },
      ]);

      await pruneSessionArtifacts('session-123', 3);

      // Should remove oldest 2 (001 and 002)
      expect(mockRm).toHaveBeenCalledTimes(2);
      expect(mockRm).toHaveBeenCalledWith(
        '/mock/user-data/ios-artifacts/session-123/snapshot-001',
        { recursive: true, force: true }
      );
      expect(mockRm).toHaveBeenCalledWith(
        '/mock/user-data/ios-artifacts/session-123/snapshot-002',
        { recursive: true, force: true }
      );
    });

    it('does nothing when artifact count is below keep limit', async () => {
      mockReaddir.mockResolvedValue([
        { name: 'snapshot-001', isDirectory: () => true },
        { name: 'snapshot-002', isDirectory: () => true },
      ]);

      await pruneSessionArtifacts('session-123', 5);

      expect(mockRm).not.toHaveBeenCalled();
    });

    it('uses default keep count of 50', async () => {
      const manyArtifacts = Array.from({ length: 60 }, (_, i) => ({
        name: `snapshot-${String(i + 1).padStart(3, '0')}`,
        isDirectory: () => true,
      }));
      mockReaddir.mockResolvedValue(manyArtifacts);

      await pruneSessionArtifacts('session-123');

      // Should remove 10 oldest
      expect(mockRm).toHaveBeenCalledTimes(10);
    });

    it('handles directory read errors gracefully', async () => {
      mockReaddir.mockRejectedValue(new Error('Read failed'));

      // Should not throw
      await expect(pruneSessionArtifacts('session-123')).resolves.not.toThrow();
    });

    it('stops pruning if delete fails (await loop behavior)', async () => {
      mockReaddir.mockResolvedValue([
        { name: 'snapshot-001', isDirectory: () => true },
        { name: 'snapshot-002', isDirectory: () => true },
        { name: 'snapshot-003', isDirectory: () => true },
      ]);

      mockRm.mockRejectedValueOnce(new Error('Delete failed'));
      mockRm.mockResolvedValueOnce(undefined);

      // pruneSessionArtifacts catches errors internally, so it won't throw
      await pruneSessionArtifacts('session-123', 1);

      // Since the first delete fails and throws, the loop stops
      // But the function catches the error and logs a warning
      expect(mockRm).toHaveBeenCalledTimes(1);
    });

    it('sorts directories by name (timestamp) before pruning', async () => {
      // Unsorted input
      mockReaddir.mockResolvedValue([
        { name: 'snapshot-003', isDirectory: () => true },
        { name: 'snapshot-001', isDirectory: () => true },
        { name: 'snapshot-002', isDirectory: () => true },
      ]);

      await pruneSessionArtifacts('session-123', 1);

      // Should remove oldest (001 and 002), not 003
      const deletedPaths = mockRm.mock.calls.map(call => call[0]);
      expect(deletedPaths).toContain('/mock/user-data/ios-artifacts/session-123/snapshot-001');
      expect(deletedPaths).toContain('/mock/user-data/ios-artifacts/session-123/snapshot-002');
      expect(deletedPaths).not.toContain('/mock/user-data/ios-artifacts/session-123/snapshot-003');
    });
  });

  // =============================================================================
  // getSessionArtifactsSize
  // =============================================================================

  describe('getSessionArtifactsSize', () => {
    it('calculates total size of all files in session directory', async () => {
      // Setup directory structure
      mockReaddir.mockImplementation(async (path: string) => {
        if (path.endsWith('session-123')) {
          return [
            { name: 'snapshot-001', isDirectory: () => true, isFile: () => false },
          ];
        }
        if (path.endsWith('snapshot-001')) {
          return [
            { name: 'screenshot.png', isDirectory: () => false, isFile: () => true },
            { name: 'logs.json', isDirectory: () => false, isFile: () => true },
          ];
        }
        return [];
      });

      mockStat.mockImplementation(async (path: string) => {
        if (path.endsWith('screenshot.png')) return { size: 100000 };
        if (path.endsWith('logs.json')) return { size: 5000 };
        return { size: 0 };
      });

      const size = await getSessionArtifactsSize('session-123');

      expect(size).toBe(105000);
    });

    it('returns 0 when directory does not exist', async () => {
      mockReaddir.mockRejectedValue({ code: 'ENOENT' });

      const size = await getSessionArtifactsSize('nonexistent-session');

      expect(size).toBe(0);
    });

    it('handles nested directories', async () => {
      mockReaddir.mockImplementation(async (path: string) => {
        if (path.endsWith('session-123')) {
          return [
            { name: 'snapshot-001', isDirectory: () => true, isFile: () => false },
          ];
        }
        if (path.endsWith('snapshot-001')) {
          return [
            { name: 'screenshot.png', isDirectory: () => false, isFile: () => true },
            { name: 'subdir', isDirectory: () => true, isFile: () => false },
          ];
        }
        if (path.endsWith('subdir')) {
          return [
            { name: 'nested.txt', isDirectory: () => false, isFile: () => true },
          ];
        }
        return [];
      });

      mockStat.mockResolvedValue({ size: 1000 });

      const size = await getSessionArtifactsSize('session-123');

      // Should count screenshot.png and nested.txt
      expect(size).toBe(2000);
    });

    it('handles stat errors gracefully', async () => {
      mockReaddir.mockResolvedValue([
        { name: 'file.txt', isDirectory: () => false, isFile: () => true },
      ]);
      mockStat.mockRejectedValue(new Error('Stat failed'));

      const size = await getSessionArtifactsSize('session-123');

      // Should return 0 instead of throwing
      expect(size).toBe(0);
    });
  });
});
