/**
 * MindMap - Deterministic canvas-based mind map visualization.
 *
 * A complete rewrite from force-directed graph to a clean, centered mind map layout.
 * Features:
 * - Center document displayed prominently in the middle
 * - Linked documents fan out in alphabetized left/right columns
 * - External URLs clustered separately at the bottom
 * - Keyboard navigation support
 * - Canvas-based rendering for full control
 * - No physics simulation - deterministic positioning
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Theme } from '../../types';
import type { GraphNodeData, DocumentNodeData, ExternalLinkNodeData } from './graphDataBuilder';

// ============================================================================
// Types
// ============================================================================

/**
 * Position and visual state for a mind map node
 */
export interface MindMapNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  side: 'left' | 'right' | 'center' | 'external';
  nodeType: 'document' | 'external';
  label: string;
  filePath?: string;
  description?: string;
  descriptionExpanded?: boolean;
  domain?: string;
  urls?: string[];
  lineCount?: number;
  wordCount?: number;
  size?: string;
  brokenLinks?: string[];
  isLargeFile?: boolean;
  isSelected?: boolean;
  isFocused?: boolean;
  connectionCount?: number;
  neighbors?: Set<string>;
}

/**
 * Link between two nodes
 */
export interface MindMapLink {
  source: string;
  target: string;
  type: 'internal' | 'external';
}

/**
 * Props for the MindMap component
 */
export interface MindMapProps {
  /** Required - the file path of the center document */
  centerFilePath: string;
  /** All nodes from graphDataBuilder */
  nodes: MindMapNode[];
  /** All links from graphDataBuilder */
  links: MindMapLink[];
  /** Current theme */
  theme: Theme;
  /** Width of the canvas container */
  width: number;
  /** Height of the canvas container */
  height: number;
  /** Maximum depth to show (1-5) */
  maxDepth: number;
  /** Whether to show external link nodes */
  showExternalLinks: boolean;
  /** Currently selected node ID */
  selectedNodeId: string | null;
  /** Callback when a node is selected */
  onNodeSelect: (node: MindMapNode | null) => void;
  /** Callback when a node is double-clicked (recenter on document) */
  onNodeDoubleClick: (node: MindMapNode) => void;
  /** Callback for context menu */
  onNodeContextMenu: (node: MindMapNode, event: MouseEvent) => void;
  /** Callback to open a document in file preview */
  onOpenFile: (filePath: string) => void;
  /** Search query for highlighting */
  searchQuery: string;
}

// ============================================================================
// Layout Constants
// ============================================================================

/** Horizontal spacing between depth levels */
const HORIZONTAL_SPACING = 340;
/** Minimum vertical spacing between nodes */
const VERTICAL_SPACING = 120;
/** Document node width */
const NODE_WIDTH = 260;
/** Header height for node title bar */
const NODE_HEADER_HEIGHT = 32;
/** Minimum node height (title only) */
const NODE_HEIGHT_BASE = 56;
/** Node height with description */
const NODE_HEIGHT_WITH_DESC = 90;
/** Maximum characters per line in description */
const DESC_MAX_CHARS_PER_LINE = 32;
/** Scale factor for center node */
const CENTER_NODE_SCALE = 1.15;
/** External node width (smaller) */
const EXTERNAL_NODE_WIDTH = 150;
/** External node height */
const EXTERNAL_NODE_HEIGHT = 38;
/** Offset for external link cluster from bottom */
const EXTERNAL_CLUSTER_OFFSET = 120;
/** Padding around canvas content */
const CANVAS_PADDING = 80;
/** Node corner radius */
const NODE_BORDER_RADIUS = 12;
/** Open icon size */
const OPEN_ICON_SIZE = 14;
/** Open icon padding from node edge */
const OPEN_ICON_PADDING = 8;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Truncate text to a maximum length with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Draw a rounded rectangle path
 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Draw an "external link" icon (square with arrow)
 */
function drawOpenIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const padding = size * 0.15;
  const boxSize = size - padding * 2;

  // Draw square
  ctx.beginPath();
  ctx.rect(x + padding, y + padding + boxSize * 0.25, boxSize * 0.75, boxSize * 0.75);
  ctx.stroke();

  // Draw arrow pointing up-right
  const arrowStart = { x: x + padding + boxSize * 0.35, y: y + padding + boxSize * 0.65 };
  const arrowEnd = { x: x + padding + boxSize, y: y + padding };

  ctx.beginPath();
  ctx.moveTo(arrowStart.x, arrowStart.y);
  ctx.lineTo(arrowEnd.x, arrowEnd.y);
  ctx.stroke();

  // Arrow head
  ctx.beginPath();
  ctx.moveTo(arrowEnd.x - boxSize * 0.3, arrowEnd.y);
  ctx.lineTo(arrowEnd.x, arrowEnd.y);
  ctx.lineTo(arrowEnd.x, arrowEnd.y + boxSize * 0.3);
  ctx.stroke();
}

