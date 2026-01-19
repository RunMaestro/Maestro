/**
 * graphDataBuilder - Builds graph data from markdown documents.
 *
 * Scans a directory for markdown files, parses their links and stats, and builds
 * a node/edge graph representing document relationships.
 *
 * Used by the DocumentGraphView component to visualize document connections.
 */

import { parseMarkdownLinks, ExternalLink } from '../../utils/markdownLinkParser';
import { computeDocumentStats, DocumentStats } from '../../utils/documentStats';
import { getRendererPerfMetrics } from '../../utils/logger';
import { PERFORMANCE_THRESHOLDS } from '../../../shared/performance-metrics';

// Performance metrics instance for graph data building
const perfMetrics = getRendererPerfMetrics('DocumentGraph');

// ============================================================================
// Parsed File Cache
// ============================================================================

/**
 * Cached parsed file entry with modification time for invalidation
 */
interface CachedParsedFile {
	/** The parsed file data */
	data: ParsedFile;
	/** File modification time (ms since epoch) when cached */
	mtime: number;
}

/**
 * Module-level cache for parsed files.
 * Key: full file path, Value: cached data with mtime
 *
 * This cache persists across graph rebuilds, significantly speeding up
 * incremental updates when only a few files change.
 */
const parsedFileCache = new Map<string, CachedParsedFile>();

/**
 * Cache for the reverse link index (which files link to which).
 * Invalidated when any file changes.
 */
interface CachedReverseLinkIndex {
	/** The reverse index map */
	reverseIndex: Map<string, Set<string>>;
	/** Set of existing files */
	existingFiles: Set<string>;
	/** Map of file path to mtime when index was built */
	fileMtimes: Map<string, number>;
	/** Root path this index was built for */
	rootPath: string;
}

let reverseLinkIndexCache: CachedReverseLinkIndex | null = null;

/**
 * Clear the parsed file cache (e.g., when switching projects)
 */
export function clearGraphDataCache(): void {
	parsedFileCache.clear();
	reverseLinkIndexCache = null;
	console.log('[DocumentGraph] Cache cleared');
}

/**
 * Invalidate cache entries for specific files (e.g., after file changes)
 */
export function invalidateCacheForFiles(filePaths: string[]): void {
	for (const filePath of filePaths) {
		parsedFileCache.delete(filePath);
	}
	// Invalidate reverse index since links may have changed
	reverseLinkIndexCache = null;
	console.log(`[DocumentGraph] Invalidated cache for ${filePaths.length} file(s)`);
}

/**
 * Get cache statistics for debugging
 */
export function getGraphCacheStats(): { parsedFileCount: number; hasReverseIndex: boolean } {
	return {
		parsedFileCount: parsedFileCache.size,
		hasReverseIndex: reverseLinkIndexCache !== null,
	};
}

/**
 * Size threshold for "large" files that need special handling.
 * Files larger than this will have their content truncated for parsing
 * to prevent blocking the UI.
 */
export const LARGE_FILE_THRESHOLD = 1024 * 1024; // 1MB

/**
 * Maximum content size to read for link extraction from large files.
 * Links are typically in the document header/early content, so reading
 * the first portion is usually sufficient for graph building.
 */
export const LARGE_FILE_PARSE_LIMIT = 100 * 1024; // 100KB

/**
 * Number of files to process before yielding to the event loop.
 * This prevents the UI from freezing during large batch operations.
 */
export const BATCH_SIZE_BEFORE_YIELD = 5;

/**
 * Yields control to the event loop to prevent UI blocking.
 * Uses requestAnimationFrame for smooth visual updates.
 */
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => {
		// Use requestAnimationFrame for better visual responsiveness
		if (typeof requestAnimationFrame !== 'undefined') {
			requestAnimationFrame(() => resolve());
		} else {
			// Fallback for environments without requestAnimationFrame
			setTimeout(resolve, 0);
		}
	});
}

/**
 * Progress callback data for reporting scan/parse progress
 */
export interface ProgressData {
	/** Current phase of the build process */
	phase: 'scanning' | 'parsing';
	/** Number of files processed so far */
	current: number;
	/** Total number of files to process (known after scanning phase) */
	total: number;
	/** Current file being processed (during parsing phase) */
	currentFile?: string;
	/** Running count of internal links found (during parsing phase) */
	internalLinksFound?: number;
	/** Running count of external links found (during parsing phase) */
	externalLinksFound?: number;
}

/**
 * Progress callback function type
 */
export type ProgressCallback = (progress: ProgressData) => void;

/**
 * Options for building the graph data
 */
export interface BuildOptions {
	/** Root directory path to scan for markdown files */
	rootPath: string;
	/** Starting file path (relative to rootPath) - the center of the graph */
	focusFile: string;
	/** Maximum depth to traverse from the focus file (default: 3) */
	maxDepth?: number;
	/** Maximum number of document nodes to include (for performance) */
	maxNodes?: number;
	/** Optional callback for progress updates during scanning and parsing */
	onProgress?: ProgressCallback;
	/** Optional SSH remote ID for remote file operations */
	sshRemoteId?: string;
}

/**
 * Data payload for document nodes
 */
export interface DocumentNodeData extends DocumentStats {
	/** Node type identifier for custom node rendering */
	nodeType: 'document';
}

