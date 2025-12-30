/**
 * ForceGraph - Force-directed graph visualization using react-force-graph-2d.
 *
 * This is a complete rewrite from React Flow to react-force-graph-2d for a smoother,
 * more Obsidian-like graph experience. Features:
 * - WebGL/Canvas-based rendering for better performance
 * - Built-in physics simulation with d3-force
 * - Smooth zoom, pan, and node dragging
 * - Node size based on connection count
 * - Neighbor depth filtering (ego-network mode)
 * - Focus mode when opened from file preview
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { ForceGraphMethods } from 'react-force-graph-2d';
import type { Theme } from '../../types';
import type { GraphNodeData, DocumentNodeData, ExternalLinkNodeData } from './graphDataBuilder';

/**
 * Node type for the force graph
 */
export interface ForceGraphNode {
  id: string;
  nodeType: 'document' | 'external';
  label: string;
  // D3 force simulation fields
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
  // Allow any additional properties for d3-force compatibility
  [key: string]: unknown;
  // Document-specific fields
  title?: string;
  filePath?: string;
  description?: string;
  lineCount?: number;
  wordCount?: number;
  size?: string;
  brokenLinks?: string[];
  isLargeFile?: boolean;
  // External-specific fields
  domain?: string;
  linkCount?: number;
  urls?: string[];
  // Computed fields
  neighbors?: Set<string>;
  connectionCount?: number;
  // Visual state
  isHighlighted?: boolean;
  isFocused?: boolean;
  isNeighbor?: boolean;
  depth?: number; // Distance from focus node (0 = focus, 1 = direct neighbor, etc.)
}

/**
 * Link type for the force graph
 */
export interface ForceGraphLink {
  source: string | ForceGraphNode;
  target: string | ForceGraphNode;
  type: 'internal' | 'external';
}

/**
 * Props for the ForceGraph component
 */
export interface ForceGraphProps {
  /** Graph nodes from graphDataBuilder */
  nodes: ForceGraphNode[];
  /** Graph edges/links from graphDataBuilder */
  links: ForceGraphLink[];
  /** Current theme */
  theme: Theme;
  /** Width of the graph container */
  width: number;
  /** Height of the graph container */
  height: number;
  /** Currently selected node ID */
  selectedNodeId: string | null;
  /** Callback when a node is selected */
  onNodeSelect: (node: ForceGraphNode | null) => void;
  /** Callback when a node is double-clicked */
  onNodeDoubleClick: (node: ForceGraphNode) => void;
  /** Callback when a node is right-clicked */
  onNodeContextMenu: (node: ForceGraphNode, event: MouseEvent) => void;
  /** Search query for filtering/highlighting */
  searchQuery: string;
  /** Whether to show external link nodes */
  showExternalLinks: boolean;
  /** Neighbor depth for focus mode (1-5, or 0 for all) */
  neighborDepth: number;
  /** File path to focus on (ego-network mode) */
  focusFilePath: string | null;
  /** Callback when focus is consumed */
  onFocusConsumed?: () => void;
}

/**
 * Convert graph builder data to force graph format
 */
export function convertToForceGraphData(
  graphNodes: Array<{ id: string; data: GraphNodeData }>,
  graphEdges: Array<{ source: string; target: string; type?: string }>
): { nodes: ForceGraphNode[]; links: ForceGraphLink[] } {
  // Build neighbor map for connection counting
  const neighborMap = new Map<string, Set<string>>();

  graphEdges.forEach(edge => {
    if (!neighborMap.has(edge.source)) {
      neighborMap.set(edge.source, new Set());
    }
    if (!neighborMap.has(edge.target)) {
      neighborMap.set(edge.target, new Set());
    }
    neighborMap.get(edge.source)!.add(edge.target);
    neighborMap.get(edge.target)!.add(edge.source);
  });

  const nodes: ForceGraphNode[] = graphNodes.map(node => {
    const neighbors = neighborMap.get(node.id) || new Set();
    const connectionCount = neighbors.size;

    if (node.data.nodeType === 'document') {
      const docData = node.data as DocumentNodeData;
      return {
        id: node.id,
        nodeType: 'document' as const,
        label: docData.title,
        title: docData.title,
        filePath: docData.filePath,
        description: docData.description,
        lineCount: docData.lineCount,
        wordCount: docData.wordCount,
        size: docData.size,
        brokenLinks: docData.brokenLinks,
        isLargeFile: docData.isLargeFile,
        neighbors,
        connectionCount,
      };
    } else {
      const extData = node.data as ExternalLinkNodeData;
      return {
        id: node.id,
        nodeType: 'external' as const,
        label: extData.domain,
        domain: extData.domain,
        linkCount: extData.linkCount,
        urls: extData.urls,
        neighbors,
        connectionCount,
      };
    }
  });

  const links: ForceGraphLink[] = graphEdges.map(edge => ({
    source: edge.source,
    target: edge.target,
    type: edge.type === 'external' ? 'external' : 'internal',
  }));

  return { nodes, links };
}

