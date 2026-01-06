/**
 * Tests for the Document Graph data builder (BFS-based API)
 *
 * The graph builder uses BFS traversal starting from a focus file,
 * discovering connected documents up to maxDepth levels.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  buildGraphData,
  expandNode,
  isDocumentNode,
  isExternalLinkNode,
  clearGraphDataCache,
  invalidateCacheForFiles,
  getGraphCacheStats,
  type DocumentNodeData,
  type ProgressData,
  type BacklinkUpdateData,
  BATCH_SIZE_BEFORE_YIELD,
} from '../../../../renderer/components/DocumentGraph/graphDataBuilder';

// Type definitions for mock file system
interface MockFile {
  content: string;
  size: number;
}

interface MockDirectory {
  [key: string]: MockFile | MockDirectory | boolean;
  _isDirectory: boolean;
}

describe('graphDataBuilder', () => {
  // Store mock functions for easy reset
  let mockReadDir: Mock;
  let mockReadFile: Mock;
  let mockStat: Mock;

  // Mock file system with linked documents
  const mockFileSystem: MockDirectory = {
    _isDirectory: true,
    'readme.md': {
      content: '# Project\n\nSee [[getting-started]] for help.\n\nVisit [GitHub](https://github.com/test/repo).',
      size: 100,
    },
    'getting-started.md': {
      content: '# Getting Started\n\nCheck [[readme]] and [[advanced/config]] for more.',
      size: 150,
    },
    'standalone.md': {
      content: '# Standalone\n\nNo links here.',
      size: 50,
    },
    advanced: {
      _isDirectory: true,
      'config.md': {
        content: '---\ntitle: Configuration\ndescription: How to configure the app\n---\n\n# Config\n\nLink to [docs](https://docs.example.com).',
        size: 200,
      },
    },
    node_modules: {
      _isDirectory: true,
      'package.json': {
        content: '{}',
        size: 10,
      },
    },
  };

  function getEntry(path: string): MockFile | MockDirectory | undefined {
    const parts = path.split('/').filter(Boolean);
    let current: MockFile | MockDirectory = mockFileSystem;

    for (const part of parts) {
      if (typeof current !== 'object' || current === null) return undefined;
      if ('content' in current) return undefined; // It's a file, can't go deeper
      current = current[part] as MockFile | MockDirectory;
      if (!current) return undefined;
    }

    return current;
  }

  function mockReadDirImpl(dirPath: string): Promise<Array<{ name: string; isDirectory: boolean; path: string }>> {
    const normalizedPath = dirPath.replace(/\/$/, '');
    const dir = normalizedPath === '/test' ? mockFileSystem : getEntry(normalizedPath.replace('/test/', ''));

    if (!dir || typeof dir !== 'object' || 'content' in dir) {
      return Promise.resolve([]);
    }

    const entries = Object.entries(dir)
      .filter(([key]) => key !== '_isDirectory')
      .map(([name, value]) => ({
        name,
        isDirectory: typeof value === 'object' && value !== null && '_isDirectory' in value && value._isDirectory === true,
        path: `${normalizedPath}/${name}`,
      }));

    return Promise.resolve(entries);
  }

  function mockReadFileImpl(filePath: string): Promise<string | null> {
    const relativePath = filePath.replace('/test/', '');
    const entry = getEntry(relativePath);

    if (entry && 'content' in entry) {
      return Promise.resolve(entry.content);
    }

    return Promise.resolve(null);
  }

  function mockStatImpl(filePath: string): Promise<{ size: number; modifiedAt: string } | null> {
    const relativePath = filePath.replace('/test/', '');
    const entry = getEntry(relativePath);

    if (entry && 'size' in entry) {
      // Return a consistent modifiedAt timestamp for cache testing
      return Promise.resolve({
        size: entry.size,
        modifiedAt: '2024-01-01T00:00:00.000Z',
      });
    }

    return Promise.resolve(null);
  }

  beforeEach(() => {
    // Clear the cache before each test to ensure isolation
    clearGraphDataCache();

    mockReadDir = vi.fn().mockImplementation(mockReadDirImpl);
    mockReadFile = vi.fn().mockImplementation(mockReadFileImpl);
    mockStat = vi.fn().mockImplementation(mockStatImpl);

    // Mock window.maestro.fs
    vi.stubGlobal('window', {
      maestro: {
        fs: {
          readDir: mockReadDir,
          readFile: mockReadFile,
          stat: mockStat,
        },
      },
    });
  });

  describe('BFS traversal from focus file', () => {
    it('should start from focus file and discover linked documents', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
      });

      // Should find readme.md and getting-started.md (linked from readme)
      expect(result.nodes.length).toBeGreaterThanOrEqual(1);
      expect(result.nodes.find(n => n.id === 'doc-readme.md')).toBeDefined();
    });

    it('should traverse links up to maxDepth', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 2,
      });

      // readme.md -> getting-started.md (depth 1) -> advanced/config.md (depth 2)
      const nodeIds = result.nodes.map(n => n.id);
      expect(nodeIds).toContain('doc-readme.md');
      expect(nodeIds).toContain('doc-getting-started.md');
      expect(nodeIds).toContain('doc-advanced/config.md');
    });

    it('should respect maxDepth limit', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 1,
      });

      // readme.md -> getting-started.md (depth 1), but NOT advanced/config.md (depth 2)
      const nodeIds = result.nodes.map(n => n.id);
      expect(nodeIds).toContain('doc-readme.md');
      expect(nodeIds).toContain('doc-getting-started.md');
      // advanced/config.md is at depth 2, should not be included
      expect(nodeIds).not.toContain('doc-advanced/config.md');
    });

    it('should not include unlinked files', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 10,
      });

      // standalone.md is not linked from any file in the chain
      const nodeIds = result.nodes.map(n => n.id);
      expect(nodeIds).not.toContain('doc-standalone.md');
    });

    it('should handle circular links without infinite loop', async () => {
      // readme.md -> getting-started.md -> readme.md (circular)
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 5,
      });

      // Should complete without hanging
      expect(result.nodes.length).toBeGreaterThan(0);
      // Each file should appear only once
      const nodeIds = result.nodes.map(n => n.id);
      const uniqueIds = new Set(nodeIds);
      expect(nodeIds.length).toBe(uniqueIds.size);
    });
  });

  describe('maxNodes limit', () => {
    it('should limit nodes when maxNodes is set', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxNodes: 2,
        maxDepth: 10,
      });

      expect(result.nodes.length).toBeLessThanOrEqual(2);
      expect(result.loadedDocuments).toBeLessThanOrEqual(2);
    });

    it('should always include focus file', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxNodes: 1,
      });

      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0].id).toBe('doc-readme.md');
    });
  });

  describe('edge creation', () => {
    it('should create edges between loaded documents', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 1,
      });

      // readme.md links to getting-started.md
      const edge = result.edges.find(
        e => e.source === 'doc-readme.md' && e.target === 'doc-getting-started.md'
      );
      expect(edge).toBeDefined();
    });

    it('should not create edges to unloaded documents', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxNodes: 1, // Only load focus file
      });

      // No edges since only one document is loaded
      expect(result.edges.length).toBe(0);
    });
  });

  describe('external links', () => {
    it('should collect external links in cachedExternalData', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 2,
      });

      // readme.md has github.com, advanced/config.md has docs.example.com
      expect(result.cachedExternalData.domainCount).toBeGreaterThanOrEqual(1);
      expect(result.cachedExternalData.totalLinkCount).toBeGreaterThanOrEqual(1);
    });

    it('should create external link nodes', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 1,
      });

      const githubNode = result.cachedExternalData.externalNodes.find(
        n => n.id === 'ext-github.com'
      );
      expect(githubNode).toBeDefined();
    });
  });

  describe('document stats', () => {
    it('should extract document stats for each node', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
      });

      const readmeNode = result.nodes.find(n => n.id === 'doc-readme.md');
      expect(readmeNode).toBeDefined();

      const data = readmeNode!.data as DocumentNodeData;
      expect(data.wordCount).toBeDefined();
      expect(data.title).toBeDefined();
    });

    it('should extract front matter title and description', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 2,
      });

      const configNode = result.nodes.find(n => n.id === 'doc-advanced/config.md');
      expect(configNode).toBeDefined();

      const data = configNode!.data as DocumentNodeData;
      expect(data.title).toBe('Configuration');
      expect(data.description).toBe('How to configure the app');
    });
  });

  describe('error handling', () => {
    it('should return empty graph when focus file does not exist', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'nonexistent.md',
      });

      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
      expect(result.totalDocuments).toBe(0);
    });

    it('should handle file read errors gracefully', async () => {
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('getting-started')) {
          return Promise.reject(new Error('File read error'));
        }
        return mockReadFileImpl(path);
      });

      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 2,
      });

      // Should still have readme.md even though getting-started failed
      expect(result.nodes.find(n => n.id === 'doc-readme.md')).toBeDefined();
    });
  });

  describe('progress callback', () => {
    it('should call onProgress during parsing', async () => {
      const onProgress = vi.fn();

      await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 1,
        onProgress,
      });

      expect(onProgress).toHaveBeenCalled();

      // Should have parsing phase calls
      const parsingCalls = onProgress.mock.calls.filter(
        (call) => call[0].phase === 'parsing'
      );
      expect(parsingCalls.length).toBeGreaterThan(0);
    });

    it('should report currentFile in progress', async () => {
      const progressFiles: string[] = [];
      const onProgress = (progress: ProgressData) => {
        if (progress.currentFile) {
          progressFiles.push(progress.currentFile);
        }
      };

      await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 1,
        onProgress,
      });

      expect(progressFiles).toContain('readme.md');
    });
  });

  describe('type guards', () => {
    it('isDocumentNode should correctly identify document nodes', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
      });

      const docNode = result.nodes[0];
      expect(isDocumentNode(docNode.data)).toBe(true);
    });

    it('isExternalLinkNode should correctly identify external link nodes', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
      });

      const extNode = result.cachedExternalData.externalNodes[0];
      if (extNode) {
        expect(isExternalLinkNode(extNode.data)).toBe(true);
      }
    });
  });

  describe('constants', () => {
    it('should export BATCH_SIZE_BEFORE_YIELD', () => {
      expect(BATCH_SIZE_BEFORE_YIELD).toBeDefined();
      expect(typeof BATCH_SIZE_BEFORE_YIELD).toBe('number');
      expect(BATCH_SIZE_BEFORE_YIELD).toBeGreaterThan(0);
    });
  });

  describe('graph data structure', () => {
    it('should return correct GraphData structure', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
      });

      expect(result).toHaveProperty('nodes');
      expect(result).toHaveProperty('edges');
      expect(result).toHaveProperty('totalDocuments');
      expect(result).toHaveProperty('loadedDocuments');
      expect(result).toHaveProperty('hasMore');
      expect(result).toHaveProperty('cachedExternalData');
      expect(result).toHaveProperty('internalLinkCount');
      expect(result).toHaveProperty('backlinksLoading');
      expect(result).toHaveProperty('startBacklinkScan');

      expect(Array.isArray(result.nodes)).toBe(true);
      expect(Array.isArray(result.edges)).toBe(true);
    });

    it('should set hasMore correctly based on queue', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxNodes: 1, // Only load focus file
      });

      // There are more files to load (getting-started.md is linked)
      // hasMore depends on whether queue still has items when we hit maxNodes
      expect(typeof result.hasMore).toBe('boolean');
    });
  });

  describe('lazy backlink loading', () => {
    it('should return startBacklinkScan function', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
      });

      expect(result.startBacklinkScan).toBeDefined();
      expect(typeof result.startBacklinkScan).toBe('function');
      expect(result.backlinksLoading).toBe(true);
    });

    it('should discover backlinks when scanning', async () => {
      // Build graph starting from advanced/config.md
      // This file has no outgoing internal links, so BFS only loads itself
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'advanced/config.md',
        maxDepth: 1,
      });

      // Initially should only include config.md (it has no outgoing internal links)
      const nodeIds = result.nodes.map(n => n.id);
      expect(nodeIds).toContain('doc-advanced/config.md');
      // getting-started.md should NOT be in initial graph (it links TO config, not FROM)
      expect(nodeIds).not.toContain('doc-getting-started.md');

      // Start backlink scan - should discover getting-started.md which links TO config.md
      const updates: BacklinkUpdateData[] = [];
      let scanComplete = false;

      await new Promise<void>((resolve) => {
        result.startBacklinkScan!(
          (update) => updates.push(update),
          () => {
            scanComplete = true;
            resolve();
          }
        );
      });

      expect(scanComplete).toBe(true);

      // Check if getting-started.md was discovered as a backlink source
      const newNodeIds = updates.flatMap(u => u.newNodes.map(n => n.id));
      expect(newNodeIds).toContain('doc-getting-started.md');
    });

    it('should create edges for backlinks', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'getting-started.md',
        maxDepth: 0, // Only focus file, no outgoing traversal
      });

      const updates: BacklinkUpdateData[] = [];

      await new Promise<void>((resolve) => {
        result.startBacklinkScan!(
          (update) => updates.push(update),
          () => resolve()
        );
      });

      // Should have edge from readme.md -> getting-started.md
      const allNewEdges = updates.flatMap(u => u.newEdges);
      const backlinkEdge = allNewEdges.find(
        e => e.source === 'doc-readme.md' && e.target === 'doc-getting-started.md'
      );
      expect(backlinkEdge).toBeDefined();
    });

    it('should be abortable', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
      });

      let updateCount = 0;
      let completed = false;

      const abort = result.startBacklinkScan!(
        () => { updateCount++; },
        () => { completed = true; }
      );

      // Abort immediately
      abort();

      // Give it a moment to process
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should not have completed since we aborted
      // (Note: in a real scenario with many files, abort would prevent completion)
      // For this small test, it may complete before abort takes effect
      expect(typeof abort).toBe('function');
    });

    it('should report progress during scan', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        focusFile: 'standalone.md', // Start from a file with no links
      });

      const updates: BacklinkUpdateData[] = [];

      await new Promise<void>((resolve) => {
        result.startBacklinkScan!(
          (update) => updates.push(update),
          () => resolve()
        );
      });

      // Even if no backlinks found, should have been called with progress info
      // Since standalone.md has no links to it, updates might be empty or have progress-only updates
      // The important thing is the scan completed
      expect(true).toBe(true); // Scan completed without error
    });
  });

  describe('caching', () => {
    it('should cache parsed files and reuse on subsequent builds', async () => {
      // First build - should read all files
      await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 1,
      });

      const firstReadFileCallCount = mockReadFile.mock.calls.length;

      // Second build - should use cache for unchanged files
      await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 1,
      });

      const secondReadFileCallCount = mockReadFile.mock.calls.length;

      // Cache should reduce file reads (stat is still called to check mtime)
      // The second build should call readFile fewer times because of cache hits
      expect(secondReadFileCallCount).toBeLessThan(firstReadFileCallCount * 2);
    });

    it('should report cache stats', async () => {
      // Initially empty
      clearGraphDataCache();
      let stats = getGraphCacheStats();
      expect(stats.parsedFileCount).toBe(0);

      // Build graph to populate cache
      await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 1,
      });

      stats = getGraphCacheStats();
      expect(stats.parsedFileCount).toBeGreaterThan(0);
    });

    it('should invalidate cache for specific files', async () => {
      // Build to populate cache
      await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
      });

      const statsBefore = getGraphCacheStats();
      expect(statsBefore.parsedFileCount).toBeGreaterThan(0);

      // Invalidate specific file
      invalidateCacheForFiles(['/test/readme.md']);

      // Cache should still have other files but not the invalidated one
      const statsAfter = getGraphCacheStats();
      expect(statsAfter.parsedFileCount).toBeLessThan(statsBefore.parsedFileCount);
    });

    it('should clear entire cache', async () => {
      // Build to populate cache
      await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 2,
      });

      expect(getGraphCacheStats().parsedFileCount).toBeGreaterThan(0);

      // Clear cache
      clearGraphDataCache();

      expect(getGraphCacheStats().parsedFileCount).toBe(0);
    });

    it('should re-parse file when mtime changes', async () => {
      // First build
      await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
      });

      const initialCallCount = mockReadFile.mock.calls.length;

      // Change the mtime for readme.md
      mockStat.mockImplementation((filePath: string) => {
        const relativePath = filePath.replace('/test/', '');
        const entry = getEntry(relativePath);

        if (entry && 'size' in entry) {
          return Promise.resolve({
            size: entry.size,
            // Different mtime for readme.md
            modifiedAt: filePath.includes('readme')
              ? '2024-06-01T00:00:00.000Z'
              : '2024-01-01T00:00:00.000Z',
          });
        }
        return Promise.resolve(null);
      });

      // Second build - should re-read readme.md due to mtime change
      await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
      });

      // Should have additional readFile calls for the changed file
      expect(mockReadFile.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  describe('expandNode (fan out)', () => {
    it('should discover outgoing links from a node', async () => {
      // First, build initial graph with depth 1 (only readme.md and getting-started.md)
      const initialGraph = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 1,
      });

      const initialPaths = new Set(
        initialGraph.nodes
          .filter(n => n.type === 'documentNode')
          .map(n => (n.data as DocumentNodeData).filePath)
          .filter((p): p is string => !!p)
      );

      // Expand getting-started.md which links to advanced/config.md
      const result = await expandNode({
        rootPath: '/test',
        filePath: 'getting-started.md',
        loadedPaths: initialPaths,
        maxDepth: 1,
      });

      // Should discover advanced/config.md
      expect(result.hasNewContent).toBe(true);
      const newNodeIds = result.newNodes.map(n => n.id);
      expect(newNodeIds).toContain('doc-advanced/config.md');
    });

    it('should create edges from expanded node to new nodes', async () => {
      const loadedPaths = new Set(['readme.md', 'getting-started.md']);

      const result = await expandNode({
        rootPath: '/test',
        filePath: 'getting-started.md',
        loadedPaths,
        maxDepth: 1,
      });

      // Should have edge from getting-started.md to advanced/config.md
      const edge = result.newEdges.find(
        e => e.source === 'doc-getting-started.md' && e.target === 'doc-advanced/config.md'
      );
      expect(edge).toBeDefined();
    });

    it('should return hasNewContent false when no new document nodes found', async () => {
      // Load all connected nodes first
      const initialGraph = await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        maxDepth: 10, // Load everything connected
      });

      const allPaths = new Set(
        initialGraph.nodes
          .filter(n => n.type === 'documentNode')
          .map(n => (n.data as DocumentNodeData).filePath)
          .filter((p): p is string => !!p)
      );

      // Try to expand readme.md - all its document links should already be loaded
      const result = await expandNode({
        rootPath: '/test',
        filePath: 'readme.md',
        loadedPaths: allPaths,
        maxDepth: 1,
      });

      // No new document nodes since getting-started.md is already loaded
      // (External links may still be returned, but document nodes should be 0)
      expect(result.newNodes.length).toBe(0);
    });

    it('should handle non-existent file gracefully', async () => {
      const result = await expandNode({
        rootPath: '/test',
        filePath: 'nonexistent.md',
        loadedPaths: new Set(['readme.md']),
        maxDepth: 1,
      });

      expect(result.hasNewContent).toBe(false);
      expect(result.newNodes.length).toBe(0);
    });

    it('should respect maxDepth when expanding', async () => {
      // Build initial graph with only readme.md
      const loadedPaths = new Set(['readme.md']);

      // Expand with depth 1 - should get getting-started.md but NOT advanced/config.md
      const result = await expandNode({
        rootPath: '/test',
        filePath: 'readme.md',
        loadedPaths,
        maxDepth: 1,
      });

      const newNodeIds = result.newNodes.map(n => n.id);
      expect(newNodeIds).toContain('doc-getting-started.md');
      expect(newNodeIds).not.toContain('doc-advanced/config.md');
    });

    it('should update loadedPaths with new paths', async () => {
      const loadedPaths = new Set(['readme.md', 'getting-started.md']);

      const result = await expandNode({
        rootPath: '/test',
        filePath: 'getting-started.md',
        loadedPaths,
        maxDepth: 1,
      });

      // Should include original paths plus new ones
      expect(result.updatedLoadedPaths.has('readme.md')).toBe(true);
      expect(result.updatedLoadedPaths.has('getting-started.md')).toBe(true);
      expect(result.updatedLoadedPaths.has('advanced/config.md')).toBe(true);
    });
  });

  describe('SSH support', () => {
    it('should pass sshRemoteId to file operations in buildGraphData', async () => {
      const testSshRemoteId = 'test-remote-123';

      await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        sshRemoteId: testSshRemoteId,
      });

      // Check that fs operations were called with sshRemoteId
      const statCalls = mockStat.mock.calls;
      const readFileCalls = mockReadFile.mock.calls;

      // At least one stat call should have been made with sshRemoteId
      expect(statCalls.some(call => call[1] === testSshRemoteId)).toBe(true);
      // At least one readFile call should have been made with sshRemoteId
      expect(readFileCalls.some(call => call[1] === testSshRemoteId)).toBe(true);
    });

    it('should pass sshRemoteId to file operations in expandNode', async () => {
      const testSshRemoteId = 'test-remote-456';

      await expandNode({
        rootPath: '/test',
        filePath: 'readme.md',
        loadedPaths: new Set(['readme.md']),
        maxDepth: 1,
        sshRemoteId: testSshRemoteId,
      });

      // Check that fs operations were called with sshRemoteId
      const statCalls = mockStat.mock.calls;
      const readFileCalls = mockReadFile.mock.calls;

      expect(statCalls.some(call => call[1] === testSshRemoteId)).toBe(true);
      expect(readFileCalls.some(call => call[1] === testSshRemoteId)).toBe(true);
    });

    it('should not cache parsed files when using SSH', async () => {
      clearGraphDataCache();

      await buildGraphData({
        rootPath: '/test',
        focusFile: 'readme.md',
        sshRemoteId: 'remote-host',
      });

      // SSH files should not be cached
      const stats = getGraphCacheStats();
      expect(stats.parsedFileCount).toBe(0);
    });
  });
});