/**
 * Data payload for external link nodes
 */
export interface ExternalLinkNodeData {
	/** Node type identifier for custom node rendering */
	nodeType: 'external';
	/** Domain name (www. stripped) */
	domain: string;
	/** Number of links to this domain */
	linkCount: number;
	/** All full URLs pointing to this domain */
	urls: string[];
}

/**
 * Combined node data type
 */
export type GraphNodeData = DocumentNodeData | ExternalLinkNodeData;

/**
 * Graph node structure
 */
export interface GraphNode {
	id: string;
	type: 'documentNode' | 'externalLinkNode';
	data: GraphNodeData;
}

/**
 * Graph edge structure
 */
export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	type?: 'default' | 'external';
}

/**
 * Cached external link data for toggling without re-scan
 */
export interface CachedExternalData {
	/** External domain nodes (can be added/removed from graph without re-parsing) */
	externalNodes: GraphNode[];
	/** Edges from documents to external domains */
	externalEdges: GraphEdge[];
	/** Total count of unique external domains */
	domainCount: number;
	/** Total count of external links (including duplicates) */
	totalLinkCount: number;
}

/**
 * Result of building graph data
 */
export interface GraphData {
	/** Nodes representing documents and optionally external domains */
	nodes: GraphNode[];
	/** Edges representing links between documents */
	edges: GraphEdge[];
	/** Total number of markdown files found (for pagination info) */
	totalDocuments: number;
	/** Number of documents currently loaded (may be less than total if maxNodes is set) */
	loadedDocuments: number;
	/** Whether there are more documents to load */
	hasMore: boolean;
	/** Cached external link data for instant toggling */
	cachedExternalData: CachedExternalData;
	/** Total count of internal links */
	internalLinkCount: number;
	/** Whether backlinks are still being loaded in the background */
	backlinksLoading?: boolean;
	/**
	 * Start lazy loading of backlinks in the background.
	 * Call this after the initial graph is displayed.
	 * @param onUpdate - Callback fired when new backlinks are discovered, with updated graph data
	 * @param onComplete - Callback fired when backlink scanning is complete
	 * @returns Abort function to cancel the background scan
	 */
	startBacklinkScan?: (
		onUpdate: (data: BacklinkUpdateData) => void,
		onComplete: () => void
	) => () => void;
}

/**
 * Data provided when backlinks are discovered during lazy loading
 */
export interface BacklinkUpdateData {
	/** New nodes to add (documents that link to existing nodes) */
	newNodes: GraphNode[];
	/** New edges to add (backlink connections) */
	newEdges: GraphEdge[];
	/** Files scanned so far */
	filesScanned: number;
	/** Total files to scan (if known) */
	totalFiles: number;
	/** Current file being scanned */
	currentFile?: string;
}

/**
 * Internal parsed file data (content is NOT stored to minimize memory usage)
 *
 * File content is parsed on-the-fly and immediately discarded after extracting
 * links and stats. This is the "lazy load" optimization - content is only read
 * when building the graph, not kept in memory.
 */
interface ParsedFile {
	/** Relative path from root (normalized) */
	relativePath: string;
	/** Full file path */
	fullPath: string;
	/** File size in bytes */
	fileSize: number;
	/** Parsed links from the file */
	internalLinks: string[];
	/** External links with domains */
	externalLinks: ExternalLink[];
	/** Computed document stats */
	stats: DocumentStats;
	/** All internal link paths (before broken link filtering) - used to compute broken links */
	allInternalLinkPaths: string[];
}

/**
 * Lightweight link data for building the reverse link index.
 * Only stores paths and links, not full stats, to minimize memory during initial scan.
 */
interface LinkIndexEntry {
	/** Relative path from root */
	relativePath: string;
	/** Outgoing internal links */
	outgoingLinks: string[];
}

/**
 * Reverse link index: maps each file path to the set of files that link TO it.
 * This enables bidirectional graph traversal.
 */
type ReverseLinkIndex = Map<string, Set<string>>;

/**
 * Recursively scan a directory for all markdown files.
 * @param rootPath - Root directory to scan
 * @param onProgress - Optional callback for progress updates (reports number of directories scanned)
 * @param sshRemoteId - Optional SSH remote ID for remote file operations
 * @returns Array of file paths relative to root
 */
async function scanMarkdownFiles(
	rootPath: string,
	onProgress?: ProgressCallback,
	sshRemoteId?: string
): Promise<string[]> {
	const markdownFiles: string[] = [];
	let directoriesScanned = 0;
	let isRootDirectory = true;

	async function scanDir(currentPath: string, relativePath: string): Promise<void> {
		const isRoot = isRootDirectory;
		isRootDirectory = false;

		try {
			const entries = await window.maestro.fs.readDir(currentPath, sshRemoteId);
			directoriesScanned++;

			// Report scanning progress (total unknown during scanning, so use current as estimate)
			if (onProgress) {
				onProgress({
					phase: 'scanning',
					current: directoriesScanned,
					total: 0, // Unknown during scanning
				});
			}

			for (const entry of entries) {
				// Skip hidden files and directories
				if (entry.name.startsWith('.')) continue;

				// Skip common non-content directories
				if (entry.isDirectory && ['node_modules', 'dist', 'build', '.git'].includes(entry.name)) {
					continue;
				}

				const fullPath = entry.path;
				const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

				if (entry.isDirectory) {
					await scanDir(fullPath, entryRelativePath);
				} else if (entry.name.toLowerCase().endsWith('.md')) {
					markdownFiles.push(entryRelativePath);
				}
			}
		} catch (error) {
			// If the root directory fails to be read, propagate the error
			if (isRoot) {
				throw new Error(
					`Failed to read directory: ${currentPath}. ${error instanceof Error ? error.message : 'Check permissions and path validity.'}`
				);
			}
			// Log error but continue scanning other directories for non-root failures
			console.warn(`Failed to scan directory ${currentPath}:`, error);
		}
	}

	await scanDir(rootPath, '');
	return markdownFiles;
}