/**
 * Draw a bezier curve link between two nodes
 */
function drawLink(
  ctx: CanvasRenderingContext2D,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  color: string,
  lineWidth: number,
  isDashed: boolean = false
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;

  if (isDashed) {
    ctx.setLineDash([6, 4]);
  } else {
    ctx.setLineDash([]);
  }

  // Calculate control points for smooth bezier curve
  const dx = Math.abs(targetX - sourceX);
  const controlOffset = Math.min(dx * 0.5, 100);

  ctx.beginPath();
  ctx.moveTo(sourceX, sourceY);

  // Use quadratic bezier for horizontal-ish connections
  if (Math.abs(sourceY - targetY) < 20) {
    ctx.lineTo(targetX, targetY);
  } else {
    // Use cubic bezier for better curves
    const cp1x = sourceX + (sourceX < targetX ? controlOffset : -controlOffset);
    const cp2x = targetX + (targetX < sourceX ? controlOffset : -controlOffset);
    ctx.bezierCurveTo(cp1x, sourceY, cp2x, targetY, targetX, targetY);
  }

  ctx.stroke();
  ctx.setLineDash([]);
}

// ============================================================================
// Layout Algorithm
// ============================================================================

interface LayoutResult {
  nodes: MindMapNode[];
  links: MindMapLink[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

/**
 * Calculate the mind map layout with center node and branching structure
 */
function calculateMindMapLayout(
  allNodes: MindMapNode[],
  allLinks: MindMapLink[],
  centerFilePath: string,
  maxDepth: number,
  canvasWidth: number,
  canvasHeight: number,
  showExternalLinks: boolean
): LayoutResult {
  // Find center node - try multiple path variations
  // The centerFilePath might be relative to the root, but node filePaths might be
  // relative to a subdirectory (e.g., "docs/index.md" vs "index.md")

  let centerNode: MindMapNode | undefined;
  let actualCenterNodeId: string = '';

  // Get all document nodes for searching
  const documentNodes = allNodes.filter(n => n.nodeType === 'document');

  // Build a list of all node IDs and filePaths for matching
  const nodeIdSet = new Set(documentNodes.map(n => n.id));
  const filePathToNode = new Map<string, MindMapNode>();
  documentNodes.forEach(n => {
    if (n.filePath) {
      // Index by full path
      filePathToNode.set(n.filePath, n);
      // Index by filename only
      const filename = n.filePath.split('/').pop();
      if (filename && !filePathToNode.has(filename)) {
        filePathToNode.set(filename, n);
      }
    }
  });

  // Generate all possible variations of the centerFilePath
  const searchVariations = [
    centerFilePath,
    centerFilePath.replace(/^\/+/, ''),
    centerFilePath.split('/').pop() || centerFilePath,
  ];

  // Try to find by node ID first
  for (const variation of searchVariations) {
    const nodeId = `doc-${variation}`;
    if (nodeIdSet.has(nodeId)) {
      centerNode = documentNodes.find(n => n.id === nodeId);
      if (centerNode) {
        actualCenterNodeId = nodeId;
        break;
      }
    }
  }

  // Try to find by filePath
  if (!centerNode) {
    for (const variation of searchVariations) {
      const node = filePathToNode.get(variation);
      if (node) {
        centerNode = node;
        actualCenterNodeId = node.id;
        break;
      }
    }
  }

  // Try fuzzy filename match (case-insensitive, without extension)
  if (!centerNode) {
    const targetFilename = (centerFilePath.split('/').pop() || centerFilePath).toLowerCase();
    const targetBasename = targetFilename.replace(/\.md$/i, '');

    for (const node of documentNodes) {
      const nodeFilename = (node.filePath?.split('/').pop() || node.label || '').toLowerCase();
      const nodeBasename = nodeFilename.replace(/\.md$/i, '');

      if (nodeFilename === targetFilename || nodeBasename === targetBasename) {
        centerNode = node;
        actualCenterNodeId = node.id;
        break;
      }
    }
  }

  // Fallback: if still not found and we have document nodes, use the first one
  if (!centerNode && documentNodes.length > 0) {
    console.warn(
      `[MindMap] Center node not found for path: "${centerFilePath}"`,
      '\nSearched variations:', searchVariations,
      '\nAvailable document nodes:',
      documentNodes.map(n => ({ id: n.id, filePath: n.filePath })).slice(0, 10),
      documentNodes.length > 10 ? `... and ${documentNodes.length - 10} more` : ''
    );
    centerNode = documentNodes[0];
    actualCenterNodeId = centerNode.id;
  }

  if (!centerNode) {
    // No document nodes at all
    console.warn(`[MindMap] No document nodes available for center`);
    return {
      nodes: [],
      links: [],
      bounds: { minX: 0, maxX: canvasWidth, minY: 0, maxY: canvasHeight }
    };
  }

  // Build adjacency map from links
  const adjacency = new Map<string, Set<string>>();
  allLinks.forEach(link => {
    if (!adjacency.has(link.source)) adjacency.set(link.source, new Set());
    if (!adjacency.has(link.target)) adjacency.set(link.target, new Set());
    adjacency.get(link.source)!.add(link.target);
    adjacency.get(link.target)!.add(link.source);
  });

  // BFS to find nodes within maxDepth
  const visited = new Map<string, number>(); // nodeId -> depth
  const queue: Array<{ id: string; depth: number }> = [{ id: actualCenterNodeId, depth: 0 }];
  visited.set(actualCenterNodeId, 0);

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

  // Filter nodes to only those within depth
  const nodesInRange = allNodes.filter(n => {
    // Filter out external nodes if not showing them
    if (n.nodeType === 'external' && !showExternalLinks) return false;
    return visited.has(n.id);
  });

  // Separate document and external nodes from the filtered set
  const visibleDocumentNodes = nodesInRange.filter(n => n.nodeType === 'document');
  const externalNodes = nodesInRange.filter(n => n.nodeType === 'external');

  // Position center node
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2 - (showExternalLinks && externalNodes.length > 0 ? 50 : 0);
  const centerWidth = NODE_WIDTH * CENTER_NODE_SCALE;
  const centerHeight = (centerNode.description ? NODE_HEIGHT_WITH_DESC : NODE_HEIGHT_BASE) * CENTER_NODE_SCALE;

  const positionedNodes: MindMapNode[] = [];
  const usedLinks: MindMapLink[] = [];

  // Add center node
  positionedNodes.push({
    ...centerNode,
    x: centerX,
    y: centerY,
    width: centerWidth,
    height: centerHeight,
    depth: 0,
    side: 'center',
    isFocused: true,
  });

  // Group nodes by depth
  const nodesByDepth = new Map<number, MindMapNode[]>();
  visibleDocumentNodes.forEach(node => {
    if (node.id === actualCenterNodeId) return;
    const depth = visited.get(node.id) || 1;
    if (!nodesByDepth.has(depth)) nodesByDepth.set(depth, []);
    nodesByDepth.get(depth)!.push(node);
  });

  // Process each depth level
  for (let depth = 1; depth <= maxDepth; depth++) {
    const nodesAtDepth = nodesByDepth.get(depth) || [];
    if (nodesAtDepth.length === 0) continue;

    // Sort alphabetically by label
    nodesAtDepth.sort((a, b) => a.label.localeCompare(b.label));

    // Split into left and right columns
    const midpoint = Math.ceil(nodesAtDepth.length / 2);
    const leftNodes = nodesAtDepth.slice(0, midpoint);
    const rightNodes = nodesAtDepth.slice(midpoint);

    // Calculate positions for left column
    const leftX = centerX - (HORIZONTAL_SPACING * depth);
    const leftTotalHeight = leftNodes.length * VERTICAL_SPACING;
    const leftStartY = centerY - leftTotalHeight / 2 + VERTICAL_SPACING / 2;

    leftNodes.forEach((node, index) => {
      const height = node.description ? NODE_HEIGHT_WITH_DESC : NODE_HEIGHT_BASE;
      positionedNodes.push({
        ...node,
        x: leftX,
        y: leftStartY + index * VERTICAL_SPACING,
        width: NODE_WIDTH,
        height,
        depth,
        side: 'left',
      });
    });

    // Calculate positions for right column
    const rightX = centerX + (HORIZONTAL_SPACING * depth);
    const rightTotalHeight = rightNodes.length * VERTICAL_SPACING;
    const rightStartY = centerY - rightTotalHeight / 2 + VERTICAL_SPACING / 2;

    rightNodes.forEach((node, index) => {
      const height = node.description ? NODE_HEIGHT_WITH_DESC : NODE_HEIGHT_BASE;
      positionedNodes.push({
        ...node,
        x: rightX,
        y: rightStartY + index * VERTICAL_SPACING,
        width: NODE_WIDTH,
        height,
        depth,
        side: 'right',
      });
    });
  }

  // Position external nodes at the bottom
  if (showExternalLinks && externalNodes.length > 0) {
    // Sort alphabetically by domain
    externalNodes.sort((a, b) => (a.domain || '').localeCompare(b.domain || ''));

    const externalY = centerY + Math.max(
      ...positionedNodes.filter(n => n.side !== 'external').map(n => Math.abs(n.y - centerY))
    ) + EXTERNAL_CLUSTER_OFFSET;

    const totalExternalWidth = externalNodes.length * (EXTERNAL_NODE_WIDTH + 20);
    const externalStartX = centerX - totalExternalWidth / 2 + EXTERNAL_NODE_WIDTH / 2;

    externalNodes.forEach((node, index) => {
      positionedNodes.push({
        ...node,
        x: externalStartX + index * (EXTERNAL_NODE_WIDTH + 20),
        y: externalY,
        width: EXTERNAL_NODE_WIDTH,
        height: EXTERNAL_NODE_HEIGHT,
        depth: 1,
        side: 'external',
      });
    });
  }

  // Filter links to only include "inside-out" connections (adjacent depth levels)
  // This prevents crossing lines by only connecting:
  // - Center (depth 0) to depth 1
  // - Depth N to depth N+1
  // - Documents to their external links
  const positionedNodeIds = new Set(positionedNodes.map(n => n.id));
  const nodeDepthMap = new Map(positionedNodes.map(n => [n.id, n.depth]));
  const nodeTypeMap = new Map(positionedNodes.map(n => [n.id, n.nodeType]));

  allLinks.forEach(link => {
    if (!positionedNodeIds.has(link.source) || !positionedNodeIds.has(link.target)) {
      return; // Skip if either node isn't positioned
    }

    const sourceDepth = nodeDepthMap.get(link.source) ?? 0;
    const targetDepth = nodeDepthMap.get(link.target) ?? 0;
    const sourceType = nodeTypeMap.get(link.source);
    const targetType = nodeTypeMap.get(link.target);

    // Allow connections if:
    // 1. Adjacent depth levels (difference of 1)
    // 2. External link connections (document to external domain)
    const depthDiff = Math.abs(sourceDepth - targetDepth);
    const isExternalLink = sourceType === 'external' || targetType === 'external';

    if (depthDiff <= 1 || isExternalLink) {
      usedLinks.push(link);
    }
  });

  // Calculate bounds
  const xs = positionedNodes.map(n => n.x);
  const ys = positionedNodes.map(n => n.y);
  const bounds = {
    minX: Math.min(...xs) - NODE_WIDTH / 2 - CANVAS_PADDING,
    maxX: Math.max(...xs) + NODE_WIDTH / 2 + CANVAS_PADDING,
    minY: Math.min(...ys) - NODE_HEIGHT_WITH_DESC / 2 - CANVAS_PADDING,
    maxY: Math.max(...ys) + NODE_HEIGHT_WITH_DESC / 2 + CANVAS_PADDING,
  };

  return { nodes: positionedNodes, links: usedLinks, bounds };
}

// ============================================================================
// Canvas Rendering
// ============================================================================

/**
 * Wrap text to fit within a maximum width, returning lines
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number = 2
): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
      if (lines.length >= maxLines) break;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine && lines.length < maxLines) {
    lines.push(currentLine);
  }

  // If we hit maxLines and there's more text, add ellipsis to last line
  if (lines.length === maxLines && currentLine && !lines.includes(currentLine)) {
    const lastLine = lines[maxLines - 1];
    lines[maxLines - 1] = truncateText(lastLine, lastLine.length - 3) + '...';
  }

  return lines;
}

/**
 * Render a document node on the canvas with themed header
 */
function renderDocumentNode(
  ctx: CanvasRenderingContext2D,
  node: MindMapNode,
  theme: Theme,
  isHovered: boolean,
  matchesSearch: boolean,
  searchActive: boolean
): void {
  const { x, y, width, height, label, description, isSelected, isFocused } = node;

  // Calculate opacity based on search state
  const alpha = searchActive && !matchesSearch ? 0.3 : 1;
  ctx.globalAlpha = alpha;

  const nodeLeft = x - width / 2;
  const nodeTop = y - height / 2;

  // Draw body background first
  const bodyColor = theme.colors.bgActivity;
  ctx.fillStyle = bodyColor;
  roundRect(ctx, nodeLeft, nodeTop, width, height, NODE_BORDER_RADIUS);
  ctx.fill();

  // Draw header background (accent colored)
  const headerColor = isFocused || isSelected
    ? theme.colors.accent
    : isHovered
      ? `${theme.colors.accent}CC`
      : `${theme.colors.accent}99`;
  ctx.fillStyle = headerColor;

  // Draw header with rounded top corners only
  ctx.beginPath();
  ctx.moveTo(nodeLeft + NODE_BORDER_RADIUS, nodeTop);
  ctx.lineTo(nodeLeft + width - NODE_BORDER_RADIUS, nodeTop);
  ctx.quadraticCurveTo(nodeLeft + width, nodeTop, nodeLeft + width, nodeTop + NODE_BORDER_RADIUS);
  ctx.lineTo(nodeLeft + width, nodeTop + NODE_HEADER_HEIGHT);
  ctx.lineTo(nodeLeft, nodeTop + NODE_HEADER_HEIGHT);
  ctx.lineTo(nodeLeft, nodeTop + NODE_BORDER_RADIUS);
  ctx.quadraticCurveTo(nodeLeft, nodeTop, nodeLeft + NODE_BORDER_RADIUS, nodeTop);
  ctx.closePath();
  ctx.fill();

  // Draw border around entire node
  ctx.strokeStyle = isFocused || isSelected
    ? theme.colors.accent
    : isHovered
      ? `${theme.colors.accent}80`
      : theme.colors.border;
  ctx.lineWidth = isFocused || isSelected ? 2 : 1;
  roundRect(ctx, nodeLeft, nodeTop, width, height, NODE_BORDER_RADIUS);
  ctx.stroke();

  // Title text (in header, white or light colored for contrast)
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const maxTitleWidth = width - OPEN_ICON_SIZE - OPEN_ICON_PADDING * 3 - 12;
  const titleText = truncateText(label, Math.floor(maxTitleWidth / 7)); // Approximate char width
  ctx.fillText(titleText, nodeLeft + 12, nodeTop + NODE_HEADER_HEIGHT / 2);

  // Open file icon (in header, right side)
  const iconX = nodeLeft + width - OPEN_ICON_SIZE - OPEN_ICON_PADDING;
  const iconY = nodeTop + (NODE_HEADER_HEIGHT - OPEN_ICON_SIZE) / 2;
  drawOpenIcon(ctx, iconX, iconY, OPEN_ICON_SIZE, isHovered ? '#FFFFFF' : 'rgba(255,255,255,0.7)');

  // Description (in body, if present)
  if (description) {
    ctx.fillStyle = theme.colors.textDim;
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    const bodyPadding = 10;
    const maxDescWidth = width - bodyPadding * 2;
    const descLines = wrapText(ctx, description, maxDescWidth, 2);

    const lineHeight = 14;
    const descStartY = nodeTop + NODE_HEADER_HEIGHT + bodyPadding;

    descLines.forEach((line, i) => {
      ctx.fillText(line, nodeLeft + bodyPadding, descStartY + i * lineHeight);
    });
  }

  ctx.globalAlpha = 1;
}

/**
 * Render an external node on the canvas
 */
function renderExternalNode(
  ctx: CanvasRenderingContext2D,
  node: MindMapNode,
  theme: Theme,
  isHovered: boolean,
  matchesSearch: boolean,
  searchActive: boolean
): void {
  const { x, y, width, height, domain, isSelected, isFocused } = node;

  // Calculate opacity based on search state
  const alpha = searchActive && !matchesSearch ? 0.3 : 1;

  ctx.globalAlpha = alpha;

  // Pill background
  ctx.fillStyle = theme.colors.bgMain;
  roundRect(ctx, x - width / 2, y - height / 2, width, height, height / 2);
  ctx.fill();

  // Border
  ctx.strokeStyle = isFocused || isSelected
    ? theme.colors.accent
    : isHovered
      ? theme.colors.textDim
      : `${theme.colors.border}80`;
  ctx.lineWidth = 1;
  roundRect(ctx, x - width / 2, y - height / 2, width, height, height / 2);
  ctx.stroke();

  // Domain text
  ctx.fillStyle = theme.colors.textDim;
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncateText(domain || '', 18), x, y);

  ctx.globalAlpha = 1;
}

// ============================================================================
// MindMap Component
// ============================================================================

/**
 * MindMap component - renders the deterministic mind map visualization
 */
export function MindMap({
  centerFilePath,
  nodes: rawNodes,
  links: rawLinks,
  theme,
  width,
  height,
  maxDepth,
  showExternalLinks,
  selectedNodeId,
  onNodeSelect,
  onNodeDoubleClick,
  onNodeContextMenu,
  onOpenFile,
  searchQuery,
}: MindMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // State - combine zoom and pan into single transform state to avoid jitter
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [transform, setTransform] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Derived values for convenience
  const zoom = transform.zoom;
  const pan = { x: transform.panX, y: transform.panY };

  // Double-click detection
  const lastClickRef = useRef<{ nodeId: string; time: number } | null>(null);
  const DOUBLE_CLICK_THRESHOLD = 300;

  // Calculate layout
  const layout = useMemo(() => {
    return calculateMindMapLayout(
      rawNodes,
      rawLinks,
      centerFilePath,
      maxDepth,
      width,
      height,
      showExternalLinks
    );
  }, [rawNodes, rawLinks, centerFilePath, maxDepth, width, height, showExternalLinks]);

  // Apply selection state to nodes
  const nodesWithState = useMemo(() => {
    return layout.nodes.map(node => ({
      ...node,
      isSelected: node.id === selectedNodeId,
    }));
  }, [layout.nodes, selectedNodeId]);

  // Check if node matches search
  const nodeMatchesSearch = useCallback((node: MindMapNode): boolean => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();

    if (node.nodeType === 'document') {
      return (
        (node.label?.toLowerCase().includes(query) ?? false) ||
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

  // Convert screen coordinates to canvas coordinates
  const screenToCanvas = useCallback((screenX: number, screenY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: screenX, y: screenY };

    return {
      x: (screenX - rect.left - pan.x) / zoom,
      y: (screenY - rect.top - pan.y) / zoom,
    };
  }, [pan, zoom]);

  // Find node at canvas coordinates
  const findNodeAtPoint = useCallback((canvasX: number, canvasY: number): MindMapNode | null => {
    // Check in reverse order so top-most nodes are found first
    for (let i = nodesWithState.length - 1; i >= 0; i--) {
      const node = nodesWithState[i];
      const halfWidth = node.width / 2;
      const halfHeight = node.height / 2;

      if (
        canvasX >= node.x - halfWidth &&
        canvasX <= node.x + halfWidth &&
        canvasY >= node.y - halfHeight &&
        canvasY <= node.y + halfHeight
      ) {
        return node;
      }
    }
    return null;
  }, [nodesWithState]);

  // Check if click is on the open icon
  const isClickOnOpenIcon = useCallback((node: MindMapNode, canvasX: number, canvasY: number): boolean => {
    if (node.nodeType !== 'document') return false;

    const iconX = node.x + node.width / 2 - OPEN_ICON_SIZE - OPEN_ICON_PADDING;
    const iconY = node.y - node.height / 2 + OPEN_ICON_PADDING;

    return (
      canvasX >= iconX &&
      canvasX <= iconX + OPEN_ICON_SIZE &&
      canvasY >= iconY &&
      canvasY <= iconY + OPEN_ICON_SIZE
    );
  }, []);

  // Render the canvas
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    // Set canvas size for high DPI
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Clear canvas
    ctx.fillStyle = theme.colors.bgMain;
    ctx.fillRect(0, 0, width, height);

    // Apply transformations
    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    // Render links first (behind nodes)
    const nodeMap = new Map(nodesWithState.map(n => [n.id, n]));
    layout.links.forEach(link => {
      const sourceNode = nodeMap.get(link.source);
      const targetNode = nodeMap.get(link.target);
      if (!sourceNode || !targetNode) return;

      const isHighlighted =
        sourceNode.id === selectedNodeId ||
        targetNode.id === selectedNodeId ||
        sourceNode.id === hoveredNodeId ||
        targetNode.id === hoveredNodeId;

      const color = isHighlighted
        ? `${theme.colors.accent}CC`
        : link.type === 'external'
          ? `${theme.colors.textDim}44`
          : `${theme.colors.textDim}66`;

      const lineWidth = isHighlighted ? 2 : 1.5;

      // Calculate connection points based on node positions
      let sourceX = sourceNode.x;
      let targetX = targetNode.x;

      // Adjust connection points to node edges
      if (sourceNode.x < targetNode.x) {
        sourceX = sourceNode.x + sourceNode.width / 2;
        targetX = targetNode.x - targetNode.width / 2;
      } else if (sourceNode.x > targetNode.x) {
        sourceX = sourceNode.x - sourceNode.width / 2;
        targetX = targetNode.x + targetNode.width / 2;
      }

      drawLink(
        ctx,
        sourceX,
        sourceNode.y,
        targetX,
        targetNode.y,
        color,
        lineWidth,
        link.type === 'external'
      );
    });

    // Render nodes
    const searchActive = searchQuery.trim().length > 0;
    nodesWithState.forEach(node => {
      const isHovered = node.id === hoveredNodeId;
      const matchesSearch = nodeMatchesSearch(node);

      if (node.nodeType === 'document') {
        renderDocumentNode(ctx, node, theme, isHovered, matchesSearch, searchActive);
      } else {
        renderExternalNode(ctx, node, theme, isHovered, matchesSearch, searchActive);
      }
    });

    ctx.restore();

    // Draw keyboard focus indicator (outside transform for crisp rendering)
    if (focusedNodeId) {
      const focusedNode = nodesWithState.find(n => n.id === focusedNodeId);
      if (focusedNode) {
        ctx.save();
        ctx.translate(pan.x, pan.y);
        ctx.scale(zoom, zoom);

        ctx.strokeStyle = theme.colors.accent;
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 4]);
        roundRect(
          ctx,
          focusedNode.x - focusedNode.width / 2 - 4,
          focusedNode.y - focusedNode.height / 2 - 4,
          focusedNode.width + 8,
          focusedNode.height + 8,
          NODE_BORDER_RADIUS + 4
        );
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.restore();
      }
    }
  }, [
    width,
    height,
    theme,
    pan,
    zoom,
    nodesWithState,
    layout.links,
    selectedNodeId,
    hoveredNodeId,
    focusedNodeId,
    searchQuery,
    nodeMatchesSearch,
  ]);

  // Render on changes
  useEffect(() => {
    render();
  }, [render]);

  // Center view on mount and when center file changes
  useEffect(() => {
    if (layout.nodes.length > 0) {
      // Center on the center node
      const centerNode = layout.nodes.find(n => n.isFocused);
      if (centerNode) {
        setTransform(prev => ({
          ...prev,
          panX: width / 2 - centerNode.x * prev.zoom,
          panY: height / 2 - centerNode.y * prev.zoom,
        }));
      }
    }
  }, [centerFilePath, width, height, layout.nodes]);

  // Mouse event handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const { x, y } = screenToCanvas(e.clientX, e.clientY);
    const node = findNodeAtPoint(x, y);

    if (node) {
      // Check if clicking on open icon
      if (node.nodeType === 'document' && node.filePath && isClickOnOpenIcon(node, x, y)) {
        onOpenFile(node.filePath);
        return;
      }

      // Handle click/double-click on node
      const now = Date.now();
      const lastClick = lastClickRef.current;

      if (lastClick && lastClick.nodeId === node.id && now - lastClick.time < DOUBLE_CLICK_THRESHOLD) {
        // Double-click
        onNodeDoubleClick(node);
        lastClickRef.current = null;
      } else {
        // Single click - select node
        onNodeSelect(node);
        setFocusedNodeId(node.id);
        lastClickRef.current = { nodeId: node.id, time: now };
      }
    } else {
      // Click on background - start panning
      setIsDragging(true);
      setDragStart({ x: e.clientX - transform.panX, y: e.clientY - transform.panY });
      onNodeSelect(null);
      setFocusedNodeId(null);
    }
  }, [screenToCanvas, findNodeAtPoint, isClickOnOpenIcon, onOpenFile, onNodeDoubleClick, onNodeSelect, transform.panX, transform.panY]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) {
      setTransform(prev => ({
        ...prev,
        panX: e.clientX - dragStart.x,
        panY: e.clientY - dragStart.y,
      }));
    } else {
      const { x, y } = screenToCanvas(e.clientX, e.clientY);
      const node = findNodeAtPoint(x, y);
      setHoveredNodeId(node?.id ?? null);

      // Update cursor
      if (canvasRef.current) {
        canvasRef.current.style.cursor = node ? 'pointer' : 'grab';
      }
    }
  }, [isDragging, dragStart, screenToCanvas, findNodeAtPoint]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    if (canvasRef.current) {
      canvasRef.current.style.cursor = hoveredNodeId ? 'pointer' : 'grab';
    }
  }, [hoveredNodeId]);

  const handleMouseLeave = useCallback(() => {
    setIsDragging(false);
    setHoveredNodeId(null);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = screenToCanvas(e.clientX, e.clientY);
    const node = findNodeAtPoint(x, y);

    if (node) {
      onNodeContextMenu(node, e.nativeEvent);
    }
  }, [screenToCanvas, findNodeAtPoint, onNodeContextMenu]);

  // Wheel handler for zooming - must be attached manually with passive: false
  // Uses functional updater to avoid stale closures and jitter
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();

    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    setTransform(prev => {
      // Calculate new zoom
      const delta = -e.deltaY * 0.001;
      const newZoom = Math.min(Math.max(prev.zoom + delta * prev.zoom, 0.2), 3);

      // Adjust pan to zoom towards mouse position
      const zoomRatio = newZoom / prev.zoom;
      const newPanX = mouseX - (mouseX - prev.panX) * zoomRatio;
      const newPanY = mouseY - (mouseY - prev.panY) * zoomRatio;

      return { zoom: newZoom, panX: newPanX, panY: newPanY };
    });
  }, []); // No dependencies - stable callback

  // Attach wheel event listener with passive: false to allow preventDefault
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, [handleWheel]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!focusedNodeId) {
      // If no node is focused, focus the center node on any arrow key
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        const centerNode = nodesWithState.find(n => n.isFocused);
        if (centerNode) {
          setFocusedNodeId(centerNode.id);
          onNodeSelect(centerNode);
        }
        e.preventDefault();
      }
      return;
    }

    const focusedNode = nodesWithState.find(n => n.id === focusedNodeId);
    if (!focusedNode) return;

    // Find nodes for navigation
    const sameColumn = nodesWithState.filter(n => n.side === focusedNode.side && n.id !== focusedNodeId);
    const leftColumn = nodesWithState.filter(n => n.x < focusedNode.x - 50);
    const rightColumn = nodesWithState.filter(n => n.x > focusedNode.x + 50);

    let nextNode: MindMapNode | undefined;

    switch (e.key) {
      case 'ArrowUp':
        // Find closest node above in same column
        nextNode = sameColumn
          .filter(n => n.y < focusedNode.y)
          .sort((a, b) => b.y - a.y)[0];
        e.preventDefault();
        break;

      case 'ArrowDown':
        // Find closest node below in same column
        nextNode = sameColumn
          .filter(n => n.y > focusedNode.y)
          .sort((a, b) => a.y - b.y)[0];
        e.preventDefault();
        break;

      case 'ArrowLeft':
        // Find closest node to the left
        nextNode = leftColumn
          .sort((a, b) => {
            const distA = Math.abs(a.y - focusedNode.y);
            const distB = Math.abs(b.y - focusedNode.y);
            return distA - distB;
          })[0];
        e.preventDefault();
        break;

      case 'ArrowRight':
        // Find closest node to the right
        nextNode = rightColumn
          .sort((a, b) => {
            const distA = Math.abs(a.y - focusedNode.y);
            const distB = Math.abs(b.y - focusedNode.y);
            return distA - distB;
          })[0];
        e.preventDefault();
        break;

      case 'Enter':
        // Recenter on focused document node
        if (focusedNode.nodeType === 'document') {
          onNodeDoubleClick(focusedNode);
        } else if (focusedNode.nodeType === 'external' && focusedNode.urls?.[0]) {
          // Open external URL
          window.open(focusedNode.urls[0], '_blank');
        }
        e.preventDefault();
        break;

      case 'o':
      case 'O':
        // Open focused document in file preview
        if (focusedNode.nodeType === 'document' && focusedNode.filePath) {
          onOpenFile(focusedNode.filePath);
        }
        e.preventDefault();
        break;
    }

    if (nextNode) {
      setFocusedNodeId(nextNode.id);
      onNodeSelect(nextNode);

      // Pan to keep focused node visible
      setTransform(prev => {
        const nodeScreenX = nextNode.x * prev.zoom + prev.panX;
        const nodeScreenY = nextNode.y * prev.zoom + prev.panY;
        const padding = 100;

        let newPanX = prev.panX;
        let newPanY = prev.panY;

        if (nodeScreenX < padding) {
          newPanX = padding - nextNode.x * prev.zoom;
        } else if (nodeScreenX > width - padding) {
          newPanX = width - padding - nextNode.x * prev.zoom;
        }

        if (nodeScreenY < padding) {
          newPanY = padding - nextNode.y * prev.zoom;
        } else if (nodeScreenY > height - padding) {
          newPanY = height - padding - nextNode.y * prev.zoom;
        }

        if (newPanX !== prev.panX || newPanY !== prev.panY) {
          return { ...prev, panX: newPanX, panY: newPanY };
        }
        return prev;
      });
    }
  }, [focusedNodeId, nodesWithState, onNodeSelect, onNodeDoubleClick, onOpenFile, width, height]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <canvas
        ref={canvasRef}
        style={{
          width,
          height,
          cursor: isDragging ? 'grabbing' : hoveredNodeId ? 'pointer' : 'grab',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
      />
    </div>
  );
}

