/**
 * Layout algorithms for the canvas-based Document Graph MindMap.
 *
 * Three algorithms are available:
 * - **Mind Map**: Deterministic left/right columns branching from center by depth
 * - **Radial**: Concentric rings radiating from center, evenly distributed
 * - **Force-Directed**: Physics simulation using d3-force for organic clustering
 *
 * All algorithms accept the same input signature and produce a LayoutResult,
 * making them interchangeable via the `calculateLayout()` dispatcher.
 */

import {
	forceSimulation,
	forceLink,
	forceManyBody,
	forceCenter,
	forceCollide,
	forceX,
	forceY,
	type SimulationNodeDatum,
	type SimulationLinkDatum,
} from 'd3-force';
import type { MindMapNode, MindMapLink } from './MindMap';

// ============================================================================
// Types
// ============================================================================

/** Available layout algorithm types */
export type MindMapLayoutType = 'mindmap' | 'radial' | 'force';

/** Display labels for layout types */
export const LAYOUT_LABELS: Record<MindMapLayoutType, { name: string; description: string }> = {
	mindmap: { name: 'Mind Map', description: 'Tree columns' },
	radial: { name: 'Radial', description: 'Concentric rings' },
	force: { name: 'Force', description: 'Physics simulation' },
};

/** Result of a layout calculation */
export interface LayoutResult {
	nodes: MindMapNode[];
	links: MindMapLink[];
	bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

/** Common layout function signature */
type LayoutFunction = (
	allNodes: MindMapNode[],
	allLinks: MindMapLink[],
	adjacency: Map<string, Set<string>>,
	centerFilePath: string,
	maxDepth: number,
	canvasWidth: number,
	canvasHeight: number,
	showExternalLinks: boolean,
	previewCharLimit: number
) => LayoutResult;

// ============================================================================
// Shared Constants
// ============================================================================

/** Document node width */
export const NODE_WIDTH = 260;
/** Header height for node title bar */
export const NODE_HEADER_HEIGHT = 32;
/** Sub-header height for folder path */
export const NODE_SUBHEADER_HEIGHT = 22;
/** Minimum node height (title + folder path, no description) */
export const NODE_HEIGHT_BASE = 56 + NODE_SUBHEADER_HEIGHT;
/** Line height for description text */
export const DESC_LINE_HEIGHT = 14;
/** Approximate characters per line in description */
export const CHARS_PER_LINE = 35;
/** Padding for description area */
export const DESC_PADDING = 20;
/** Scale factor for center node */
export const CENTER_NODE_SCALE = 1.15;
/** External node width (smaller) */
export const EXTERNAL_NODE_WIDTH = 150;
/** External node height */
export const EXTERNAL_NODE_HEIGHT = 38;
/** Padding around canvas content */
export const CANVAS_PADDING = 80;

// Mind Map specific constants
const HORIZONTAL_SPACING = 340;
const VERTICAL_GAP = 30;

// Radial specific constants
const RADIAL_BASE_RADIUS = 280;
const RADIAL_RING_SPACING = 240;
const RADIAL_EXTERNAL_OFFSET = 180;

// Force specific constants
const FORCE_LINK_DISTANCE = 300;
const FORCE_CHARGE_STRENGTH = -400;
const FORCE_COLLIDE_PADDING = 30;
const EXTERNAL_CLUSTER_OFFSET = 160;
const FORCE_TICK_COUNT = 300;
const FORCE_EXTERNAL_RING_PADDING = 250;

// ============================================================================
// Shared Utilities
// ============================================================================

/**
 * Cache for node height calculations.
 * Key format: `${textLength}:${previewCharLimit}`
 */
const nodeHeightCache = new Map<string, number>();

/**
 * Calculate node height based on actual content length (with caching)
 */
export function calculateNodeHeight(
	previewText: string | undefined,
	previewCharLimit: number
): number {
	if (!previewText) {
		return NODE_HEIGHT_BASE;
	}

	const cacheKey = `${Math.min(previewText.length, previewCharLimit)}:${previewCharLimit}`;
	const cached = nodeHeightCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	const truncatedLength = Math.min(previewText.length, previewCharLimit);
	const actualLines = Math.ceil(truncatedLength / CHARS_PER_LINE);
	const lines = Math.max(1, Math.min(actualLines, 15));
	const height = NODE_HEIGHT_BASE + lines * DESC_LINE_HEIGHT + DESC_PADDING;

	nodeHeightCache.set(cacheKey, height);
	return height;
}

/**
 * Build an adjacency map from links for efficient neighbor lookups.
 */
export function buildAdjacencyMap(links: MindMapLink[]): Map<string, Set<string>> {
	const adjacency = new Map<string, Set<string>>();
	for (const link of links) {
		if (!adjacency.has(link.source)) adjacency.set(link.source, new Set());
		if (!adjacency.has(link.target)) adjacency.set(link.target, new Set());
		adjacency.get(link.source)!.add(link.target);
		adjacency.get(link.target)!.add(link.source);
	}
	return adjacency;
}

// ============================================================================
// Shared Layout Preamble
// ============================================================================

/** Data produced by the shared layout preamble */
interface LayoutInput {
	centerNode: MindMapNode;
	actualCenterNodeId: string;
	visited: Map<string, number>;
	visibleDocumentNodes: MindMapNode[];
	externalNodes: MindMapNode[];
	centerX: number;
	centerY: number;
	centerWidth: number;
	centerHeight: number;
	allLinks: MindMapLink[];
	showExternalLinks: boolean;
	previewCharLimit: number;
	maxDepth: number;
	canvasWidth: number;
	canvasHeight: number;
}

/**
 * Shared preamble for all layout algorithms.
 * Finds center node, runs BFS, and filters visible nodes.
 */
function prepareLayoutInput(
	allNodes: MindMapNode[],
	allLinks: MindMapLink[],
	adjacency: Map<string, Set<string>>,
	centerFilePath: string,
	maxDepth: number,
	canvasWidth: number,
	canvasHeight: number,
	showExternalLinks: boolean,
	previewCharLimit: number
): LayoutInput | null {
	// Find center node - try multiple path variations
	let centerNode: MindMapNode | undefined;
	let actualCenterNodeId = '';

	const documentNodes = allNodes.filter((n) => n.nodeType === 'document');
	const nodeIdSet = new Set(documentNodes.map((n) => n.id));
	const filePathToNode = new Map<string, MindMapNode>();
	documentNodes.forEach((n) => {
		if (n.filePath) {
			filePathToNode.set(n.filePath, n);
			const filename = n.filePath.split('/').pop();
			if (filename && !filePathToNode.has(filename)) {
				filePathToNode.set(filename, n);
			}
		}
	});

	const searchVariations = [
		centerFilePath,
		centerFilePath.replace(/^\/+/, ''),
		centerFilePath.split('/').pop() || centerFilePath,
	];

	// Try node ID match
	for (const variation of searchVariations) {
		const nodeId = `doc-${variation}`;
		if (nodeIdSet.has(nodeId)) {
			centerNode = documentNodes.find((n) => n.id === nodeId);
			if (centerNode) {
				actualCenterNodeId = nodeId;
				break;
			}
		}
	}

	// Try filePath match
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

	// Try fuzzy filename match
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

	// Fallback to first node
	if (!centerNode && documentNodes.length > 0) {
		centerNode = documentNodes[0];
		actualCenterNodeId = centerNode.id;
	}

	if (!centerNode) {
		return null;
	}

	// BFS to find nodes within maxDepth
	const visited = new Map<string, number>();
	const queue: Array<{ id: string; depth: number }> = [{ id: actualCenterNodeId, depth: 0 }];
	visited.set(actualCenterNodeId, 0);

	while (queue.length > 0) {
		const { id, depth } = queue.shift()!;
		if (depth >= maxDepth) continue;
		const neighbors = adjacency.get(id) || new Set();
		neighbors.forEach((neighborId) => {
			if (!visited.has(neighborId)) {
				visited.set(neighborId, depth + 1);
				queue.push({ id: neighborId, depth: depth + 1 });
			}
		});
	}

	// Filter to visible nodes
	const nodesInRange = allNodes.filter((n) => {
		if (n.nodeType === 'external' && !showExternalLinks) return false;
		return visited.has(n.id);
	});

	const visibleDocumentNodes = nodesInRange.filter((n) => n.nodeType === 'document');
	const externalNodes = nodesInRange.filter((n) => n.nodeType === 'external');

	// Center position
	const centerX = canvasWidth / 2;
	const centerY = canvasHeight / 2 - (showExternalLinks && externalNodes.length > 0 ? 50 : 0);
	const centerPreviewText = centerNode.description || centerNode.contentPreview;
	const centerWidth = NODE_WIDTH * CENTER_NODE_SCALE;
	const centerHeight = calculateNodeHeight(centerPreviewText, previewCharLimit) * CENTER_NODE_SCALE;

	return {
		centerNode,
		actualCenterNodeId,
		visited,
		visibleDocumentNodes,
		externalNodes,
		centerX,
		centerY,
		centerWidth,
		centerHeight,
		allLinks,
		showExternalLinks,
		previewCharLimit,
		maxDepth,
		canvasWidth,
		canvasHeight,
	};
}

/**
 * Calculate bounds from positioned nodes.
 */
function calculateBounds(
	positionedNodes: MindMapNode[],
	previewCharLimit: number
): LayoutResult['bounds'] {
	if (positionedNodes.length === 0) {
		return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
	}
	const maxNodeHeight = calculateNodeHeight('x'.repeat(previewCharLimit), previewCharLimit);
	const xs = positionedNodes.map((n) => n.x);
	const ys = positionedNodes.map((n) => n.y);
	return {
		minX: Math.min(...xs) - NODE_WIDTH / 2 - CANVAS_PADDING,
		maxX: Math.max(...xs) + NODE_WIDTH / 2 + CANVAS_PADDING,
		minY: Math.min(...ys) - maxNodeHeight / 2 - CANVAS_PADDING,
		maxY: Math.max(...ys) + maxNodeHeight / 2 + CANVAS_PADDING,
	};
}

/**
 * Filter links to only include connections between positioned nodes.
 * For mind map and radial: only adjacent-depth connections.
 * For force: all connections between visible nodes.
 */
function filterLinks(
	allLinks: MindMapLink[],
	positionedNodes: MindMapNode[],
	adjacentDepthOnly: boolean
): MindMapLink[] {
	const positionedNodeIds = new Set(positionedNodes.map((n) => n.id));
	const nodeDepthMap = new Map(positionedNodes.map((n) => [n.id, n.depth]));
	const nodeTypeMap = new Map(positionedNodes.map((n) => [n.id, n.nodeType]));
	const usedLinks: MindMapLink[] = [];

	allLinks.forEach((link) => {
		if (!positionedNodeIds.has(link.source) || !positionedNodeIds.has(link.target)) return;

		if (!adjacentDepthOnly) {
			usedLinks.push(link);
			return;
		}

		const sourceDepth = nodeDepthMap.get(link.source) ?? 0;
		const targetDepth = nodeDepthMap.get(link.target) ?? 0;
		const sourceType = nodeTypeMap.get(link.source);
		const targetType = nodeTypeMap.get(link.target);
		const depthDiff = Math.abs(sourceDepth - targetDepth);
		const isExternalLink = sourceType === 'external' || targetType === 'external';

		if (depthDiff <= 1 || isExternalLink) {
			usedLinks.push(link);
		}
	});

	return usedLinks;
}

// ============================================================================
// Mind Map Layout (Deterministic columns)
// ============================================================================

/**
 * Calculate the mind map layout with center node and branching left/right columns.
 * This is the original layout algorithm — deterministic, alphabetized.
 */
export const calculateMindMapLayout: LayoutFunction = (
	allNodes,
	allLinks,
	adjacency,
	centerFilePath,
	maxDepth,
	canvasWidth,
	canvasHeight,
	showExternalLinks,
	previewCharLimit
) => {
	const input = prepareLayoutInput(
		allNodes,
		allLinks,
		adjacency,
		centerFilePath,
		maxDepth,
		canvasWidth,
		canvasHeight,
		showExternalLinks,
		previewCharLimit
	);

	if (!input) {
		return {
			nodes: [],
			links: [],
			bounds: { minX: 0, maxX: canvasWidth, minY: 0, maxY: canvasHeight },
		};
	}

	const {
		centerNode,
		actualCenterNodeId,
		visited,
		visibleDocumentNodes,
		externalNodes,
		centerX,
		centerY,
		centerWidth,
		centerHeight,
	} = input;

	const positionedNodes: MindMapNode[] = [];

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
	visibleDocumentNodes.forEach((node) => {
		if (node.id === actualCenterNodeId) return;
		const depth = visited.get(node.id) || 1;
		if (!nodesByDepth.has(depth)) nodesByDepth.set(depth, []);
		nodesByDepth.get(depth)!.push(node);
	});

	// Process each depth level
	for (let depth = 1; depth <= maxDepth; depth++) {
		const nodesAtDepth = nodesByDepth.get(depth) || [];
		if (nodesAtDepth.length === 0) continue;

		nodesAtDepth.sort((a, b) => a.label.localeCompare(b.label));

		const midpoint = Math.ceil(nodesAtDepth.length / 2);
		const leftNodes = nodesAtDepth.slice(0, midpoint);
		const rightNodes = nodesAtDepth.slice(midpoint);

		// Left column
		const leftX = centerX - HORIZONTAL_SPACING * depth;
		const leftNodeHeights = leftNodes.map((node) => {
			const previewText = node.description || node.contentPreview;
			return calculateNodeHeight(previewText, previewCharLimit);
		});
		const leftTotalHeight =
			leftNodeHeights.reduce((sum, h) => sum + h, 0) +
			Math.max(0, leftNodes.length - 1) * VERTICAL_GAP;
		let leftCurrentY = centerY - leftTotalHeight / 2;

		leftNodes.forEach((node, index) => {
			const height = leftNodeHeights[index];
			const nodeY = leftCurrentY + height / 2;
			positionedNodes.push({
				...node,
				x: leftX,
				y: nodeY,
				width: NODE_WIDTH,
				height,
				depth,
				side: 'left',
			});
			leftCurrentY += height + VERTICAL_GAP;
		});

		// Right column
		const rightX = centerX + HORIZONTAL_SPACING * depth;
		const rightNodeHeights = rightNodes.map((node) => {
			const previewText = node.description || node.contentPreview;
			return calculateNodeHeight(previewText, previewCharLimit);
		});
		const rightTotalHeight =
			rightNodeHeights.reduce((sum, h) => sum + h, 0) +
			Math.max(0, rightNodes.length - 1) * VERTICAL_GAP;
		let rightCurrentY = centerY - rightTotalHeight / 2;

		rightNodes.forEach((node, index) => {
			const height = rightNodeHeights[index];
			const nodeY = rightCurrentY + height / 2;
			positionedNodes.push({
				...node,
				x: rightX,
				y: nodeY,
				width: NODE_WIDTH,
				height,
				depth,
				side: 'right',
			});
			rightCurrentY += height + VERTICAL_GAP;
		});
	}

	// Position external nodes at the bottom
	if (showExternalLinks && externalNodes.length > 0) {
		positionExternalNodesBottom(externalNodes, positionedNodes, centerX, centerY);
	}

	const usedLinks = filterLinks(allLinks, positionedNodes, true);
	const bounds = calculateBounds(positionedNodes, previewCharLimit);
	return { nodes: positionedNodes, links: usedLinks, bounds };
};

// ============================================================================
// Radial Layout (Concentric rings)
// ============================================================================

/**
 * Calculate a radial layout with concentric rings around the center node.
 * Nodes at each depth level are distributed evenly around a ring.
 * Deterministic — no physics, pure trigonometry.
 */
export const calculateRadialLayout: LayoutFunction = (
	allNodes,
	allLinks,
	adjacency,
	centerFilePath,
	maxDepth,
	canvasWidth,
	canvasHeight,
	showExternalLinks,
	previewCharLimit
) => {
	const input = prepareLayoutInput(
		allNodes,
		allLinks,
		adjacency,
		centerFilePath,
		maxDepth,
		canvasWidth,
		canvasHeight,
		showExternalLinks,
		previewCharLimit
	);

	if (!input) {
		return {
			nodes: [],
			links: [],
			bounds: { minX: 0, maxX: canvasWidth, minY: 0, maxY: canvasHeight },
		};
	}

	const {
		centerNode,
		actualCenterNodeId,
		visited,
		visibleDocumentNodes,
		externalNodes,
		centerX,
		centerY,
		centerWidth,
		centerHeight,
	} = input;

	const positionedNodes: MindMapNode[] = [];

	// Center node
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

	// Group by depth
	const nodesByDepth = new Map<number, MindMapNode[]>();
	visibleDocumentNodes.forEach((node) => {
		if (node.id === actualCenterNodeId) return;
		const depth = visited.get(node.id) || 1;
		if (!nodesByDepth.has(depth)) nodesByDepth.set(depth, []);
		nodesByDepth.get(depth)!.push(node);
	});

	// Position nodes on concentric rings
	let maxRadius = 0;
	for (let depth = 1; depth <= maxDepth; depth++) {
		const nodesAtDepth = nodesByDepth.get(depth) || [];
		if (nodesAtDepth.length === 0) continue;

		// Sort alphabetically for deterministic positioning
		nodesAtDepth.sort((a, b) => a.label.localeCompare(b.label));

		const radius = RADIAL_BASE_RADIUS + (depth - 1) * RADIAL_RING_SPACING;
		maxRadius = Math.max(maxRadius, radius);

		// If only one node, place it directly above center
		const count = nodesAtDepth.length;
		const angleStep = (2 * Math.PI) / count;
		const startAngle = -Math.PI / 2; // Start at top

		nodesAtDepth.forEach((node, index) => {
			const angle = startAngle + index * angleStep;
			const x = centerX + radius * Math.cos(angle);
			const y = centerY + radius * Math.sin(angle);
			const previewText = node.description || node.contentPreview;
			const height = calculateNodeHeight(previewText, previewCharLimit);

			// Determine side based on which half of the circle
			const side: MindMapNode['side'] =
				x < centerX - 10 ? 'left' : x > centerX + 10 ? 'right' : 'right';

			positionedNodes.push({
				...node,
				x,
				y,
				width: NODE_WIDTH,
				height,
				depth,
				side,
			});
		});
	}

	// Position external nodes on an outer ring
	if (showExternalLinks && externalNodes.length > 0) {
		externalNodes.sort((a, b) => (a.domain || '').localeCompare(b.domain || ''));

		const externalRadius = Math.max(maxRadius, RADIAL_BASE_RADIUS) + RADIAL_EXTERNAL_OFFSET;
		const count = externalNodes.length;
		const angleStep = (2 * Math.PI) / count;
		const startAngle = -Math.PI / 2;

		externalNodes.forEach((node, index) => {
			const angle = startAngle + index * angleStep;
			positionedNodes.push({
				...node,
				x: centerX + externalRadius * Math.cos(angle),
				y: centerY + externalRadius * Math.sin(angle),
				width: EXTERNAL_NODE_WIDTH,
				height: EXTERNAL_NODE_HEIGHT,
				depth: 1,
				side: 'external',
			});
		});
	}

	// Radial uses adjacent-depth link filtering like mind map
	const usedLinks = filterLinks(allLinks, positionedNodes, true);
	const bounds = calculateBounds(positionedNodes, previewCharLimit);
	return { nodes: positionedNodes, links: usedLinks, bounds };
};

// ============================================================================
// Force-Directed Layout (d3-force)
// ============================================================================

/** Extended node for d3-force simulation */
interface ForceNode extends SimulationNodeDatum {
	id: string;
	width: number;
	height: number;
}

/** Link for d3-force simulation */
interface ForceLinkDatum extends SimulationLinkDatum<ForceNode> {
	id: string;
}

/**
 * Calculate a force-directed layout using d3-force.
 * The center node is pinned; other nodes settle via physics simulation.
 * Initial positions are seeded deterministically to avoid jitter on re-renders.
 */
export const calculateForceLayout: LayoutFunction = (
	allNodes,
	allLinks,
	adjacency,
	centerFilePath,
	maxDepth,
	canvasWidth,
	canvasHeight,
	showExternalLinks,
	previewCharLimit
) => {
	const input = prepareLayoutInput(
		allNodes,
		allLinks,
		adjacency,
		centerFilePath,
		maxDepth,
		canvasWidth,
		canvasHeight,
		showExternalLinks,
		previewCharLimit
	);

	if (!input) {
		return {
			nodes: [],
			links: [],
			bounds: { minX: 0, maxX: canvasWidth, minY: 0, maxY: canvasHeight },
		};
	}

	const {
		centerNode,
		actualCenterNodeId,
		visited,
		visibleDocumentNodes,
		externalNodes,
		centerX,
		centerY,
		centerWidth,
		centerHeight,
	} = input;

	// Build simulation nodes — seed positions deterministically from index
	const docNodesForSim = visibleDocumentNodes.filter((n) => n.id !== actualCenterNodeId);
	const simNodes: ForceNode[] = docNodesForSim.map((node, i) => {
		const previewText = node.description || node.contentPreview;
		const height = calculateNodeHeight(previewText, previewCharLimit);
		// Deterministic initial position: spread in a circle around center
		const angle = (2 * Math.PI * i) / Math.max(docNodesForSim.length, 1);
		const initRadius = 200 + (visited.get(node.id) || 1) * 100;
		return {
			id: node.id,
			x: centerX + initRadius * Math.cos(angle),
			y: centerY + initRadius * Math.sin(angle),
			width: NODE_WIDTH,
			height,
		};
	});

	// Add center node (pinned)
	const centerSimNode: ForceNode = {
		id: actualCenterNodeId,
		x: centerX,
		y: centerY,
		fx: centerX,
		fy: centerY,
		width: centerWidth,
		height: centerHeight,
	};
	simNodes.unshift(centerSimNode);

	// Build simulation links from internal links between visible nodes
	const simNodeIds = new Set(simNodes.map((n) => n.id));
	const simLinks: ForceLinkDatum[] = [];
	const linkIdSet = new Set<string>();

	allLinks.forEach((link) => {
		if (link.type === 'external') return;
		if (!simNodeIds.has(link.source) || !simNodeIds.has(link.target)) return;
		const key = [link.source, link.target].sort().join('|');
		if (linkIdSet.has(key)) return;
		linkIdSet.add(key);
		simLinks.push({ id: key, source: link.source, target: link.target });
	});

	// Run simulation synchronously
	const simulation = forceSimulation<ForceNode>(simNodes)
		.force(
			'link',
			forceLink<ForceNode, ForceLinkDatum>(simLinks)
				.id((d) => d.id)
				.distance(FORCE_LINK_DISTANCE)
				.strength(0.5)
		)
		.force('charge', forceManyBody<ForceNode>().strength(FORCE_CHARGE_STRENGTH).distanceMax(800))
		.force(
			'collide',
			forceCollide<ForceNode>()
				.radius((d) => Math.max(d.width, d.height) / 2 + FORCE_COLLIDE_PADDING)
				.strength(1.0)
				.iterations(3)
		)
		.force('center', forceCenter(centerX, centerY))
		.force('x', forceX<ForceNode>(centerX).strength(0.05))
		.force('y', forceY<ForceNode>(centerY).strength(0.05))
		.stop();

	simulation.tick(FORCE_TICK_COUNT);

	// Build position map from simulation
	const positionMap = new Map(simNodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));

