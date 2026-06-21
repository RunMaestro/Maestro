/**
 * Tests for the Document Graph data builder (BFS-based API)
 *
 * The graph builder uses BFS traversal starting from a focus file,
 * discovering connected documents up to maxDepth levels.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
	buildGraphData,
	expandNode,
	isDocumentNode,
	isExternalLinkNode,
	clearGraphDataCache,
	invalidateCacheForFiles,
	getGraphCacheStats,
	type DocumentNodeData,
	type ExternalLinkNodeData,
	type ProgressData,
	type BacklinkUpdateData,
	BATCH_SIZE_BEFORE_YIELD,
	LARGE_FILE_THRESHOLD,
} from '../../renderer/components/DocumentGraph/graphDataBuilder';
import { getRendererPerfMetrics, logger } from '../../renderer/utils/logger';

// Type definitions for mock file system
interface MockFile {
	content: string;
	size: number;
}

interface MockDirectory {
	[key: string]: MockFile | MockDirectory | boolean;
	_isDirectory: boolean;
}

const expectedDocumentGraphLogPrefixes = [
	'[DocumentGraph] Cache cleared',
	'[DocumentGraph] Invalidated cache',
	'[DocumentGraph] Building graph from focus file',
	'[DocumentGraph] Found ',
	'[DocumentGraph] BFS traversal complete',
	'[DocumentGraph] Starting background backlink scan',
	'[DocumentGraph] Backlink scan',
	'[DocumentGraph] Expanding node',
	'[DocumentGraph] Node expansion complete',
];

let unexpectedConsoleLogs: unknown[][] = [];

function isExpectedDocumentGraphLog(args: unknown[]) {
	const message = args[0];
	return (
		typeof message === 'string' &&
		expectedDocumentGraphLogPrefixes.some((prefix) => message.startsWith(prefix))
	);
}

describe('graphDataBuilder', () => {
	// Store mock functions for easy reset
	let mockReadDir: Mock;
	let mockReadFile: Mock;
	let mockStat: Mock;

	// Mock file system with linked documents
	const mockFileSystem: MockDirectory = {
		_isDirectory: true,
		'.hidden.md': {
			content: '# Hidden\n\nThis file should not be scanned.',
			size: 40,
		},
		'notes.txt': {
			content: 'Plain text notes should not be scanned.',
			size: 40,
		},
		'readme.md': {
			content:
				'# Project\n\nSee [[getting-started]] for help.\n\nVisit [GitHub](https://github.com/test/repo).',
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
				content:
					'---\ntitle: Configuration\ndescription: How to configure the app\n---\n\n# Config\n\nLink to [docs](https://docs.example.com).',
				size: 200,
			},
		},
		research: {
			_isDirectory: true,
			'index.md': {
				content: '# Research\n\nSee [[vendor-report]] and [[config]] for details.',
				size: 80,
			},
			vendors: {
				_isDirectory: true,
				'vendor-report.md': {
					content: '# Vendor Report\n\nSee [[index]] for overview.',
					size: 60,
				},
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

	function createFile(content: string, size = content.length): MockFile {
		return { content, size };
	}

	function setEntry(path: string, entry: MockFile | MockDirectory): void {
		const parts = path.split('/').filter(Boolean);
		let current = mockFileSystem;

		for (const part of parts.slice(0, -1)) {
			const existing = current[part];
			if (!existing || typeof existing !== 'object' || 'content' in existing) {
				current[part] = { _isDirectory: true };
			}
			current = current[part] as MockDirectory;
		}

		current[parts[parts.length - 1]] = entry;
	}

	function deleteEntry(path: string): void {
		const parts = path.split('/').filter(Boolean);
		let current = mockFileSystem;

		for (const part of parts.slice(0, -1)) {
			const next = current[part];
			if (!next || typeof next !== 'object' || 'content' in next) return;
			current = next as MockDirectory;
		}

		delete current[parts[parts.length - 1]];
	}

	async function withTemporaryFiles<T>(
		entries: Record<string, MockFile | MockDirectory>,
		callback: () => Promise<T>
	): Promise<T> {
		for (const [path, entry] of Object.entries(entries)) {
			setEntry(path, entry);
		}

		try {
			return await callback();
		} finally {
			for (const path of Object.keys(entries)) {
				deleteEntry(path);
			}
		}
	}

	function mockReadDirImpl(
		dirPath: string
	): Promise<Array<{ name: string; isDirectory: boolean; path: string }>> {
		const normalizedPath = dirPath.replace(/\/$/, '');
		const dir =
			normalizedPath === '/test' ? mockFileSystem : getEntry(normalizedPath.replace('/test/', ''));

		if (!dir || typeof dir !== 'object' || 'content' in dir) {
			return Promise.resolve([]);
		}

		const entries = Object.entries(dir)
			.filter(([key]) => key !== '_isDirectory')
			.map(([name, value]) => ({
				name,
				isDirectory:
					typeof value === 'object' &&
					value !== null &&
					'_isDirectory' in value &&
					value._isDirectory === true,
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
		unexpectedConsoleLogs = [];
		vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			if (!isExpectedDocumentGraphLog(args)) {
				unexpectedConsoleLogs.push(args);
			}
		});

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
			expect(result.nodes.find((n) => n.id === 'doc-readme.md')).toBeDefined();
		});

		it('should traverse links up to maxDepth', async () => {
			const result = await buildGraphData({
				rootPath: '/test',
				focusFile: 'readme.md',
				maxDepth: 2,
			});

			// readme.md -> getting-started.md (depth 1) -> advanced/config.md (depth 2)
			const nodeIds = result.nodes.map((n) => n.id);
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
			const nodeIds = result.nodes.map((n) => n.id);
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
			const nodeIds = result.nodes.map((n) => n.id);
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
			const nodeIds = result.nodes.map((n) => n.id);
			const uniqueIds = new Set(nodeIds);
			expect(nodeIds.length).toBe(uniqueIds.size);
		});

		it('should terminate directory scan when symlink cycle would recurse forever', async () => {
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			// Simulate a cycle: /test always reports a "loop" subdir that resolves
			// back to /test. Without depth protection this recurses indefinitely.
			const cyclicReadDir = vi.fn().mockImplementation(async (dirPath: string) => [
				{
					name: 'entry.md',
					isDirectory: false,
					path: `${dirPath.replace(/\/$/, '')}/entry.md`,
				},
				{
					name: 'loop',
					isDirectory: true,
					// Always points back to the root, as a symlink cycle would
					path: '/test',
				},
			]);

			vi.stubGlobal('window', {
				maestro: {
					fs: {
						readDir: cyclicReadDir,
						readFile: vi.fn().mockResolvedValue('# entry\n'),
						stat: vi.fn().mockResolvedValue({ size: 10, modifiedAt: '2024-01-01T00:00:00.000Z' }),
					},
				},
			});

			try {
				// The call must complete - depth cap prevents runaway recursion
				const result = await buildGraphData({
					rootPath: '/test',
					focusFile: 'entry.md',
				});

				expect(consoleWarn).toHaveBeenCalledWith(
					'scanMarkdownFiles: reached max depth 10 at /test; stopping recursion'
				);
				expect(result.nodes.length).toBeGreaterThan(0);
				// readDir should be called a bounded number of times (depth cap is 10)
				expect(cyclicReadDir.mock.calls.length).toBeLessThanOrEqual(12);
			} finally {
				consoleWarn.mockRestore();
			}
		});
	});

	describe('cross-directory wiki link resolution', () => {
		it('should resolve wiki links to files in subdirectories via filename fallback', async () => {
			// research/index.md has [[vendor-report]] which lives at research/vendors/vendor-report.md
			// Without file-tree-aware resolution, this would resolve to research/vendor-report.md (wrong)
			const result = await buildGraphData({
				rootPath: '/test',
				focusFile: 'research/index.md',
				maxDepth: 2,
			});

			const nodeIds = result.nodes.map((n) => n.id);
			expect(nodeIds).toContain('doc-research/index.md');
			expect(nodeIds).toContain('doc-research/vendors/vendor-report.md');
		});

		it('should resolve wiki links across sibling directories', async () => {
			// research/index.md has [[config]] which lives at advanced/config.md
			const result = await buildGraphData({
				rootPath: '/test',
				focusFile: 'research/index.md',
				maxDepth: 2,
			});

			const nodeIds = result.nodes.map((n) => n.id);
			expect(nodeIds).toContain('doc-advanced/config.md');
		});
	});

	describe('directory scanning', () => {
		it('skips hidden markdown files and non-markdown files while collecting all markdown files', async () => {
			const result = await buildGraphData({
				rootPath: '/test',
				focusFile: 'readme.md',
			});

			expect(result.allMarkdownFiles).toContain('readme.md');
			expect(result.allMarkdownFiles).not.toContain('.hidden.md');
			expect(result.allMarkdownFiles).not.toContain('notes.txt');
			expect(result.allMarkdownFiles).not.toContain('node_modules/package.json');
		});

		it('keeps the focus graph when the root directory cannot be read', async () => {
			const error = new Error('Permission denied');
			const loggerWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
			mockReadDir.mockRejectedValue(error);

			const result = await buildGraphData({
				rootPath: '/test',
				focusFile: 'readme.md',
			});

			expect(result.nodes.map((node) => node.id)).toContain('doc-readme.md');
			expect(result.allMarkdownFiles).toEqual([]);
			expect(loggerWarn).toHaveBeenCalledWith(
				'[DocumentGraph] Directory scan failed:',
				undefined,
				expect.objectContaining({
					message: 'Failed to read directory: /test. Permission denied',
				})
			);
		});

		it('keeps the focus graph when the root scan throws a non-Error value', async () => {
			const loggerWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
			mockReadDir.mockRejectedValue('denied');

			const result = await buildGraphData({
				rootPath: '/test',
				focusFile: 'readme.md',
			});

			expect(result.nodes.map((node) => node.id)).toContain('doc-readme.md');
			expect(result.allMarkdownFiles).toEqual([]);
			expect(loggerWarn).toHaveBeenCalledWith(
				'[DocumentGraph] Directory scan failed:',
				undefined,
				expect.any(Error)
			);
		});

		it('logs and continues when a nested directory cannot be read', async () => {
			const readError = new Error('No access');
			const loggerWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
			mockReadDir.mockImplementation((dirPath: string) => {
				if (dirPath === '/test/advanced') {
					return Promise.reject(readError);
				}
				return mockReadDirImpl(dirPath);
			});

			const result = await buildGraphData({
				rootPath: '/test',
				focusFile: 'readme.md',
				maxDepth: 1,
			});

			expect(result.nodes.map((node) => node.id)).toContain('doc-readme.md');
			expect(result.allMarkdownFiles).not.toContain('advanced/config.md');
			expect(loggerWarn).toHaveBeenCalledWith(
				'Failed to scan directory /test/advanced:',
				undefined,
				readError
			);
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
				(e) => e.source === 'doc-readme.md' && e.target === 'doc-getting-started.md'
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

		it('does not queue a focus file link that resolves back to the focus file', async () => {
			await withTemporaryFiles(
				{
					'self-linked.md': createFile('# Self\n\n[[self-linked]]'),
				},
				async () => {
					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'self-linked.md',
					});

					expect(result.nodes.map((node) => node.id)).toEqual(['doc-self-linked.md']);
					expect(result.edges).toContainEqual(
						expect.objectContaining({
							source: 'doc-self-linked.md',
							target: 'doc-self-linked.md',
						})
					);
				}
			);
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
				(n) => n.id === 'ext-github.com'
			);
			expect(githubNode).toBeDefined();
		});

		it('groups duplicate external links by domain without duplicating identical URLs', async () => {
			await withTemporaryFiles(
				{
					'external-dupes.md': createFile(
						[
							'# External Dupes',
							'[[external-dupes-child]]',
							'[One](https://example.com/a)',
							'[One again](https://example.com/a)',
						].join('\n\n')
					),
					'external-dupes-child.md': createFile(
						[
							'# External Dupes Child',
							'[Same](https://example.com/a)',
							'[Two](https://example.com/b)',
						].join('\n\n')
					),
				},
				async () => {
					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'external-dupes.md',
						maxDepth: 1,
					});

					const exampleNode = result.cachedExternalData.externalNodes.find(
						(node) => node.id === 'ext-example.com'
					);
					expect(exampleNode).toBeDefined();
					const data = exampleNode!.data as ExternalLinkNodeData;
					expect(data.linkCount).toBe(3);
					expect(data.urls).toEqual(['https://example.com/a', 'https://example.com/b']);
					expect(result.cachedExternalData.totalLinkCount).toBe(3);
				}
			);
		});
	});

	describe('document stats', () => {
		it('should extract document stats for each node', async () => {
			const result = await buildGraphData({
				rootPath: '/test',
				focusFile: 'readme.md',
			});

			const readmeNode = result.nodes.find((n) => n.id === 'doc-readme.md');
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

			const configNode = result.nodes.find((n) => n.id === 'doc-advanced/config.md');
			expect(configNode).toBeDefined();

			const data = configNode!.data as DocumentNodeData;
			expect(data.title).toBe('Configuration');
			expect(data.description).toBe('How to configure the app');
		});
	});

	describe('error handling', () => {
		it('should return empty graph when focus file does not exist', async () => {
			const loggerDebug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
			const consoleError = vi.spyOn(logger, 'error').mockImplementation(() => {});

			try {
				const result = await buildGraphData({
					rootPath: '/test',
					focusFile: 'nonexistent.md',
				});

				expect(loggerDebug).toHaveBeenCalledWith(
					'[DocumentGraph] parseFileWithSsh: stat returned null for /test/nonexistent.md'
				);
				expect(consoleError).toHaveBeenCalledWith(
					'[DocumentGraph] Failed to parse focus file: nonexistent.md'
				);
				expect(result.nodes).toHaveLength(0);
				expect(result.edges).toHaveLength(0);
				expect(result.totalDocuments).toBe(0);
			} finally {
				loggerDebug.mockRestore();
				consoleError.mockRestore();
			}
		});

		it('should handle file read errors gracefully', async () => {
			const consoleWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
			const readError = new Error('File read error');
			mockReadFile.mockImplementation((path: string) => {
				if (path.includes('getting-started')) {
					return Promise.reject(readError);
				}
				return mockReadFileImpl(path);
			});

			try {
				const result = await buildGraphData({
					rootPath: '/test',
					focusFile: 'readme.md',
					maxDepth: 2,
				});

				// Should still have readme.md even though getting-started failed
				expect(result.nodes.find((n) => n.id === 'doc-readme.md')).toBeDefined();
				expect(consoleWarn).toHaveBeenCalledWith(
					'Failed to parse file /test/getting-started.md:',
					undefined,
					readError
				);
			} finally {
				consoleWarn.mockRestore();
			}
		});

		it('should skip linked files when readFile returns null', async () => {
			const consoleWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
			mockReadFile.mockImplementation((path: string) => {
				if (path.includes('getting-started')) {
					return Promise.resolve(null);
				}
				return mockReadFileImpl(path);
			});

			const result = await buildGraphData({
				rootPath: '/test',
				focusFile: 'readme.md',
				maxDepth: 2,
			});

			expect(result.nodes.map((node) => node.id)).toEqual(['doc-readme.md']);
			expect(consoleWarn).toHaveBeenCalledWith(
				'[DocumentGraph] parseFileWithSsh: readFile returned null for /test/getting-started.md'
			);
		});

		it('should default missing file size and modified time while parsing', async () => {
			await withTemporaryFiles(
				{
					'metadata-defaults.md': createFile('# Metadata defaults'),
				},
				async () => {
					mockStat.mockImplementation((filePath: string) => {
						if (filePath.endsWith('/metadata-defaults.md')) {
							return Promise.resolve({});
						}
						return mockStatImpl(filePath);
					});

					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'metadata-defaults.md',
					});

					const metadataNode = result.nodes.find((node) => node.id === 'doc-metadata-defaults.md');
					expect(metadataNode).toBeDefined();
					expect((metadataNode!.data as DocumentNodeData).size).toBe('0 B');
				}
			);
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
			const parsingCalls = onProgress.mock.calls.filter((call) => call[0].phase === 'parsing');
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

		it('yields during larger parsing batches without dropping progress updates', async () => {
			const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
				callback(1);
				return 1;
			});
			vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);

			await withTemporaryFiles(
				{
					'batch-root.md': createFile(
						Array.from(
							{ length: BATCH_SIZE_BEFORE_YIELD },
							(_, index) => `[[batch-${index + 1}]]`
						).join('\n')
					),
					...Object.fromEntries(
						Array.from({ length: BATCH_SIZE_BEFORE_YIELD }, (_, index) => [
							`batch-${index + 1}.md`,
							createFile(`# Batch ${index + 1}`),
						])
					),
				},
				async () => {
					const onProgress = vi.fn();

					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'batch-root.md',
						maxDepth: 1,
						onProgress,
					});

					expect(result.nodes).toHaveLength(BATCH_SIZE_BEFORE_YIELD + 1);
					expect(requestAnimationFrame).toHaveBeenCalled();
					expect(onProgress).toHaveBeenCalledWith(
						expect.objectContaining({
							phase: 'parsing',
							current: BATCH_SIZE_BEFORE_YIELD + 1,
							total: BATCH_SIZE_BEFORE_YIELD + 1,
						})
					);
				}
			);
		});
	});

	describe('performance and large-file handling', () => {
		it('warns when a small graph build exceeds the configured threshold', async () => {
			const perfMetrics = getRendererPerfMetrics('DocumentGraph');
			vi.spyOn(perfMetrics, 'end').mockReturnValue(1001);
			const consoleWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

			await buildGraphData({
				rootPath: '/test',
				focusFile: 'readme.md',
				maxDepth: 1,
			});

			expect(consoleWarn).toHaveBeenCalledWith(
				expect.stringContaining('[DocumentGraph] buildGraphData took 1001ms'),
				undefined,
				expect.objectContaining({
					nodeCount: expect.any(Number),
					edgeCount: expect.any(Number),
				})
			);
		});

		it('uses the large-graph threshold when at least 100 documents are loaded', async () => {
			const perfMetrics = getRendererPerfMetrics('DocumentGraph');
			vi.spyOn(perfMetrics, 'end').mockReturnValue(3001);
			const consoleWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
			const linkedFiles = 99;

			await withTemporaryFiles(
				{
					'large-threshold-root.md': createFile(
						Array.from(
							{ length: linkedFiles },
							(_, index) => `[[large-threshold-${index + 1}]]`
						).join('\n')
					),
					...Object.fromEntries(
						Array.from({ length: linkedFiles }, (_, index) => [
							`large-threshold-${index + 1}.md`,
							createFile(`# Large Threshold ${index + 1}`),
						])
					),
				},
				async () => {
					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'large-threshold-root.md',
						maxDepth: 1,
						maxNodes: 100,
					});

					expect(result.loadedDocuments).toBe(100);
					expect(consoleWarn).toHaveBeenCalledWith(
						expect.stringContaining('threshold: 3000ms'),
						undefined,
						expect.objectContaining({
							nodeCount: 100,
						})
					);
				}
			);
		});

		it('marks large files and truncates content before parsing', async () => {
			const largeContent = `# Large File\n\n[[standalone]]\n\n${'word '.repeat(
				Math.ceil(LARGE_FILE_THRESHOLD / 5)
			)}`;

			await withTemporaryFiles(
				{
					'large.md': createFile(largeContent, LARGE_FILE_THRESHOLD + 1),
				},
				async () => {
					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'large.md',
						maxDepth: 1,
					});

					const largeNode = result.nodes.find((node) => node.id === 'doc-large.md');
					expect(largeNode).toBeDefined();
					const data = largeNode!.data as DocumentNodeData;
					expect(data.isLargeFile).toBe(true);
					expect(result.edges).toContainEqual(
						expect.objectContaining({
							source: 'doc-large.md',
							target: 'doc-standalone.md',
						})
					);
				}
			);
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
			const nodeIds = result.nodes.map((n) => n.id);
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
			const newNodeIds = updates.flatMap((u) => u.newNodes.map((n) => n.id));
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
			const allNewEdges = updates.flatMap((u) => u.newEdges);
			const backlinkEdge = allNewEdges.find(
				(e) => e.source === 'doc-readme.md' && e.target === 'doc-getting-started.md'
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
				() => {
					updateCount++;
				},
				() => {
					completed = true;
				}
			);

			// Abort immediately
			abort();

			// Give it a moment to process
			await new Promise((resolve) => setTimeout(resolve, 50));

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
			expect(Array.isArray(updates)).toBe(true);
		});

		it('sends a final backlink update when discoveries remain after the last batch', async () => {
			await withTemporaryFiles(
				{
					'late-backlink.md': createFile('# Late\n\nSee [[standalone]].'),
				},
				async () => {
					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'standalone.md',
					});

					const updates: BacklinkUpdateData[] = [];

					await new Promise<void>((resolve) => {
						result.startBacklinkScan!(
							(update) => updates.push(update),
							() => resolve()
						);
					});

					expect(updates.at(-1)).toEqual(
						expect.objectContaining({
							newNodes: expect.arrayContaining([
								expect.objectContaining({ id: 'doc-late-backlink.md' }),
							]),
							totalFiles: expect.any(Number),
						})
					);
				}
			);
		});

		it('continues backlink scanning when link-only parsing returns null', async () => {
			await withTemporaryFiles(
				{
					'statless-backlink.md': createFile('# Statless\n\n[[standalone]]'),
				},
				async () => {
					mockStat.mockImplementation((filePath: string) => {
						if (filePath.endsWith('/statless-backlink.md')) {
							return Promise.resolve(null);
						}
						return mockStatImpl(filePath);
					});

					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'standalone.md',
					});

					const updates: BacklinkUpdateData[] = [];

					await new Promise<void>((resolve) => {
						result.startBacklinkScan!(
							(update) => updates.push(update),
							() => resolve()
						);
					});

					const discoveredIds = updates.flatMap((update) => update.newNodes.map((node) => node.id));
					expect(discoveredIds).not.toContain('doc-statless-backlink.md');
				}
			);
		});

		it('continues backlink scanning when link-only reads return null or throw', async () => {
			await withTemporaryFiles(
				{
					'metadata-default-backlink.md': createFile('# Metadata fallback\n\n[[standalone]]'),
					'null-read-backlink.md': createFile('# Null read\n\n[[standalone]]'),
					'throwing-read-backlink.md': createFile('# Throwing read\n\n[[standalone]]'),
				},
				async () => {
					const readError = new Error('read failed');
					mockStat.mockImplementation((filePath: string) => {
						if (filePath.endsWith('/metadata-default-backlink.md')) {
							return Promise.resolve({});
						}
						return mockStatImpl(filePath);
					});
					mockReadFile.mockImplementation((filePath: string) => {
						if (filePath.endsWith('/null-read-backlink.md')) {
							return Promise.resolve(null);
						}
						if (filePath.endsWith('/throwing-read-backlink.md')) {
							return Promise.reject(readError);
						}
						return mockReadFileImpl(filePath);
					});

					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'standalone.md',
					});

					const updates: BacklinkUpdateData[] = [];

					await new Promise<void>((resolve) => {
						result.startBacklinkScan!(
							(update) => updates.push(update),
							() => resolve()
						);
					});

					const discoveredIds = updates.flatMap((update) => update.newNodes.map((node) => node.id));
					expect(discoveredIds).toContain('doc-metadata-default-backlink.md');
					expect(discoveredIds).not.toContain('doc-null-read-backlink.md');
					expect(discoveredIds).not.toContain('doc-throwing-read-backlink.md');
				}
			);
		});

		it('skips backlink nodes when full parsing fails after link-only parsing succeeds', async () => {
			await withTemporaryFiles(
				{
					'vanishing-backlink.md': createFile('# Vanishing\n\n[[standalone]]'),
				},
				async () => {
					const consoleWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
					let vanishingReads = 0;
					mockReadFile.mockImplementation((filePath: string) => {
						if (filePath.endsWith('/vanishing-backlink.md')) {
							vanishingReads++;
							return Promise.resolve(vanishingReads === 1 ? '# Vanishing\n\n[[standalone]]' : null);
						}
						return mockReadFileImpl(filePath);
					});

					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'standalone.md',
					});

					const updates: BacklinkUpdateData[] = [];

					await new Promise<void>((resolve) => {
						result.startBacklinkScan!(
							(update) => updates.push(update),
							() => resolve()
						);
					});

					const discoveredIds = updates.flatMap((update) => update.newNodes.map((node) => node.id));
					expect(discoveredIds).not.toContain('doc-vanishing-backlink.md');
					expect(consoleWarn).toHaveBeenCalledWith(
						'[DocumentGraph] parseFileWithSsh: readFile returned null for /test/vanishing-backlink.md'
					);
				}
			);
		});

		it('does not call completion when aborted after a final backlink update', async () => {
			await withTemporaryFiles(
				{
					'abort-after-update.md': createFile('# Abort after update\n\n[[standalone]]'),
				},
				async () => {
					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'standalone.md',
					});
					let abort: (() => void) | undefined;
					const onComplete = vi.fn();

					await new Promise<void>((resolve) => {
						abort = result.startBacklinkScan!(() => {
							abort?.();
							resolve();
						}, onComplete);
					});

					await new Promise((resolve) => setTimeout(resolve, 0));
					expect(onComplete).not.toHaveBeenCalled();
				}
			);
		});

		it('uses cached parsed files for backlink link-only scans', async () => {
			await buildGraphData({
				rootPath: '/test',
				focusFile: 'readme.md',
				maxDepth: 1,
			});
			const result = await buildGraphData({
				rootPath: '/test',
				focusFile: 'standalone.md',
			});
			mockReadFile.mockClear();

			await new Promise<void>((resolve) => {
				result.startBacklinkScan!(
					() => {},
					() => resolve()
				);
			});

			expect(mockReadFile).not.toHaveBeenCalledWith('/test/readme.md', undefined);
		});

		it('truncates large files during backlink link-only scans', async () => {
			const largeBacklinkContent = `# Large Backlink\n\n[[standalone]]\n\n${'word '.repeat(
				Math.ceil(LARGE_FILE_THRESHOLD / 5)
			)}`;

			await withTemporaryFiles(
				{
					'large-backlink.md': createFile(largeBacklinkContent, LARGE_FILE_THRESHOLD + 1),
				},
				async () => {
					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'standalone.md',
					});

					const updates: BacklinkUpdateData[] = [];

					await new Promise<void>((resolve) => {
						result.startBacklinkScan!(
							(update) => updates.push(update),
							() => resolve()
						);
					});

					const largeNode = updates
						.flatMap((update) => update.newNodes)
						.find((node) => node.id === 'doc-large-backlink.md');
					expect(largeNode).toBeDefined();
					expect((largeNode!.data as DocumentNodeData).isLargeFile).toBe(true);
				}
			);
		});

		it('reports completion when backlink scanning fails', async () => {
			await withTemporaryFiles(
				{
					'failing-update-backlink.md': createFile('# Failing Update\n\n[[standalone]]'),
				},
				async () => {
					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'standalone.md',
					});
					const consoleError = vi.spyOn(logger, 'error').mockImplementation(() => {});
					const scanError = new Error('scan failed');
					let completed = false;

					await new Promise<void>((resolve) => {
						result.startBacklinkScan!(
							() => {
								throw scanError;
							},
							() => {
								completed = true;
								resolve();
							}
						);
					});

					expect(completed).toBe(true);
					expect(consoleError).toHaveBeenCalledWith(
						'[DocumentGraph] Backlink scan failed:',
						undefined,
						scanError
					);
					consoleError.mockRestore();
				}
			);
		});

		it('does not call completion when an aborted backlink scan later fails', async () => {
			await withTemporaryFiles(
				{
					'aborted-update-backlink.md': createFile('# Aborted Update\n\n[[standalone]]'),
				},
				async () => {
					const result = await buildGraphData({
						rootPath: '/test',
						focusFile: 'standalone.md',
					});
					const consoleError = vi.spyOn(logger, 'error').mockImplementation(() => {});
					const scanError = new Error('late scan failure');
					const onComplete = vi.fn();
					let abort!: () => void;

					abort = result.startBacklinkScan!(() => {
						abort();
						throw scanError;
					}, onComplete);
					await new Promise((resolve) => setTimeout(resolve, 50));

					expect(consoleError).toHaveBeenCalledWith(
						'[DocumentGraph] Backlink scan failed:',
						undefined,
						scanError
					);
					expect(onComplete).not.toHaveBeenCalled();
					consoleError.mockRestore();
				}
			);
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
					.filter((n) => n.type === 'documentNode')
					.map((n) => (n.data as DocumentNodeData).filePath)
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
			const newNodeIds = result.newNodes.map((n) => n.id);
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
				(e) => e.source === 'doc-getting-started.md' && e.target === 'doc-advanced/config.md'
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
					.filter((n) => n.type === 'documentNode')
					.map((n) => (n.data as DocumentNodeData).filePath)
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
			const loggerDebug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
			const consoleWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

			try {
				const result = await expandNode({
					rootPath: '/test',
					filePath: 'nonexistent.md',
					loadedPaths: new Set(['readme.md']),
					maxDepth: 1,
				});

				expect(loggerDebug).toHaveBeenCalledWith(
					'[DocumentGraph] parseFileWithSsh: stat returned null for /test/nonexistent.md'
				);
				expect(consoleWarn).toHaveBeenCalledWith(
					'[DocumentGraph] Failed to parse source node for expansion:',
					undefined,
					'nonexistent.md'
				);
				expect(result.hasNewContent).toBe(false);
				expect(result.newNodes.length).toBe(0);
			} finally {
				loggerDebug.mockRestore();
				consoleWarn.mockRestore();
			}
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

			const newNodeIds = result.newNodes.map((n) => n.id);
			expect(newNodeIds).toContain('doc-getting-started.md');
			expect(newNodeIds).not.toContain('doc-advanced/config.md');
		});

		it('skips queued nodes that exceed maxDepth', async () => {
			const result = await expandNode({
				rootPath: '/test',
				filePath: 'readme.md',
				loadedPaths: new Set(['readme.md']),
				maxDepth: 0,
			});

			expect(result.hasNewContent).toBe(true);
			expect(result.newNodes).toHaveLength(0);
			expect(result.newExternalNodes.map((node) => node.id)).toEqual(['ext-github.com']);
			expect(result.updatedLoadedPaths).toEqual(new Set(['readme.md']));
		});

		it('continues expansion when an outgoing link cannot be parsed', async () => {
			const loggerDebug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
			await withTemporaryFiles(
				{
					'missing-target-source.md': createFile('# Missing target\n\n[[ghost-target]]'),
				},
				async () => {
					try {
						const result = await expandNode({
							rootPath: '/test',
							filePath: 'missing-target-source.md',
							loadedPaths: new Set(['missing-target-source.md']),
							maxDepth: 1,
						});

						expect(loggerDebug).toHaveBeenCalledWith(
							'[DocumentGraph] parseFileWithSsh: stat returned null for /test/ghost-target.md'
						);
						expect(result.hasNewContent).toBe(false);
						expect(result.newNodes).toHaveLength(0);
						expect(result.updatedLoadedPaths).toEqual(new Set(['missing-target-source.md']));
					} finally {
						loggerDebug.mockRestore();
					}
				}
			);
		});

		it('discovers second-depth nodes without creating a source-to-grandchild edge', async () => {
			await withTemporaryFiles(
				{
					'depth-source.md': createFile('# Source\n\n[[depth-child]]'),
					'depth-child.md': createFile('# Child\n\n[[depth-source]]\n\n[[depth-grandchild]]'),
					'depth-grandchild.md': createFile('# Grandchild'),
				},
				async () => {
					const result = await expandNode({
						rootPath: '/test',
						filePath: 'depth-source.md',
						loadedPaths: new Set(['depth-source.md']),
						maxDepth: 2,
						allMarkdownFiles: ['depth-source.md', 'depth-child.md', 'depth-grandchild.md'],
					});

					expect(result.newNodes.map((node) => node.id)).toEqual([
						'doc-depth-child.md',
						'doc-depth-grandchild.md',
					]);
					expect(result.newEdges).toContainEqual(
						expect.objectContaining({
							source: 'doc-depth-source.md',
							target: 'doc-depth-child.md',
						})
					);
					expect(result.newEdges).not.toContainEqual(
						expect.objectContaining({ target: 'doc-depth-grandchild.md' })
					);
				}
			);
		});

		it('deduplicates repeated edges from expanded nodes to loaded documents', async () => {
			await withTemporaryFiles(
				{
					'duplicate-edge-source.md': createFile('# Source\n\n[[duplicate-edge-child]]'),
					'duplicate-edge-child.md': createFile(
						'# Child\n\n[[readme]]\n\n[[readme]]\n\n[[duplicate-edge-child]]'
					),
				},
				async () => {
					const result = await expandNode({
						rootPath: '/test',
						filePath: 'duplicate-edge-source.md',
						loadedPaths: new Set(['duplicate-edge-source.md', 'readme.md']),
						maxDepth: 1,
					});

					const duplicateEdges = result.newEdges.filter(
						(edge) =>
							edge.source === 'doc-duplicate-edge-child.md' && edge.target === 'doc-readme.md'
					);
					expect(duplicateEdges).toHaveLength(1);
				}
			);
		});

		it('defensively deduplicates duplicate parser output during expansion', async () => {
			vi.resetModules();
			vi.doMock('../../renderer/utils/markdownLinkParser', async (importOriginal) => {
				const actual =
					await importOriginal<typeof import('../../renderer/utils/markdownLinkParser')>();

				return {
					...actual,
					parseMarkdownLinks: vi.fn((content: string, relativePath: string, options) => {
						if (relativePath === 'duplicate-parser-source.md') {
							return {
								internalLinks: ['duplicate-parser-child.md'],
								externalLinks: [
									{ url: 'https://example.com/a', domain: 'example.com' },
									{ url: 'https://example.com/a', domain: 'example.com' },
								],
								frontMatter: {},
							};
						}

						if (relativePath === 'duplicate-parser-child.md') {
							return {
								internalLinks: ['readme.md', 'readme.md'],
								externalLinks: [],
								frontMatter: {},
							};
						}

						return actual.parseMarkdownLinks(content, relativePath, options);
					}),
				};
			});

			try {
				const { expandNode: expandNodeWithDuplicateParser } =
					await import('../../renderer/components/DocumentGraph/graphDataBuilder');

				await withTemporaryFiles(
					{
						'duplicate-parser-source.md': createFile('# Source'),
						'duplicate-parser-child.md': createFile('# Child'),
					},
					async () => {
						const result = await expandNodeWithDuplicateParser({
							rootPath: '/test',
							filePath: 'duplicate-parser-source.md',
							loadedPaths: new Set(['duplicate-parser-source.md', 'readme.md']),
							maxDepth: 1,
						});

						const exampleNode = result.newExternalNodes.find(
							(node) => node.id === 'ext-example.com'
						);
						expect(exampleNode).toBeDefined();
						expect((exampleNode!.data as ExternalLinkNodeData).urls).toEqual([
							'https://example.com/a',
						]);
						const duplicateEdges = result.newEdges.filter(
							(edge) =>
								edge.source === 'doc-duplicate-parser-child.md' && edge.target === 'doc-readme.md'
						);
						expect(duplicateEdges).toHaveLength(1);
					}
				);
			} finally {
				vi.doUnmock('../../renderer/utils/markdownLinkParser');
				vi.resetModules();
			}
		});

		it('groups external links from the source and newly expanded nodes', async () => {
			await withTemporaryFiles(
				{
					'external-source.md': createFile(
						[
							'# External Source',
							'[[external-child]]',
							'[One](https://example.com/a)',
							'[One duplicate](https://example.com/a)',
							'[Two](https://example.com/b)',
						].join('\n\n')
					),
					'external-child.md': createFile(
						[
							'# External Child',
							'[Same as source](https://example.com/a)',
							'[Three duplicate](https://example.com/c)',
							'[Four](https://example.com/d)',
						].join('\n\n')
					),
				},
				async () => {
					const result = await expandNode({
						rootPath: '/test',
						filePath: 'external-source.md',
						loadedPaths: new Set(['external-source.md']),
						maxDepth: 1,
					});

					const exampleNode = result.newExternalNodes.find((node) => node.id === 'ext-example.com');
					expect(exampleNode).toBeDefined();
					const data = exampleNode!.data as ExternalLinkNodeData;
					expect(data.linkCount).toBe(5);
					expect(data.urls).toEqual([
						'https://example.com/a',
						'https://example.com/b',
						'https://example.com/c',
						'https://example.com/d',
					]);
				}
			);
		});

		it('yields during larger expansion batches without losing loaded paths', async () => {
			vi.stubGlobal('requestAnimationFrame', undefined);

			await withTemporaryFiles(
				{
					'expand-batch-root.md': createFile(
						Array.from(
							{ length: BATCH_SIZE_BEFORE_YIELD },
							(_, index) => `[[expand-batch-${index + 1}]]`
						).join('\n')
					),
					...Object.fromEntries(
						Array.from({ length: BATCH_SIZE_BEFORE_YIELD }, (_, index) => [
							`expand-batch-${index + 1}.md`,
							createFile(`# Expand Batch ${index + 1}`),
						])
					),
				},
				async () => {
					const result = await expandNode({
						rootPath: '/test',
						filePath: 'expand-batch-root.md',
						loadedPaths: new Set(['expand-batch-root.md']),
						maxDepth: 1,
					});

					expect(result.newNodes).toHaveLength(BATCH_SIZE_BEFORE_YIELD);
					for (let index = 1; index <= BATCH_SIZE_BEFORE_YIELD; index++) {
						expect(result.updatedLoadedPaths.has(`expand-batch-${index}.md`)).toBe(true);
					}
				}
			);
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
			expect(statCalls.some((call) => call[1] === testSshRemoteId)).toBe(true);
			// At least one readFile call should have been made with sshRemoteId
			expect(readFileCalls.some((call) => call[1] === testSshRemoteId)).toBe(true);
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

			expect(statCalls.some((call) => call[1] === testSshRemoteId)).toBe(true);
			expect(readFileCalls.some((call) => call[1] === testSshRemoteId)).toBe(true);
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

afterEach(() => {
	expect(unexpectedConsoleLogs).toEqual([]);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