/**
 * Parse a single markdown file and extract its data (local files only).
 * For large files (>1MB), content is truncated to prevent UI blocking.
 *
 * Uses caching with mtime-based invalidation to avoid re-parsing unchanged files.
 *
 * Note: For SSH support, use parseFileWithSsh instead.
 *
 * @param rootPath - Root directory path
 * @param relativePath - Path relative to root
 * @returns Parsed file data or null if reading fails
 */
async function _parseFile(rootPath: string, relativePath: string): Promise<ParsedFile | null> {
	const fullPath = `${rootPath}/${relativePath}`;

	try {
		// Get file stats first to check size and mtime
		const stat = await window.maestro.fs.stat(fullPath);
		if (!stat) {
			return null;
		}
		const fileSize = stat.size ?? 0;
		// Parse modifiedAt ISO string to timestamp for cache comparison
		const fileMtime = stat.modifiedAt ? new Date(stat.modifiedAt).getTime() : 0;
		const isLargeFile = fileSize > LARGE_FILE_THRESHOLD;

		// Check cache - if we have a cached version with matching mtime, use it
		const cached = parsedFileCache.get(fullPath);
		if (cached && cached.mtime === fileMtime) {
			return cached.data;
		}

		// Read file content
		const content = await window.maestro.fs.readFile(fullPath);
		if (content === null || content === undefined) {
			return null;
		}

		// For large files, truncate content for parsing to prevent UI blocking.
		// We still use the full file size for stats display.
		// Links are typically in the document header/early content, so truncation
		// rarely misses important link information.
		let contentForParsing = content;
		if (isLargeFile && content.length > LARGE_FILE_PARSE_LIMIT) {
			contentForParsing = content.substring(0, LARGE_FILE_PARSE_LIMIT);
			// Log for debugging - large file handling
			console.debug(
				`[DocumentGraph] Large file truncated for parsing: ${relativePath} (${(fileSize / 1024 / 1024).toFixed(1)}MB → ${(LARGE_FILE_PARSE_LIMIT / 1024).toFixed(0)}KB)`
			);
		}

		// Parse links from content (possibly truncated for large files)
		const { internalLinks, externalLinks } = parseMarkdownLinks(contentForParsing, relativePath);

		// Compute document statistics
		// For large files, we compute stats from the truncated content but with accurate file size
		const stats = computeDocumentStats(contentForParsing, relativePath, fileSize);

		// Mark large files in stats for UI indication
		if (isLargeFile) {
			stats.isLargeFile = true;
		}

		// Note: We intentionally do NOT store 'content' in the returned object.
		// The content has been parsed for links and stats, and is no longer needed.
		// This "lazy load" approach minimizes memory usage by discarding content immediately.
		const parsed: ParsedFile = {
			relativePath,
			fullPath,
			fileSize,
			internalLinks,
			externalLinks,
			stats,
			allInternalLinkPaths: internalLinks, // Store all links to identify broken ones later
		};

		// Cache the result with mtime
		parsedFileCache.set(fullPath, { data: parsed, mtime: fileMtime });

		return parsed;
	} catch (error) {
		console.warn(`Failed to parse file ${fullPath}:`, error);
		return null;
	}
}

/**
 * Quickly extract just the internal links from a file (no stats computation).
 * Used for building the reverse link index efficiently.
 *
 * Uses caching with mtime-based invalidation - if we have a cached full parse,
 * we can extract links from it without re-reading the file.
 *
 * @param rootPath - Root directory path
 * @param relativePath - Path relative to root
 * @returns LinkIndexEntry or null if reading fails
 */
async function parseFileLinksOnly(
	rootPath: string,
	relativePath: string
): Promise<LinkIndexEntry | null> {
	const fullPath = `${rootPath}/${relativePath}`;

	try {
		// Get file stats first to check size and mtime
		const stat = await window.maestro.fs.stat(fullPath);
		if (!stat) {
			return null;
		}
		const fileSize = stat.size ?? 0;
		// Parse modifiedAt ISO string to timestamp for cache comparison
		const fileMtime = stat.modifiedAt ? new Date(stat.modifiedAt).getTime() : 0;
		const isLargeFile = fileSize > LARGE_FILE_THRESHOLD;

		// Check cache - if we have a cached full parse with matching mtime, extract links from it
		const cached = parsedFileCache.get(fullPath);
		if (cached && cached.mtime === fileMtime) {
			return {
				relativePath,
				outgoingLinks: cached.data.internalLinks,
			};
		}

		// Read file content
		const content = await window.maestro.fs.readFile(fullPath);
		if (content === null || content === undefined) {
			return null;
		}

		// For large files, truncate content for parsing
		let contentForParsing = content;
		if (isLargeFile && content.length > LARGE_FILE_PARSE_LIMIT) {
			contentForParsing = content.substring(0, LARGE_FILE_PARSE_LIMIT);
		}

		// Parse links from content (only need internal links for index)
		const { internalLinks } = parseMarkdownLinks(contentForParsing, relativePath);

		return {
			relativePath,
			outgoingLinks: internalLinks,
		};
	} catch {
		// Silently fail - file may not exist or be unreadable
		return null;
	}
}

