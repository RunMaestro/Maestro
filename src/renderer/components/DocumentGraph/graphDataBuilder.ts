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
}

/**
 * Progress callback function type
 */
export type ProgressCallback = (progress: ProgressData) => void;

/**
 * Options for building the graph data
 */
export interface BuildOptions {
  /** Whether to include external link nodes in the graph */
  includeExternalLinks: boolean;
  /** Root directory path to scan for markdown files */
  rootPath: string;
  /** Maximum number of document nodes to include (for performance with large directories) */
  maxNodes?: number;
  /** Number of nodes to skip (for pagination/load more) */
  offset?: number;
  /** Optional callback for progress updates during scanning and parsing */
  onProgress?: ProgressCallback;
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
 * Recursively scan a directory for all markdown files
 * @param rootPath - Root directory to scan
 * @param onProgress - Optional callback for progress updates (reports number of directories scanned)
 * @returns Array of file paths relative to root
 */
async function scanMarkdownFiles(
  rootPath: string,
  onProgress?: ProgressCallback
): Promise<string[]> {
  const markdownFiles: string[] = [];
  let directoriesScanned = 0;
  let isRootDirectory = true;

  async function scanDir(currentPath: string, relativePath: string): Promise<void> {
    const isRoot = isRootDirectory;
    isRootDirectory = false;

    try {
      const entries = await window.maestro.fs.readDir(currentPath);
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
 * Parse a single markdown file and extract its data.
 * For large files (>1MB), content is truncated to prevent UI blocking.
 *
 * @param rootPath - Root directory path
 * @param relativePath - Path relative to root
 * @returns Parsed file data or null if reading fails
 */
async function parseFile(rootPath: string, relativePath: string): Promise<ParsedFile | null> {
  const fullPath = `${rootPath}/${relativePath}`;

  try {
    // Get file stats first to check size
    const stat = await window.maestro.fs.stat(fullPath);
    const fileSize = stat?.size ?? 0;
    const isLargeFile = fileSize > LARGE_FILE_THRESHOLD;

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
    return {
      relativePath,
      fullPath,
      fileSize,
      internalLinks,
      externalLinks,
      stats,
      allInternalLinkPaths: internalLinks, // Store all links to identify broken ones later
    };
  } catch (error) {
    console.warn(`Failed to parse file ${fullPath}:`, error);
    return null;
  }
}

/**
 * Build graph data from a directory of markdown files
 *
 * @param options - Build configuration options
 * @returns GraphData with nodes and edges
 */
export async function buildGraphData(options: BuildOptions): Promise<GraphData> {
  const { rootPath, includeExternalLinks, maxNodes, offset = 0, onProgress } = options;

  const buildStart = perfMetrics.start();

  // Step 1: Scan for all markdown files
  const scanStart = perfMetrics.start();
  const markdownPaths = await scanMarkdownFiles(rootPath, onProgress);
  const totalDocuments = markdownPaths.length;
  perfMetrics.end(scanStart, 'buildGraphData:scan', {
    totalDocuments,
    rootPath: rootPath.split('/').slice(-2).join('/'), // Last 2 path segments for privacy
  });

  // Step 2: Apply pagination if maxNodes is set
  let pathsToProcess = markdownPaths;
  if (maxNodes !== undefined && maxNodes > 0) {
    pathsToProcess = markdownPaths.slice(offset, offset + maxNodes);
  }

  // Step 3: Parse the files we're processing
  // We yield to the event loop every BATCH_SIZE_BEFORE_YIELD files to prevent UI blocking
  const parseStart = perfMetrics.start();
  const parsedFiles: ParsedFile[] = [];
  for (let i = 0; i < pathsToProcess.length; i++) {
    const relativePath = pathsToProcess[i];

    // Report parsing progress
    if (onProgress) {
      onProgress({
        phase: 'parsing',
        current: i + 1,
        total: pathsToProcess.length,
        currentFile: relativePath,
      });
    }

    const parsed = await parseFile(rootPath, relativePath);
    if (parsed) {
      parsedFiles.push(parsed);
    }

    // Yield to event loop periodically to prevent UI blocking
    // This is especially important when processing many files or large files
    if ((i + 1) % BATCH_SIZE_BEFORE_YIELD === 0) {
      await yieldToEventLoop();
    }
  }
  perfMetrics.end(parseStart, 'buildGraphData:parse', {
    fileCount: pathsToProcess.length,
    parsedCount: parsedFiles.length,
  });

  // Create a set of known file paths for validating internal links
  // Note: We use ALL known paths (not just loaded ones) to allow edges to connect properly
  const knownPaths = new Set(markdownPaths);
  // Track which files we've loaded for edge filtering
  const loadedPaths = new Set(parsedFiles.map((f) => f.relativePath));

  // Step 4: Build document nodes
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Track external domains for deduplication
  const externalDomains = new Map<string, { count: number; urls: string[] }>();

  for (let i = 0; i < parsedFiles.length; i++) {
    const file = parsedFiles[i];
    const nodeId = `doc-${file.relativePath}`;

    // Identify broken links (links to files that don't exist in the scanned directory)
    const brokenLinks = file.allInternalLinkPaths.filter((link) => !knownPaths.has(link));

    // Create document node
    nodes.push({
      id: nodeId,
      type: 'documentNode',
      data: {
        nodeType: 'document',
        ...file.stats,
        // Only include brokenLinks if there are any
        ...(brokenLinks.length > 0 ? { brokenLinks } : {}),
      },
    });

    // Create edges for internal links
    for (const internalLink of file.internalLinks) {
      // Only create edge if target file exists AND is loaded (to avoid dangling edges)
      if (knownPaths.has(internalLink) && loadedPaths.has(internalLink)) {
        const targetNodeId = `doc-${internalLink}`;
        edges.push({
          id: `edge-${nodeId}-${targetNodeId}`,
          source: nodeId,
          target: targetNodeId,
          type: 'default',
        });
      }
    }

    // Collect external links if enabled
    if (includeExternalLinks) {
      for (const externalLink of file.externalLinks) {
        const existing = externalDomains.get(externalLink.domain);
        if (existing) {
          existing.count++;
          if (!existing.urls.includes(externalLink.url)) {
            existing.urls.push(externalLink.url);
          }
        } else {
          externalDomains.set(externalLink.domain, {
            count: 1,
            urls: [externalLink.url],
          });
        }

        // Create edge from document to external domain
        const externalNodeId = `ext-${externalLink.domain}`;
        edges.push({
          id: `edge-${nodeId}-${externalNodeId}`,
          source: nodeId,
          target: externalNodeId,
          type: 'external',
        });
      }
    }
  }

  // Step 5: Create external domain nodes if enabled
  if (includeExternalLinks) {
    for (const [domain, data] of externalDomains) {
      nodes.push({
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
  }

  // Calculate pagination info
  const loadedDocuments = parsedFiles.length;
  const hasMore = maxNodes !== undefined && maxNodes > 0 && offset + loadedDocuments < totalDocuments;

  // Log total build time with performance threshold check
  const totalBuildTime = perfMetrics.end(buildStart, 'buildGraphData:total', {
    totalDocuments,
    loadedDocuments,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    includeExternalLinks,
  });

  // Warn if build time exceeds thresholds
  const threshold = totalDocuments < 100
    ? PERFORMANCE_THRESHOLDS.GRAPH_BUILD_SMALL
    : PERFORMANCE_THRESHOLDS.GRAPH_BUILD_LARGE;
  if (totalBuildTime > threshold) {
    console.warn(
      `[DocumentGraph] buildGraphData took ${totalBuildTime.toFixed(0)}ms (threshold: ${threshold}ms)`,
      { totalDocuments, nodeCount: nodes.length, edgeCount: edges.length }
    );
  }

  return { nodes, edges, totalDocuments, loadedDocuments, hasMore };
}

/**
 * Get document node data from a node
 * Type guard for document nodes
 */
export function isDocumentNode(
  data: GraphNodeData
): data is DocumentNodeData {
  return data.nodeType === 'document';
}

/**
 * Get external link node data from a node
 * Type guard for external link nodes
 */
export function isExternalLinkNode(
  data: GraphNodeData
): data is ExternalLinkNodeData {
  return data.nodeType === 'external';
}

export default buildGraphData;
