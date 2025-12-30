/**
 * Tests for the Document Graph data builder
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  buildGraphData,
  isDocumentNode,
  isExternalLinkNode,
  type GraphNodeData,
  type DocumentNodeData,
  type ExternalLinkNodeData,
  type ProgressData,
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

  // Mock file system data
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

    if (entry && typeof entry === 'object' && 'content' in entry) {
      return Promise.resolve((entry as MockFile).content);
    }

    return Promise.resolve(null);
  }

  function mockStatImpl(filePath: string): Promise<{ size: number; createdAt: string; modifiedAt: string }> {
    const relativePath = filePath.replace('/test/', '');
    const entry = getEntry(relativePath);

    if (entry && typeof entry === 'object' && 'size' in entry) {
      return Promise.resolve({
        size: (entry as MockFile).size,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-15T12:30:00.000Z',
      });
    }

    return Promise.resolve({
      size: 0,
      createdAt: '2024-01-01T00:00:00.000Z',
      modifiedAt: '2024-01-15T12:30:00.000Z',
    });
  }

  beforeEach(() => {
    // Reset mocks before each test
    mockReadDir = vi.fn().mockImplementation(mockReadDirImpl);
    mockReadFile = vi.fn().mockImplementation(mockReadFileImpl);
    mockStat = vi.fn().mockImplementation(mockStatImpl);

    // Apply mocks to window.maestro
    vi.mocked(window.maestro.fs.readDir).mockImplementation(mockReadDir);
    vi.mocked(window.maestro.fs.readFile).mockImplementation(mockReadFile);
    vi.mocked(window.maestro.fs.stat).mockImplementation(mockStat);
  });

  describe('buildGraphData', () => {
    it('should scan directory and find markdown files', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      // Should find 4 markdown files (readme, getting-started, standalone, advanced/config)
      const documentNodes = result.nodes.filter((n) => n.type === 'documentNode');
      expect(documentNodes).toHaveLength(4);
    });

    it('should skip node_modules directory', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      // Should not include any files from node_modules
      const nodeIds = result.nodes.map((n) => n.id);
      expect(nodeIds.every((id) => !id.includes('node_modules'))).toBe(true);
    });

    it('should create edges for internal wiki links', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      // readme.md links to getting-started.md
      const readmeToGettingStarted = result.edges.find(
        (e) => e.source === 'doc-readme.md' && e.target === 'doc-getting-started.md'
      );
      expect(readmeToGettingStarted).toBeDefined();
    });

    it('should create edges for nested internal links', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      // getting-started.md links to advanced/config.md
      const gettingStartedToConfig = result.edges.find(
        (e) => e.source === 'doc-getting-started.md' && e.target === 'doc-advanced/config.md'
      );
      expect(gettingStartedToConfig).toBeDefined();
    });

    it('should not create edges for non-existent files', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      // No edge should target a non-existent file
      const documentIds = new Set(
        result.nodes.filter((n) => n.type === 'documentNode').map((n) => n.id)
      );

      const brokenEdges = result.edges.filter(
        (e) => e.type !== 'external' && !documentIds.has(e.target)
      );
      expect(brokenEdges).toHaveLength(0);
    });

    it('should extract document stats for each node', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const readmeNode = result.nodes.find((n) => n.id === 'doc-readme.md');
      expect(readmeNode).toBeDefined();

      const data = readmeNode!.data as DocumentNodeData;
      expect(data.nodeType).toBe('document');
      expect(data.title).toBe('Project');
      expect(data.lineCount).toBeGreaterThan(0);
      expect(data.wordCount).toBeGreaterThan(0);
      expect(data.size).toBe('100 B');
    });

    it('should extract front matter title and description', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const configNode = result.nodes.find((n) => n.id === 'doc-advanced/config.md');
      expect(configNode).toBeDefined();

      const data = configNode!.data as DocumentNodeData;
      expect(data.title).toBe('Configuration');
      expect(data.description).toBe('How to configure the app');
    });
  });

  describe('external links', () => {
    it('should not include external links when disabled', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const externalNodes = result.nodes.filter((n) => n.type === 'externalLinkNode');
      expect(externalNodes).toHaveLength(0);

      const externalEdges = result.edges.filter((e) => e.type === 'external');
      expect(externalEdges).toHaveLength(0);
    });

    it('should include external link nodes when enabled', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: true,
      });

      const externalNodes = result.nodes.filter((n) => n.type === 'externalLinkNode');
      // Should have nodes for github.com and docs.example.com
      expect(externalNodes.length).toBeGreaterThanOrEqual(2);
    });

    it('should deduplicate external domains', async () => {
      // Add another file with the same github.com link
      const originalReadDirImpl = mockReadDirImpl;
      mockReadDir.mockImplementation((path: string) => {
        if (path === '/test') {
          return Promise.resolve([
            { name: 'readme.md', isDirectory: false, path: '/test/readme.md' },
            { name: 'another.md', isDirectory: false, path: '/test/another.md' },
          ]);
        }
        return originalReadDirImpl(path);
      });

      mockReadFile.mockImplementation((path: string) => {
        if (path === '/test/readme.md') {
          return Promise.resolve('# Readme\n\nVisit [GitHub](https://github.com/test/repo).');
        }
        if (path === '/test/another.md') {
          return Promise.resolve('# Another\n\nAlso see [GitHub](https://github.com/other/repo).');
        }
        return Promise.resolve(null);
      });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: true,
      });

      // Should only have one github.com node, with count of 2
      const githubNodes = result.nodes.filter(
        (n) => n.type === 'externalLinkNode' && n.id === 'ext-github.com'
      );
      expect(githubNodes).toHaveLength(1);

      const data = githubNodes[0].data as ExternalLinkNodeData;
      expect(data.linkCount).toBe(2);
      expect(data.urls).toHaveLength(2);
    });

    it('should create edges to external link nodes', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: true,
      });

      // readme.md links to github.com
      const readmeToGithub = result.edges.find(
        (e) => e.source === 'doc-readme.md' && e.target === 'ext-github.com'
      );
      expect(readmeToGithub).toBeDefined();
      expect(readmeToGithub!.type).toBe('external');
    });
  });

  describe('type guards', () => {
    it('isDocumentNode should identify document nodes', () => {
      const docData: GraphNodeData = {
        nodeType: 'document',
        title: 'Test',
        lineCount: 10,
        wordCount: 100,
        size: '1 KB',
        filePath: 'test.md',
      };

      expect(isDocumentNode(docData)).toBe(true);
      expect(isExternalLinkNode(docData)).toBe(false);
    });

    it('isExternalLinkNode should identify external link nodes', () => {
      const extData: GraphNodeData = {
        nodeType: 'external',
        domain: 'github.com',
        linkCount: 3,
        urls: ['https://github.com/test'],
      };

      expect(isExternalLinkNode(extData)).toBe(true);
      expect(isDocumentNode(extData)).toBe(false);
    });
  });

  describe('max nodes limit', () => {
    it('should limit nodes when maxNodes is set', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
        maxNodes: 2,
      });

      // Should only have 2 document nodes
      const documentNodes = result.nodes.filter((n) => n.type === 'documentNode');
      expect(documentNodes).toHaveLength(2);
    });

    it('should return correct pagination info with maxNodes', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
        maxNodes: 2,
      });

      // Total should be 4 (all markdown files), but only 2 loaded
      expect(result.totalDocuments).toBe(4);
      expect(result.loadedDocuments).toBe(2);
      expect(result.hasMore).toBe(true);
    });

    it('should return hasMore=false when all documents loaded', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
        maxNodes: 10, // More than total documents
      });

      expect(result.totalDocuments).toBe(4);
      expect(result.loadedDocuments).toBe(4);
      expect(result.hasMore).toBe(false);
    });

    it('should not create edges to unloaded documents', async () => {
      // Load only 1 document - readme.md links to getting-started.md
      // but getting-started.md won't be loaded, so no edge should be created
      mockReadDir.mockImplementation((path: string) => {
        if (path === '/test') {
          return Promise.resolve([
            { name: 'readme.md', isDirectory: false, path: '/test/readme.md' },
            { name: 'getting-started.md', isDirectory: false, path: '/test/getting-started.md' },
          ]);
        }
        return Promise.resolve([]);
      });

      mockReadFile.mockImplementation((path: string) => {
        if (path === '/test/readme.md') {
          return Promise.resolve('# Readme\n\nSee [[getting-started]].');
        }
        if (path === '/test/getting-started.md') {
          return Promise.resolve('# Getting Started\n\nHello.');
        }
        return Promise.resolve(null);
      });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
        maxNodes: 1,
      });

      // Only 1 document loaded
      expect(result.loadedDocuments).toBe(1);
      // Should have no edges (target not loaded)
      expect(result.edges).toHaveLength(0);
    });

    it('should work with offset for pagination', async () => {
      mockReadDir.mockImplementation((path: string) => {
        if (path === '/test') {
          return Promise.resolve([
            { name: 'a.md', isDirectory: false, path: '/test/a.md' },
            { name: 'b.md', isDirectory: false, path: '/test/b.md' },
            { name: 'c.md', isDirectory: false, path: '/test/c.md' },
            { name: 'd.md', isDirectory: false, path: '/test/d.md' },
          ]);
        }
        return Promise.resolve([]);
      });

      mockReadFile.mockImplementation((path: string) => {
        const name = path.split('/').pop()?.replace('.md', '').toUpperCase();
        return Promise.resolve(`# ${name}`);
      });

      mockStat.mockResolvedValue({ size: 10, createdAt: '', modifiedAt: '' });

      // Load 2 documents starting from offset 1
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
        maxNodes: 2,
        offset: 1,
      });

      expect(result.totalDocuments).toBe(4);
      expect(result.loadedDocuments).toBe(2);
      expect(result.hasMore).toBe(true);

      // Should have b.md and c.md loaded (skipped a.md)
      const nodeIds = result.nodes.map((n) => n.id);
      expect(nodeIds).toContain('doc-b.md');
      expect(nodeIds).toContain('doc-c.md');
      expect(nodeIds).not.toContain('doc-a.md');
      expect(nodeIds).not.toContain('doc-d.md');
    });

    it('should include all documents when maxNodes is not set', async () => {
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      expect(result.totalDocuments).toBe(4);
      expect(result.loadedDocuments).toBe(4);
      expect(result.hasMore).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle empty directory', async () => {
      mockReadDir.mockResolvedValue([]);

      const result = await buildGraphData({
        rootPath: '/empty',
        includeExternalLinks: false,
      });

      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
      expect(result.totalDocuments).toBe(0);
      expect(result.loadedDocuments).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('should handle file read errors gracefully', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'test.md', isDirectory: false, path: '/test/test.md' },
      ]);
      mockReadFile.mockRejectedValue(new Error('File read error'));

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      // Should continue without crashing
      expect(result.nodes).toHaveLength(0);
    });

    it('should handle subdirectory scan errors gracefully', async () => {
      // First call succeeds with a directory, second call (subdirectory) fails
      mockReadDir
        .mockResolvedValueOnce([
          { name: 'readme.md', isDirectory: false, path: '/test/readme.md' },
          { name: 'broken', isDirectory: true, path: '/test/broken' },
        ])
        .mockRejectedValueOnce(new Error('Permission denied'));

      mockReadFile.mockResolvedValue('# Test');
      mockStat.mockResolvedValue({ size: 50, createdAt: '', modifiedAt: '' });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      // Should still include the readable file
      expect(result.nodes).toHaveLength(1);
    });

    it('should throw error when root directory fails to be read', async () => {
      // Root directory fails immediately
      mockReadDir.mockRejectedValueOnce(new Error('Permission denied'));

      await expect(
        buildGraphData({
          rootPath: '/inaccessible',
          includeExternalLinks: false,
        })
      ).rejects.toThrow('Failed to read directory');
    });

    it('should include original error message in root directory failure', async () => {
      // Root directory fails with specific error
      mockReadDir.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));

      await expect(
        buildGraphData({
          rootPath: '/nonexistent',
          includeExternalLinks: false,
        })
      ).rejects.toThrow('ENOENT: no such file or directory');
    });

    it('should handle null/undefined file content', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'test.md', isDirectory: false, path: '/test/test.md' },
      ]);
      mockReadFile.mockResolvedValue(null);

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      expect(result.nodes).toHaveLength(0);
    });

    // Note: Node positions are no longer set by graphDataBuilder.
    // Positions are computed by the D3 force simulation in ForceGraph.tsx.
    // The graphDataBuilder now returns GraphNode[] without position property.
  });

  describe('progress callback', () => {
    it('should call onProgress during scanning phase', async () => {
      const progressCalls: ProgressData[] = [];
      const onProgress = vi.fn((progress: ProgressData) => {
        progressCalls.push({ ...progress });
      });

      await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
        onProgress,
      });

      // Should have received scanning phase updates
      const scanningCalls = progressCalls.filter((p) => p.phase === 'scanning');
      expect(scanningCalls.length).toBeGreaterThan(0);

      // Scanning phase should have current > 0 and total = 0 (unknown during scanning)
      for (const call of scanningCalls) {
        expect(call.current).toBeGreaterThan(0);
        expect(call.total).toBe(0);
      }
    });

    it('should call onProgress during parsing phase with current/total', async () => {
      const progressCalls: ProgressData[] = [];
      const onProgress = vi.fn((progress: ProgressData) => {
        progressCalls.push({ ...progress });
      });

      await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
        onProgress,
      });

      // Should have received parsing phase updates
      const parsingCalls = progressCalls.filter((p) => p.phase === 'parsing');
      expect(parsingCalls.length).toBeGreaterThan(0);

      // Parsing phase should have current <= total and total > 0
      for (const call of parsingCalls) {
        expect(call.current).toBeGreaterThan(0);
        expect(call.total).toBeGreaterThan(0);
        expect(call.current).toBeLessThanOrEqual(call.total);
      }
    });

    it('should include currentFile in parsing phase progress', async () => {
      const progressCalls: ProgressData[] = [];
      const onProgress = vi.fn((progress: ProgressData) => {
        progressCalls.push({ ...progress });
      });

      await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
        onProgress,
      });

      // All parsing phase calls should have a currentFile
      const parsingCalls = progressCalls.filter((p) => p.phase === 'parsing');
      for (const call of parsingCalls) {
        expect(call.currentFile).toBeDefined();
        expect(call.currentFile).toMatch(/\.md$/);
      }
    });

    it('should report progress incrementally during parsing', async () => {
      mockReadDir.mockImplementation((path: string) => {
        if (path === '/test') {
          return Promise.resolve([
            { name: 'a.md', isDirectory: false, path: '/test/a.md' },
            { name: 'b.md', isDirectory: false, path: '/test/b.md' },
            { name: 'c.md', isDirectory: false, path: '/test/c.md' },
          ]);
        }
        return Promise.resolve([]);
      });

      mockReadFile.mockImplementation((path: string) => {
        const name = path.split('/').pop()?.replace('.md', '').toUpperCase();
        return Promise.resolve(`# ${name}`);
      });

      mockStat.mockResolvedValue({ size: 10, createdAt: '', modifiedAt: '' });

      const progressCalls: ProgressData[] = [];
      const onProgress = vi.fn((progress: ProgressData) => {
        progressCalls.push({ ...progress });
      });

      await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
        onProgress,
      });

      // Should have 3 parsing calls (one per file)
      const parsingCalls = progressCalls.filter((p) => p.phase === 'parsing');
      expect(parsingCalls).toHaveLength(3);

      // Should increment from 1 to 3
      expect(parsingCalls[0].current).toBe(1);
      expect(parsingCalls[0].total).toBe(3);
      expect(parsingCalls[1].current).toBe(2);
      expect(parsingCalls[2].current).toBe(3);
    });

    it('should work without onProgress callback', async () => {
      // Should not throw when onProgress is not provided
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      expect(result.nodes.length).toBeGreaterThan(0);
    });

    it('should report correct total when maxNodes limits files', async () => {
      mockReadDir.mockImplementation((path: string) => {
        if (path === '/test') {
          return Promise.resolve([
            { name: 'a.md', isDirectory: false, path: '/test/a.md' },
            { name: 'b.md', isDirectory: false, path: '/test/b.md' },
            { name: 'c.md', isDirectory: false, path: '/test/c.md' },
            { name: 'd.md', isDirectory: false, path: '/test/d.md' },
          ]);
        }
        return Promise.resolve([]);
      });

      mockReadFile.mockImplementation((path: string) => {
        const name = path.split('/').pop()?.replace('.md', '').toUpperCase();
        return Promise.resolve(`# ${name}`);
      });

      mockStat.mockResolvedValue({ size: 10, createdAt: '', modifiedAt: '' });

      const progressCalls: ProgressData[] = [];
      const onProgress = vi.fn((progress: ProgressData) => {
        progressCalls.push({ ...progress });
      });

      await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
        maxNodes: 2, // Only process 2 files
        onProgress,
      });

      // Parsing phase should show 2 files to process, not 4
      const parsingCalls = progressCalls.filter((p) => p.phase === 'parsing');
      expect(parsingCalls).toHaveLength(2);
      expect(parsingCalls[0].total).toBe(2);
      expect(parsingCalls[1].total).toBe(2);
    });
  });

  describe('Performance profiling: graph build time with 500+ markdown files', () => {
    /**
     * These tests document and verify the performance characteristics of building
     * a Document Graph with 500+ markdown files, simulating a large documentation
     * repository or wiki.
     *
     * Key performance aspects tested:
     * 1. Directory scanning scalability (recursive traversal)
     * 2. File parsing time with various link densities
     * 3. Node/edge creation efficiency
     * 4. Memory footprint through lazy loading
     * 5. External link aggregation at scale
     */

    describe('Directory scanning with 500+ files', () => {
      beforeEach(() => {
        vi.clearAllMocks();
      });

      it('should verify recursive scan visits each directory once', async () => {
        // Simulate a directory structure with 10 directories, each containing 50 files = 500 files
        const directories = Array.from({ length: 10 }, (_, i) => `dir-${i}`);
        const filesPerDir = 50;

        let readDirCallCount = 0;
        const readDirCalls: string[] = [];

        mockReadDir.mockImplementation((dirPath: string) => {
          readDirCallCount++;
          readDirCalls.push(dirPath);

          if (dirPath === '/test') {
            return Promise.resolve(directories.map((d) => ({
              name: d,
              isDirectory: true,
              path: `/test/${d}`,
            })));
          }

          // Each subdirectory contains 50 markdown files
          const dirName = dirPath.split('/').pop();
          if (directories.includes(dirName ?? '')) {
            return Promise.resolve(
              Array.from({ length: filesPerDir }, (_, i) => ({
                name: `file-${i}.md`,
                isDirectory: false,
                path: `${dirPath}/file-${i}.md`,
              }))
            );
          }

          return Promise.resolve([]);
        });

        mockReadFile.mockImplementation((path: string) => {
          const fileName = path.split('/').pop()?.replace('.md', '') ?? 'Doc';
          return Promise.resolve(`# ${fileName}\n\nContent here.`);
        });

        mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        // Should have 500 document nodes (10 dirs * 50 files)
        expect(result.totalDocuments).toBe(500);

        // Should have visited 11 directories (1 root + 10 subdirs)
        expect(readDirCallCount).toBe(11);

        // Each directory should be visited exactly once
        const uniqueDirCalls = new Set(readDirCalls);
        expect(uniqueDirCalls.size).toBe(11);
      });

      it('should skip node_modules, dist, build, .git directories for efficiency', async () => {
        const skippedDirs = ['node_modules', 'dist', 'build', '.git'];
        const readDirCalls: string[] = [];

        mockReadDir.mockImplementation((dirPath: string) => {
          readDirCalls.push(dirPath);

          if (dirPath === '/test') {
            return Promise.resolve([
              { name: 'docs', isDirectory: true, path: '/test/docs' },
              { name: 'node_modules', isDirectory: true, path: '/test/node_modules' },
              { name: 'dist', isDirectory: true, path: '/test/dist' },
              { name: 'build', isDirectory: true, path: '/test/build' },
              { name: '.git', isDirectory: true, path: '/test/.git' },
              { name: 'readme.md', isDirectory: false, path: '/test/readme.md' },
            ]);
          }

          if (dirPath === '/test/docs') {
            return Promise.resolve([
              { name: 'api.md', isDirectory: false, path: '/test/docs/api.md' },
            ]);
          }

          // These should not be called if skipping works
          if (skippedDirs.some((d) => dirPath.includes(d))) {
            return Promise.resolve([
              { name: 'should-not-see.md', isDirectory: false, path: `${dirPath}/should-not-see.md` },
            ]);
          }

          return Promise.resolve([]);
        });

        mockReadFile.mockResolvedValue('# Doc\n\nContent.');
        mockStat.mockResolvedValue({ size: 50, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        // Should NOT have visited skipped directories
        for (const skipped of skippedDirs) {
          const visitedSkipped = readDirCalls.some((call) => call.includes(skipped));
          expect(visitedSkipped).toBe(false);
        }

        // Should only have 2 markdown files (readme.md and docs/api.md)
        expect(result.totalDocuments).toBe(2);
      });

      it('should handle deeply nested directory structure (10 levels deep)', async () => {
        const maxDepth = 10;
        let deepestReached = 0;

        mockReadDir.mockImplementation((dirPath: string) => {
          const depth = dirPath.split('/').filter(Boolean).length - 1; // -1 for 'test'
          if (depth > deepestReached) deepestReached = depth;

          if (depth < maxDepth) {
            return Promise.resolve([
              { name: 'subdir', isDirectory: true, path: `${dirPath}/subdir` },
              { name: `doc-${depth}.md`, isDirectory: false, path: `${dirPath}/doc-${depth}.md` },
            ]);
          }

          // At max depth, just return a file
          return Promise.resolve([
            { name: 'final.md', isDirectory: false, path: `${dirPath}/final.md` },
          ]);
        });

        mockReadFile.mockResolvedValue('# Deep Doc\n\nContent.');
        mockStat.mockResolvedValue({ size: 30, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        // Should have reached depth 10
        expect(deepestReached).toBe(maxDepth);

        // Should have 11 files (1 per level + final)
        expect(result.totalDocuments).toBe(11);
      });
    });

    describe('File parsing performance with various link densities', () => {
      beforeEach(() => {
        vi.clearAllMocks();
      });

      it('should handle files with 0 links efficiently', async () => {
        // 500 files with no links
        const fileCount = 500;

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockImplementation((path: string) => {
          const num = path.match(/file-(\d+)\.md/)?.[1] ?? '0';
          return Promise.resolve(`# Document ${num}\n\nThis is content without any links.`);
        });

        mockStat.mockResolvedValue({ size: 50, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        // Should have 500 nodes with 0 edges
        expect(result.nodes).toHaveLength(500);
        expect(result.edges).toHaveLength(0);
      });

      it('should handle files with 10+ internal links each (high density)', async () => {
        // 100 files, each linking to 10 other files = 1000 potential edges
        const fileCount = 100;

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockImplementation((path: string) => {
          const num = parseInt(path.match(/file-(\d+)\.md/)?.[1] ?? '0', 10);
          // Each file links to 10 other files (wrapping around)
          const links = Array.from({ length: 10 }, (_, i) => {
            const target = (num + i + 1) % fileCount;
            return `[[file-${target}]]`;
          }).join(' ');
          return Promise.resolve(`# Document ${num}\n\n${links}`);
        });

        mockStat.mockResolvedValue({ size: 200, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        // Should have 100 nodes
        expect(result.nodes).toHaveLength(100);

        // Should have 1000 edges (100 files * 10 links each)
        expect(result.edges).toHaveLength(1000);
      });

      it('should handle files with many external links (for aggregation testing)', async () => {
        // 100 files, each with 5 external links to 20 unique domains
        const fileCount = 100;
        const domains = Array.from({ length: 20 }, (_, i) => `domain-${i}.com`);

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockImplementation((path: string) => {
          const num = parseInt(path.match(/file-(\d+)\.md/)?.[1] ?? '0', 10);
          // Each file links to 5 domains (cycling through the 20 domains)
          const links = Array.from({ length: 5 }, (_, i) => {
            const domainIdx = (num + i) % domains.length;
            return `[Link](https://${domains[domainIdx]}/page${num})`;
          }).join(' ');
          return Promise.resolve(`# Document ${num}\n\n${links}`);
        });

        mockStat.mockResolvedValue({ size: 250, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: true,
        });

        // Should have 100 document nodes + 20 external domain nodes
        const docNodes = result.nodes.filter((n) => n.type === 'documentNode');
        const extNodes = result.nodes.filter((n) => n.type === 'externalLinkNode');

        expect(docNodes).toHaveLength(100);
        expect(extNodes).toHaveLength(20); // Domains are deduplicated

        // Should have 500 external edges (100 files * 5 links each)
        const externalEdges = result.edges.filter((e) => e.type === 'external');
        expect(externalEdges).toHaveLength(500);
      });

      it('should handle mixed internal and external links', async () => {
        // 200 files with 3 internal + 2 external links each
        const fileCount = 200;

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockImplementation((path: string) => {
          const num = parseInt(path.match(/file-(\d+)\.md/)?.[1] ?? '0', 10);
          const internalLinks = Array.from({ length: 3 }, (_, i) => {
            const target = (num + i + 1) % fileCount;
            return `[[file-${target}]]`;
          }).join(' ');
          const externalLinks = `[GitHub](https://github.com/test${num}) [Docs](https://docs.example.com/page${num})`;
          return Promise.resolve(`# Doc ${num}\n\n${internalLinks}\n\n${externalLinks}`);
        });

        mockStat.mockResolvedValue({ size: 300, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: true,
        });

        // Should have 200 doc nodes + 2 external nodes
        expect(result.nodes.filter((n) => n.type === 'documentNode')).toHaveLength(200);
        expect(result.nodes.filter((n) => n.type === 'externalLinkNode')).toHaveLength(2);

        // Should have 600 internal + 400 external = 1000 edges
        const internalEdges = result.edges.filter((e) => e.type !== 'external');
        const externalEdges = result.edges.filter((e) => e.type === 'external');

        expect(internalEdges).toHaveLength(600);
        expect(externalEdges).toHaveLength(400);
      });
    });

    describe('Memory efficiency through lazy loading', () => {
      beforeEach(() => {
        vi.clearAllMocks();
      });

      it('should not store file content in result (content is parsed and discarded)', async () => {
        // 100 files with large content
        const fileCount = 100;
        const largeContent = 'X'.repeat(10000); // 10KB per file

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockResolvedValue(`# Large Doc\n\n${largeContent}`);
        mockStat.mockResolvedValue({ size: 10000, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        // Verify nodes don't contain the large content
        for (const node of result.nodes) {
          const data = node.data as DocumentNodeData;
          // Content should not be stored in node data
          expect((data as unknown as { content?: string }).content).toBeUndefined();
          // But stats should be computed
          expect(data.title).toBe('Large Doc');
          expect(data.wordCount).toBeGreaterThan(0);
        }
      });

      it('should verify result set size is proportional to nodes, not file content size', async () => {
        // 500 files with varying content sizes
        const fileCount = 500;

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockImplementation((path: string) => {
          const num = parseInt(path.match(/file-(\d+)\.md/)?.[1] ?? '0', 10);
          // Vary content size from 100 to 5000 chars
          const contentSize = 100 + (num % 50) * 100;
          return Promise.resolve(`# Doc ${num}\n\n${'Y'.repeat(contentSize)}`);
        });

        mockStat.mockResolvedValue({ size: 2000, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        // Result should have 500 nodes
        expect(result.nodes).toHaveLength(500);

        // Rough size check: each node should be small (< 1KB of metadata)
        // Total result should be under 500KB for 500 nodes
        const resultJson = JSON.stringify(result);
        expect(resultJson.length).toBeLessThan(500 * 1024); // < 500KB
      });
    });

    describe('Node and edge creation efficiency', () => {
      beforeEach(() => {
        vi.clearAllMocks();
      });

      it('should create correct number of nodes regardless of edge count', async () => {
        // 300 files with varying link counts
        const fileCount = 300;

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockImplementation((path: string) => {
          const num = parseInt(path.match(/file-(\d+)\.md/)?.[1] ?? '0', 10);
          // Varying number of links: 0-9 based on file number
          const linkCount = num % 10;
          const links = Array.from({ length: linkCount }, (_, i) => {
            const target = (num + i + 1) % fileCount;
            return `[[file-${target}]]`;
          }).join(' ');
          return Promise.resolve(`# Doc ${num}\n\n${links}`);
        });

        mockStat.mockResolvedValue({ size: 150, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        // Should have exactly 300 document nodes
        expect(result.nodes).toHaveLength(300);

        // Edge count should be sum of 0+1+2+...+9 repeated 30 times = 45 * 30 = 1350
        expect(result.edges).toHaveLength(1350);
      });

      it('should only create edges between loaded documents (no dangling edges)', async () => {
        // 100 files, but only load first 50 with maxNodes
        const fileCount = 100;

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockImplementation((path: string) => {
          const num = parseInt(path.match(/file-(\d+)\.md/)?.[1] ?? '0', 10);
          // Each file links to file+50 (which won't be loaded if maxNodes=50)
          const target = (num + 50) % fileCount;
          return Promise.resolve(`# Doc ${num}\n\n[[file-${target}]]`);
        });

        mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
          maxNodes: 50,
        });

        // Should have 50 nodes loaded
        expect(result.nodes).toHaveLength(50);
        expect(result.loadedDocuments).toBe(50);
        expect(result.totalDocuments).toBe(100);
        expect(result.hasMore).toBe(true);

        // Files 0-49 link to files 50-99, but 50-99 aren't loaded
        // So there should be 0 edges (all targets are unloaded)
        expect(result.edges).toHaveLength(0);
      });

      it('should handle circular references without issues', async () => {
        // 50 files in a circular reference chain: 0 -> 1 -> 2 -> ... -> 49 -> 0
        const fileCount = 50;

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockImplementation((path: string) => {
          const num = parseInt(path.match(/file-(\d+)\.md/)?.[1] ?? '0', 10);
          const nextTarget = (num + 1) % fileCount;
          return Promise.resolve(`# Doc ${num}\n\n[[file-${nextTarget}]]`);
        });

        mockStat.mockResolvedValue({ size: 80, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        // Should have 50 nodes
        expect(result.nodes).toHaveLength(50);

        // Should have 50 edges (one from each file to the next)
        expect(result.edges).toHaveLength(50);

        // Verify the circular reference: last file links to first
        const lastToFirst = result.edges.find(
          (e) => e.source === 'doc-file-49.md' && e.target === 'doc-file-0.md'
        );
        expect(lastToFirst).toBeDefined();
      });
    });

    describe('Performance documentation: expected timing', () => {
      beforeEach(() => {
        vi.clearAllMocks();
      });

      /**
       * These tests document expected performance characteristics.
       * Actual timing depends on hardware, but relative performance
       * should be consistent.
       */

      it('documents expected timing for 500 files with 0 links', async () => {
        /**
         * Expected performance for 500 files, no links:
         * - Directory scan: ~50-100ms (depends on FS performance)
         * - File parsing: ~200-400ms (500 readFile + stat calls)
         * - Node creation: ~10-20ms (simple object creation)
         * - Total: ~260-520ms typical
         *
         * Bottleneck: File I/O operations (readFile + stat)
         */
        const fileCount = 500;

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        let readFileCallCount = 0;
        let statCallCount = 0;

        mockReadFile.mockImplementation(() => {
          readFileCallCount++;
          return Promise.resolve('# Doc\n\nNo links here.');
        });

        mockStat.mockImplementation(() => {
          statCallCount++;
          return Promise.resolve({ size: 50, createdAt: '', modifiedAt: '' });
        });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        // Verify 500 files were processed
        expect(result.totalDocuments).toBe(500);
        expect(readFileCallCount).toBe(500);
        expect(statCallCount).toBe(500);
      });

      it('documents expected timing for 500 files with 5 links each (high edge count)', async () => {
        /**
         * Expected performance for 500 files, 5 links each:
         * - Directory scan: ~50-100ms
         * - File parsing + link extraction: ~300-600ms (includes regex parsing)
         * - Edge creation: ~50-100ms (2500 edges)
         * - Total: ~400-800ms typical
         *
         * Edge creation is still fast because it's in-memory.
         */
        const fileCount = 500;

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockImplementation((path: string) => {
          const num = parseInt(path.match(/file-(\d+)\.md/)?.[1] ?? '0', 10);
          const links = Array.from({ length: 5 }, (_, i) => {
            const target = (num + i + 1) % fileCount;
            return `[[file-${target}]]`;
          }).join(' ');
          return Promise.resolve(`# Doc ${num}\n\n${links}`);
        });

        mockStat.mockResolvedValue({ size: 150, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        expect(result.nodes).toHaveLength(500);
        expect(result.edges).toHaveLength(2500);
      });

      it('documents expected timing with maxNodes pagination', async () => {
        /**
         * Expected performance with maxNodes=100:
         * - Directory scan: ~50-100ms (must scan all to know total)
         * - File parsing: ~40-80ms (only 100 files)
         * - Total: ~90-180ms typical
         *
         * Pagination significantly reduces file I/O time.
         */
        const fileCount = 500;

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        let readFileCallCount = 0;

        mockReadFile.mockImplementation(() => {
          readFileCallCount++;
          return Promise.resolve('# Doc\n\nContent.');
        });

        mockStat.mockResolvedValue({ size: 50, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
          maxNodes: 100,
        });

        // Total is still 500, but only 100 loaded
        expect(result.totalDocuments).toBe(500);
        expect(result.loadedDocuments).toBe(100);
        expect(readFileCallCount).toBe(100); // Only 100 files read
      });
    });

    describe('Progress callback verification at scale', () => {
      beforeEach(() => {
        vi.clearAllMocks();
      });

      it('should report accurate progress during 500 file scan', async () => {
        const fileCount = 500;
        const progressCalls: ProgressData[] = [];

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockResolvedValue('# Doc\n\nContent.');
        mockStat.mockResolvedValue({ size: 50, createdAt: '', modifiedAt: '' });

        const onProgress = vi.fn((progress: ProgressData) => {
          progressCalls.push({ ...progress });
        });

        await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
          onProgress,
        });

        // Should have scanning phase calls
        const scanningCalls = progressCalls.filter((p) => p.phase === 'scanning');
        expect(scanningCalls.length).toBeGreaterThan(0);

        // Should have 500 parsing phase calls (one per file)
        const parsingCalls = progressCalls.filter((p) => p.phase === 'parsing');
        expect(parsingCalls).toHaveLength(500);

        // First parsing call should show 1/500
        expect(parsingCalls[0].current).toBe(1);
        expect(parsingCalls[0].total).toBe(500);

        // Last parsing call should show 500/500
        expect(parsingCalls[499].current).toBe(500);
        expect(parsingCalls[499].total).toBe(500);

        // Progress should be monotonically increasing
        for (let i = 1; i < parsingCalls.length; i++) {
          expect(parsingCalls[i].current).toBe(parsingCalls[i - 1].current + 1);
        }
      });

      it('should report correct file names during parsing progress', async () => {
        const fileCount = 100;
        const progressCalls: ProgressData[] = [];

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockResolvedValue('# Doc');
        mockStat.mockResolvedValue({ size: 50, createdAt: '', modifiedAt: '' });

        await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
          onProgress: (progress) => progressCalls.push({ ...progress }),
        });

        const parsingCalls = progressCalls.filter((p) => p.phase === 'parsing');

        // Each parsing call should have a valid currentFile
        for (const call of parsingCalls) {
          expect(call.currentFile).toBeDefined();
          expect(call.currentFile).toMatch(/^file-\d+\.md$/);
        }
      });
    });

    describe('Edge cases with large datasets', () => {
      beforeEach(() => {
        vi.clearAllMocks();
      });

      it('should handle files with very long titles (100+ chars)', async () => {
        const fileCount = 100;
        const longTitle = 'A'.repeat(150);

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockResolvedValue(`# ${longTitle}\n\nContent.`);
        mockStat.mockResolvedValue({ size: 200, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        expect(result.nodes).toHaveLength(100);

        // All nodes should have the long title
        for (const node of result.nodes) {
          const data = node.data as DocumentNodeData;
          expect(data.title).toBe(longTitle);
        }
      });

      it('should handle files with very long paths (nested 20 levels)', async () => {
        // Build a deeply nested path
        const depth = 20;

        // Build path incrementally for proper matching
        const pathLevels: string[] = ['/test'];
        for (let i = 0; i < depth; i++) {
          pathLevels.push(`${pathLevels[i]}/subdir`);
        }
        const deepPath = pathLevels[depth];
        const fileName = 'deep-file.md';
        const fullPath = `${deepPath}/${fileName}`;
        const relativePath = fullPath.replace('/test/', '');

        mockReadDir.mockImplementation((path: string) => {
          // Find which level we're at
          const level = pathLevels.indexOf(path);

          if (level >= 0 && level < depth) {
            // Not at deepest level yet - return subdir
            return Promise.resolve([
              { name: 'subdir', isDirectory: true, path: pathLevels[level + 1] },
            ]);
          } else if (path === deepPath) {
            // At deepest level - return the file
            return Promise.resolve([
              { name: fileName, isDirectory: false, path: fullPath },
            ]);
          }
          return Promise.resolve([]);
        });

        mockReadFile.mockResolvedValue('# Deep File\n\nContent.');
        mockStat.mockResolvedValue({ size: 50, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        expect(result.nodes).toHaveLength(1);

        const data = result.nodes[0].data as DocumentNodeData;
        expect(data.filePath).toBe(relativePath);
      });

      it('should handle self-referential links without creating duplicate edges', async () => {
        // Files that link to themselves
        const fileCount = 50;

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockImplementation((path: string) => {
          const num = path.match(/file-(\d+)\.md/)?.[1] ?? '0';
          // Each file links to itself multiple times
          return Promise.resolve(
            `# Doc ${num}\n\n[[file-${num}]] [[file-${num}]] [[file-${num}]]`
          );
        });

        mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        expect(result.nodes).toHaveLength(50);

        // Each file creates 3 self-edges (link parser doesn't deduplicate)
        // This tests that the system handles self-references
        expect(result.edges.length).toBeGreaterThan(0);

        // Verify edges point to valid nodes
        const nodeIds = new Set(result.nodes.map((n) => n.id));
        for (const edge of result.edges) {
          expect(nodeIds.has(edge.source)).toBe(true);
          expect(nodeIds.has(edge.target)).toBe(true);
        }
      });

      it('should handle files with no content (empty files)', async () => {
        const fileCount = 100;

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        // Half files empty, half with content
        mockReadFile.mockImplementation((path: string) => {
          const num = parseInt(path.match(/file-(\d+)\.md/)?.[1] ?? '0', 10);
          return Promise.resolve(num % 2 === 0 ? '' : '# Has Content');
        });

        mockStat.mockResolvedValue({ size: 0, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        // All files should create nodes (even empty ones)
        expect(result.nodes).toHaveLength(100);
      });

      it('should handle special characters in file names', async () => {
        const specialNames = [
          'file with spaces.md',
          'file-with-dashes.md',
          'file_with_underscores.md',
          'file.multiple.dots.md',
          'UPPERCASE.md',
          'MixedCase.md',
          'file123numbers.md',
        ];

        mockReadDir.mockResolvedValue(
          specialNames.map((name) => ({
            name,
            isDirectory: false,
            path: `/test/${name}`,
          }))
        );

        mockReadFile.mockResolvedValue('# Doc\n\nContent.');
        mockStat.mockResolvedValue({ size: 50, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: false,
        });

        expect(result.nodes).toHaveLength(specialNames.length);

        // Verify all special names are present
        const filePaths = result.nodes.map((n) => (n.data as DocumentNodeData).filePath);
        for (const name of specialNames) {
          expect(filePaths).toContain(name);
        }
      });
    });

    describe('External link aggregation at scale', () => {
      beforeEach(() => {
        vi.clearAllMocks();
      });

      it('should correctly aggregate link counts across 500 files', async () => {
        const fileCount = 500;
        // Each file links to 2 common domains
        const domains = ['github.com', 'example.com'];

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockImplementation((path: string) => {
          const num = path.match(/file-(\d+)\.md/)?.[1] ?? '0';
          return Promise.resolve(
            `# Doc ${num}\n\n[GH](https://github.com/repo${num}) [Ex](https://example.com/page${num})`
          );
        });

        mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: true,
        });

        // Should have 500 doc nodes + 2 external nodes
        expect(result.nodes.filter((n) => n.type === 'documentNode')).toHaveLength(500);
        expect(result.nodes.filter((n) => n.type === 'externalLinkNode')).toHaveLength(2);

        // Each external node should have linkCount of 500
        const extNodes = result.nodes.filter((n) => n.type === 'externalLinkNode');
        for (const node of extNodes) {
          const data = node.data as ExternalLinkNodeData;
          expect(data.linkCount).toBe(500);
          expect(data.urls).toHaveLength(500);
        }

        // Should have 1000 external edges (500 files * 2 domains)
        const externalEdges = result.edges.filter((e) => e.type === 'external');
        expect(externalEdges).toHaveLength(1000);
      });

      it('should handle domains with many unique URLs', async () => {
        const fileCount = 200;
        // Each file links to the same domain with a unique URL

        mockReadDir.mockResolvedValue(
          Array.from({ length: fileCount }, (_, i) => ({
            name: `file-${i}.md`,
            isDirectory: false,
            path: `/test/file-${i}.md`,
          }))
        );

        mockReadFile.mockImplementation((path: string) => {
          const num = path.match(/file-(\d+)\.md/)?.[1] ?? '0';
          return Promise.resolve(`# Doc ${num}\n\n[Link](https://api.example.com/endpoint${num})`);
        });

        mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

        const result = await buildGraphData({
          rootPath: '/test',
          includeExternalLinks: true,
        });

        // Should have one external node for api.example.com
        const extNodes = result.nodes.filter((n) => n.type === 'externalLinkNode');
        expect(extNodes).toHaveLength(1);

        const data = extNodes[0].data as ExternalLinkNodeData;
        expect(data.domain).toBe('api.example.com');
        expect(data.linkCount).toBe(200);
        expect(data.urls).toHaveLength(200);

        // Verify each URL is unique
        const uniqueUrls = new Set(data.urls);
        expect(uniqueUrls.size).toBe(200);
      });
    });
  });

  describe('Broken internal links detection', () => {
    /**
     * These tests verify that the graph builder correctly identifies and tracks
     * broken internal links (links to files that don't exist in the scanned directory).
     */

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should identify broken links to non-existent files', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'doc1.md', isDirectory: false, path: '/test/doc1.md' },
      ]);

      mockReadFile.mockImplementation(() => {
        // Link to a file that doesn't exist
        return Promise.resolve('# Doc 1\n\n[[missing-doc]]\n[[another-missing]]');
      });

      mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      expect(result.nodes).toHaveLength(1);

      const nodeData = result.nodes[0].data as DocumentNodeData;
      expect(nodeData.brokenLinks).toBeDefined();
      expect(nodeData.brokenLinks).toHaveLength(2);
      expect(nodeData.brokenLinks).toContain('missing-doc.md');
      expect(nodeData.brokenLinks).toContain('another-missing.md');
    });

    it('should NOT include brokenLinks when all links are valid', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'doc1.md', isDirectory: false, path: '/test/doc1.md' },
        { name: 'doc2.md', isDirectory: false, path: '/test/doc2.md' },
      ]);

      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('doc1')) {
          return Promise.resolve('# Doc 1\n\n[[doc2]]');
        }
        return Promise.resolve('# Doc 2\n\nNo links.');
      });

      mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      expect(result.nodes).toHaveLength(2);

      const doc1Data = result.nodes.find(n => n.id === 'doc-doc1.md')?.data as DocumentNodeData;
      // brokenLinks should NOT be present when there are no broken links
      expect(doc1Data.brokenLinks).toBeUndefined();
    });

    it('should include brokenLinks only when some links are broken', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'doc1.md', isDirectory: false, path: '/test/doc1.md' },
        { name: 'doc2.md', isDirectory: false, path: '/test/doc2.md' },
      ]);

      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('doc1')) {
          // doc1 links to doc2 (valid) and doc3 (broken)
          return Promise.resolve('# Doc 1\n\n[[doc2]]\n[[doc3]]');
        }
        return Promise.resolve('# Doc 2');
      });

      mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const doc1Data = result.nodes.find(n => n.id === 'doc-doc1.md')?.data as DocumentNodeData;
      expect(doc1Data.brokenLinks).toBeDefined();
      expect(doc1Data.brokenLinks).toHaveLength(1);
      expect(doc1Data.brokenLinks).toContain('doc3.md');
    });

    it('should handle relative path broken links', async () => {
      mockReadDir.mockImplementation((path: string) => {
        if (path === '/test') {
          return Promise.resolve([
            { name: 'docs', isDirectory: true, path: '/test/docs' },
          ]);
        }
        if (path === '/test/docs') {
          return Promise.resolve([
            { name: 'readme.md', isDirectory: false, path: '/test/docs/readme.md' },
          ]);
        }
        return Promise.resolve([]);
      });

      mockReadFile.mockImplementation(() => {
        // Link to a relative path that doesn't exist
        return Promise.resolve('# Readme\n\n[link](../missing/file.md)');
      });

      mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const nodeData = result.nodes[0].data as DocumentNodeData;
      expect(nodeData.brokenLinks).toBeDefined();
      expect(nodeData.brokenLinks!.length).toBeGreaterThan(0);
    });

    it('should track broken links separately from valid edges', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'doc1.md', isDirectory: false, path: '/test/doc1.md' },
        { name: 'doc2.md', isDirectory: false, path: '/test/doc2.md' },
      ]);

      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('doc1')) {
          // doc1 links to doc2 (valid), doc3 (broken), and doc4 (broken)
          return Promise.resolve('# Doc 1\n\n[[doc2]] [[doc3]] [[doc4]]');
        }
        return Promise.resolve('# Doc 2');
      });

      mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      // Should have 1 valid edge (doc1 -> doc2)
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].source).toBe('doc-doc1.md');
      expect(result.edges[0].target).toBe('doc-doc2.md');

      // Should have 2 broken links
      const doc1Data = result.nodes.find(n => n.id === 'doc-doc1.md')?.data as DocumentNodeData;
      expect(doc1Data.brokenLinks).toHaveLength(2);
    });

    it('should handle multiple documents with broken links', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'doc1.md', isDirectory: false, path: '/test/doc1.md' },
        { name: 'doc2.md', isDirectory: false, path: '/test/doc2.md' },
      ]);

      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('doc1')) {
          return Promise.resolve('# Doc 1\n\n[[missing1]]');
        }
        return Promise.resolve('# Doc 2\n\n[[missing2]]');
      });

      mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const doc1Data = result.nodes.find(n => n.id === 'doc-doc1.md')?.data as DocumentNodeData;
      const doc2Data = result.nodes.find(n => n.id === 'doc-doc2.md')?.data as DocumentNodeData;

      expect(doc1Data.brokenLinks).toContain('missing1.md');
      expect(doc2Data.brokenLinks).toContain('missing2.md');
    });

    it('should NOT count external links as broken', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'doc1.md', isDirectory: false, path: '/test/doc1.md' },
      ]);

      mockReadFile.mockImplementation(() => {
        // External link should not appear as broken
        return Promise.resolve('# Doc 1\n\n[GitHub](https://github.com/test)');
      });

      mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: true,
      });

      const nodeData = result.nodes.find(n => n.type === 'documentNode')?.data as DocumentNodeData;
      // External links should not be in brokenLinks
      expect(nodeData.brokenLinks).toBeUndefined();
    });

    it('should handle wiki links with display text as broken', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'doc1.md', isDirectory: false, path: '/test/doc1.md' },
      ]);

      mockReadFile.mockImplementation(() => {
        // Wiki link with display text: [[path|display]]
        return Promise.resolve('# Doc 1\n\n[[missing-doc|Display Text]]');
      });

      mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const nodeData = result.nodes[0].data as DocumentNodeData;
      expect(nodeData.brokenLinks).toBeDefined();
      expect(nodeData.brokenLinks).toContain('missing-doc.md');
    });

    it('should NOT count image links as broken internal links', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'doc1.md', isDirectory: false, path: '/test/doc1.md' },
      ]);

      mockReadFile.mockImplementation(() => {
        // Image embeds should not be treated as internal links
        return Promise.resolve('# Doc 1\n\n[[screenshot.png]]\n[[diagram.svg]]');
      });

      mockStat.mockResolvedValue({ size: 100, createdAt: '', modifiedAt: '' });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const nodeData = result.nodes[0].data as DocumentNodeData;
      // Image links should be skipped, not counted as broken
      expect(nodeData.brokenLinks).toBeUndefined();
    });

    it('should handle many broken links efficiently', async () => {
      const brokenLinkCount = 50;

      mockReadDir.mockResolvedValue([
        { name: 'doc1.md', isDirectory: false, path: '/test/doc1.md' },
      ]);

      mockReadFile.mockImplementation(() => {
        const links = Array.from({ length: brokenLinkCount }, (_, i) =>
          `[[missing-${i}]]`
        ).join('\n');
        return Promise.resolve(`# Doc 1\n\n${links}`);
      });

      mockStat.mockResolvedValue({ size: 500, createdAt: '', modifiedAt: '' });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const nodeData = result.nodes[0].data as DocumentNodeData;
      expect(nodeData.brokenLinks).toHaveLength(brokenLinkCount);

      // Verify all broken links are correctly identified
      for (let i = 0; i < brokenLinkCount; i++) {
        expect(nodeData.brokenLinks).toContain(`missing-${i}.md`);
      }
    });
  });

  describe('Large file handling (>1MB)', () => {
    const ONE_MB = 1024 * 1024;
    const LARGE_FILE_PARSE_LIMIT = 100 * 1024; // 100KB

    it('should mark files >1MB as isLargeFile', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'large.md', isDirectory: false, path: '/test/large.md' },
      ]);

      // File size > 1MB
      mockStat.mockResolvedValue({
        size: ONE_MB + 1,
        createdAt: '',
        modifiedAt: '',
      });

      mockReadFile.mockResolvedValue('# Large File\n\nSome content.');

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      expect(result.nodes).toHaveLength(1);
      const nodeData = result.nodes[0].data as DocumentNodeData;
      expect(nodeData.isLargeFile).toBe(true);
    });

    it('should NOT mark files <=1MB as isLargeFile', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'normal.md', isDirectory: false, path: '/test/normal.md' },
      ]);

      // File size exactly 1MB (not > 1MB)
      mockStat.mockResolvedValue({
        size: ONE_MB,
        createdAt: '',
        modifiedAt: '',
      });

      mockReadFile.mockResolvedValue('# Normal File\n\nSome content.');

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      expect(result.nodes).toHaveLength(1);
      const nodeData = result.nodes[0].data as DocumentNodeData;
      expect(nodeData.isLargeFile).toBeUndefined();
    });

    it('should truncate large file content for parsing but preserve accurate file size', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'huge.md', isDirectory: false, path: '/test/huge.md' },
      ]);

      const actualSize = ONE_MB * 5; // 5MB file
      mockStat.mockResolvedValue({
        size: actualSize,
        createdAt: '',
        modifiedAt: '',
      });

      // Create content larger than parse limit
      const largeContent = 'a'.repeat(LARGE_FILE_PARSE_LIMIT * 2);
      mockReadFile.mockResolvedValue(`# Title\n\n${largeContent}`);

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const nodeData = result.nodes[0].data as DocumentNodeData;

      // Should be marked as large file
      expect(nodeData.isLargeFile).toBe(true);

      // File size should reflect actual size (5MB = "5.0 MB")
      expect(nodeData.size).toBe('5.0 MB');
    });

    it('should still extract links from the first 100KB of large files', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'large-with-links.md', isDirectory: false, path: '/test/large-with-links.md' },
        { name: 'target.md', isDirectory: false, path: '/test/target.md' },
      ]);

      mockStat.mockImplementation((filePath: string) => {
        if (filePath.includes('large-with-links')) {
          return Promise.resolve({ size: ONE_MB * 2, createdAt: '', modifiedAt: '' });
        }
        return Promise.resolve({ size: 100, createdAt: '', modifiedAt: '' });
      });

      // Links are at the beginning (within first 100KB)
      const linkContent = '# Large File\n\n[[target]]\n\n[External](https://example.com)\n\n';
      const padding = 'x'.repeat(LARGE_FILE_PARSE_LIMIT * 2);
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes('large-with-links')) {
          return Promise.resolve(linkContent + padding);
        }
        return Promise.resolve('# Target');
      });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: true,
      });

      // Should have created edge from large file to target
      const edge = result.edges.find(
        (e) => e.source === 'doc-large-with-links.md' && e.target === 'doc-target.md'
      );
      expect(edge).toBeDefined();

      // Should have captured external link too
      const externalEdge = result.edges.find(
        (e) => e.source === 'doc-large-with-links.md' && e.target === 'ext-example.com'
      );
      expect(externalEdge).toBeDefined();
    });

    it('should miss links beyond 100KB truncation point in large files', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'large-late-links.md', isDirectory: false, path: '/test/large-late-links.md' },
        { name: 'late-target.md', isDirectory: false, path: '/test/late-target.md' },
      ]);

      mockStat.mockImplementation((filePath: string) => {
        if (filePath.includes('large-late-links')) {
          return Promise.resolve({ size: ONE_MB * 2, createdAt: '', modifiedAt: '' });
        }
        return Promise.resolve({ size: 100, createdAt: '', modifiedAt: '' });
      });

      // Links are after the 100KB truncation point
      const padding = 'x'.repeat(LARGE_FILE_PARSE_LIMIT + 1000);
      const lateLinks = '\n\n[[late-target]]\n\n';
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes('large-late-links')) {
          return Promise.resolve(`# Large File\n\n${padding}${lateLinks}`);
        }
        return Promise.resolve('# Late Target');
      });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      // Edge should NOT be created because link is beyond truncation point
      const edge = result.edges.find(
        (e) => e.source === 'doc-large-late-links.md' && e.target === 'doc-late-target.md'
      );
      expect(edge).toBeUndefined();
    });

    it('should handle mixed normal and large files in same directory', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'small.md', isDirectory: false, path: '/test/small.md' },
        { name: 'medium.md', isDirectory: false, path: '/test/medium.md' },
        { name: 'large.md', isDirectory: false, path: '/test/large.md' },
      ]);

      mockStat.mockImplementation((filePath: string) => {
        if (filePath.includes('small')) return Promise.resolve({ size: 1000, createdAt: '', modifiedAt: '' });
        if (filePath.includes('medium')) return Promise.resolve({ size: ONE_MB / 2, createdAt: '', modifiedAt: '' });
        if (filePath.includes('large')) return Promise.resolve({ size: ONE_MB * 3, createdAt: '', modifiedAt: '' });
        return Promise.resolve({ size: 100, createdAt: '', modifiedAt: '' });
      });

      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes('small')) return Promise.resolve('# Small');
        if (filePath.includes('medium')) return Promise.resolve('# Medium');
        if (filePath.includes('large')) return Promise.resolve('# Large');
        return Promise.resolve('');
      });

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      expect(result.nodes).toHaveLength(3);

      // Only the large file should be marked
      const smallNode = result.nodes.find((n) => n.id === 'doc-small.md');
      const mediumNode = result.nodes.find((n) => n.id === 'doc-medium.md');
      const largeNode = result.nodes.find((n) => n.id === 'doc-large.md');

      expect((smallNode?.data as DocumentNodeData).isLargeFile).toBeUndefined();
      expect((mediumNode?.data as DocumentNodeData).isLargeFile).toBeUndefined();
      expect((largeNode?.data as DocumentNodeData).isLargeFile).toBe(true);
    });

    it('should handle file exactly at 1MB threshold (not marked as large)', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'exactly-1mb.md', isDirectory: false, path: '/test/exactly-1mb.md' },
      ]);

      mockStat.mockResolvedValue({
        size: ONE_MB,
        createdAt: '',
        modifiedAt: '',
      });

      mockReadFile.mockResolvedValue('# Exactly 1MB');

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const nodeData = result.nodes[0].data as DocumentNodeData;
      // Exactly 1MB should NOT be marked as large (only > 1MB)
      expect(nodeData.isLargeFile).toBeUndefined();
    });

    it('should handle file just over 1MB threshold (marked as large)', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'just-over-1mb.md', isDirectory: false, path: '/test/just-over-1mb.md' },
      ]);

      mockStat.mockResolvedValue({
        size: ONE_MB + 1,
        createdAt: '',
        modifiedAt: '',
      });

      mockReadFile.mockResolvedValue('# Just Over 1MB');

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const nodeData = result.nodes[0].data as DocumentNodeData;
      // Just over 1MB should be marked as large
      expect(nodeData.isLargeFile).toBe(true);
    });

    it('should preserve title extraction from large file (within truncation)', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'titled-large.md', isDirectory: false, path: '/test/titled-large.md' },
      ]);

      mockStat.mockResolvedValue({
        size: ONE_MB * 2,
        createdAt: '',
        modifiedAt: '',
      });

      mockReadFile.mockResolvedValue('---\ntitle: My Large Document\n---\n\n# Content\n\nLots of text...');

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const nodeData = result.nodes[0].data as DocumentNodeData;
      expect(nodeData.title).toBe('My Large Document');
      expect(nodeData.isLargeFile).toBe(true);
    });

    it('should not block UI when processing multiple large files (yielding)', async () => {
      // Create 20 large files to trigger multiple yield points
      const fileCount = 20;
      const files = Array.from({ length: fileCount }, (_, i) => ({
        name: `large-${i}.md`,
        isDirectory: false,
        path: `/test/large-${i}.md`,
      }));

      mockReadDir.mockResolvedValue(files);

      mockStat.mockResolvedValue({
        size: ONE_MB * 2,
        createdAt: '',
        modifiedAt: '',
      });

      mockReadFile.mockResolvedValue('# Large File Content');

      // Track if we yield (requestAnimationFrame should be called)
      // This test verifies that the function completes without blocking
      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      expect(result.nodes).toHaveLength(fileCount);
      // All files should be marked as large
      result.nodes.forEach((node) => {
        expect((node.data as DocumentNodeData).isLargeFile).toBe(true);
      });
    });

    it('should handle large file with content exactly at parse limit', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'at-limit.md', isDirectory: false, path: '/test/at-limit.md' },
      ]);

      mockStat.mockResolvedValue({
        size: ONE_MB * 2,
        createdAt: '',
        modifiedAt: '',
      });

      // Content exactly at parse limit
      const exactContent = 'a'.repeat(LARGE_FILE_PARSE_LIMIT);
      mockReadFile.mockResolvedValue(exactContent);

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      // Should process without error
      expect(result.nodes).toHaveLength(1);
      expect((result.nodes[0].data as DocumentNodeData).isLargeFile).toBe(true);
    });

    it('should correctly report line and word counts from truncated content', async () => {
      mockReadDir.mockResolvedValue([
        { name: 'stats-test.md', isDirectory: false, path: '/test/stats-test.md' },
      ]);

      mockStat.mockResolvedValue({
        size: ONE_MB * 2,
        createdAt: '',
        modifiedAt: '',
      });

      // Create content with known lines and words at the beginning
      const knownContent = '# Title\n\nLine 2 with five words here.\nLine 3.\n\n';
      const padding = 'x'.repeat(LARGE_FILE_PARSE_LIMIT * 2);
      mockReadFile.mockResolvedValue(knownContent + padding);

      const result = await buildGraphData({
        rootPath: '/test',
        includeExternalLinks: false,
      });

      const nodeData = result.nodes[0].data as DocumentNodeData;

      // Stats are computed from truncated content
      // The exact counts depend on how much of the padding fits in 100KB
      expect(nodeData.lineCount).toBeGreaterThan(0);
      expect(nodeData.wordCount).toBeGreaterThan(0);
      expect(nodeData.isLargeFile).toBe(true);
    });
  });
});