/**
 * Build a reverse link index by scanning all markdown files in the directory.
 * The index maps each file path to the set of files that link TO it.
 *
 * Note: This function is currently unused as backlink scanning is done
 * incrementally via startBacklinkScan. Kept for potential future use.
 *
 * @param rootPath - Root directory to scan
 * @param onProgress - Optional progress callback
 * @returns ReverseLinkIndex and set of all existing file paths
 */
async function _buildReverseLinkIndex(
	rootPath: string,
	onProgress?: ProgressCallback
): Promise<{ reverseIndex: ReverseLinkIndex; existingFiles: Set<string> }> {
	// Scan all markdown files
	const allFiles = await scanMarkdownFiles(rootPath, onProgress);
	const existingFiles = new Set(allFiles);

	// Build the reverse index
	const reverseIndex: ReverseLinkIndex = new Map();

	// Process files in batches to avoid blocking UI
	let filesProcessed = 0;
	for (const filePath of allFiles) {
		const entry = await parseFileLinksOnly(rootPath, filePath);
		if (entry) {
			// For each outgoing link, add the current file as an incoming link
			for (const targetPath of entry.outgoingLinks) {
				if (!reverseIndex.has(targetPath)) {
					reverseIndex.set(targetPath, new Set());
				}
				reverseIndex.get(targetPath)!.add(filePath);
			}
		}

		filesProcessed++;
		if (filesProcessed % BATCH_SIZE_BEFORE_YIELD === 0) {
			await yieldToEventLoop();
			if (onProgress) {
				onProgress({
					phase: 'scanning',
					current: filesProcessed,
					total: allFiles.length,
					currentFile: filePath,
				});
			}
		}
	}

	console.log('[DocumentGraph] Built reverse link index:', {
		totalFiles: allFiles.length,
		filesWithIncomingLinks: reverseIndex.size,
	});

	return { reverseIndex, existingFiles };
}

/**
 * Build graph data starting from a focus file and traversing outward via OUTGOING links only.
 * Uses BFS to discover connected documents up to maxDepth levels.
 *
 * This is the "instant" phase - it only follows outgoing links which requires no directory scan.
 * Backlinks (incoming links) are loaded lazily in the background via startBacklinkScan().
 *
 * @param options - Build configuration options
 * @returns GraphData with nodes, edges, and a startBacklinkScan function for lazy backlink loading
 */
