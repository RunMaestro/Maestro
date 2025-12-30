/**
 * DocumentGraphView - Main container component for the markdown document graph visualization.
 *
 * Rewritten to use react-force-graph-2d for a smoother, Obsidian-like experience.
 *
 * Features:
 * - Force-directed graph with smooth physics simulation
 * - Neighbor depth slider for focused ego-network views
 * - Node size based on connection count
 * - Search highlighting
 * - External links toggle
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
  Focus,
  AlertCircle,
} from 'lucide-react';
import type { Theme } from '../../types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Modal, ModalFooter } from '../ui/Modal';
import { useDebouncedCallback } from '../../hooks/utils';
import { buildGraphData, ProgressData, GraphNodeData } from './graphDataBuilder';
import { ForceGraph, ForceGraphNode, ForceGraphLink, convertToForceGraphData } from './ForceGraph';
import { NodeContextMenu } from './NodeContextMenu';
import { GraphLegend } from './GraphLegend';

/** Debounce delay for graph rebuilds when settings change (ms) */
const GRAPH_REBUILD_DEBOUNCE_DELAY = 300;
/** Default maximum number of nodes to load initially */
const DEFAULT_MAX_NODES = 50;
/** Number of additional nodes to load when clicking "Load more" */
const LOAD_MORE_INCREMENT = 25;

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
  /** Optional file path (relative to rootPath) to focus on when the graph opens */
  focusFilePath?: string;
  /** Callback when focus file is consumed (cleared after focusing) */
  onFocusFileConsumed?: () => void;
  /** Saved layout mode preference */
  savedLayoutMode?: 'force' | 'hierarchical';
  /** Callback to persist layout mode changes */
  onLayoutModeChange?: (mode: 'force' | 'hierarchical') => void;
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
  onFocusFileConsumed,
  defaultShowExternalLinks = false,
  onExternalLinksChange,
  defaultMaxNodes = DEFAULT_MAX_NODES,
  defaultNeighborDepth = 2,
  onNeighborDepthChange,
}: DocumentGraphViewProps) {
  // Graph data state
  const [nodes, setNodes] = useState<ForceGraphNode[]>([]);
  const [links, setLinks] = useState<ForceGraphLink[]>([]);
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
  const [selectedNode, setSelectedNode] = useState<ForceGraphNode | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Pagination state
  const [totalDocuments, setTotalDocuments] = useState(0);
  const [loadedDocuments, setLoadedDocuments] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [maxNodes, setMaxNodes] = useState(defaultMaxNodes);

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
  const [graphDimensions, setGraphDimensions] = useState({ width: 800, height: 600 });

  // Layer stack for escape handling
  const { registerLayer, unregisterLayer } = useLayerStack();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Track whether data has been loaded
  const hasLoadedDataRef = useRef(false);
  const prevRootPathRef = useRef(rootPath);

  // Focus file tracking
  const [activeFocusFile, setActiveFocusFile] = useState<string | null>(null);
  const focusFilePathRef = useRef(focusFilePath);
  focusFilePathRef.current = focusFilePath;

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
   * Focus container on open
   */
  useEffect(() => {
    if (isOpen) {
      containerRef.current?.focus();
    }
  }, [isOpen]);

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
      const graphData = await buildGraphData({
        rootPath,
        includeExternalLinks,
        maxNodes: resetPagination ? defaultMaxNodes : maxNodes,
        onProgress: handleProgress,
      });

      // Update pagination state
      setTotalDocuments(graphData.totalDocuments);
      setLoadedDocuments(graphData.loadedDocuments);
      setHasMore(graphData.hasMore);

      // Convert to force graph format
      const { nodes: forceNodes, links: forceLinks } = convertToForceGraphData(
        graphData.nodes.map(n => ({ id: n.id, data: n.data })),
        graphData.edges.map(e => ({ source: e.source, target: e.target, type: e.type }))
      );

      setNodes(forceNodes);
      setLinks(forceLinks);

      // Set active focus file if provided
      if (focusFilePathRef.current) {
        setActiveFocusFile(focusFilePathRef.current);
      }
    } catch (err) {
      console.error('Failed to build graph data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load document graph');
    } finally {
      setLoading(false);
    }
  }, [rootPath, includeExternalLinks, maxNodes, defaultMaxNodes, handleProgress]);

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
   * Reload when external links toggle changes
   */
  useEffect(() => {
    if (isOpen && hasLoadedDataRef.current) {
      debouncedLoadGraphData();
    }
  }, [includeExternalLinks]);

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
  const handleNodeSelect = useCallback((node: ForceGraphNode | null) => {
    setSelectedNodeId(node?.id ?? null);
    setSelectedNode(node);
    setContextMenu(null);
  }, []);

  /**
   * Handle node double-click
   */
  const handleNodeDoubleClick = useCallback((node: ForceGraphNode) => {
    if (node.nodeType === 'document' && onDocumentOpen && node.filePath) {
      onDocumentOpen(node.filePath);
    } else if (node.nodeType === 'external' && onExternalLinkOpen && node.urls?.length) {
      onExternalLinkOpen(node.urls[0]);
    }
  }, [onDocumentOpen, onExternalLinkOpen]);

  /**
   * Handle node context menu
   */
  const handleNodeContextMenu = useCallback((node: ForceGraphNode, event: MouseEvent) => {
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      nodeId: node.id,
      nodeData: node.nodeType === 'document'
        ? {
            nodeType: 'document',
            title: node.title || '',
            filePath: node.filePath || '',
            description: node.description,
            lineCount: node.lineCount || 0,
            wordCount: node.wordCount || 0,
            size: node.size || '0B',
          }
        : {
            nodeType: 'external',
            domain: node.domain || '',
            linkCount: node.linkCount || 0,
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
   * Handle focus file consumed
   */
  const handleFocusConsumed = useCallback(() => {
    onFocusFileConsumed?.();
  }, [onFocusFileConsumed]);

  /**
   * Clear focus mode
   */
  const handleClearFocus = useCallback(() => {
    setActiveFocusFile(null);
    setNeighborDepth(0);
  }, []);

  /**
   * Focus on selected node
   */
  const handleFocusOnNode = useCallback(() => {
    if (selectedNode?.nodeType === 'document' && selectedNode.filePath) {
      setActiveFocusFile(selectedNode.filePath);
      if (neighborDepth === 0) {
        setNeighborDepth(2);
      }
    }
  }, [selectedNode, neighborDepth]);

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
        includeExternalLinks,
        maxNodes: newMaxNodes,
      });

      setTotalDocuments(graphData.totalDocuments);
      setLoadedDocuments(graphData.loadedDocuments);
      setHasMore(graphData.hasMore);

      const { nodes: forceNodes, links: forceLinks } = convertToForceGraphData(
        graphData.nodes.map(n => ({ id: n.id, data: n.data })),
        graphData.edges.map(e => ({ source: e.source, target: e.target, type: e.type }))
      );

      setNodes(forceNodes);
      setLinks(forceLinks);
    } catch (err) {
      console.error('Failed to load more documents:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, maxNodes, rootPath, includeExternalLinks]);

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

  if (!isOpen) return null;

  const documentCount = nodes.filter(n => n.nodeType === 'document').length;
  const externalCount = nodes.filter(n => n.nodeType === 'external').length;

  // Count matching nodes when search is active
  const searchMatchCount = searchQuery.trim()
    ? nodes.filter(n => {
        const query = searchQuery.toLowerCase();
        if (n.nodeType === 'document') {
          return (
            (n.title?.toLowerCase().includes(query) ?? false) ||
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
      onClick={onClose}
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
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded cursor-pointer"
                style={{
                  backgroundColor: `${theme.colors.accent}30`,
                  color: theme.colors.accent,
                }}
                onClick={handleClearFocus}
                title="Click to show all documents"
              >
                <Focus className="w-3 h-3" />
                Focus: {activeFocusFile.split('/').pop()}
                <X className="w-3 h-3 ml-1" />
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

            {/* Focus on Selected */}
            {selectedNode?.nodeType === 'document' && (
              <button
                onClick={handleFocusOnNode}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors"
                style={{
                  backgroundColor: `${theme.colors.accent}15`,
                  color: theme.colors.textMain,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${theme.colors.accent}25`)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`)}
                title="Focus view on selected document"
              >
                <Focus className="w-4 h-4" />
                Focus
              </button>
            )}

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
        </div>

        {/* Selected Node Info Bar */}
        {selectedNode && (
          <div
            className="px-6 py-2 border-b flex items-center gap-3 text-sm"
            style={{
              borderColor: theme.colors.border,
              backgroundColor: `${theme.colors.accent}10`,
            }}
          >
            {selectedNode.nodeType === 'document' ? (
              <>
                <span style={{ color: theme.colors.accent, fontWeight: 500 }}>
                  {selectedNode.title}
                </span>
                <span style={{ color: theme.colors.textDim }}>
                  {selectedNode.filePath}
                </span>
                {selectedNode.connectionCount !== undefined && selectedNode.connectionCount > 0 && (
                  <span
                    className="px-2 py-0.5 rounded text-xs"
                    style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
                  >
                    {selectedNode.connectionCount} connection{selectedNode.connectionCount !== 1 ? 's' : ''}
                  </span>
                )}
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
          className="flex-1 relative"
          style={{ backgroundColor: theme.colors.bgMain }}
        >
          {loading ? (
            <div className="h-full flex flex-col items-center justify-center gap-4">
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: theme.colors.accent }} />
              <div className="flex flex-col items-center gap-2">
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
          ) : (
            <ForceGraph
              nodes={nodes}
              links={links}
              theme={theme}
              width={graphDimensions.width}
              height={graphDimensions.height}
              selectedNodeId={selectedNodeId}
              onNodeSelect={handleNodeSelect}
              onNodeDoubleClick={handleNodeDoubleClick}
              onNodeContextMenu={handleNodeContextMenu}
              searchQuery={searchQuery}
              showExternalLinks={includeExternalLinks}
              neighborDepth={neighborDepth}
              focusFilePath={activeFocusFile}
              onFocusConsumed={handleFocusConsumed}
            />
          )}

          {/* Graph Legend */}
          {!loading && !error && nodes.length > 0 && (
            <GraphLegend theme={theme} showExternalLinks={includeExternalLinks} />
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
          className="px-6 py-3 border-t flex items-center justify-between text-xs flex-shrink-0"
          style={{
            borderColor: theme.colors.border,
            color: theme.colors.textDim,
          }}
        >
          <div className="flex items-center gap-3">
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
          <span style={{ opacity: 0.7 }}>
            Click to select • Double-click to open • Drag to move • Scroll to zoom • Esc to close
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

      {/* Click outside depth slider to close it */}
      {showDepthSlider && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setShowDepthSlider(false)}
        />
      )}
    </div>
  );
}

export default DocumentGraphView;