/**
 * Filter nodes based on neighbor depth from a focus node
 */
function filterByNeighborDepth(
  nodes: ForceGraphNode[],
  links: ForceGraphLink[],
  focusNodeId: string,
  maxDepth: number
): { nodes: ForceGraphNode[]; links: ForceGraphLink[] } {
  if (maxDepth <= 0) {
    return { nodes, links };
  }

  // Build adjacency map
  const adjacency = new Map<string, Set<string>>();
  links.forEach(link => {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;

    if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
    if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
    adjacency.get(sourceId)!.add(targetId);
    adjacency.get(targetId)!.add(sourceId);
  });

  // BFS to find nodes within depth
  const visited = new Map<string, number>(); // nodeId -> depth
  const queue: Array<{ id: string; depth: number }> = [{ id: focusNodeId, depth: 0 }];
  visited.set(focusNodeId, 0);

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (depth >= maxDepth) continue;

    const neighbors = adjacency.get(id) || new Set();
    neighbors.forEach(neighborId => {
      if (!visited.has(neighborId)) {
        visited.set(neighborId, depth + 1);
        queue.push({ id: neighborId, depth: depth + 1 });
      }
    });
  }

  // Filter nodes and add depth info
  const filteredNodes = nodes
    .filter(node => visited.has(node.id))
    .map(node => ({
      ...node,
      depth: visited.get(node.id),
      isFocused: node.id === focusNodeId,
    }));

  // Filter links to only include those between visible nodes
  const visibleNodeIds = new Set(filteredNodes.map(n => n.id));
  const filteredLinks = links.filter(link => {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
    return visibleNodeIds.has(sourceId) && visibleNodeIds.has(targetId);
  });

  return { nodes: filteredNodes, links: filteredLinks };
}

/**
 * ForceGraph component - renders the force-directed graph
 */