	// Build positioned nodes
	const positionedNodes: MindMapNode[] = [];

	// Center node
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

	// Document nodes
	docNodesForSim.forEach((node) => {
		const pos = positionMap.get(node.id);
		if (!pos) return;
		const previewText = node.description || node.contentPreview;
		const height = calculateNodeHeight(previewText, previewCharLimit);
		const depth = visited.get(node.id) || 1;
		const side: MindMapNode['side'] = pos.x < centerX - 10 ? 'left' : 'right';

		positionedNodes.push({
			...node,
			x: pos.x,
			y: pos.y,
			width: NODE_WIDTH,
			height,
			depth,
			side,
		});
	});

	// External nodes: ring around the bounding box
	if (showExternalLinks && externalNodes.length > 0) {
		externalNodes.sort((a, b) => (a.domain || '').localeCompare(b.domain || ''));

		// Find bounding box of document nodes
		let minX = Infinity,
			maxX = -Infinity,
			minY = Infinity,
			maxY = -Infinity;
		for (const n of positionedNodes) {
			minX = Math.min(minX, n.x - n.width / 2);
			maxX = Math.max(maxX, n.x + n.width / 2);
			minY = Math.min(minY, n.y - n.height / 2);
			maxY = Math.max(maxY, n.y + n.height / 2);
		}

		const bbCenterX = (minX + maxX) / 2;
		const bbCenterY = (minY + maxY) / 2;
		const bbWidth = maxX - minX;
		const bbHeight = maxY - minY;
		const ringRadius = Math.max(bbWidth, bbHeight) / 2 + FORCE_EXTERNAL_RING_PADDING;

		const count = externalNodes.length;
		const angleStep = (2 * Math.PI) / count;
		const startAngle = -Math.PI / 2;

		externalNodes.forEach((node, index) => {
			const angle = startAngle + index * angleStep;
			positionedNodes.push({
				...node,
				x: bbCenterX + ringRadius * Math.cos(angle),
				y: bbCenterY + ringRadius * Math.sin(angle),
				width: EXTERNAL_NODE_WIDTH,
				height: EXTERNAL_NODE_HEIGHT,
				depth: 1,
				side: 'external',
			});
		});
	}