export async function buildGraphData(options: BuildOptions): Promise<GraphData> {
	const { rootPath, focusFile, maxDepth = 3, maxNodes = 100, onProgress, sshRemoteId } = options;

	const buildStart = perfMetrics.start();

	console.log('[DocumentGraph] Building graph from focus file (outgoing links only):', {
		rootPath,
		focusFile,
		maxDepth,
		maxNodes,
		sshRemoteId: !!sshRemoteId,
	});

	// Track parsed files by path for deduplication
	const parsedFileMap = new Map<string, ParsedFile>();
	// BFS queue: [relativePath, depth]
	const queue: Array<{ path: string; depth: number }> = [];
	// Track visited paths to avoid re-processing
	const visited = new Set<string>();

	// Step 1: Parse the focus file first (use SSH-aware parsing)
	const focusParsed = await parseFileWithSsh(rootPath, focusFile, sshRemoteId);
	if (!focusParsed) {
		console.error(`[DocumentGraph] Failed to parse focus file: ${focusFile}`);
		return {
			nodes: [],
			edges: [],
			totalDocuments: 0,
			loadedDocuments: 0,
			hasMore: false,
			cachedExternalData: {
				externalNodes: [],
				externalEdges: [],
				domainCount: 0,
				totalLinkCount: 0,
			},
			internalLinkCount: 0,
		};
	}

	parsedFileMap.set(focusFile, focusParsed);
	visited.add(focusFile);

	// Add OUTGOING linked files to queue (focus file links to these)
	for (const link of focusParsed.internalLinks) {
		if (!visited.has(link)) {
			queue.push({ path: link, depth: 1 });
			visited.add(link);
		}
	}

	// Report initial progress
	if (onProgress) {
		onProgress({
			phase: 'parsing',
			current: 1,
			total: 1 + queue.length,
			currentFile: focusFile,
			internalLinksFound: focusParsed.internalLinks.length,
			externalLinksFound: focusParsed.externalLinks.length,
		});
	}

	// Step 2: BFS traversal to discover connected documents (outgoing links only - instant)
	let filesProcessed = 1;
	let totalInternalLinks = focusParsed.internalLinks.length;
	let totalExternalLinks = focusParsed.externalLinks.length;

	while (queue.length > 0 && parsedFileMap.size < maxNodes) {
		const { path, depth } = queue.shift()!;

		// Skip if beyond max depth
		if (depth > maxDepth) continue;

		// Parse the file (use SSH-aware parsing)
		const parsed = await parseFileWithSsh(rootPath, path, sshRemoteId);
		if (!parsed) continue; // File doesn't exist or failed to parse

		parsedFileMap.set(path, parsed);
		filesProcessed++;
		totalInternalLinks += parsed.internalLinks.length;
		totalExternalLinks += parsed.externalLinks.length;

		// Report progress
		if (onProgress) {
			onProgress({
				phase: 'parsing',
				current: filesProcessed,
				total: filesProcessed + queue.length,
				currentFile: path,
				internalLinksFound: totalInternalLinks,
				externalLinksFound: totalExternalLinks,
			});
		}

		// Add OUTGOING linked files to queue (if not at max depth)
		if (depth < maxDepth) {
			for (const link of parsed.internalLinks) {
				if (!visited.has(link)) {
					queue.push({ path: link, depth: depth + 1 });
					visited.add(link);
				}
			}
		}

		// Yield to event loop periodically
		if (filesProcessed % BATCH_SIZE_BEFORE_YIELD === 0) {
			await yieldToEventLoop();
		}
	}

	const parsedFiles = Array.from(parsedFileMap.values());
	const loadedPaths = new Set(parsedFileMap.keys());

	console.log('[DocumentGraph] BFS traversal complete (outgoing only):', {
		focusFile,
		filesLoaded: parsedFiles.length,
		maxDepth,
		queueRemaining: queue.length,
	});

	// Step 3: Build document nodes and collect external link data
	const documentNodes: GraphNode[] = [];
	const internalEdges: GraphEdge[] = [];
	const externalDomains = new Map<string, { count: number; urls: string[] }>();
	const externalEdges: GraphEdge[] = [];
	let totalExternalLinkCount = 0;
	let internalLinkCount = 0;

	for (const file of parsedFiles) {
		const nodeId = `doc-${file.relativePath}`;

		// Identify broken links (links to files that don't exist or weren't loaded)
		const brokenLinks = file.allInternalLinkPaths.filter(
			(link) => !loadedPaths.has(link) && !visited.has(link)
		);

		// Create document node
		documentNodes.push({
			id: nodeId,
			type: 'documentNode',
			data: {
				nodeType: 'document',
				...file.stats,
				...(brokenLinks.length > 0 ? { brokenLinks } : {}),
			},
		});

		// Create edges for internal links (only if target is loaded)
		for (const internalLink of file.internalLinks) {
			if (loadedPaths.has(internalLink)) {
				const targetNodeId = `doc-${internalLink}`;
				internalEdges.push({
					id: `edge-${nodeId}-${targetNodeId}`,
					source: nodeId,
					target: targetNodeId,
					type: 'default',
				});
				internalLinkCount++;
			}
		}

		// Collect external links
		for (const externalLink of file.externalLinks) {
			totalExternalLinkCount++;
			const existing = externalDomains.get(externalLink.domain);
			if (existing) {
				existing.count++;
				if (!existing.urls.includes(externalLink.url)) {
					existing.urls.push(externalLink.url);
				}
			} else {
				externalDomains.set(externalLink.domain, { count: 1, urls: [externalLink.url] });
			}

			const externalNodeId = `ext-${externalLink.domain}`;
			externalEdges.push({
				id: `edge-${nodeId}-${externalNodeId}`,
				source: nodeId,
				target: externalNodeId,
				type: 'external',
			});
		}
	}

	// Step 4: Build external domain nodes
	const externalNodes: GraphNode[] = [];
	for (const [domain, data] of externalDomains) {
		externalNodes.push({
			id: `ext-${domain}`,
			type: 'externalLinkNode',
			data: {
				nodeType: 'external',
				domain,
				linkCount: data.count,
				urls: data.urls,
			},
		});
	}

	// Build cached external data
	const cachedExternalData: CachedExternalData = {
		externalNodes,
		externalEdges,
		domainCount: externalDomains.size,
		totalLinkCount: totalExternalLinkCount,
	};

	// Determine if there are more documents (queue had remaining items or hit maxNodes)
	const hasMore = queue.length > 0 || parsedFiles.length >= maxNodes;

	// Log total build time with performance threshold check
	const totalBuildTime = perfMetrics.end(buildStart, 'buildGraphData:total', {
		totalDocuments: visited.size,
		loadedDocuments: parsedFiles.length,
		nodeCount: documentNodes.length,
		edgeCount: internalEdges.length,
		externalDomainsCached: externalDomains.size,
	});

	// Warn if build time exceeds thresholds
	const threshold =
		parsedFiles.length < 100
			? PERFORMANCE_THRESHOLDS.GRAPH_BUILD_SMALL
			: PERFORMANCE_THRESHOLDS.GRAPH_BUILD_LARGE;
	if (totalBuildTime > threshold) {
		console.warn(
			`[DocumentGraph] buildGraphData took ${totalBuildTime.toFixed(0)}ms (threshold: ${threshold}ms)`,
			{
				totalDocuments: visited.size,
				nodeCount: documentNodes.length,
				edgeCount: internalEdges.length,
			}
		);
	}

	// Create the lazy backlink scanner function
	// This scans all markdown files in the background to find files that link TO our loaded documents
	const startBacklinkScan = (
		onUpdate: (data: BacklinkUpdateData) => void,
		onComplete: () => void
	): (() => void) => {
		let aborted = false;

		const runScan = async () => {
			console.log('[DocumentGraph] Starting background backlink scan...');
			const scanStart = perfMetrics.start();

			try {
				// Scan all markdown files in the directory
				const allFiles = await scanMarkdownFiles(rootPath, undefined, sshRemoteId);
				const totalFiles = allFiles.length;

				console.log(`[DocumentGraph] Backlink scan: found ${totalFiles} markdown files to check`);

				// Track which new nodes/edges we discover
				const newNodes: GraphNode[] = [];
				const newEdges: GraphEdge[] = [];
				const discoveredBacklinkFiles = new Set<string>();

				let filesScanned = 0;
				let batchNewNodes: GraphNode[] = [];
				let batchNewEdges: GraphEdge[] = [];

				for (const filePath of allFiles) {
					if (aborted) {
						console.log('[DocumentGraph] Backlink scan aborted');
						return;
					}

					// Skip files we already have in the graph
					if (loadedPaths.has(filePath)) {
						filesScanned++;
						continue;
					}

					// Parse just the links from this file (use SSH-aware parsing)
					const entry = await parseFileLinksOnlyWithSsh(rootPath, filePath, sshRemoteId);
					if (!entry) {
						filesScanned++;
						continue;
					}

					// Check if any of its outgoing links point to our loaded documents
					const linksToLoadedDocs = entry.outgoingLinks.filter((link) => loadedPaths.has(link));

					if (linksToLoadedDocs.length > 0 && !discoveredBacklinkFiles.has(filePath)) {
						discoveredBacklinkFiles.add(filePath);

						// Parse the full file to get stats for the node (use SSH-aware parsing)
						const parsed = await parseFileWithSsh(rootPath, filePath, sshRemoteId);
						if (parsed) {
							const nodeId = `doc-${filePath}`;

							// Create node for this backlink source
							const newNode: GraphNode = {
								id: nodeId,
								type: 'documentNode',
								data: {
									nodeType: 'document',
									...parsed.stats,
								},
							};
							batchNewNodes.push(newNode);
							newNodes.push(newNode);

							// Create edges for each link to our loaded documents
							for (const targetPath of linksToLoadedDocs) {
								const targetNodeId = `doc-${targetPath}`;
								const newEdge: GraphEdge = {
									id: `edge-${nodeId}-${targetNodeId}`,
									source: nodeId,
									target: targetNodeId,
									type: 'default',
								};
								batchNewEdges.push(newEdge);
								newEdges.push(newEdge);
							}
						}
					}

					filesScanned++;

					// Yield to event loop and send updates periodically
					if (filesScanned % BATCH_SIZE_BEFORE_YIELD === 0) {
						await yieldToEventLoop();

						// If we have new nodes/edges, send an update
						if (batchNewNodes.length > 0 || batchNewEdges.length > 0) {
							onUpdate({
								newNodes: batchNewNodes,
								newEdges: batchNewEdges,
								filesScanned,
								totalFiles,
								currentFile: filePath,
							});
							batchNewNodes = [];
							batchNewEdges = [];
						}
					}
				}

				// Send any remaining updates
				if (batchNewNodes.length > 0 || batchNewEdges.length > 0) {
					onUpdate({
						newNodes: batchNewNodes,
						newEdges: batchNewEdges,
						filesScanned,
						totalFiles,
					});
				}

				const scanTime = perfMetrics.end(scanStart, 'buildGraphData:backlinkScan', {
					totalFiles,
					newNodesFound: newNodes.length,
					newEdgesFound: newEdges.length,
				});

				console.log(`[DocumentGraph] Backlink scan complete in ${scanTime.toFixed(0)}ms:`, {
					filesScanned,
					newNodesFound: newNodes.length,
					newEdgesFound: newEdges.length,
				});

				if (!aborted) {
					onComplete();
				}
			} catch (error) {
				console.error('[DocumentGraph] Backlink scan failed:', error);
				if (!aborted) {
					onComplete();
				}
			}
		};

		// Start the scan asynchronously
		runScan();

		// Return abort function
		return () => {
			aborted = true;
		};
	};

	return {
		nodes: documentNodes,
		edges: internalEdges,
		totalDocuments: visited.size,
		loadedDocuments: parsedFiles.length,
		hasMore,
		cachedExternalData,
		internalLinkCount,
		backlinksLoading: true,
		startBacklinkScan,
	};
}