export function ForceGraph({
  nodes: rawNodes,
  links: rawLinks,
  theme,
  width,
  height,
  selectedNodeId,
  onNodeSelect,
  onNodeDoubleClick: _onNodeDoubleClick,
  onNodeContextMenu,
  searchQuery,
  showExternalLinks,
  neighborDepth,
  focusFilePath,
  onFocusConsumed,
}: ForceGraphProps) {
  const graphRef = useRef<ForceGraphMethods<ForceGraphNode, ForceGraphLink>>();
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hasInitialized, setHasInitialized] = useState(false);

  // Filter out external nodes if not showing them
  const filteredByType = useMemo(() => {
    const nodes = showExternalLinks
      ? rawNodes
      : rawNodes.filter(n => n.nodeType === 'document');

    const nodeIds = new Set(nodes.map(n => n.id));
    const links = rawLinks.filter(l => {
      const sourceId = typeof l.source === 'string' ? l.source : l.source.id;
      const targetId = typeof l.target === 'string' ? l.target : l.target.id;
      return nodeIds.has(sourceId) && nodeIds.has(targetId);
    });

    return { nodes, links };
  }, [rawNodes, rawLinks, showExternalLinks]);

  // Apply neighbor depth filtering if focus file is set
  const { nodes, links } = useMemo(() => {
    if (focusFilePath && neighborDepth > 0) {
      const focusNodeId = `doc-${focusFilePath}`;
      const focusNode = filteredByType.nodes.find(n => n.id === focusNodeId);

      if (focusNode) {
        return filterByNeighborDepth(
          filteredByType.nodes,
          filteredByType.links,
          focusNodeId,
          neighborDepth
        );
      }
    }

    return filteredByType;
  }, [filteredByType, focusFilePath, neighborDepth]);

  // Check if node matches search query
  const nodeMatchesSearch = useCallback((node: ForceGraphNode): boolean => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();

    if (node.nodeType === 'document') {
      return (
        (node.title?.toLowerCase().includes(query) ?? false) ||
        (node.filePath?.toLowerCase().includes(query) ?? false) ||
        (node.description?.toLowerCase().includes(query) ?? false)
      );
    } else {
      return (
        (node.domain?.toLowerCase().includes(query) ?? false) ||
        (node.urls?.some(url => url.toLowerCase().includes(query)) ?? false)
      );
    }
  }, [searchQuery]);

  // Get node color based on state
  const getNodeColor = useCallback((node: ForceGraphNode): string => {
    const isSearchActive = searchQuery.trim().length > 0;
    const matchesSearch = nodeMatchesSearch(node);

    // Dimmed if search is active and doesn't match
    if (isSearchActive && !matchesSearch) {
      return theme.colors.textDim + '40'; // Very transparent
    }

    // Highlighted states
    if (node.id === selectedNodeId) {
      return theme.colors.accent;
    }
    if (node.id === hoveredNodeId) {
      return theme.colors.accent + 'CC';
    }
    if (node.isFocused) {
      return theme.colors.accent;
    }

    // Check if neighbor of selected/hovered
    const activeNodeId = hoveredNodeId || selectedNodeId;
    if (activeNodeId) {
      const activeNode = nodes.find(n => n.id === activeNodeId);
      if (activeNode?.neighbors?.has(node.id)) {
        return node.nodeType === 'document'
          ? theme.colors.accent + '99'
          : theme.colors.textDim + '99';
      }
    }

    // Default colors by type
    if (node.nodeType === 'document') {
      // Color intensity based on depth from focus
      if (node.depth !== undefined && node.depth > 0) {
        const opacity = Math.max(0.4, 1 - (node.depth - 1) * 0.2);
        return theme.colors.accent + Math.round(opacity * 255).toString(16).padStart(2, '0');
      }
      return theme.colors.accent + 'BB';
    } else {
      return theme.colors.textDim + '88';
    }
  }, [theme, selectedNodeId, hoveredNodeId, searchQuery, nodeMatchesSearch, nodes]);

  // Get node size based on connection count
  const getNodeSize = useCallback((node: ForceGraphNode): number => {
    const baseSize = node.nodeType === 'document' ? 8 : 5;
    const connectionBonus = Math.min((node.connectionCount || 0) * 0.5, 8);

    // Make focused node larger
    if (node.isFocused) {
      return baseSize + connectionBonus + 4;
    }

    // Slightly larger if selected or hovered
    if (node.id === selectedNodeId || node.id === hoveredNodeId) {
      return baseSize + connectionBonus + 2;
    }

    return baseSize + connectionBonus;
  }, [selectedNodeId, hoveredNodeId]);

  // Get link color based on state
  const getLinkColor = useCallback((link: ForceGraphLink): string => {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;

    const activeNodeId = hoveredNodeId || selectedNodeId;

    // Highlight links connected to active node
    if (activeNodeId && (sourceId === activeNodeId || targetId === activeNodeId)) {
      return theme.colors.accent + 'CC';
    }

    // External links are dimmer
    if (link.type === 'external') {
      return theme.colors.textDim + '44';
    }

    return theme.colors.textDim + '66';
  }, [theme, selectedNodeId, hoveredNodeId]);

  // Get link width based on state
  const getLinkWidth = useCallback((link: ForceGraphLink): number => {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;

    const activeNodeId = hoveredNodeId || selectedNodeId;

    if (activeNodeId && (sourceId === activeNodeId || targetId === activeNodeId)) {
      return 2;
    }

    return link.type === 'external' ? 0.5 : 1;
  }, [selectedNodeId, hoveredNodeId]);

  // Draw node with label
  const drawNode = useCallback((
    node: ForceGraphNode,
    ctx: CanvasRenderingContext2D,
    globalScale: number
  ) => {
    const size = getNodeSize(node);
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const color = getNodeColor(node);

    // Draw node circle
    ctx.beginPath();
    ctx.arc(x, y, size, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();

    // Draw border for selected/focused nodes
    if (node.id === selectedNodeId || node.isFocused) {
      ctx.strokeStyle = theme.colors.accent;
      ctx.lineWidth = 2 / globalScale;
      ctx.stroke();
    }

    // Draw label if zoomed in enough or node is active
    const showLabel = globalScale > 0.8 ||
      node.id === selectedNodeId ||
      node.id === hoveredNodeId ||
      node.isFocused;

    if (showLabel) {
      const label = node.label;
      const fontSize = Math.max(10 / globalScale, 3);
      ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      // Draw label background for readability
      const metrics = ctx.measureText(label);
      const labelHeight = fontSize * 1.2;
      const padding = 2 / globalScale;

      ctx.fillStyle = theme.colors.bgActivity + 'DD';
      ctx.fillRect(
        x - metrics.width / 2 - padding,
        y + size + 2 / globalScale,
        metrics.width + padding * 2,
        labelHeight + padding
      );

      // Draw label text
      ctx.fillStyle = theme.colors.textMain;
      ctx.fillText(label, x, y + size + 3 / globalScale);
    }
  }, [theme, selectedNodeId, hoveredNodeId, getNodeSize, getNodeColor]);

  // Handle node click
  const handleNodeClick = useCallback((node: ForceGraphNode) => {
    onNodeSelect(node);
  }, [onNodeSelect]);

  // Handle node hover
  const handleNodeHover = useCallback((node: ForceGraphNode | null) => {
    setHoveredNodeId(node?.id ?? null);
  }, []);

  // Handle node right-click
  const handleNodeRightClick = useCallback((node: ForceGraphNode, event: MouseEvent) => {
    event.preventDefault();
    onNodeContextMenu(node, event);
  }, [onNodeContextMenu]);

  // Handle background click
  const handleBackgroundClick = useCallback(() => {
    onNodeSelect(null);
  }, [onNodeSelect]);

  // Center on focus node after initial load
  useEffect(() => {
    if (!hasInitialized && nodes.length > 0 && graphRef.current) {
      setHasInitialized(true);

      // If we have a focus file, center on it
      if (focusFilePath) {
        const focusNodeId = `doc-${focusFilePath}`;
        const focusNode = nodes.find(n => n.id === focusNodeId);

        if (focusNode) {
          // Wait for physics to settle a bit
          setTimeout(() => {
            graphRef.current?.centerAt(focusNode.x ?? 0, focusNode.y ?? 0, 500);
            graphRef.current?.zoom(1.5, 500);
            onFocusConsumed?.();
          }, 500);
        } else {
          // Focus file not found, just zoom to fit
          setTimeout(() => {
            graphRef.current?.zoomToFit(400, 50);
            onFocusConsumed?.();
          }, 500);
        }
      } else {
        // No focus file, zoom to fit all
        setTimeout(() => {
          graphRef.current?.zoomToFit(400, 50);
        }, 500);
      }
    }
  }, [hasInitialized, nodes, focusFilePath, onFocusConsumed]);

  // Re-center when focus file changes
  useEffect(() => {
    if (focusFilePath && hasInitialized && graphRef.current) {
      const focusNodeId = `doc-${focusFilePath}`;
      const focusNode = nodes.find(n => n.id === focusNodeId);

      if (focusNode && focusNode.x !== undefined && focusNode.y !== undefined) {
        graphRef.current.centerAt(focusNode.x, focusNode.y, 500);
        graphRef.current.zoom(1.5, 500);
      }
    }
  }, [focusFilePath, hasInitialized, nodes]);

  // Configure physics
  useEffect(() => {
    if (graphRef.current) {
      // Get the d3 force simulation
      const fg = graphRef.current;

      // Configure forces for better layout
      fg.d3Force('charge')?.strength(-150);
      fg.d3Force('link')?.distance(80);
      fg.d3Force('center')?.strength(0.05);

      // Reheat simulation when nodes change significantly
      fg.d3ReheatSimulation();
    }
  }, [nodes.length]);

  return (
    <ForceGraph2D
      ref={graphRef}
      graphData={{ nodes, links }}
      width={width}
      height={height}
      backgroundColor={theme.colors.bgMain}
      // Node rendering
      nodeCanvasObject={drawNode}
      nodePointerAreaPaint={(node, color, ctx) => {
        const size = getNodeSize(node as ForceGraphNode);
        ctx.beginPath();
        ctx.arc(node.x ?? 0, node.y ?? 0, size + 2, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
      }}
      // Link rendering
      linkColor={getLinkColor}
      linkWidth={getLinkWidth}
      linkDirectionalParticles={0}
      linkCurvature={0.1}
      // Interactions
      onNodeClick={handleNodeClick}
      onNodeHover={handleNodeHover}
      onNodeRightClick={handleNodeRightClick}
      onNodeDragEnd={(node) => {
        // Fix node position after drag
        node.fx = node.x;
        node.fy = node.y;
      }}
      onBackgroundClick={handleBackgroundClick}
      // Performance
      cooldownTicks={100}
      warmupTicks={50}
      // Enable dragging
      enableNodeDrag={true}
      // Zoom limits
      minZoom={0.1}
      maxZoom={4}
    />
  );
}

export default ForceGraph;