	// Force layout shows all links between visible nodes (no depth filtering)
	const usedLinks = filterLinks(allLinks, positionedNodes, false);
	const bounds = calculateBounds(positionedNodes, previewCharLimit);
	return { nodes: positionedNodes, links: usedLinks, bounds };
};

// ============================================================================
// Shared External Node Positioning (Mind Map)
// ============================================================================

/**
 * Position external nodes in a horizontal row at the bottom (used by mind map layout).
 */
function positionExternalNodesBottom(
	externalNodes: MindMapNode[],
	positionedNodes: MindMapNode[],
	centerX: number,
	centerY: number
): void {
	externalNodes.sort((a, b) => (a.domain || '').localeCompare(b.domain || ''));

	const maxYDistance = positionedNodes.reduce((max, n) => {
		if (n.side === 'external') return max;
		const dist = Math.abs(n.y - centerY);
		return dist > max ? dist : max;
	}, 0);
	const externalY = centerY + maxYDistance + EXTERNAL_CLUSTER_OFFSET;
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

// ============================================================================
// Layout Dispatcher
// ============================================================================

/** Map of layout type to algorithm implementation */
const LAYOUT_ALGORITHMS: Record<MindMapLayoutType, LayoutFunction> = {
	mindmap: calculateMindMapLayout,
	radial: calculateRadialLayout,
	force: calculateForceLayout,
};

/**
 * Dispatch to the appropriate layout algorithm based on type.
 */
export function calculateLayout(
	layoutType: MindMapLayoutType,
	allNodes: MindMapNode[],
	allLinks: MindMapLink[],
	adjacency: Map<string, Set<string>>,
	centerFilePath: string,
	maxDepth: number,
	canvasWidth: number,
	canvasHeight: number,
	showExternalLinks: boolean,
	previewCharLimit: number
): LayoutResult {
	const algorithm = LAYOUT_ALGORITHMS[layoutType] || calculateMindMapLayout;
	return algorithm(
		allNodes,
		allLinks,
		adjacency,
		centerFilePath,
		maxDepth,
		canvasWidth,
		canvasHeight,
		showExternalLinks,
		previewCharLimit
	);
}