// ============================================================================
// Data Conversion Utilities
// ============================================================================

/**
 * Convert graph builder data to mind map format
 * Ensures no duplicate nodes by using a Map for deduplication
 */
export function convertToMindMapData(
  graphNodes: Array<{ id: string; data: GraphNodeData }>,
  graphEdges: Array<{ source: string; target: string; type?: string }>
): { nodes: MindMapNode[]; links: MindMapLink[] } {
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

  // Use Map for deduplication - prevents duplicate nodes with same ID
  const nodeMap = new Map<string, MindMapNode>();

  graphNodes.forEach(node => {
    // Skip if we've already processed this node ID
    if (nodeMap.has(node.id)) {
      console.warn(`[MindMap] Skipping duplicate node: ${node.id}`);
      return;
    }

    const neighbors = neighborMap.get(node.id) || new Set();
    const connectionCount = neighbors.size;

    let mindMapNode: MindMapNode;

    if (node.data.nodeType === 'document') {
      const docData = node.data as DocumentNodeData;
      mindMapNode = {
        id: node.id,
        x: 0,
        y: 0,
        width: NODE_WIDTH,
        height: docData.description ? NODE_HEIGHT_WITH_DESC : NODE_HEIGHT_BASE,
        depth: 0,
        side: 'center' as const,
        nodeType: 'document' as const,
        label: docData.title,
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
      mindMapNode = {
        id: node.id,
        x: 0,
        y: 0,
        width: EXTERNAL_NODE_WIDTH,
        height: EXTERNAL_NODE_HEIGHT,
        depth: 0,
        side: 'external' as const,
        nodeType: 'external' as const,
        label: extData.domain,
        domain: extData.domain,
        urls: extData.urls,
        neighbors,
        connectionCount,
      };
    }

    nodeMap.set(node.id, mindMapNode);
  });

  const nodes = Array.from(nodeMap.values());

  // Deduplicate links as well
  const linkSet = new Set<string>();
  const links: MindMapLink[] = [];

  graphEdges.forEach(edge => {
    // Create a canonical key for the edge (sorted to avoid A->B and B->A duplicates)
    const sortedKey = [edge.source, edge.target].sort().join('|');

    if (!linkSet.has(sortedKey)) {
      linkSet.add(sortedKey);
      links.push({
        source: edge.source,
        target: edge.target,
        type: edge.type === 'external' ? 'external' : 'internal',
      });
    }
  });

  return { nodes, links };
}

export default MindMap;
