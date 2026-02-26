/**
 * DocumentGraphView - Main container component for the markdown document graph visualization.
 *
 * Uses a canvas-based MindMap component with deterministic layout.
 *
 * Features:
 * - Centered mind map layout with focus document in the middle
 * - Left/right columns for alphabetized document links
 * - External URLs clustered at the bottom
 * - Neighbor depth slider for focused ego-network views
 * - Search highlighting
 * - Keyboard navigation (arrow keys, Enter to recenter, O to open)
 * - Theme-aware styling throughout
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	X,
	Network,
	ExternalLink,
	RefreshCw,
	Search,
	Loader2,
	ChevronDown,
	Sliders,
	AlertCircle,
	RotateCcw,
	HelpCircle,
	Calendar,
	CheckSquare,
	Type,
	ChevronLeft,
	ChevronRight,
} from 'lucide-react';
import type { Theme } from '../../types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Modal, ModalFooter } from '../ui/Modal';
import { useDebouncedCallback } from '../../hooks/utils';
import {
	buildGraphData,
	ProgressData,
	GraphNodeData,
	CachedExternalData,
	invalidateCacheForFiles,
	BacklinkUpdateData,
	GraphData,
} from './graphDataBuilder';
import {
	MindMap,
	MindMapNode,
	MindMapLink,
	convertToMindMapData,
	NodePositionOverride,
} from './MindMap';
import { type MindMapLayoutType, LAYOUT_LABELS } from './mindMapLayouts';
import { NodeContextMenu } from './NodeContextMenu';
import { GraphLegend } from './GraphLegend';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { generateProseStyles } from '../../utils/markdownConfig';
import type { FileNode } from '../../types/fileTree';

/** Debounce delay for graph rebuilds when settings change (ms) */
const GRAPH_REBUILD_DEBOUNCE_DELAY = 300;

/**
 * Build a file tree structure from graph node file paths.
 * This enables wiki-link resolution in the preview panel.
 */
function buildFileTreeFromPaths(filePaths: string[]): FileNode[] {
	const root: FileNode[] = [];
	const folderMap = new Map<string, FileNode>();

	for (const filePath of filePaths) {
		if (!filePath) continue;

		const parts = filePath.split('/');
		let currentLevel = root;
		let currentPath = '';

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLastPart = i === parts.length - 1;
			currentPath = currentPath ? `${currentPath}/${part}` : part;

			if (isLastPart) {
				// It's a file
				currentLevel.push({
					name: part,
					type: 'file',
					fullPath: filePath,
				});
			} else {
				// It's a folder - check if it already exists
				let folder = folderMap.get(currentPath);
				if (!folder) {
					folder = {
						name: part,
						type: 'folder',
						isFolder: true,
						children: [],
					};
					folderMap.set(currentPath, folder);
					currentLevel.push(folder);
				}
				currentLevel = folder.children!;
			}
		}
	}

	return root;
}
/** Default maximum number of nodes to load initially */
const DEFAULT_MAX_NODES = 200;
/** Number of additional nodes to load when clicking "Load more" */
const LOAD_MORE_INCREMENT = 25;

/**
 * Count markdown tasks (checkboxes) in content
 * Reuses pattern from FilePreview.tsx
 */
const countMarkdownTasks = (content: string): { completed: number; total: number } => {
	const openMatches = content.match(/^[\s]*[-*]\s*\[\s*\]/gm);
	const closedMatches = content.match(/^[\s]*[-*]\s*\[[xX]\]/gm);
	const open = openMatches?.length || 0;
	const closed = closedMatches?.length || 0;
	return { completed: closed, total: open + closed };
};

/**
 * Format date for display in footer
 */
const formatDate = (date: Date): string => {
	return date.toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
};

/**
 * Props for the DocumentGraphView component
 */
export interface DocumentGraphViewProps {
	/** Whether the modal is open */
	isOpen: boolean;
	/** Callback to close the modal */
	onClose: () => void;
	/** Current theme */
	theme: Theme;
	/** Root directory path to scan for markdown files */
	rootPath: string;
	/** Optional callback when a document node is double-clicked */
	onDocumentOpen?: (filePath: string) => void;
	/** Optional callback when an external link node is double-clicked */
	onExternalLinkOpen?: (url: string) => void;
	/** Required file path (relative to rootPath) to focus on - the center of the mind map */
	focusFilePath: string;
	/** Callback when focus file is consumed (cleared after focusing) */
	onFocusFileConsumed?: () => void;
	/** Default setting for showing external links (from settings) */
	defaultShowExternalLinks?: boolean;
	/** Callback to persist external links toggle changes */
	onExternalLinksChange?: (show: boolean) => void;
	/** Default maximum number of nodes to load (from settings) */
	defaultMaxNodes?: number;
	/** Default neighbor depth for focus mode (from settings) */
	defaultNeighborDepth?: number;
	/** Callback to persist neighbor depth changes */
	onNeighborDepthChange?: (depth: number) => void;
	/** Default preview character limit (from settings) */
	defaultPreviewCharLimit?: number;
	/** Callback to persist preview character limit changes */
	onPreviewCharLimitChange?: (limit: number) => void;
	/** Default layout algorithm type (from settings, with per-agent override) */
	defaultLayoutType?: MindMapLayoutType;
	/** Callback to persist layout type changes */
	onLayoutTypeChange?: (type: MindMapLayoutType) => void;
	/** Optional SSH remote ID - if provided, shows unavailable message (can't scan remote filesystem) */
	sshRemoteId?: string;
}

/**
 * DocumentGraphView component
 */
