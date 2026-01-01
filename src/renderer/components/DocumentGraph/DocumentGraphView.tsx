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

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  Focus,
} from 'lucide-react';
import type { Theme } from '../../types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Modal, ModalFooter } from '../ui/Modal';
import { useDebouncedCallback } from '../../hooks/utils';
import { buildGraphData, ProgressData, GraphNodeData, CachedExternalData } from './graphDataBuilder';
import { MindMap, MindMapNode, MindMapLink, convertToMindMapData, NodePositionOverride } from './MindMap';
import { NodeContextMenu } from './NodeContextMenu';
import { GraphLegend } from './GraphLegend';

/** Debounce delay for graph rebuilds when settings change (ms) */
const GRAPH_REBUILD_DEBOUNCE_DELAY = 300;
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

  // Selection state
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<MindMapNode | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

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
   * Load and build graph data
   */
  const loadGraphData = useCallback(async (resetPagination = true) => {
    setLoading(true);
    setError(null);
    setProgress(null);

    if (resetPagination) {
      setMaxNodes(defaultMaxNodes);
    }

    try {
      console.log('[DocumentGraph] Building graph data:', { rootPath, focusFilePath, includeExternalLinks });

      const graphData = await buildGraphData({
        rootPath,
        focusFile: focusFilePath,
        maxDepth: neighborDepth > 0 ? neighborDepth : 10, // Use large depth for "all"
        maxNodes: resetPagination ? defaultMaxNodes : maxNodes,
        onProgress: handleProgress,
      });

      console.log('[DocumentGraph] Graph data built:', {
        totalDocuments: graphData.totalDocuments,
        loadedDocuments: graphData.loadedDocuments,
        nodeCount: graphData.nodes.length,
        edgeCount: graphData.edges.length,
        internalLinkCount: graphData.internalLinkCount,
        externalLinkCount: graphData.cachedExternalData.totalLinkCount,
        externalDomains: graphData.cachedExternalData.domainCount,
        sampleNodeIds: graphData.nodes.slice(0, 5).map(n => n.id),
      });

      // Update pagination state
      setTotalDocuments(graphData.totalDocuments);
      setLoadedDocuments(graphData.loadedDocuments);
      setHasMore(graphData.hasMore);

      // Cache external data and link counts for instant toggling
      setCachedExternalData(graphData.cachedExternalData);
      setInternalLinkCount(graphData.internalLinkCount);

      // Convert document-only nodes/links to mind map format (for toggling)
      const docOnlyNodes = graphData.nodes.filter(n => n.type === 'documentNode');
      const docOnlyEdges = graphData.edges.filter(e => e.type !== 'external');
      const { nodes: docMindMapNodes, links: docMindMapLinks } = convertToMindMapData(
        docOnlyNodes.map(n => ({ id: n.id, data: n.data })),
        docOnlyEdges.map(e => ({ source: e.source, target: e.target, type: e.type }))
      );
      setDocumentOnlyNodes(docMindMapNodes);
      setDocumentOnlyLinks(docMindMapLinks);

      // Convert ALL nodes/links (with external) to mind map format (for toggling)
      const allNodes = [...docOnlyNodes, ...graphData.cachedExternalData.externalNodes];
      const allEdges = [...docOnlyEdges, ...graphData.cachedExternalData.externalEdges];
      const { nodes: allMindMapNodes, links: allMindMapLinks } = convertToMindMapData(
        allNodes.map(n => ({ id: n.id, data: n.data })),
        allEdges.map(e => ({ source: e.source, target: e.target, type: e.type }))
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
        sampleFilePaths: mindMapNodes.filter(n => n.nodeType === 'document').slice(0, 5).map(n => n.filePath),
        focusFilePath,
      });

      setNodes(mindMapNodes);
      setLinks(mindMapLinks);

      // Set active focus file from the required focusFilePath prop
      setActiveFocusFile(focusFilePath);
    } catch (err) {
      console.error('Failed to build graph data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load document graph');
    } finally {
      setLoading(false);
    }
  }, [rootPath, includeExternalLinks, maxNodes, defaultMaxNodes, handleProgress, focusFilePath, neighborDepth]);

  /**
   * Debounced version of loadGraphData for settings changes
   */
  const { debouncedCallback: debouncedLoadGraphData, cancel: cancelDebouncedLoad } = useDebouncedCallback(
    () => loadGraphData(),
    GRAPH_REBUILD_DEBOUNCE_DELAY
  );

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
  }, [includeExternalLinks, isOpen, documentOnlyNodes, documentOnlyLinks, allNodesWithExternal, allLinksWithExternal]);

  /**
   * Cancel debounced load on unmount
   */
  useEffect(() => {
    return () => cancelDebouncedLoad();
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
    window.maestro.fs.stat(fullPath)
      .then(stats => {
        setSelectedNodeStats({
          createdAt: stats.createdAt ? new Date(stats.createdAt) : null,
          modifiedAt: stats.modifiedAt ? new Date(stats.modifiedAt) : null,
        });
      })
      .catch(() => {
        setSelectedNodeStats(null);
      });

    // Load file content to count tasks
    window.maestro.fs.readFile(fullPath)
      .then(content => {
        const tasks = countMarkdownTasks(content);
        setSelectedNodeTasks(tasks.total > 0 ? tasks : null);
      })
      .catch(() => {
        setSelectedNodeTasks(null);
      });
  }, [selectedNode, rootPath]);

  /**
   * Handle node double-click - recenter on this document
   */
  const handleNodeDoubleClick = useCallback((node: MindMapNode) => {
    if (node.nodeType === 'document' && node.filePath) {
      // Set this node as the new center of the mind map
      setActiveFocusFile(node.filePath);
      // Ensure neighbor depth is set if it was 0 (show all)
      if (neighborDepth === 0) {
        setNeighborDepth(2);
        onNeighborDepthChange?.(2);
      }
    }
    // For external nodes, we could potentially show all documents linking to it
    // For now, just select it
  }, [neighborDepth, onNeighborDepthChange]);

  /**
   * Handle node context menu
   */
  const handleNodeContextMenu = useCallback((node: MindMapNode, event: MouseEvent) => {
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      nodeId: node.id,
      nodeData: node.nodeType === 'document'
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
  const handleNeighborDepthChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newDepth = parseInt(e.target.value, 10);
    setNeighborDepth(newDepth);
    onNeighborDepthChange?.(newDepth);
  }, [onNeighborDepthChange]);

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
      });

      setTotalDocuments(graphData.totalDocuments);
      setLoadedDocuments(graphData.loadedDocuments);
      setHasMore(graphData.hasMore);

      const { nodes: mindMapNodes, links: mindMapLinks } = convertToMindMapData(
        graphData.nodes.map(n => ({ id: n.id, data: n.data })),
        graphData.edges.map(e => ({ source: e.source, target: e.target, type: e.type }))
      );

      setNodes(mindMapNodes);
      setLinks(mindMapLinks);
    } catch (err) {
      console.error('Failed to load more documents:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, maxNodes, rootPath, activeFocusFile, focusFilePath, neighborDepth]);

  /**
   * Handle context menu open
   */
  const handleContextMenuOpen = useCallback((filePath: string) => {
    if (onDocumentOpen) {
      onDocumentOpen(filePath);
    }
  }, [onDocumentOpen]);

  /**
   * Handle context menu open external
   */
  const handleContextMenuOpenExternal = useCallback((url: string) => {
    if (onExternalLinkOpen) {
      onExternalLinkOpen(url);
    }
  }, [onExternalLinkOpen]);

  /**
   * Handle context menu focus
   */
  const handleContextMenuFocus = useCallback((nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (node?.nodeType === 'document' && node.filePath) {
      setActiveFocusFile(node.filePath);
      if (neighborDepth === 0) {
        setNeighborDepth(2);
      }
    }
    setContextMenu(null);
  }, [nodes, neighborDepth]);

  /**
   * Handle node position change from drag operations
   */
  const handleNodePositionChange = useCallback((nodeId: string, position: NodePositionOverride) => {
    setNodePositions(prev => {
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
  const handleOpenFile = useCallback((filePath: string) => {
    if (onDocumentOpen) {
      onDocumentOpen(filePath);
    }
  }, [onDocumentOpen]);

  /**
   * Handle search input escape key
   * First Escape: clear search if there's content
   * Second Escape (or first if empty): blur search, return focus to graph, select center node
   */
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
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
          const centerNode = nodes.find(n => n.filePath === activeFocusFile);
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
  }, [searchQuery, activeFocusFile, nodes, handleNodeSelect]);

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

  // Show unavailable message for remote sessions - Document Graph cannot scan remote filesystems
  if (sshRemoteId) {
    return (
      <div
        className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] animate-in fade-in duration-100"
        onClick={onClose}
      >
        <div
          ref={containerRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Document Graph - Not Available"
          className="rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none"
          style={{
            backgroundColor: theme.colors.bgActivity,
            borderColor: theme.colors.border,
            width: 480,
            maxWidth: '90vw',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div
            className="px-6 py-4 border-b flex items-center justify-between flex-shrink-0"
            style={{ borderColor: theme.colors.border }}
          >
            <div className="flex items-center gap-3">
              <Network className="w-5 h-5" style={{ color: theme.colors.textDim }} />
              <h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
                Document Graph
              </h2>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded transition-colors"
              style={{ color: theme.colors.textDim }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Content */}
          <div className="px-6 py-8 flex flex-col items-center gap-4">
            <div
              className="p-4 rounded-full"
              style={{ backgroundColor: `${theme.colors.accent}20` }}
            >
              <AlertCircle
                className="w-8 h-8"
                style={{ color: theme.colors.accent }}
              />
            </div>
            <div className="text-center">
              <h3 className="text-base font-medium mb-2" style={{ color: theme.colors.textMain }}>
                Not Available for Remote Sessions
              </h3>
              <p className="text-sm" style={{ color: theme.colors.textDim }}>
                Document Graph requires local filesystem access to scan and visualize markdown file relationships.
                This feature is not available when connected to a remote host via SSH.
              </p>
            </div>
          </div>

          {/* Footer */}
          <div
            className="px-6 py-4 border-t flex justify-end"
            style={{ borderColor: theme.colors.border }}
          >
            <button
              onClick={onClose}
              className="px-4 py-2 rounded text-sm font-medium transition-colors"
              style={{
                backgroundColor: theme.colors.accent,
                color: theme.colors.bgMain,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.85')}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const documentCount = nodes.filter(n => n.nodeType === 'document').length;
  const externalCount = nodes.filter(n => n.nodeType === 'external').length;

  // Count matching nodes when search is active
  const searchMatchCount = searchQuery.trim()
    ? nodes.filter(n => {
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
            {activeFocusFile && (
              <span
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded"
                style={{
                  backgroundColor: `${theme.colors.accent}30`,
                  color: theme.colors.accent,
                }}
                title="Double-click another node to change focus"
              >
                <Focus className="w-3 h-3" />
                Focus: {activeFocusFile.split('/').pop()}
              </span>
            )}
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
                onBlur={(e) => (e.currentTarget.style.borderColor = searchQuery ? theme.colors.accent : 'transparent')}
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

            {/* Neighbor Depth Slider */}
            <div className="relative">
              <button
                onClick={() => setShowDepthSlider(!showDepthSlider)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors"
                style={{
                  backgroundColor: neighborDepth > 0 ? `${theme.colors.accent}25` : `${theme.colors.accent}10`,
                  color: neighborDepth > 0 ? theme.colors.accent : theme.colors.textDim,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${theme.colors.accent}30`)}
                onMouseLeave={(e) =>
                  (e.currentTarget.style.backgroundColor = neighborDepth > 0
                    ? `${theme.colors.accent}25`
                    : `${theme.colors.accent}10`)
                }
                title={neighborDepth > 0 ? `Showing ${neighborDepth} level${neighborDepth > 1 ? 's' : ''} of neighbors` : 'Show all nodes'}
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
                  <div className="flex justify-between text-xs mt-1" style={{ color: theme.colors.textDim }}>
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

            {/* External Links Toggle */}
            <button
              onClick={handleExternalLinksToggle}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors"
              style={{
                backgroundColor: includeExternalLinks ? `${theme.colors.accent}25` : `${theme.colors.accent}10`,
                color: includeExternalLinks ? theme.colors.accent : theme.colors.textDim,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${theme.colors.accent}30`)}
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
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${theme.colors.warning}30`)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = `${theme.colors.warning}20`)}
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
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)}
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
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)}
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
                  {selectedNode.connectionCount !== undefined && selectedNode.connectionCount > 0 && (
                    <span
                      className="px-2 py-0.5 rounded text-xs"
                      style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
                    >
                      {selectedNode.connectionCount} connection{selectedNode.connectionCount !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                {/* Right side: file path */}
                <span style={{ color: theme.colors.textDim }}>
                  {selectedNode.filePath}
                </span>
              </>
            ) : (
              <>
                <span style={{ color: theme.colors.textDim }}>
                  External: {selectedNode.domain}
                </span>
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
                  {progress ? (
                    progress.phase === 'scanning'
                      ? `Scanning directories... (${progress.current} scanned)`
                      : `Parsing documents... ${progress.current} of ${progress.total}`
                  ) : (
                    'Initializing...'
                  )}
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
                {progress && progress.phase === 'parsing' && (progress.internalLinksFound !== undefined || progress.externalLinksFound !== undefined) && (
                  <p
                    className="text-xs"
                    style={{ color: theme.colors.textDim, opacity: 0.6 }}
                  >
                    {progress.internalLinksFound ?? 0} internal · {progress.externalLinksFound ?? 0} external links
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
              onNodeContextMenu={handleNodeContextMenu}
              onOpenFile={handleOpenFile}
              searchQuery={searchQuery}
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
                backgroundColor: legendExpanded ? `${theme.colors.accent}25` : `${theme.colors.accent}10`,
                color: legendExpanded ? theme.colors.accent : theme.colors.textMain,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${theme.colors.accent}30`)}
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
                  includeExternalLinks && externalCount > 0 ? `, ${externalCount} external domain${externalCount !== 1 ? 's' : ''}` : ''
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
                {loadingMore ? 'Loading...' : `Load more (${totalDocuments - loadedDocuments} remaining)`}
              </button>
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
                    <span style={{ color: theme.colors.success }}>{selectedNodeTasks.completed}</span>
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

          <span style={{ opacity: 0.7 }}>
            Click to select • Double-click to recenter • O to open • Arrow keys to navigate • Esc to close
          </span>
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
      {showDepthSlider && (
        <div
          className="fixed inset-0 z-40"
          onClick={(e) => {
            e.stopPropagation(); // Prevent triggering modal close
            setShowDepthSlider(false);
          }}
        />
      )}
    </div>
  );
}

export default DocumentGraphView;