/**
 * Get document node data from a node
 * Type guard for document nodes
 */
export function isDocumentNode(data: GraphNodeData): data is DocumentNodeData {
	return data.nodeType === 'document';
}

/**
 * Get external link node data from a node
 * Type guard for external link nodes
 */
export function isExternalLinkNode(data: GraphNodeData): data is ExternalLinkNodeData {
	return data.nodeType === 'external';
}

/**
 * Options for expanding a node's outgoing links
 */
export interface ExpandNodeOptions {
	/** Root directory path */
	rootPath: string;
	/** File path of the node to expand (relative to rootPath) */
	filePath: string;
	/** Set of file paths already loaded in the graph */
	loadedPaths: Set<string>;
	/** Maximum depth to traverse from the expanded node (default: 1) */
	maxDepth?: number;
	/** Optional SSH remote ID for remote file operations */
	sshRemoteId?: string;
}

/**
 * Result of expanding a node
 */
export interface ExpandNodeResult {
	/** New nodes discovered (documents that weren't already loaded) */
	newNodes: GraphNode[];
	/** New edges discovered (links from expanded node and new nodes) */
	newEdges: GraphEdge[];
	/** New external nodes discovered */
	newExternalNodes: GraphNode[];
	/** New external edges discovered */
	newExternalEdges: GraphEdge[];
	/** Updated set of loaded paths (original + new) */
	updatedLoadedPaths: Set<string>;
	/** Whether any new nodes were discovered */
	hasNewContent: boolean;
}