export function DocumentGraphView({
	isOpen,
	onClose,
	theme,
	rootPath,
	onDocumentOpen,
	onExternalLinkOpen,
	focusFilePath,
	onFocusFileConsumed: _onFocusFileConsumed,
	defaultShowExternalLinks = false,
	onExternalLinksChange,
	defaultMaxNodes = DEFAULT_MAX_NODES,
	defaultNeighborDepth = 2,
	onNeighborDepthChange,
	defaultPreviewCharLimit = 100,
	onPreviewCharLimitChange,
	defaultLayoutType = 'mindmap',
	onLayoutTypeChange,
	sshRemoteId,
}: DocumentGraphViewProps) {
	// Graph data state
	const [nodes, setNodes] = useState<MindMapNode[]>([]);
	const [links, setLinks] = useState<MindMapLink[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [progress, setProgress] = useState<ProgressData | null>(null);

	// Settings state
	const [includeExternalLinks, setIncludeExternalLinks] = useState(defaultShowExternalLinks);
	const [neighborDepth, setNeighborDepth] = useState(defaultNeighborDepth);
	const [showDepthSlider, setShowDepthSlider] = useState(false);
	const [previewCharLimit, setPreviewCharLimit] = useState(defaultPreviewCharLimit);
	const [showPreviewSlider, setShowPreviewSlider] = useState(false);
	const [layoutType, setLayoutType] = useState<MindMapLayoutType>(defaultLayoutType);
	const [showLayoutDropdown, setShowLayoutDropdown] = useState(false);

	// Selection state
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [selectedNode, setSelectedNode] = useState<MindMapNode | null>(null);
	const [searchQuery, setSearchQuery] = useState('');

	// Preview panel state
	const [previewFile, setPreviewFile] = useState<{
		path: string;
		relativePath: string;
		name: string;
		content: string;
	} | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);

	// Preview navigation history (for back/forward through wiki link clicks)
	const [previewHistory, setPreviewHistory] = useState<
		Array<{ path: string; relativePath: string; name: string; content: string }>
	>([]);
	const [previewHistoryIndex, setPreviewHistoryIndex] = useState(-1);

	// All markdown files discovered during scanning (for wiki-link resolution)
	const [allMarkdownFiles, setAllMarkdownFiles] = useState<string[]>([]);

	// Build file tree from ALL markdown files for wiki-link resolution in preview
	// This enables linking to files that aren't currently loaded in the graph view
	const previewFileTree = useMemo(() => {
		return buildFileTreeFromPaths(allMarkdownFiles);
	}, [allMarkdownFiles]);

	// Pagination state
	const [totalDocuments, setTotalDocuments] = useState(0);
	const [loadedDocuments, setLoadedDocuments] = useState(0);
	const [hasMore, setHasMore] = useState(false);
	const [maxNodes, setMaxNodes] = useState(defaultMaxNodes);

	// Cached external data for instant toggling (without re-scanning)
	const [_cachedExternalData, setCachedExternalData] = useState<CachedExternalData | null>(null);
	const [_internalLinkCount, setInternalLinkCount] = useState(0);

	// Store already-converted MindMap nodes/links for toggling (with all required fields)
	const [documentOnlyNodes, setDocumentOnlyNodes] = useState<MindMapNode[]>([]);
	const [documentOnlyLinks, setDocumentOnlyLinks] = useState<MindMapLink[]>([]);
	const [allNodesWithExternal, setAllNodesWithExternal] = useState<MindMapNode[]>([]);
	const [allLinksWithExternal, setAllLinksWithExternal] = useState<MindMapLink[]>([]);

	// Context menu state
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		nodeId: string;
		nodeData: GraphNodeData;
	} | null>(null);

	// Close confirmation modal state
	const [showCloseConfirmation, setShowCloseConfirmation] = useState(false);
	const confirmCloseButtonRef = useRef<HTMLButtonElement>(null);

	// Container refs
	const containerRef = useRef<HTMLDivElement>(null);
	const graphContainerRef = useRef<HTMLDivElement>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const mindMapContainerRef = useRef<HTMLDivElement>(null);
	const previewContentRef = useRef<HTMLDivElement>(null);
	const [graphDimensions, setGraphDimensions] = useState({ width: 800, height: 600 });

	// Layer stack for escape handling
	const { registerLayer, unregisterLayer } = useLayerStack();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Track whether data has been loaded
	const hasLoadedDataRef = useRef(false);
	const prevRootPathRef = useRef(rootPath);

	// Focus file tracking - activeFocusFile is the current center of the mind map
	// Initially set from props, but can change when user double-clicks a node
	const [activeFocusFile, setActiveFocusFile] = useState<string | null>(focusFilePath);

	// Track if legend is expanded for layer stack
	const [legendExpanded, setLegendExpanded] = useState(false);

	// Node position overrides from user drag operations
	// Persisted across modal close/reopen, cleared on focus/depth changes
	const [nodePositions, setNodePositions] = useState<Map<string, NodePositionOverride>>(new Map());

	// Track the focus/depth that the positions were created for
	const positionsContextRef = useRef<{ focusFile: string | null; depth: number } | null>(null);

	// Selected node file stats (created/modified dates)
	const [selectedNodeStats, setSelectedNodeStats] = useState<{
		createdAt: Date | null;
		modifiedAt: Date | null;
	} | null>(null);

	// Selected node task counts
	const [selectedNodeTasks, setSelectedNodeTasks] = useState<{
		completed: number;
		total: number;
	} | null>(null);

	// Backlink loading state
	const [backlinksLoading, setBacklinksLoading] = useState(false);
	const [backlinkProgress, setBacklinkProgress] = useState<{
		scanned: number;
		total: number;
	} | null>(null);
	const abortBacklinkScanRef = useRef<(() => void) | null>(null);
	const currentGraphDataRef = useRef<GraphData | null>(null);

	/**
	 * Handle escape - show confirmation modal
	 */
	const handleEscapeRequest = useCallback(() => {
		setShowCloseConfirmation(true);
	}, []);

	/**
	 * Register with layer stack for Escape handling
	 */
	useEffect(() => {
		if (isOpen) {
			const id = registerLayer({
				type: 'modal',
				priority: MODAL_PRIORITIES.DOCUMENT_GRAPH,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'lenient',
				onEscape: handleEscapeRequest,
			});
			return () => unregisterLayer(id);
		}
	}, [isOpen, registerLayer, unregisterLayer, handleEscapeRequest]);

	/**
	 * Register depth slider dropdown with layer stack when open
	 */
	useEffect(() => {
		if (showDepthSlider) {
			const id = registerLayer({
				type: 'overlay',
				priority: MODAL_PRIORITIES.DOCUMENT_GRAPH + 1,
				blocksLowerLayers: false,
				capturesFocus: false,
				focusTrap: 'none',
				allowClickOutside: true,
				onEscape: () => setShowDepthSlider(false),
			});
			return () => unregisterLayer(id);
		}
	}, [showDepthSlider, registerLayer, unregisterLayer]);

	/**
	 * Register layout dropdown with layer stack when open
	 */
	useEffect(() => {
		if (showLayoutDropdown) {
			const id = registerLayer({
				type: 'overlay',
				priority: MODAL_PRIORITIES.DOCUMENT_GRAPH + 1,
				blocksLowerLayers: false,
				capturesFocus: false,
				focusTrap: 'none',
				allowClickOutside: true,
				onEscape: () => setShowLayoutDropdown(false),
			});
			return () => unregisterLayer(id);
		}
	}, [showLayoutDropdown, registerLayer, unregisterLayer]);

	/**
	 * Register legend with layer stack when expanded
	 */
	useEffect(() => {
		if (legendExpanded) {
			const id = registerLayer({
				type: 'overlay',
				priority: MODAL_PRIORITIES.DOCUMENT_GRAPH + 1,
				blocksLowerLayers: false,
				capturesFocus: false,
				focusTrap: 'none',
				allowClickOutside: true,
				onEscape: () => setLegendExpanded(false),
			});
			return () => unregisterLayer(id);
		}
	}, [legendExpanded, registerLayer, unregisterLayer]);

	/**
	 * Focus container on open
	 */
	useEffect(() => {
		if (isOpen) {
			containerRef.current?.focus();
		}
	}, [isOpen]);

	/**
	 * Focus mind map container when graph finishes loading
	 * This enables immediate keyboard navigation
	 */
	useEffect(() => {
		if (isOpen && !loading && !error && nodes.length > 0 && activeFocusFile) {
			// Small delay to ensure MindMap is rendered
			requestAnimationFrame(() => {
				mindMapContainerRef.current?.focus();
			});
		}
	}, [isOpen, loading, error, nodes.length, activeFocusFile]);

	/**
	 * Track graph container dimensions
	 */
	useEffect(() => {
		if (!isOpen || !graphContainerRef.current) return;

		const updateDimensions = () => {
			if (graphContainerRef.current) {
				const rect = graphContainerRef.current.getBoundingClientRect();
				setGraphDimensions({ width: rect.width, height: rect.height });
			}
		};

		updateDimensions();

		const resizeObserver = new ResizeObserver(updateDimensions);
		resizeObserver.observe(graphContainerRef.current);

		return () => resizeObserver.disconnect();
	}, [isOpen]);

	/**
	 * Handle progress updates from graphDataBuilder
	 */
	const handleProgress = useCallback((progressData: ProgressData) => {
		setProgress(progressData);
	}, []);

	/**
	 * Handle backlink updates from background scan
	 */
	const handleBacklinkUpdate = useCallback(
		(updateData: BacklinkUpdateData) => {
			setBacklinkProgress({ scanned: updateData.filesScanned, total: updateData.totalFiles });

			if (updateData.newNodes.length > 0 || updateData.newEdges.length > 0) {
				// Convert new nodes/edges to MindMap format and add them
				const { nodes: newMindMapNodes, links: newMindMapLinks } = convertToMindMapData(
					updateData.newNodes.map((n) => ({ id: n.id, data: n.data })),
					updateData.newEdges.map((e) => ({ source: e.source, target: e.target, type: e.type })),
					previewCharLimit
				);

				// Add new nodes/links to all our cached states
				setNodes((prev) => [...prev, ...newMindMapNodes]);
				setLinks((prev) => [...prev, ...newMindMapLinks]);
				setDocumentOnlyNodes((prev) => [...prev, ...newMindMapNodes]);
				setDocumentOnlyLinks((prev) => [...prev, ...newMindMapLinks]);
				setAllNodesWithExternal((prev) => [...prev, ...newMindMapNodes]);
				setAllLinksWithExternal((prev) => [...prev, ...newMindMapLinks]);
				setLoadedDocuments((prev) => prev + updateData.newNodes.length);

				console.log('[DocumentGraph] Added backlinks:', {
					newNodes: updateData.newNodes.length,
					newEdges: updateData.newEdges.length,
					progress: `${updateData.filesScanned}/${updateData.totalFiles}`,
				});
			}
		},
		[previewCharLimit]
	);

	/**
	 * Handle backlink scan completion
	 */
	const handleBacklinkComplete = useCallback(() => {
		setBacklinksLoading(false);
		setBacklinkProgress(null);
		abortBacklinkScanRef.current = null;
		console.log('[DocumentGraph] Backlink scan complete');
	}, []);

	/**
	 * Load and build graph data
	 */
	const loadGraphData = useCallback(
		async (resetPagination = true) => {
			// Abort any ongoing backlink scan
			if (abortBacklinkScanRef.current) {
				abortBacklinkScanRef.current();
				abortBacklinkScanRef.current = null;
			}

			setLoading(true);
			setError(null);
			setProgress(null);
			setBacklinksLoading(false);
			setBacklinkProgress(null);

			if (resetPagination) {
				setMaxNodes(defaultMaxNodes);
			}

			try {
				console.log('[DocumentGraph] Building graph data:', {
					rootPath,
					focusFilePath,
					includeExternalLinks,
					sshRemoteId: !!sshRemoteId,
				});

				const graphData = await buildGraphData({
					rootPath,
					focusFile: focusFilePath,
					maxDepth: neighborDepth > 0 ? neighborDepth : 10, // Use large depth for "all"
					maxNodes: resetPagination ? defaultMaxNodes : maxNodes,
					onProgress: handleProgress,
					sshRemoteId,
				});

				// Store reference to current graph data for backlink scanning
				currentGraphDataRef.current = graphData;

				console.log('[DocumentGraph] Graph data built (outgoing links only):', {
					totalDocuments: graphData.totalDocuments,
					loadedDocuments: graphData.loadedDocuments,
					nodeCount: graphData.nodes.length,
					edgeCount: graphData.edges.length,
					internalLinkCount: graphData.internalLinkCount,
					externalLinkCount: graphData.cachedExternalData.totalLinkCount,
					externalDomains: graphData.cachedExternalData.domainCount,
					sampleNodeIds: graphData.nodes.slice(0, 5).map((n) => n.id),
				});

				// Update pagination state
				setTotalDocuments(graphData.totalDocuments);
				setLoadedDocuments(graphData.loadedDocuments);
				setHasMore(graphData.hasMore);

				// Store all markdown files for wiki-link resolution in preview panel
				setAllMarkdownFiles(graphData.allMarkdownFiles);

				// Cache external data and link counts for instant toggling
				setCachedExternalData(graphData.cachedExternalData);
				setInternalLinkCount(graphData.internalLinkCount);

				// Convert document-only nodes/links to mind map format (for toggling)
				const docOnlyNodes = graphData.nodes.filter((n) => n.type === 'documentNode');
				const docOnlyEdges = graphData.edges.filter((e) => e.type !== 'external');
				const { nodes: docMindMapNodes, links: docMindMapLinks } = convertToMindMapData(
					docOnlyNodes.map((n) => ({ id: n.id, data: n.data })),
					docOnlyEdges.map((e) => ({ source: e.source, target: e.target, type: e.type })),
					previewCharLimit
				);
				setDocumentOnlyNodes(docMindMapNodes);
				setDocumentOnlyLinks(docMindMapLinks);

				// Convert ALL nodes/links (with external) to mind map format (for toggling)
				const allNodes = [...docOnlyNodes, ...graphData.cachedExternalData.externalNodes];
				const allEdges = [...docOnlyEdges, ...graphData.cachedExternalData.externalEdges];
				const { nodes: allMindMapNodes, links: allMindMapLinks } = convertToMindMapData(
					allNodes.map((n) => ({ id: n.id, data: n.data })),
					allEdges.map((e) => ({ source: e.source, target: e.target, type: e.type })),
					previewCharLimit
				);
				setAllNodesWithExternal(allMindMapNodes);
				setAllLinksWithExternal(allMindMapLinks);

				// Set current display based on includeExternalLinks setting
				const mindMapNodes = includeExternalLinks ? allMindMapNodes : docMindMapNodes;
				const mindMapLinks = includeExternalLinks ? allMindMapLinks : docMindMapLinks;

				console.log('[DocumentGraph] Converted to mind map format:', {
					nodeCount: mindMapNodes.length,
					linkCount: mindMapLinks.length,
					docOnlyCount: docMindMapNodes.length,
					withExternalCount: allMindMapNodes.length,
					sampleFilePaths: mindMapNodes
						.filter((n) => n.nodeType === 'document')
						.slice(0, 5)
						.map((n) => n.filePath),
					focusFilePath,
				});

				setNodes(mindMapNodes);
				setLinks(mindMapLinks);

				// Set active focus file from the required focusFilePath prop
				setActiveFocusFile(focusFilePath);

				// Start background backlink scan after initial graph is displayed
				if (graphData.startBacklinkScan) {
					setBacklinksLoading(true);
					abortBacklinkScanRef.current = graphData.startBacklinkScan(
						handleBacklinkUpdate,
						handleBacklinkComplete
					);
				}
			} catch (err) {
				console.error('Failed to build graph data:', err);
				setError(err instanceof Error ? err.message : 'Failed to load document graph');
			} finally {
				setLoading(false);
			}
		},
		[
			rootPath,
			includeExternalLinks,
			maxNodes,
			defaultMaxNodes,
			handleProgress,
			focusFilePath,
			neighborDepth,
			previewCharLimit,
			handleBacklinkUpdate,
			handleBacklinkComplete,
			sshRemoteId,
		]
	);

	/**
	 * Debounced version of loadGraphData for settings changes
	 */
	const { debouncedCallback: debouncedLoadGraphData, cancel: cancelDebouncedLoad } =
		useDebouncedCallback(() => loadGraphData(), GRAPH_REBUILD_DEBOUNCE_DELAY);

	/**
	 * Load data when modal opens or settings change
	 */
	useEffect(() => {
		if (!isOpen) return;

		const rootPathChanged = prevRootPathRef.current !== rootPath;
		prevRootPathRef.current = rootPath;

		const needsInitialLoad = !hasLoadedDataRef.current || rootPathChanged;

		if (needsInitialLoad) {
			hasLoadedDataRef.current = true;
			loadGraphData();
		}
	}, [isOpen, rootPath, loadGraphData]);

	/**
	 * Toggle external links using cached data (no re-scan needed)
	 */
	useEffect(() => {
		// Only toggle if we have cached data and the modal is showing post-initial-load
		if (!isOpen || !hasLoadedDataRef.current) return;
		if (documentOnlyNodes.length === 0 && allNodesWithExternal.length === 0) return;

		// Use pre-converted cached data to instantly toggle external links on/off
		if (includeExternalLinks) {
			setNodes(allNodesWithExternal);
			setLinks(allLinksWithExternal);
			console.log('[DocumentGraph] Added external links from cache:', {
				totalNodes: allNodesWithExternal.length,
				totalLinks: allLinksWithExternal.length,
			});
		} else {
			setNodes(documentOnlyNodes);
			setLinks(documentOnlyLinks);
			console.log('[DocumentGraph] Removed external links (using cached document-only data):', {
				totalNodes: documentOnlyNodes.length,
				totalLinks: documentOnlyLinks.length,
			});
		}
	}, [
		includeExternalLinks,
		isOpen,
		documentOnlyNodes,
		documentOnlyLinks,
		allNodesWithExternal,
		allLinksWithExternal,
	]);

	/**
	 * Recalculate node heights when previewCharLimit changes
	 * The layout is recalculated in MindMap, but we need to update the cached node heights
	 */
	useEffect(() => {
		if (!isOpen || !hasLoadedDataRef.current) return;
		// Trigger a graph reload to recalculate node heights with new character limit
		debouncedLoadGraphData();
	}, [previewCharLimit, debouncedLoadGraphData, isOpen]);

	/**
	 * Cancel debounced load and backlink scan on unmount
	 */
	useEffect(() => {
		return () => {
			cancelDebouncedLoad();
			if (abortBacklinkScanRef.current) {
				abortBacklinkScanRef.current();
				abortBacklinkScanRef.current = null;
			}
		};
	}, [cancelDebouncedLoad]);

	/**
	 * Set up file watcher for real-time updates
	 */
	useEffect(() => {
		if (!isOpen || !rootPath) return;

		window.maestro.documentGraph.watchFolder(rootPath).catch((err) => {
			console.error('Failed to start document graph file watcher:', err);
		});

		const unsubscribe = window.maestro.documentGraph.onFilesChanged((data) => {
			if (data.rootPath === rootPath) {
				// Invalidate cache for changed files before rebuilding graph
				const changedPaths = data.changes.map((c: { filePath: string }) => c.filePath);
				invalidateCacheForFiles(changedPaths);
				debouncedLoadGraphData();
			}
		});

		return () => {
			unsubscribe();
			window.maestro.documentGraph.unwatchFolder(rootPath).catch((err) => {
				console.error('Failed to stop document graph file watcher:', err);
			});
		};
	}, [isOpen, rootPath, debouncedLoadGraphData]);

	/**
	 * Handle node selection
	 */
	const handleNodeSelect = useCallback((node: MindMapNode | null) => {
		setSelectedNodeId(node?.id ?? null);
		setSelectedNode(node);
		setContextMenu(null);
	}, []);

	/**
	 * Load file stats and task counts when selected document node changes
	 */
	useEffect(() => {
		if (!selectedNode || selectedNode.nodeType !== 'document' || !selectedNode.filePath) {
			setSelectedNodeStats(null);
			setSelectedNodeTasks(null);
			return;
		}

		const fullPath = `${rootPath}/${selectedNode.filePath}`;

		// Load file stats (created/modified dates)
		window.maestro.fs
			.stat(fullPath, sshRemoteId)
			.then((stats) => {
				setSelectedNodeStats({
					createdAt: stats.createdAt ? new Date(stats.createdAt) : null,
					modifiedAt: stats.modifiedAt ? new Date(stats.modifiedAt) : null,
				});
			})
			.catch(() => {
				setSelectedNodeStats(null);
			});

		// Load file content to count tasks
		window.maestro.fs
			.readFile(fullPath, sshRemoteId)
			.then((content) => {
				const tasks = countMarkdownTasks(content);
				setSelectedNodeTasks(tasks.total > 0 ? tasks : null);
			})
			.catch(() => {
				setSelectedNodeTasks(null);
			});
	}, [selectedNode, rootPath, sshRemoteId]);

	/**
	 * Handle node double-click - re-layout the graph with this node as the new center.
	 * The existing nodes are preserved, but the layout fans out from the new center.
	 */
	const handleNodeDoubleClick = useCallback((node: MindMapNode) => {
		if (node.nodeType !== 'document' || !node.filePath) {
			return;
		}

		// Set this node as the new center - triggers re-layout in MindMap
		setActiveFocusFile(node.filePath);

		console.log('[DocumentGraph] Re-centering graph on:', node.filePath);
	}, []);

	/**
	 * Handle node context menu
	 */
	const handleNodeContextMenu = useCallback((node: MindMapNode, event: MouseEvent) => {
		event.preventDefault();
		setContextMenu({
			x: event.clientX,
			y: event.clientY,
			nodeId: node.id,
			nodeData:
				node.nodeType === 'document'
					? {
							nodeType: 'document',
							title: node.label || '',
							filePath: node.filePath || '',
							description: node.description,
							lineCount: node.lineCount || 0,
							wordCount: node.wordCount || 0,
							size: node.size || '0B',
						}
					: {
							nodeType: 'external',
							domain: node.domain || '',
							linkCount: node.connectionCount || 0,
							urls: node.urls || [],
						},
		});
	}, []);

	/**
	 * Handle external links toggle
	 */
	const handleExternalLinksToggle = useCallback(() => {
		setIncludeExternalLinks((prev) => {
			const newValue = !prev;
			onExternalLinksChange?.(newValue);
			return newValue;
		});
	}, [onExternalLinksChange]);

	/**
	 * Handle neighbor depth change
	 */
	const handleNeighborDepthChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const newDepth = parseInt(e.target.value, 10);
			setNeighborDepth(newDepth);
			onNeighborDepthChange?.(newDepth);
		},
		[onNeighborDepthChange]
	);

	/**
	 * Handle preview character limit change
	 */
	const handlePreviewCharLimitChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const newLimit = parseInt(e.target.value, 10);
			setPreviewCharLimit(newLimit);
			onPreviewCharLimitChange?.(newLimit);
		},
		[onPreviewCharLimitChange]
	);

	/**
	 * Handle layout type change — clears drag overrides since they're layout-specific
	 */
	const handleLayoutTypeChange = useCallback(
		(type: MindMapLayoutType) => {
			setLayoutType(type);
			setShowLayoutDropdown(false);
			// Clear node position overrides since they're layout-specific
			setNodePositions(new Map());
			positionsContextRef.current = null;
			onLayoutTypeChange?.(type);
		},
		[onLayoutTypeChange]
	);

	/**
	 * Handle load more
	 */
	const handleLoadMore = useCallback(async () => {
		if (!hasMore || loadingMore) return;

		setLoadingMore(true);
		const newMaxNodes = maxNodes + LOAD_MORE_INCREMENT;
		setMaxNodes(newMaxNodes);

		try {
			const graphData = await buildGraphData({
				rootPath,
				focusFile: activeFocusFile || focusFilePath,
				maxDepth: neighborDepth > 0 ? neighborDepth : 10,
				maxNodes: newMaxNodes,
				sshRemoteId,
			});

			setTotalDocuments(graphData.totalDocuments);
			setLoadedDocuments(graphData.loadedDocuments);
			setHasMore(graphData.hasMore);

			const { nodes: mindMapNodes, links: mindMapLinks } = convertToMindMapData(
				graphData.nodes.map((n) => ({ id: n.id, data: n.data })),
				graphData.edges.map((e) => ({ source: e.source, target: e.target, type: e.type })),
				previewCharLimit
			);

			setNodes(mindMapNodes);
			setLinks(mindMapLinks);
		} catch (err) {
			console.error('Failed to load more documents:', err);
		} finally {
			setLoadingMore(false);
		}
	}, [
		hasMore,
		loadingMore,
		maxNodes,
		rootPath,
		activeFocusFile,
		focusFilePath,
		neighborDepth,
		previewCharLimit,
		sshRemoteId,
	]);

	/**
	 * Handle context menu open
	 */
	const handleContextMenuOpen = useCallback(
		(filePath: string) => {
			if (onDocumentOpen) {
				onDocumentOpen(filePath);
			}
		},
		[onDocumentOpen]
	);

	/**
	 * Handle context menu open external
	 */
	const handleContextMenuOpenExternal = useCallback(
		(url: string) => {
			if (onExternalLinkOpen) {
				onExternalLinkOpen(url);
			}
		},
		[onExternalLinkOpen]
	);

	/**
	 * Handle context menu focus
	 */
	const handleContextMenuFocus = useCallback(
		(nodeId: string) => {
			const node = nodes.find((n) => n.id === nodeId);
			if (node?.nodeType === 'document' && node.filePath) {
				setActiveFocusFile(node.filePath);
				if (neighborDepth === 0) {
					setNeighborDepth(2);
				}
			}
			setContextMenu(null);
		},
		[nodes, neighborDepth]
	);

	/**
	 * Handle node position change from drag operations
	 */
	const handleNodePositionChange = useCallback((nodeId: string, position: NodePositionOverride) => {
		setNodePositions((prev) => {
			const next = new Map(prev);
			next.set(nodeId, position);
			return next;
		});
	}, []);

	/**
	 * Reset all node positions to algorithmic layout
	 */
	const handleResetLayout = useCallback(() => {
		setNodePositions(new Map());
		positionsContextRef.current = null;
	}, []);

	/**
	 * Clear node positions only when focus changes.
	 * Preserve positions when depth changes (increase or decrease) or external links are toggled.
	 * Existing nodes keep their positions; new nodes get algorithmic positions.
	 * User can always hit "Reset Layout" to get a fresh layout.
	 */
	useEffect(() => {
		const currentContext = { focusFile: activeFocusFile, depth: neighborDepth };
		const prevContext = positionsContextRef.current;

		if (prevContext) {
			const focusChanged = prevContext.focusFile !== currentContext.focusFile;

			// Only clear positions if focus changed (recentering on a different document)
			if (focusChanged) {
				setNodePositions(new Map());
			}
		}

		// Update context ref
		positionsContextRef.current = currentContext;
	}, [activeFocusFile, neighborDepth]);

	/**
	 * Handle open file from mind map (clicking open icon or pressing O key)
	 */
	const handleOpenFile = useCallback(
		(filePath: string) => {
			if (onDocumentOpen) {
				onDocumentOpen(filePath);
			}
		},
		[onDocumentOpen]
	);

	/**
	 * Open a markdown preview panel inside the graph view.
	 * Pushes to navigation history for back/forward support.
	 */
	const handlePreviewFile = useCallback(
		async (filePath: string) => {
			const isAbsolutePath = filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath);
			const fullPath = isAbsolutePath ? filePath : `${rootPath}/${filePath}`;
			const relativePath =
				rootPath && fullPath.startsWith(`${rootPath}/`)
					? fullPath.slice(rootPath.length + 1)
					: filePath;

			setPreviewLoading(true);
			setPreviewError(null);

			try {
				const content = await window.maestro.fs.readFile(fullPath, sshRemoteId);

				if (content === null) {
					throw new Error('Unable to read file contents.');
				}

				const newEntry = {
					path: fullPath,
					relativePath,
					name: relativePath.split('/').pop() || relativePath,
					content,
				};

				setPreviewFile(newEntry);

				// Push to history, truncating any forward history
				setPreviewHistory((prev) => {
					const newHistory = prev.slice(0, previewHistoryIndex + 1);
					newHistory.push(newEntry);
					return newHistory;
				});
				setPreviewHistoryIndex((prev) => prev + 1);
			} catch (err) {
				setPreviewFile(null);
				setPreviewError(err instanceof Error ? err.message : 'Failed to load preview.');
			} finally {
				setPreviewLoading(false);
			}
		},
		[rootPath, sshRemoteId, previewHistoryIndex]
	);

	/**
	 * Close the preview panel and clear navigation history
	 */
	const handlePreviewClose = useCallback(() => {
		setPreviewFile(null);
		setPreviewLoading(false);
		setPreviewError(null);
		setPreviewHistory([]);
		setPreviewHistoryIndex(-1);
	}, []);

	/**
	 * Navigate back in preview history
	 */
	const handlePreviewBack = useCallback(() => {
		if (previewHistoryIndex > 0) {
			const newIndex = previewHistoryIndex - 1;
			setPreviewHistoryIndex(newIndex);
			setPreviewFile(previewHistory[newIndex]);
			// Focus the content area for keyboard scrolling
			requestAnimationFrame(() => {
				previewContentRef.current?.focus();
			});
		}
	}, [previewHistoryIndex, previewHistory]);

	/**
	 * Navigate forward in preview history
	 */
	const handlePreviewForward = useCallback(() => {
		if (previewHistoryIndex < previewHistory.length - 1) {
			const newIndex = previewHistoryIndex + 1;
			setPreviewHistoryIndex(newIndex);
			setPreviewFile(previewHistory[newIndex]);
			// Focus the content area for keyboard scrolling
			requestAnimationFrame(() => {
				previewContentRef.current?.focus();
			});
		}
	}, [previewHistoryIndex, previewHistory]);

	// Can navigate back/forward?
	const canGoBack = previewHistoryIndex > 0;
	const canGoForward = previewHistoryIndex < previewHistory.length - 1;

	/**
	 * Handle keyboard navigation in preview panel (left/right arrow keys)
	 */
	const handlePreviewKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			// Only handle arrow keys without modifiers
			if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

			if (e.key === 'ArrowLeft' && canGoBack) {
				e.preventDefault();
				handlePreviewBack();
			} else if (e.key === 'ArrowRight' && canGoForward) {
				e.preventDefault();
				handlePreviewForward();
			}
		},
		[canGoBack, canGoForward, handlePreviewBack, handlePreviewForward]
	);

	/**
	 * Register preview panel with layer stack when open.
	 * Escape closes the preview and returns focus to the graph.
	 */
	useEffect(() => {
		if (previewFile || previewLoading || previewError) {
			const id = registerLayer({
				type: 'overlay',
				priority: MODAL_PRIORITIES.DOCUMENT_GRAPH + 1,
				blocksLowerLayers: false,
				capturesFocus: true,
				focusTrap: 'lenient',
				allowClickOutside: true,
				onEscape: () => {
					handlePreviewClose();
					// Return focus to the mind map container
					requestAnimationFrame(() => {
						mindMapContainerRef.current?.focus();
					});
				},
			});
			return () => unregisterLayer(id);
		}
	}, [
		previewFile,
		previewLoading,
		previewError,
		registerLayer,
		unregisterLayer,
		handlePreviewClose,
	]);

	/**
	 * Focus the preview content area when preview file loads.
	 * This enables immediate keyboard scrolling.
	 */
	useEffect(() => {
		if (previewFile && !previewLoading && !previewError) {
			requestAnimationFrame(() => {
				previewContentRef.current?.focus();
			});
		}
	}, [previewFile, previewLoading, previewError]);

	/**
	 * Handle search input escape key
	 * First Escape: clear search if there's content
	 * Second Escape (or first if empty): blur search, return focus to graph, select center node
	 */
	const handleSearchKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === 'Escape') {
				e.stopPropagation(); // Prevent layer stack from handling
				if (searchQuery) {
					// First Escape: clear search query
					setSearchQuery('');
				} else {
					// Second Escape (or first if empty): blur search, select center node, focus graph
					searchInputRef.current?.blur();

					// Select the center node (the focus file) first
					if (activeFocusFile) {
						const centerNode = nodes.find((n) => n.filePath === activeFocusFile);
						if (centerNode) {
							handleNodeSelect(centerNode);
						}
					}

					// Focus the mind map container after state update
					requestAnimationFrame(() => {
						mindMapContainerRef.current?.focus();
					});
				}
			}
		},
		[searchQuery, activeFocusFile, nodes, handleNodeSelect]
	);

	/**
	 * Handle container keyboard shortcuts (Cmd+F for search)
	 */
	const handleContainerKeyDown = useCallback((e: React.KeyboardEvent) => {
		// Cmd+F or Ctrl+F to focus search
		if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
			e.preventDefault();
			searchInputRef.current?.focus();
			searchInputRef.current?.select();
		}
	}, []);

	if (!isOpen) return null;

	const documentCount = nodes.filter((n) => n.nodeType === 'document').length;
	const externalCount = nodes.filter((n) => n.nodeType === 'external').length;

	// Count matching nodes when search is active
	const searchMatchCount = searchQuery.trim()
		? nodes.filter((n) => {
				const query = searchQuery.toLowerCase();
				if (n.nodeType === 'document') {
					return (
						(n.label?.toLowerCase().includes(query) ?? false) ||
						(n.filePath?.toLowerCase().includes(query) ?? false)
					);
				} else {
					return n.domain?.toLowerCase().includes(query) ?? false;
				}
			}).length
		: 0;
	const totalNodesCount = documentCount + externalCount;

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] animate-in fade-in duration-100"
			onClick={handleEscapeRequest}
		>
			<div
				ref={containerRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label="Document Graph"
				className="rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
					width: '90vw',
					height: '90vh',
				}}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={handleContainerKeyDown}
			>
				{/* Header */}
				<div
					className="px-6 py-4 border-b flex items-center justify-between flex-shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-3">
						<Network className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
							Document Graph
						</h2>
						<span
							className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
							style={{ backgroundColor: theme.colors.warning + '30', color: theme.colors.warning }}
						>
							Beta
						</span>
						<span
							className="text-xs px-2 py-0.5 rounded"
							style={{
								backgroundColor: `${theme.colors.accent}20`,
								color: theme.colors.textDim,
							}}
						>
							{rootPath.split('/').pop()}
						</span>
					</div>

					<div className="flex items-center gap-3">
						{/* Search Input */}
						<div className="relative">
							<Search
								className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
								style={{ color: theme.colors.textDim }}
							/>
							<input
								ref={searchInputRef}
								type="text"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								onKeyDown={handleSearchKeyDown}
								placeholder="Search documents..."
								className="pl-8 pr-3 py-1.5 rounded text-sm outline-none transition-colors"
								style={{
									backgroundColor: `${theme.colors.accent}10`,
									color: theme.colors.textMain,
									border: `1px solid ${searchQuery ? theme.colors.accent : 'transparent'}`,
									width: 180,
								}}
								onFocus={(e) => (e.currentTarget.style.borderColor = theme.colors.accent)}
								onBlur={(e) =>
									(e.currentTarget.style.borderColor = searchQuery
										? theme.colors.accent
										: 'transparent')
								}
								aria-label="Search documents in graph"
							/>
							{searchQuery && (
								<button
									onClick={() => {
										setSearchQuery('');
										searchInputRef.current?.focus();
									}}
									className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded-full transition-colors"
									style={{ color: theme.colors.textDim }}
									onMouseEnter={(e) => (e.currentTarget.style.color = theme.colors.textMain)}
									onMouseLeave={(e) => (e.currentTarget.style.color = theme.colors.textDim)}
									title="Clear search"
									aria-label="Clear search"
								>
									<X className="w-3 h-3" />
								</button>
							)}
						</div>

						{/* Layout Algorithm Selector */}
						<div className="relative">
							<button
								onClick={() => setShowLayoutDropdown(!showLayoutDropdown)}
								className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors"
								style={{
									backgroundColor: `${theme.colors.accent}10`,
									color: theme.colors.textDim,
								}}
								onMouseEnter={(e) =>
									(e.currentTarget.style.backgroundColor = `${theme.colors.accent}30`)
								}
								onMouseLeave={(e) =>
									(e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`)
								}
								title={`Layout: ${LAYOUT_LABELS[layoutType].name}`}
							>
								<Network className="w-4 h-4" />
								{LAYOUT_LABELS[layoutType].name}
								<ChevronDown className="w-3 h-3" />
							</button>

							{showLayoutDropdown && (
								<div
									className="absolute top-full left-0 mt-2 py-1 rounded-lg shadow-lg z-50"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
										minWidth: 200,
									}}
								>
									{(['mindmap', 'radial', 'force'] as MindMapLayoutType[]).map((type) => (
										<button
											key={type}
											onClick={() => handleLayoutTypeChange(type)}
											className="w-full px-3 py-2 text-left text-sm transition-colors flex items-center justify-between"
											style={{
												backgroundColor:
													layoutType === type
														? `${theme.colors.accent}15`
														: 'transparent',
												color:
													layoutType === type
														? theme.colors.accent
														: theme.colors.textMain,
											}}
											onMouseEnter={(e) =>
												(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
											}
											onMouseLeave={(e) =>
												(e.currentTarget.style.backgroundColor =
													layoutType === type
														? `${theme.colors.accent}15`
														: 'transparent')
											}
										>
											<span>{LAYOUT_LABELS[type].name}</span>
											<span
												className="text-xs"
												style={{ color: theme.colors.textDim }}
											>
												{LAYOUT_LABELS[type].description}
											</span>
										</button>
									))}
								</div>
							)}
						</div>

						{/* Neighbor Depth Slider */}
						<div className="relative">
							<button
								onClick={() => setShowDepthSlider(!showDepthSlider)}
								className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors"
								style={{
									backgroundColor:
										neighborDepth > 0 ? `${theme.colors.accent}25` : `${theme.colors.accent}10`,
									color: neighborDepth > 0 ? theme.colors.accent : theme.colors.textDim,
								}}
								onMouseEnter={(e) =>
									(e.currentTarget.style.backgroundColor = `${theme.colors.accent}30`)
								}
								onMouseLeave={(e) =>
									(e.currentTarget.style.backgroundColor =
										neighborDepth > 0 ? `${theme.colors.accent}25` : `${theme.colors.accent}10`)
								}
								title={
									neighborDepth > 0
										? `Showing ${neighborDepth} level${neighborDepth > 1 ? 's' : ''} of neighbors`
										: 'Show all nodes'
								}
							>
								<Sliders className="w-4 h-4" />
								Depth: {neighborDepth === 0 ? 'All' : neighborDepth}
							</button>

							{showDepthSlider && (
								<div
									className="absolute top-full right-0 mt-2 p-3 rounded-lg shadow-lg z-50"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
										minWidth: 200,
									}}
								>
									<div className="flex items-center justify-between mb-2">
										<span className="text-xs" style={{ color: theme.colors.textDim }}>
											Neighbor Depth
										</span>
										<span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
											{neighborDepth === 0 ? 'All' : neighborDepth}
										</span>
									</div>
									<input
										type="range"
										min="0"
										max="5"
										value={neighborDepth}
										onChange={handleNeighborDepthChange}
										className="w-full"
										style={{ accentColor: theme.colors.accent }}
									/>
									<div
										className="flex justify-between text-xs mt-1"
										style={{ color: theme.colors.textDim }}
									>
										<span>All</span>
										<span>1</span>
										<span>2</span>
										<span>3</span>
										<span>4</span>
										<span>5</span>
									</div>
									<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
										{neighborDepth === 0
											? 'Showing all documents'
											: `Showing documents within ${neighborDepth} link${neighborDepth > 1 ? 's' : ''} of focus`}
									</p>
								</div>
							)}
						</div>

						{/* Preview Character Limit Slider */}
						<div className="relative">
							<button
								onClick={() => setShowPreviewSlider(!showPreviewSlider)}
								className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors"
								style={{
									backgroundColor:
										previewCharLimit > 100
											? `${theme.colors.accent}25`
											: `${theme.colors.accent}10`,
									color: previewCharLimit > 100 ? theme.colors.accent : theme.colors.textDim,
								}}
								onMouseEnter={(e) =>
									(e.currentTarget.style.backgroundColor = `${theme.colors.accent}30`)
								}
								onMouseLeave={(e) =>
									(e.currentTarget.style.backgroundColor =
										previewCharLimit > 100
											? `${theme.colors.accent}25`
											: `${theme.colors.accent}10`)
								}
								title={`Preview text limit: ${previewCharLimit} characters`}
							>
								<Type className="w-4 h-4" />
								Preview: {previewCharLimit}
							</button>

							{showPreviewSlider && (
								<div
									className="absolute top-full right-0 mt-2 p-3 rounded-lg shadow-lg z-50"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
										minWidth: 220,
									}}
								>
									<div className="flex items-center justify-between mb-2">
										<span className="text-xs" style={{ color: theme.colors.textDim }}>
											Preview Characters
										</span>
										<span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
											{previewCharLimit}
										</span>
									</div>
									<input
										type="range"
										min="50"
										max="500"
										step="50"
										value={previewCharLimit}
										onChange={handlePreviewCharLimitChange}
										className="w-full"
										style={{ accentColor: theme.colors.accent }}
									/>
									<div
										className="flex justify-between text-xs mt-1"
										style={{ color: theme.colors.textDim }}
									>
										<span>50</span>
										<span>200</span>
										<span>350</span>
										<span>500</span>
									</div>
									<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
										Characters shown in document previews
									</p>
								</div>
							)}
						</div>

						{/* External Links Toggle */}
						<button
							onClick={handleExternalLinksToggle}
							className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors"
							style={{
								backgroundColor: includeExternalLinks
									? `${theme.colors.accent}25`
									: `${theme.colors.accent}10`,
								color: includeExternalLinks ? theme.colors.accent : theme.colors.textDim,
							}}
							onMouseEnter={(e) =>
								(e.currentTarget.style.backgroundColor = `${theme.colors.accent}30`)
							}
							onMouseLeave={(e) =>
								(e.currentTarget.style.backgroundColor = includeExternalLinks
									? `${theme.colors.accent}25`
									: `${theme.colors.accent}10`)
							}
							title={includeExternalLinks ? 'Hide external links' : 'Show external links'}
						>
							<ExternalLink className="w-4 h-4" />
							External
						</button>

						{/* Reset Layout Button - only show when positions have been modified */}
						{nodePositions.size > 0 && (
							<button
								onClick={handleResetLayout}
								className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors"
								style={{
									backgroundColor: `${theme.colors.warning}20`,
									color: theme.colors.warning,
								}}
								onMouseEnter={(e) =>
									(e.currentTarget.style.backgroundColor = `${theme.colors.warning}30`)
								}
								onMouseLeave={(e) =>
									(e.currentTarget.style.backgroundColor = `${theme.colors.warning}20`)
								}
								title="Reset all node positions to algorithmic layout"
							>
								<RotateCcw className="w-4 h-4" />
								Reset Layout
							</button>
						)}

						{/* Refresh Button */}
						<button
							onClick={() => loadGraphData()}
							className="p-1.5 rounded transition-colors"
							style={{ color: theme.colors.textDim }}
							onMouseEnter={(e) =>
								(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
							}
							onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
							title="Refresh graph"
							disabled={loading}
						>
							<RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
						</button>

						{/* Close Button */}
						<button
							onClick={handleEscapeRequest}
							className="p-1.5 rounded transition-colors"
							style={{ color: theme.colors.textDim }}
							onMouseEnter={(e) =>
								(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
							}
							onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
							title="Close (Esc)"
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				</div>

				{/* Selected Node Info Bar */}
				{selectedNode && (
					<div
						className="px-6 py-2 border-b flex items-center justify-between text-sm"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: `${theme.colors.accent}10`,
						}}
					>
						{selectedNode.nodeType === 'document' ? (
							<>
								{/* Left side: title and connection count */}
								<div className="flex items-center gap-3">
									<span style={{ color: theme.colors.accent, fontWeight: 500 }}>
										{selectedNode.label}
									</span>
									{selectedNode.connectionCount !== undefined &&
										selectedNode.connectionCount > 0 && (
											<span
												className="px-2 py-0.5 rounded text-xs"
												style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
											>
												{selectedNode.connectionCount} connection
												{selectedNode.connectionCount !== 1 ? 's' : ''}
											</span>
										)}
								</div>
								{/* Right side: file path */}
								<span style={{ color: theme.colors.textDim }}>{selectedNode.filePath}</span>
							</>
						) : (
							<>
								<span style={{ color: theme.colors.textDim }}>External: {selectedNode.domain}</span>
								{selectedNode.urls && selectedNode.urls.length > 1 && (
									<span style={{ color: theme.colors.textDim }}>
										({selectedNode.urls.length} links)
									</span>
								)}
							</>
						)}
					</div>
				)}

				{/* Main Content - Force Graph */}
				<div
					ref={graphContainerRef}
					className="flex-1 relative min-h-0 overflow-hidden"
					style={{ backgroundColor: theme.colors.bgMain }}
				>
					{loading ? (
						<div className="h-full flex flex-col items-center justify-center gap-8">
							<Loader2 className="w-8 h-8 animate-spin" style={{ color: theme.colors.accent }} />
							<div className="flex flex-col items-center gap-4">
								<p className="text-sm" style={{ color: theme.colors.textDim }}>
									{progress
										? progress.phase === 'scanning'
											? `Scanning directories... (${progress.current} scanned)`
											: `Parsing documents... ${progress.current} of ${progress.total}`
										: 'Initializing...'}
								</p>
								{progress && progress.phase === 'parsing' && progress.total > 0 && (
									<div
										className="w-48 h-1.5 rounded-full overflow-hidden"
										style={{ backgroundColor: `${theme.colors.accent}20` }}
									>
										<div
											className="h-full rounded-full transition-all duration-150 ease-out"
											style={{
												backgroundColor: theme.colors.accent,
												width: `${Math.round((progress.current / progress.total) * 100)}%`,
											}}
										/>
									</div>
								)}
								{progress && progress.phase === 'parsing' && progress.currentFile && (
									<p
										className="text-xs max-w-sm truncate"
										style={{ color: theme.colors.textDim, opacity: 0.7 }}
										title={progress.currentFile}
									>
										{progress.currentFile}
									</p>
								)}
								{progress &&
									progress.phase === 'parsing' &&
									(progress.internalLinksFound !== undefined ||
										progress.externalLinksFound !== undefined) && (
										<p className="text-xs" style={{ color: theme.colors.textDim, opacity: 0.6 }}>
											{progress.internalLinksFound ?? 0} internal ·{' '}
											{progress.externalLinksFound ?? 0} external links
										</p>
									)}
							</div>
						</div>
					) : error ? (
						<div
							className="h-full flex flex-col items-center justify-center gap-4"
							style={{ color: theme.colors.textDim }}
						>
							<AlertCircle className="w-12 h-12 opacity-50" />
							<p>Failed to load document graph</p>
							<p className="text-sm opacity-70">{error}</p>
							<button
								onClick={() => loadGraphData()}
								className="px-4 py-2 rounded text-sm"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.bgMain,
								}}
							>
								Retry
							</button>
						</div>
					) : nodes.length === 0 ? (
						<div
							className="h-full flex flex-col items-center justify-center gap-2"
							style={{ color: theme.colors.textDim }}
						>
							<Network className="w-12 h-12 opacity-30" />
							<p className="text-lg">No markdown files found</p>
							<p className="text-sm opacity-70">This directory doesn't contain any .md files</p>
						</div>
					) : activeFocusFile ? (
						<MindMap
							centerFilePath={activeFocusFile}
							nodes={nodes}
							links={links}
							theme={theme}
							width={graphDimensions.width}
							height={graphDimensions.height}
							maxDepth={neighborDepth || 2}
							showExternalLinks={includeExternalLinks}
							selectedNodeId={selectedNodeId}
							onNodeSelect={handleNodeSelect}
							onNodeDoubleClick={handleNodeDoubleClick}
							onNodePreview={(node) => {
								if (node.nodeType === 'document' && node.filePath) {
									handlePreviewFile(node.filePath);
								}
							}}
							onNodeContextMenu={handleNodeContextMenu}
							onOpenFile={handleOpenFile}
							searchQuery={searchQuery}
							previewCharLimit={previewCharLimit}
							layoutType={layoutType}
							nodePositions={nodePositions}
							onNodePositionChange={handleNodePositionChange}
							containerRef={mindMapContainerRef}
						/>
					) : (
						<div
							className="h-full flex flex-col items-center justify-center gap-2"
							style={{ color: theme.colors.textDim }}
						>
							<Network className="w-12 h-12 opacity-30" />
							<p className="text-lg">No focus document selected</p>
							<p className="text-sm opacity-70">Select a document to view its connections</p>
						</div>
					)}

					{/* Help/Legend Side Panel */}
					{legendExpanded && !loading && !error && nodes.length > 0 && (
						<GraphLegend
							theme={theme}
							showExternalLinks={includeExternalLinks}
							onClose={() => setLegendExpanded(false)}
						/>
					)}

					{/* Context Menu */}
					{contextMenu && (
						<NodeContextMenu
							x={contextMenu.x}
							y={contextMenu.y}
							theme={theme}
							nodeData={contextMenu.nodeData}
							nodeId={contextMenu.nodeId}
							onOpen={handleContextMenuOpen}
							onOpenExternal={handleContextMenuOpenExternal}
							onFocus={handleContextMenuFocus}
							onDismiss={() => setContextMenu(null)}
						/>
					)}

					{/* Markdown Preview Panel */}
					{(previewFile || previewLoading || previewError) && (
						<div
							className="absolute top-4 right-4 bottom-4 rounded-lg shadow-2xl border flex flex-col z-50 outline-none"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
								width: 'min(560px, 42vw)',
								maxWidth: '90%',
							}}
							onKeyDown={handlePreviewKeyDown}
						>
							<style>{generateProseStyles({ theme, scopeSelector: '.graph-preview' })}</style>
							<div
								className="px-4 py-3 border-b flex items-center justify-between gap-3"
								style={{ borderColor: theme.colors.border }}
							>
								<div className="flex items-center gap-2 min-w-0">
									{/* Back/Forward navigation buttons */}
									<div className="flex items-center gap-0.5">
										<button
											onClick={handlePreviewBack}
											disabled={!canGoBack}
											className="p-1 rounded transition-colors"
											style={{
												color: canGoBack ? theme.colors.textMain : theme.colors.textDim,
												opacity: canGoBack ? 1 : 0.4,
												cursor: canGoBack ? 'pointer' : 'default',
											}}
											onMouseEnter={(e) =>
												canGoBack &&
												(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
											}
											onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
											title={canGoBack ? 'Go back (←)' : 'No previous document'}
											aria-label="Go back"
										>
											<ChevronLeft className="w-4 h-4" />
										</button>
										<button
											onClick={handlePreviewForward}
											disabled={!canGoForward}
											className="p-1 rounded transition-colors"
											style={{
												color: canGoForward ? theme.colors.textMain : theme.colors.textDim,
												opacity: canGoForward ? 1 : 0.4,
												cursor: canGoForward ? 'pointer' : 'default',
											}}
											onMouseEnter={(e) =>
												canGoForward &&
												(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
											}
											onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
											title={canGoForward ? 'Go forward (→)' : 'No next document'}
											aria-label="Go forward"
										>
											<ChevronRight className="w-4 h-4" />
										</button>
									</div>
									{/* Document title and path */}
									<div className="min-w-0">
										<p
											className="text-sm font-semibold truncate"
											style={{ color: theme.colors.textMain }}
										>
											{previewFile?.name || 'Loading preview...'}
										</p>
										<p className="text-xs truncate" style={{ color: theme.colors.textDim }}>
											{previewFile?.relativePath || ''}
										</p>
									</div>
								</div>
								<div className="flex items-center gap-2">
									{previewFile && onDocumentOpen && (
										<button
											onClick={() => onDocumentOpen(previewFile.relativePath)}
											className="px-2 py-1 rounded text-xs transition-colors"
											style={{
												backgroundColor: `${theme.colors.accent}20`,
												color: theme.colors.accent,
											}}
											title="Open in file preview"
										>
											Open
										</button>
									)}
									<button
										onClick={handlePreviewClose}
										className="p-1 rounded transition-colors"
										style={{ color: theme.colors.textDim }}
										title="Close preview (Esc)"
									>
										<X className="w-4 h-4" />
									</button>
								</div>
							</div>
							<div
								ref={previewContentRef}
								tabIndex={0}
								className="flex-1 overflow-auto px-4 py-3 graph-preview outline-none"
							>
								{previewLoading ? (
									<div
										className="flex items-center gap-2 text-xs"
										style={{ color: theme.colors.textDim }}
									>
										<Loader2 className="w-4 h-4 animate-spin" />
										Loading preview...
									</div>
								) : previewError ? (
									<p className="text-xs" style={{ color: theme.colors.textDim }}>
										{previewError}
									</p>
								) : previewFile ? (
									<MarkdownRenderer
										content={previewFile.content}
										theme={theme}
										onCopy={async (text: string) => {
											try {
												await navigator.clipboard.writeText(text);
											} catch (err) {
												console.error('Failed to copy to clipboard:', err);
											}
										}}
										fileTree={previewFileTree}
										projectRoot={rootPath}
										cwd={previewFile.relativePath.split('/').slice(0, -1).join('/')}
										onFileClick={handlePreviewFile}
										sshRemoteId={sshRemoteId}
									/>
								) : null}
							</div>
						</div>
					)}
				</div>

				{/* Footer */}
				<div
					className="px-6 py-4 border-t flex items-center justify-between text-xs flex-shrink-0"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textDim,
						minHeight: 52,
					}}
				>
					<div className="flex items-center gap-3">
						{/* Help Button */}
						<button
							onClick={() => setLegendExpanded(!legendExpanded)}
							className="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors"
							style={{
								backgroundColor: legendExpanded
									? `${theme.colors.accent}25`
									: `${theme.colors.accent}10`,
								color: legendExpanded ? theme.colors.accent : theme.colors.textMain,
							}}
							onMouseEnter={(e) =>
								(e.currentTarget.style.backgroundColor = `${theme.colors.accent}30`)
							}
							onMouseLeave={(e) =>
								(e.currentTarget.style.backgroundColor = legendExpanded
									? `${theme.colors.accent}25`
									: `${theme.colors.accent}10`)
							}
							title={legendExpanded ? 'Close help panel' : 'Open help panel'}
						>
							<HelpCircle className="w-3.5 h-3.5" />
							Help?
						</button>
						<span>
							{searchQuery.trim() ? (
								<>
									<span style={{ color: theme.colors.accent }}>{searchMatchCount}</span>
									{` of ${totalNodesCount} matching`}
								</>
							) : documentCount > 0 ? (
								`${documentCount}${totalDocuments > loadedDocuments ? ` of ${totalDocuments}` : ''} document${documentCount !== 1 ? 's' : ''}${
									includeExternalLinks && externalCount > 0
										? `, ${externalCount} external domain${externalCount !== 1 ? 's' : ''}`
										: ''
								}`
							) : (
								'No documents found'
							)}
						</span>
						{hasMore && (
							<button
								onClick={handleLoadMore}
								disabled={loadingMore}
								className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.bgMain,
									opacity: loadingMore ? 0.7 : 1,
									cursor: loadingMore ? 'wait' : 'pointer',
								}}
								onMouseEnter={(e) => !loadingMore && (e.currentTarget.style.opacity = '0.85')}
								onMouseLeave={(e) => !loadingMore && (e.currentTarget.style.opacity = '1')}
								title={`Load ${Math.min(LOAD_MORE_INCREMENT, totalDocuments - loadedDocuments)} more documents`}
							>
								{loadingMore ? (
									<Loader2 className="w-3 h-3 animate-spin" />
								) : (
									<ChevronDown className="w-3 h-3" />
								)}
								{loadingMore
									? 'Loading...'
									: `Load more (${totalDocuments - loadedDocuments} remaining)`}
							</button>
						)}
						{/* Backlink loading indicator */}
						{backlinksLoading && (
							<span
								className="flex items-center gap-1.5 px-2 py-1 rounded text-xs"
								style={{
									backgroundColor: `${theme.colors.accent}15`,
									color: theme.colors.textDim,
								}}
								title="Scanning for documents that link to the current graph"
							>
								<Loader2 className="w-3 h-3 animate-spin" style={{ color: theme.colors.accent }} />
								<span>
									Scanning backlinks
									{backlinkProgress && ` (${backlinkProgress.scanned}/${backlinkProgress.total})`}
									...
								</span>
							</span>
						)}
					</div>

					{/* Center: Selected node stats */}
					{selectedNode?.nodeType === 'document' && (selectedNodeStats || selectedNodeTasks) && (
						<div className="flex items-center gap-4" style={{ color: theme.colors.textDim }}>
							{/* Task counts */}
							{selectedNodeTasks && (
								<div className="flex items-center gap-1.5" title="Markdown tasks">
									<CheckSquare className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
									<span>
										<span style={{ color: theme.colors.success }}>
											{selectedNodeTasks.completed}
										</span>
										<span> of </span>
										<span style={{ color: theme.colors.textMain }}>{selectedNodeTasks.total}</span>
										<span> tasks</span>
									</span>
								</div>
							)}
							{/* Created date */}
							{selectedNodeStats?.createdAt && (
								<div className="flex items-center gap-1.5" title="Created date">
									<Calendar className="w-3.5 h-3.5" />
									<span>Created {formatDate(selectedNodeStats.createdAt)}</span>
								</div>
							)}
							{/* Modified date */}
							{selectedNodeStats?.modifiedAt && (
								<div className="flex items-center gap-1.5" title="Modified date">
									<Calendar className="w-3.5 h-3.5" />
									<span>Modified {formatDate(selectedNodeStats.modifiedAt)}</span>
								</div>
							)}
						</div>
					)}
				</div>
			</div>

			{/* Close Confirmation Modal */}
			{showCloseConfirmation && (
				<Modal
					theme={theme}
					title="Close Document Graph?"
					priority={MODAL_PRIORITIES.DOCUMENT_GRAPH + 1}
					onClose={() => setShowCloseConfirmation(false)}
					width={400}
					footer={
						<ModalFooter
							theme={theme}
							onCancel={() => setShowCloseConfirmation(false)}
							onConfirm={() => {
								setShowCloseConfirmation(false);
								onClose();
							}}
							cancelLabel="Cancel"
							confirmLabel="Close Graph"
							confirmButtonRef={confirmCloseButtonRef}
						/>
					}
					initialFocusRef={confirmCloseButtonRef}
				>
					<p style={{ color: theme.colors.textDim }}>
						Are you sure you want to close the Document Graph?
					</p>
				</Modal>
			)}

			{/* Click outside dropdowns to close them */}
			{showLayoutDropdown && (
				<div
					className="fixed inset-0 z-40"
					onClick={(e) => {
						e.stopPropagation();
						setShowLayoutDropdown(false);
					}}
				/>
			)}
			{showDepthSlider && (
				<div
					className="fixed inset-0 z-40"
					onClick={(e) => {
						e.stopPropagation();
						setShowDepthSlider(false);
					}}
				/>
			)}
		</div>
	);
}

export default DocumentGraphView;