/**
 * Expand a node's outgoing links to discover new documents.
 * Used for "fan out" functionality when double-clicking an unexpanded node.
 *
 * @param options - Expansion options
 * @returns ExpandNodeResult with new nodes and edges to add to the graph
 */
export async function expandNode(options: ExpandNodeOptions): Promise<ExpandNodeResult> {
	const { rootPath, filePath, loadedPaths, maxDepth = 1, sshRemoteId } = options;

	console.log('[DocumentGraph] Expanding node:', {
		filePath,
		loadedPaths: loadedPaths.size,
		maxDepth,
	});

	const newNodes: GraphNode[] = [];
	const newEdges: GraphEdge[] = [];
	const newExternalNodes: GraphNode[] = [];
	const newExternalEdges: GraphEdge[] = [];
	const updatedLoadedPaths = new Set(loadedPaths);

	// Track external domains found during expansion
	const externalDomains = new Map<string, { count: number; urls: string[] }>();

	// Parse the source node to get its outgoing links
	const sourceParsed = await parseFileWithSsh(rootPath, filePath, sshRemoteId);
	if (!sourceParsed) {
		console.warn('[DocumentGraph] Failed to parse source node for expansion:', filePath);
		return {
			newNodes,
			newEdges,
			newExternalNodes,
			newExternalEdges,
			updatedLoadedPaths,
			hasNewContent: false,
		};
	}

	// BFS queue for new nodes to parse
	const queue: Array<{ path: string; depth: number }> = [];
	const visited = new Set<string>();

	// Add unloaded outgoing links to queue
	for (const link of sourceParsed.internalLinks) {
		if (!loadedPaths.has(link) && !visited.has(link)) {
			queue.push({ path: link, depth: 1 });
			visited.add(link);
		}
	}

	// Process source node's external links
	const sourceNodeId = `doc-${filePath}`;
	for (const externalLink of sourceParsed.externalLinks) {
		const existing = externalDomains.get(externalLink.domain);
		if (existing) {
			existing.count++;
			if (!existing.urls.includes(externalLink.url)) {
				existing.urls.push(externalLink.url);
			}
		} else {
			externalDomains.set(externalLink.domain, { count: 1, urls: [externalLink.url] });
		}

		const externalNodeId = `ext-${externalLink.domain}`;
		newExternalEdges.push({
			id: `edge-${sourceNodeId}-${externalNodeId}`,
			source: sourceNodeId,
			target: externalNodeId,
			type: 'external',
		});
	}

	// BFS to parse new nodes
	while (queue.length > 0) {
		const { path, depth } = queue.shift()!;

		// Skip if beyond max depth
		if (depth > maxDepth) continue;

		// Parse the file
		const parsed = await parseFileWithSsh(rootPath, path, sshRemoteId);
		if (!parsed) continue; // File doesn't exist or failed to parse

		// Add to loaded paths
		updatedLoadedPaths.add(path);

		// Create node
		const nodeId = `doc-${path}`;
		newNodes.push({
			id: nodeId,
			type: 'documentNode',
			data: {
				nodeType: 'document',
				...parsed.stats,
			},
		});

		// Create edge from source or parent to this node
		// We need to find which loaded node links to this one
		// For simplicity, we create the edge from the source node
		if (depth === 1) {
			// Direct child of expanded node
			newEdges.push({
				id: `edge-${sourceNodeId}-${nodeId}`,
				source: sourceNodeId,
				target: nodeId,
				type: 'default',
			});
		}

		// Process this node's outgoing links
		if (depth < maxDepth) {
			for (const link of parsed.internalLinks) {
				if (!loadedPaths.has(link) && !visited.has(link) && !updatedLoadedPaths.has(link)) {
					queue.push({ path: link, depth: depth + 1 });
					visited.add(link);
				}
			}
		}

		// Create edges to already-loaded nodes
		for (const link of parsed.internalLinks) {
			if (loadedPaths.has(link) || updatedLoadedPaths.has(link)) {
				const targetNodeId = `doc-${link}`;
				// Avoid duplicate edges
				const edgeId = `edge-${nodeId}-${targetNodeId}`;
				if (!newEdges.some((e) => e.id === edgeId)) {
					newEdges.push({
						id: edgeId,
						source: nodeId,
						target: targetNodeId,
						type: 'default',
					});
				}
			}
		}

		// Process external links
		for (const externalLink of parsed.externalLinks) {
			const existing = externalDomains.get(externalLink.domain);
			if (existing) {
				existing.count++;
				if (!existing.urls.includes(externalLink.url)) {
					existing.urls.push(externalLink.url);
				}
			} else {
				externalDomains.set(externalLink.domain, { count: 1, urls: [externalLink.url] });
			}

			const externalNodeId = `ext-${externalLink.domain}`;
			newExternalEdges.push({
				id: `edge-${nodeId}-${externalNodeId}`,
				source: nodeId,
				target: externalNodeId,
				type: 'external',
			});
		}

		// Yield to event loop periodically
		if (newNodes.length % BATCH_SIZE_BEFORE_YIELD === 0) {
			await yieldToEventLoop();
		}
	}

	// Build external domain nodes
	for (const [domain, data] of externalDomains) {
		newExternalNodes.push({
			id: `ext-${domain}`,
			type: 'externalLinkNode',
			data: {
				nodeType: 'external',
				domain,
				linkCount: data.count,
				urls: data.urls,
			},
		});
	}

	console.log('[DocumentGraph] Node expansion complete:', {
		filePath,
		newNodes: newNodes.length,
		newEdges: newEdges.length,
		newExternalNodes: newExternalNodes.length,
	});

	return {
		newNodes,
		newEdges,
		newExternalNodes,
		newExternalEdges,
		updatedLoadedPaths,
		hasNewContent: newNodes.length > 0 || newExternalNodes.length > 0,
	};
}

/**
 * Parse a file with optional SSH support.
 * Wrapper around parseFile that handles SSH remote operations.
 */
async function parseFileWithSsh(
	rootPath: string,
	relativePath: string,
	sshRemoteId?: string
): Promise<ParsedFile | null> {
	const fullPath = `${rootPath}/${relativePath}`;

	try {
		// Get file stats
		const stat = await window.maestro.fs.stat(fullPath, sshRemoteId);
		if (!stat) {
			console.warn(`[DocumentGraph] parseFileWithSsh: stat returned null for ${fullPath}`);
			return null;
		}
		const fileSize = stat.size ?? 0;
		const fileMtime = stat.modifiedAt ? new Date(stat.modifiedAt).getTime() : 0;
		const isLargeFile = fileSize > LARGE_FILE_THRESHOLD;

		// Check cache (only for local files)
		if (!sshRemoteId) {
			const cached = parsedFileCache.get(fullPath);
			if (cached && cached.mtime === fileMtime) {
				return cached.data;
			}
		}

		// Read file content
		const content = await window.maestro.fs.readFile(fullPath, sshRemoteId);
		if (content === null || content === undefined) {
			console.warn(`[DocumentGraph] parseFileWithSsh: readFile returned null for ${fullPath}`);
			return null;
		}

		// For large files, truncate content for parsing
		let contentForParsing = content;
		if (isLargeFile && content.length > LARGE_FILE_PARSE_LIMIT) {
			contentForParsing = content.substring(0, LARGE_FILE_PARSE_LIMIT);
		}

		// Parse links from content
		const { internalLinks, externalLinks } = parseMarkdownLinks(contentForParsing, relativePath);

		// Compute document statistics
		const stats = computeDocumentStats(contentForParsing, relativePath, fileSize);

		if (isLargeFile) {
			stats.isLargeFile = true;
		}

		const parsed: ParsedFile = {
			relativePath,
			fullPath,
			fileSize,
			internalLinks,
			externalLinks,
			stats,
			allInternalLinkPaths: internalLinks,
		};

		// Cache the result (only for local files)
		if (!sshRemoteId) {
			parsedFileCache.set(fullPath, { data: parsed, mtime: fileMtime });
		}

		return parsed;
	} catch (error) {
		console.warn(`Failed to parse file ${fullPath}:`, error);
		return null;
	}
}

/**
 * Parse a file's links only with optional SSH support.
 * Lightweight version that only extracts links, not full stats.
 */
async function parseFileLinksOnlyWithSsh(
	rootPath: string,
	relativePath: string,
	sshRemoteId?: string
): Promise<LinkIndexEntry | null> {
	const fullPath = `${rootPath}/${relativePath}`;

	try {
		// Get file stats
		const stat = await window.maestro.fs.stat(fullPath, sshRemoteId);
		if (!stat) {
			return null;
		}
		const fileSize = stat.size ?? 0;
		const fileMtime = stat.modifiedAt ? new Date(stat.modifiedAt).getTime() : 0;
		const isLargeFile = fileSize > LARGE_FILE_THRESHOLD;

		// Check cache (only for local files)
		if (!sshRemoteId) {
			const cached = parsedFileCache.get(fullPath);
			if (cached && cached.mtime === fileMtime) {
				return {
					relativePath,
					outgoingLinks: cached.data.internalLinks,
				};
			}
		}

		// Read file content
		const content = await window.maestro.fs.readFile(fullPath, sshRemoteId);
		if (content === null || content === undefined) {
			return null;
		}

		// For large files, truncate content for parsing
		let contentForParsing = content;
		if (isLargeFile && content.length > LARGE_FILE_PARSE_LIMIT) {
			contentForParsing = content.substring(0, LARGE_FILE_PARSE_LIMIT);
		}

		// Parse links from content (only need internal links for index)
		const { internalLinks } = parseMarkdownLinks(contentForParsing, relativePath);

		return {
			relativePath,
			outgoingLinks: internalLinks,
		};
	} catch {
		// Silently fail - file may not exist or be unreadable
		return null;
	}
}

export default buildGraphData;
