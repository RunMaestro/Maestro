/**
 * Layout algorithms for the canvas-based Document Graph MindMap.
 *
 * Four algorithms are available:
 * - **Mind Map**: Deterministic left/right columns branching from center by depth
 * - **Radial**: Concentric rings radiating from center, evenly distributed
 * - **Hierarchical**: Top-down tree, BFS depth as horizontal rows below the center
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
import type { MindMapLayoutType } from './layoutTypes';
import { isPreviewOff } from './previewCharLimit';

// ============================================================================
// Types
// ============================================================================

// The layout vocabulary lives in its own leaf module so `settingsStore` and the
// `Session` interface can name a layout without importing d3-force. Re-exported
// here because every existing consumer imports it from this file.
export {
	LAYOUT_LABELS,
	MIND_MAP_LAYOUT_TYPES,
	nextMindMapLayout,
	isMindMapLayoutType,
} from './layoutTypes';
export type { MindMapLayoutType } from './layoutTypes';

/** Result of a layout calculation */
export interface LayoutResult {
	nodes: MindMapNode[];
	links: MindMapLink[];
	bounds: { minX: number; maxX: number; minY: number; maxY: number };
	/**
	 * Optional canvas-space captions a layout wants drawn behind its nodes.
	 * Only Timeline populates it - a time axis with no dates on it is just an
	 * arbitrary left-to-right ordering, so the labels are the layout, not
	 * decoration. Every other layout leaves this undefined and the renderer
	 * draws nothing.
	 */
	axisLabels?: LayoutAxisLabel[];
}

/** A caption drawn in canvas space, centered horizontally on `x`. */
export interface LayoutAxisLabel {
	x: number;
	y: number;
	text: string;
	/** Draw a faint vertical rule this tall under the caption. */
	ruleHeight?: number;
}

/** Common layout function signature. `spacingScale` is optional and defaults to 1. */
type LayoutFunction = (
	allNodes: MindMapNode[],
	allLinks: MindMapLink[],
	adjacency: Map<string, Set<string>>,
	centerFilePath: string,
	maxDepth: number,
	canvasWidth: number,
	canvasHeight: number,
	showExternalLinks: boolean,
	previewCharLimit: number,
	spacingScale?: number,
	showOrphans?: boolean
) => LayoutResult;

/** Clamp range and step for the user-adjustable node spacing multiplier. */
export const SPACING_SCALE_MIN = 0.4;
export const SPACING_SCALE_MAX = 3.0;
export const SPACING_SCALE_STEP = 0.1;
export const SPACING_SCALE_DEFAULT = 1.0;

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
/**
 * Height of a document node with previews turned off: the title bar alone,
 * drawn as a filename pill with no body box and no folder sub-header.
 */
export const NODE_PILL_HEIGHT = NODE_HEADER_HEIGHT;
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

/**
 * Approximate advance width of one character in the pill's 12px 600-weight
 * font, and the non-text width inside a pill (left inset + open icon + its
 * padding). The renderer truncates the filename against these same two
 * numbers, so a pill sized here is exactly wide enough for the text drawn in
 * it. Keep them here rather than in the renderer: layout needs them first, and
 * a second copy is how a pill ends up sized for a label it then clips.
 */
export const NODE_PILL_CHAR_WIDTH = 7;
export const NODE_PILL_CHROME_WIDTH = 50;
/** Floor for a pill so a one-word filename is still a clickable target. */
export const NODE_PILL_MIN_WIDTH = 96;

/**
 * Width of a document node.
 *
 * A full card is a fixed column, but a pill is only as wide as its filename.
 * Every layout spaces nodes off this rather than off `NODE_WIDTH`, because a
 * pill that reserves the full 260px card width draws 32px tall and claims five
 * times its real footprint - which is what pushed the radial rings out to
 * thousands of pixels and spread the force layout to match.
 */
export function calculateNodeWidth(label: string | undefined, previewCharLimit: number): number {
	if (!isPreviewOff(previewCharLimit)) {
		return NODE_WIDTH;
	}
	const textWidth = (label?.length ?? 0) * NODE_PILL_CHAR_WIDTH + NODE_PILL_CHROME_WIDTH;
	// Capped at the card width so a very long filename truncates exactly as it
	// did before rather than growing an unbounded pill.
	return Math.max(NODE_PILL_MIN_WIDTH, Math.min(NODE_WIDTH, Math.round(textWidth)));
}

// Mind Map specific constants
const HORIZONTAL_SPACING = 340;
const VERTICAL_GAP = 30;

// Radial specific constants
const RADIAL_BASE_RADIUS = 400;
const RADIAL_RING_SPACING = 340;
const RADIAL_EXTERNAL_OFFSET = 260;
/**
 * Pills are a fraction of a card's height, so a ring sized for cards leaves
 * most of its area empty. These are the pill-mode equivalents.
 */
const RADIAL_PILL_BASE_RADIUS = 210;
const RADIAL_PILL_RING_SPACING = 130;
/** Tangential gap left between two nodes sitting side by side on a band. */
const RADIAL_ARC_GAP = 60;
const RADIAL_PILL_ARC_GAP = 22;
/** Radial gap between two sub-bands of the same depth. */
const RADIAL_BAND_GAP = 56;
const RADIAL_PILL_BAND_GAP = 24;
/**
 * A depth is split into sub-bands rather than one ring once it would need more
 * circumference than this many nodes' worth. Purely a guard against a single
 * enormous ring; the real limit is the circumference arithmetic below.
 */
const RADIAL_MAX_BANDS = 24;

// Hierarchical specific constants
const HIERARCHICAL_LEVEL_HEIGHT = 220;
const HIERARCHICAL_NODE_SPACING = 80;
const HIERARCHICAL_EXTERNAL_GAP = 120;

// Force specific constants
const FORCE_LINK_DISTANCE = 300;
const FORCE_CHARGE_STRENGTH = -400;
const FORCE_COLLIDE_PADDING = 30;
const EXTERNAL_CLUSTER_OFFSET = 160;
const FORCE_TICK_COUNT = 300;
const FORCE_EXTERNAL_RING_PADDING = 250;

// Orphan band: gap below the rest of the graph, spacing between orphan tiles,
// and how many fit on a row before wrapping.
const ORPHAN_CLUSTER_OFFSET = 220;
const ORPHAN_GAP = 32;
const ORPHAN_ROW_MAX = 6;

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
	// Off is not "a zero-character preview" - the node loses its body and its
	// folder sub-header and draws as a filename pill, so it has its own height
	// regardless of how much text the document has.
	if (isPreviewOff(previewCharLimit)) {
		return NODE_PILL_HEIGHT;
	}

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
	/**
	 * Document nodes the center cannot reach. Empty unless `showOrphans` is on.
	 *
	 * Deliberately NOT merged into `visibleDocumentNodes`: those are placed by
	 * BFS depth ring, and an unreachable node has no depth. Giving one a
	 * borrowed depth would draw it as a child of the center it has no link to.
	 */
	orphanNodes: MindMapNode[];
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
	previewCharLimit: number,
	showOrphans: boolean = false
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

	// Documents the BFS above could not reach. This covers both a truly
	// unlinked file and a disconnected cluster that links only within itself -
	// both are invisible from the center, and both are what the user means by
	// "the ones that aren't interlinked".
	const orphanNodes = showOrphans
		? allNodes.filter((n) => n.nodeType === 'document' && !visited.has(n.id))
		: [];

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
		orphanNodes,
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
function calculateBounds(positionedNodes: MindMapNode[]): LayoutResult['bounds'] {
	if (positionedNodes.length === 0) {
		return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
	}
	// Measure each node's own box rather than assuming every one is a full-width
	// card. Zoom-to-fit frames these bounds, so padding them out to the widest
	// possible node would frame empty canvas on a graph made of pills.
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const node of positionedNodes) {
		const halfWidth = node.width / 2;
		const halfHeight = node.height / 2;
		if (node.x - halfWidth < minX) minX = node.x - halfWidth;
		if (node.x + halfWidth > maxX) maxX = node.x + halfWidth;
		if (node.y - halfHeight < minY) minY = node.y - halfHeight;
		if (node.y + halfHeight > maxY) maxY = node.y + halfHeight;
	}
	return {
		minX: minX - CANVAS_PADDING,
		maxX: maxX + CANVAS_PADDING,
		minY: minY - CANVAS_PADDING,
		maxY: maxY + CANVAS_PADDING,
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
 * This is the original layout algorithm - deterministic, alphabetized.
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
	previewCharLimit,
	spacingScale,
	showOrphans
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
		previewCharLimit,
		showOrphans
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
		orphanNodes,
		centerX,
		centerY,
		centerWidth,
		centerHeight,
	} = input;

	const scale = spacingScale ?? 1;
	const horizontalSpacing = HORIZONTAL_SPACING * scale;
	const verticalGap = VERTICAL_GAP * scale;

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
		const leftX = centerX - horizontalSpacing * depth;
		const leftNodeHeights = leftNodes.map((node) => {
			const previewText = node.description || node.contentPreview;
			return calculateNodeHeight(previewText, previewCharLimit);
		});
		const leftTotalHeight =
			leftNodeHeights.reduce((sum, h) => sum + h, 0) +
			Math.max(0, leftNodes.length - 1) * verticalGap;
		let leftCurrentY = centerY - leftTotalHeight / 2;

		leftNodes.forEach((node, index) => {
			const height = leftNodeHeights[index];
			const nodeY = leftCurrentY + height / 2;
			positionedNodes.push({
				...node,
				x: leftX,
				y: nodeY,
				width: calculateNodeWidth(node.label, previewCharLimit),
				height,
				depth,
				side: 'left',
			});
			leftCurrentY += height + verticalGap;
		});

		// Right column
		const rightX = centerX + horizontalSpacing * depth;
		const rightNodeHeights = rightNodes.map((node) => {
			const previewText = node.description || node.contentPreview;
			return calculateNodeHeight(previewText, previewCharLimit);
		});
		const rightTotalHeight =
			rightNodeHeights.reduce((sum, h) => sum + h, 0) +
			Math.max(0, rightNodes.length - 1) * verticalGap;
		let rightCurrentY = centerY - rightTotalHeight / 2;

		rightNodes.forEach((node, index) => {
			const height = rightNodeHeights[index];
			const nodeY = rightCurrentY + height / 2;
			positionedNodes.push({
				...node,
				x: rightX,
				y: nodeY,
				width: calculateNodeWidth(node.label, previewCharLimit),
				height,
				depth,
				side: 'right',
			});
			rightCurrentY += height + verticalGap;
		});
	}

	// Position external nodes at the bottom
	if (showExternalLinks && externalNodes.length > 0) {
		positionExternalNodesBottom(externalNodes, positionedNodes, centerX, centerY);
	}

	positionOrphanNodesBottom(orphanNodes, positionedNodes, centerX, centerY, previewCharLimit);

	const usedLinks = filterLinks(allLinks, positionedNodes, true);
	const bounds = calculateBounds(positionedNodes);
	return { nodes: positionedNodes, links: usedLinks, bounds };
};

// ============================================================================
// Radial Layout (Concentric rings)
// ============================================================================

/** One node measured for band packing. */
interface MeasuredNode {
	node: MindMapNode;
	width: number;
	height: number;
}

/** One node placed on a band, at angle `t` around the ring. */
interface BandPlacement {
	item: MeasuredNode;
	t: number;
}

/** A sub-band of a single BFS depth: a ring radius and the nodes drawn on it. */
interface RingBand {
	radius: number;
	placements: BandPlacement[];
}

/**
 * Half the node's extent along the ring at angle `t`.
 *
 * A node is an axis-aligned box, so how much of the ring it consumes depends on
 * where it sits: at the left and right of the ring the tangent runs vertically
 * and the node only costs half its height, while at the top and bottom it costs
 * half its width. Reserving the full width everywhere - which is what the old
 * fixed `NODE_WIDTH + 60` arc length did - over-reserves by 3x down the sides
 * once previews are off and a node is a 32px pill.
 */
function tangentialHalfExtent(item: MeasuredNode, t: number): number {
	return (Math.abs(Math.sin(t)) * item.width + Math.abs(Math.cos(t)) * item.height) / 2;
}

/**
 * Distribute one depth's nodes over as many concentric bands as their real
 * sizes need, starting at `startRadius`.
 *
 * A band is filled until the nodes on it would use up its whole circumference,
 * then a new band opens further out. Because each band out is longer than the
 * one before, the radius needed for N nodes grows roughly as sqrt(N) instead of
 * linearly. Radius used to be `N * (NODE_WIDTH + 60) / 2pi`, so a few dozen
 * siblings produced a multi-thousand-pixel circle that was empty in the middle
 * and could not be framed on screen at the old 0.2 zoom floor.
 */
function layoutRingBands(
	measured: MeasuredNode[],
	startRadius: number,
	arcGap: number,
	bandGap: number
): RingBand[] {
	if (measured.length === 0) return [];

	// The radial step clears the WIDEST node, not the tallest.
	//
	// A band is a circle, so the radial direction is horizontal where the band
	// crosses the vertical axis of the center. Two nodes sitting there on
	// neighbouring bands are separated horizontally by exactly the step, so a
	// step sized off node height overlaps them side by side even though the
	// arithmetic looks generous. This costs nothing in practice: the win here
	// comes from using each band's circumference, not from packing the bands
	// close together.
	const widest = measured.reduce((max, item) => Math.max(max, item.width), 0);
	const bandStep = widest + bandGap;

	const bands: RingBand[] = [];
	let radius = Math.max(startRadius, 1);
	let index = 0;

	while (index < measured.length && bands.length < RADIAL_MAX_BANDS) {
		const placements: BandPlacement[] = [];
		// Start at the top of the ring, matching where the old layout began.
		const startT = -Math.PI / 2;
		let t = startT;

		while (index < measured.length) {
			const item = measured[index];
			if (placements.length > 0) {
				const previous = placements[placements.length - 1];
				// Two neighbours are placed a chord apart, not an arc apart, so
				// the angle is solved from the chord directly. Spacing by arc
				// length instead puts them closer together than asked for, by
				// more the tighter the ring gets.
				const separation =
					tangentialHalfExtent(previous.item, t) + tangentialHalfExtent(item, t) + arcGap;
				const step = chordAngle(separation, radius);
				const nextT = t + step;
				// Reserve the closing gap back to the first node as well. Filling
				// right up to 2pi leaves the last node on top of the first, which
				// is the one overlap a forward walk cannot see coming.
				const first = placements[0].item;
				const closing = chordAngle(
					tangentialHalfExtent(item, nextT) + tangentialHalfExtent(first, startT) + arcGap,
					radius
				);
				if (nextT + closing - startT >= 2 * Math.PI) break;
				t = nextT;
			}
			placements.push({ item, t });
			index++;
		}

		// Take up the slack so a sparse band spreads around the ring instead of
		// crowding the top with a visible seam.
		const spanUsed = placements[placements.length - 1].t - startT;
		if (placements.length > 1 && spanUsed > 0) {
			// Leave one slot's worth of span unallocated: the gap between the
			// last node and the first is one more spacing, not zero.
			const targetSpan = 2 * Math.PI * (1 - 1 / placements.length);
			const stretch = targetSpan / spanUsed;
			// EXPAND ONLY. A band the walk filled tightly already spans more than
			// this target, and scaling it down would pull every node closer than
			// the clearance the walk just measured.
			if (stretch > 1) {
				placements.forEach((placement) => {
					placement.t = startT + (placement.t - startT) * stretch;
				});
			}
		}

		bands.push({ radius, placements });
		radius += bandStep;
	}

	// Anything the band guard cut off piles onto the outermost band. A guard
	// only - overlap there beats opening unbounded bands on a pathological
	// graph, and beats dropping nodes silently.
	if (index < measured.length) {
		const last = bands[bands.length - 1];
		const remaining = measured.slice(index);
		remaining.forEach((item, offset) => {
			last.placements.push({ item, t: (2 * Math.PI * offset) / remaining.length });
		});
	}

	return bands;
}

/**
 * The angle subtending a chord of length `chord` on a circle of `radius`.
 *
 * Falls back to the arc-length angle once the chord is wider than the circle,
 * which happens on the innermost band of a sparse depth and has no solution.
 */
function chordAngle(chord: number, radius: number): number {
	if (radius <= 0) return 0;
	const ratio = chord / (2 * radius);
	if (ratio >= 1) return Math.PI;
	return 2 * Math.asin(ratio);
}

/**
 * Calculate a radial layout with concentric rings around the center node.
 * Nodes at each depth level are distributed evenly around a ring.
 * Deterministic - no physics, pure trigonometry.
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
	previewCharLimit,
	spacingScale,
	showOrphans
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
		previewCharLimit,
		showOrphans
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
		orphanNodes,
		centerX,
		centerY,
		centerWidth,
		centerHeight,
	} = input;

	const scale = spacingScale ?? 1;
	const pillMode = isPreviewOff(previewCharLimit);
	const radialBaseRadius = (pillMode ? RADIAL_PILL_BASE_RADIUS : RADIAL_BASE_RADIUS) * scale;
	const radialRingSpacing = (pillMode ? RADIAL_PILL_RING_SPACING : RADIAL_RING_SPACING) * scale;
	const arcGap = (pillMode ? RADIAL_PILL_ARC_GAP : RADIAL_ARC_GAP) * scale;
	const bandGap = (pillMode ? RADIAL_PILL_BAND_GAP : RADIAL_BAND_GAP) * scale;

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

	// Position nodes on concentric rings. A depth with more siblings than its
	// ring can hold spills into further sub-bands rather than inflating one
	// ring: radius grew LINEARLY in sibling count before this, so a few dozen
	// siblings produced a multi-thousand-pixel circle that was empty in the
	// middle and could not be framed on screen. Banding makes it grow with the
	// square root instead.
	let maxRadius = 0;
	let depthStartRadius = radialBaseRadius;
	for (let depth = 1; depth <= maxDepth; depth++) {
		const nodesAtDepth = nodesByDepth.get(depth) || [];
		if (nodesAtDepth.length === 0) continue;

		// Sort alphabetically for deterministic positioning
		nodesAtDepth.sort((a, b) => a.label.localeCompare(b.label));

		const measured: MeasuredNode[] = nodesAtDepth.map((node) => ({
			node,
			width: calculateNodeWidth(node.label, previewCharLimit),
			height: calculateNodeHeight(node.description || node.contentPreview, previewCharLimit),
		}));

		const bands = layoutRingBands(measured, depthStartRadius, arcGap, bandGap);

		bands.forEach((band) => {
			maxRadius = Math.max(maxRadius, band.radius);
			band.placements.forEach(({ item, t }) => {
				const x = centerX + band.radius * Math.cos(t);
				const y = centerY + band.radius * Math.sin(t);
				const side: MindMapNode['side'] =
					x < centerX - 10 ? 'left' : x > centerX + 10 ? 'right' : 'right';

				positionedNodes.push({
					...item.node,
					x,
					y,
					width: item.width,
					height: item.height,
					depth,
					side,
				});
			});
		});

		// The next depth starts clear of the last band this depth used.
		const lastBand = bands[bands.length - 1];
		depthStartRadius = (lastBand?.radius ?? depthStartRadius) + radialRingSpacing;
	}

	// Position external nodes on an outer ring
	if (showExternalLinks && externalNodes.length > 0) {
		externalNodes.sort((a, b) => (a.domain || '').localeCompare(b.domain || ''));

		const externalRadius = Math.max(maxRadius, radialBaseRadius) + RADIAL_EXTERNAL_OFFSET;
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
	positionOrphanNodesBottom(orphanNodes, positionedNodes, centerX, centerY, previewCharLimit);

	const usedLinks = filterLinks(allLinks, positionedNodes, true);
	const bounds = calculateBounds(positionedNodes);
	return { nodes: positionedNodes, links: usedLinks, bounds };
};

// ============================================================================
// Hierarchical Layout (Top-Down Tree)
// ============================================================================

/**
 * Calculate a top-down hierarchical layout: the center node sits at the top
 * and each BFS depth level becomes a horizontal row underneath. Nodes within
 * a row are alphabetized and evenly spaced. External link nodes (when shown)
 * are placed in a final row below the deepest document row.
 */
export const calculateHierarchicalLayout: LayoutFunction = (
	allNodes,
	allLinks,
	adjacency,
	centerFilePath,
	maxDepth,
	canvasWidth,
	canvasHeight,
	showExternalLinks,
	previewCharLimit,
	spacingScale,
	showOrphans
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
		previewCharLimit,
		showOrphans
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
		orphanNodes,
		centerX,
		centerY,
		centerWidth,
		centerHeight,
	} = input;

	const scale = spacingScale ?? 1;
	const levelHeight = HIERARCHICAL_LEVEL_HEIGHT * scale;
	const nodeSpacing = HIERARCHICAL_NODE_SPACING * scale;

	const positionedNodes: MindMapNode[] = [];

	// Center node anchors the top of the tree.
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

	// Bucket non-center nodes by BFS depth.
	const nodesByDepth = new Map<number, MindMapNode[]>();
	visibleDocumentNodes.forEach((node) => {
		if (node.id === actualCenterNodeId) return;
		const depth = visited.get(node.id) || 1;
		if (!nodesByDepth.has(depth)) nodesByDepth.set(depth, []);
		nodesByDepth.get(depth)!.push(node);
	});

	let lastDocRowY = centerY;
	for (let depth = 1; depth <= maxDepth; depth++) {
		const nodesAtDepth = nodesByDepth.get(depth) || [];
		if (nodesAtDepth.length === 0) continue;

		nodesAtDepth.sort((a, b) => a.label.localeCompare(b.label));

		const rowY = centerY + depth * levelHeight;
		// Stride off the widest node actually in this row. A row of filename
		// pills is a fraction of a card wide, and reserving the card width
		// spreads the row across screens of empty canvas.
		const widestInRow = nodesAtDepth.reduce(
			(max, node) => Math.max(max, calculateNodeWidth(node.label, previewCharLimit)),
			0
		);
		const stride = widestInRow + nodeSpacing;
		const rowWidth = Math.max(0, nodesAtDepth.length - 1) * stride;
		const startX = centerX - rowWidth / 2;

		nodesAtDepth.forEach((node, index) => {
			const previewText = node.description || node.contentPreview;
			const height = calculateNodeHeight(previewText, previewCharLimit);
			const x = startX + index * stride;
			const side: MindMapNode['side'] =
				x < centerX - 10 ? 'left' : x > centerX + 10 ? 'right' : 'right';
			positionedNodes.push({
				...node,
				x,
				y: rowY,
				width: calculateNodeWidth(node.label, previewCharLimit),
				height,
				depth,
				side,
			});
		});

		lastDocRowY = rowY;
	}

	// External nodes go in a final row below the deepest document row.
	if (showExternalLinks && externalNodes.length > 0) {
		externalNodes.sort((a, b) => (a.domain || '').localeCompare(b.domain || ''));
		const externalY = lastDocRowY + HIERARCHICAL_EXTERNAL_GAP * scale;
		const stride = EXTERNAL_NODE_WIDTH + 20;
		const rowWidth = Math.max(0, externalNodes.length - 1) * stride;
		const startX = centerX - rowWidth / 2;
		externalNodes.forEach((node, index) => {
			positionedNodes.push({
				...node,
				x: startX + index * stride,
				y: externalY,
				width: EXTERNAL_NODE_WIDTH,
				height: EXTERNAL_NODE_HEIGHT,
				depth: 1,
				side: 'external',
			});
		});
	}

	positionOrphanNodesBottom(orphanNodes, positionedNodes, centerX, centerY, previewCharLimit);

	const usedLinks = filterLinks(allLinks, positionedNodes, true);
	const bounds = calculateBounds(positionedNodes);
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
	previewCharLimit,
	spacingScale,
	showOrphans
) => {
	const forceLinkDistance = FORCE_LINK_DISTANCE * (spacingScale ?? 1);
	const input = prepareLayoutInput(
		allNodes,
		allLinks,
		adjacency,
		centerFilePath,
		maxDepth,
		canvasWidth,
		canvasHeight,
		showExternalLinks,
		previewCharLimit,
		showOrphans
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
		orphanNodes,
		centerX,
		centerY,
		centerWidth,
		centerHeight,
	} = input;

	// Build simulation nodes - seed positions deterministically from index
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
			width: calculateNodeWidth(node.label, previewCharLimit),
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
				.distance(forceLinkDistance)
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
			width: calculateNodeWidth(node.label, previewCharLimit),
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
	positionOrphanNodesBottom(orphanNodes, positionedNodes, centerX, centerY, previewCharLimit);

	const usedLinks = filterLinks(allLinks, positionedNodes, false);
	const bounds = calculateBounds(positionedNodes);
	return { nodes: positionedNodes, links: usedLinks, bounds };
};

// ============================================================================
// Lobes Layout (Clustered by link community)
// ============================================================================

// Lobes specific constants
const LOBE_LINK_DISTANCE = 150;
const LOBE_PILL_LINK_DISTANCE = 78;
const LOBE_CHARGE_STRENGTH = -220;
const LOBE_COLLIDE_PADDING = 14;
const LOBE_TICK_COUNT = 220;
/** Gap left between the outer edges of two neighbouring lobes. */
const LOBE_GAP = 90;
/** How many label-propagation rounds to run before accepting the partition. */
const LOBE_PROPAGATION_ROUNDS = 12;

/**
 * Partition nodes into communities by label propagation over `adjacency`.
 *
 * Deterministic on purpose: nodes are visited in sorted-id order and a tie
 * between two equally-common neighbour labels is broken by the lexicographically
 * smallest one, so the same graph always produces the same lobes. The usual
 * randomized visit order would reshuffle the whole picture on every re-render,
 * which reads as the layout being unstable rather than as clustering.
 *
 * Nodes with no visible neighbours keep their own id as their label, so they
 * end up as single-node lobes rather than being swept into an arbitrary one.
 */
function detectCommunities(
	nodeIds: string[],
	adjacency: Map<string, Set<string>>
): Map<string, string> {
	const visible = new Set(nodeIds);
	const labels = new Map<string, string>();
	nodeIds.forEach((id) => labels.set(id, id));

	const order = [...nodeIds].sort();

	for (let round = 0; round < LOBE_PROPAGATION_ROUNDS; round++) {
		let changed = false;
		for (const id of order) {
			const neighbors = adjacency.get(id);
			if (!neighbors || neighbors.size === 0) continue;

			const counts = new Map<string, number>();
			neighbors.forEach((neighborId) => {
				if (!visible.has(neighborId)) return;
				const label = labels.get(neighborId);
				if (label === undefined) return;
				counts.set(label, (counts.get(label) ?? 0) + 1);
			});
			if (counts.size === 0) continue;

			let best = labels.get(id)!;
			let bestCount = -1;
			// Sorting the candidates makes the tie-break lexicographic, which is
			// what keeps the partition stable across renders.
			[...counts.keys()].sort().forEach((label) => {
				const count = counts.get(label)!;
				if (count > bestCount) {
					best = label;
					bestCount = count;
				}
			});

			if (best !== labels.get(id)) {
				labels.set(id, best);
				changed = true;
			}
		}
		if (!changed) break;
	}

	return labels;
}

/**
 * Calculate a lobe layout: documents are grouped into communities by how they
 * link to each other, each community is relaxed into a blob by a short force
 * simulation, and the blobs are packed on a ring around the center node's own
 * lobe.
 *
 * Where Radial answers "how far is this from the center?", Lobes answers "what
 * clusters together?" - a question BFS depth rings throw away entirely on a
 * hub-and-spoke corpus, where almost everything lands one hop from the hub.
 */
export const calculateLobesLayout: LayoutFunction = (
	allNodes,
	allLinks,
	adjacency,
	centerFilePath,
	maxDepth,
	canvasWidth,
	canvasHeight,
	showExternalLinks,
	previewCharLimit,
	spacingScale,
	showOrphans
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
		previewCharLimit,
		showOrphans
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
		orphanNodes,
		centerX,
		centerY,
		centerWidth,
		centerHeight,
	} = input;

	const scale = spacingScale ?? 1;
	const pillMode = isPreviewOff(previewCharLimit);
	const linkDistance = (pillMode ? LOBE_PILL_LINK_DISTANCE : LOBE_LINK_DISTANCE) * scale;
	const lobeGap = LOBE_GAP * scale;

	const docNodes = visibleDocumentNodes;
	const docIds = docNodes.map((n) => n.id);
	const communities = detectCommunities(docIds, adjacency);

	// Group nodes by community label, then sort the groups largest-first so the
	// packing ring starts with the blobs that dominate the picture.
	const groups = new Map<string, MindMapNode[]>();
	docNodes.forEach((node) => {
		const label = communities.get(node.id) ?? node.id;
		if (!groups.has(label)) groups.set(label, []);
		groups.get(label)!.push(node);
	});

	const centerCommunity = communities.get(actualCenterNodeId);
	const lobes = [...groups.entries()]
		.map(([label, members]) => ({
			label,
			members: [...members].sort((a, b) => a.label.localeCompare(b.label)),
		}))
		.sort((a, b) => {
			// The center's own lobe is placed at the middle of the canvas, so it
			// is pulled out of the ring ordering entirely.
			if (a.label === centerCommunity) return -1;
			if (b.label === centerCommunity) return 1;
			if (b.members.length !== a.members.length) return b.members.length - a.members.length;
			return a.label.localeCompare(b.label);
		});

	/** Relax one community into a blob centred on the origin. */
	const relaxLobe = (
		members: MindMapNode[]
	): {
		placed: Array<{ node: MindMapNode; x: number; y: number; width: number; height: number }>;
		radius: number;
	} => {
		const measured = members.map((node, index) => {
			const width = calculateNodeWidth(node.label, previewCharLimit);
			const height = calculateNodeHeight(node.description || node.contentPreview, previewCharLimit);
			// Deterministic seed: a phyllotaxis spiral, so the simulation starts
			// from an evenly spread disc rather than a random cloud.
			const angle = index * 2.399963229728653;
			const seedRadius = Math.sqrt(index) * linkDistance * 0.7;
			return {
				id: node.id,
				node,
				width,
				height,
				x: seedRadius * Math.cos(angle),
				y: seedRadius * Math.sin(angle),
			};
		});

		if (measured.length === 1) {
			const only = measured[0];
			return {
				placed: [{ node: only.node, x: 0, y: 0, width: only.width, height: only.height }],
				radius: Math.max(only.width, only.height) / 2,
			};
		}

		const simNodes: ForceNode[] = measured.map((m) => ({
			id: m.id,
			x: m.x,
			y: m.y,
			width: m.width,
			height: m.height,
		}));
		const idSet = new Set(simNodes.map((n) => n.id));
		const simLinks: ForceLinkDatum[] = [];
		const seenLinks = new Set<string>();
		allLinks.forEach((link) => {
			if (link.type === 'external') return;
			if (!idSet.has(link.source) || !idSet.has(link.target)) return;
			const key = [link.source, link.target].sort().join('|');
			if (seenLinks.has(key)) return;
			seenLinks.add(key);
			simLinks.push({ id: key, source: link.source, target: link.target });
		});

		forceSimulation<ForceNode>(simNodes)
			.force(
				'link',
				forceLink<ForceNode, ForceLinkDatum>(simLinks)
					.id((d) => d.id)
					.distance(linkDistance)
					.strength(0.7)
			)
			.force('charge', forceManyBody<ForceNode>().strength(LOBE_CHARGE_STRENGTH).distanceMax(600))
			.force(
				'collide',
				forceCollide<ForceNode>()
					.radius((d) => Math.max(d.width, d.height) / 2 + LOBE_COLLIDE_PADDING)
					.strength(1)
					.iterations(3)
			)
			.force('x', forceX<ForceNode>(0).strength(0.08))
			.force('y', forceY<ForceNode>(0).strength(0.08))
			.stop()
			.tick(LOBE_TICK_COUNT);

		// Recentre the blob on its own centroid so packing can treat it as a
		// disc at the origin.
		const meanX = simNodes.reduce((sum, n) => sum + (n.x ?? 0), 0) / simNodes.length;
		const meanY = simNodes.reduce((sum, n) => sum + (n.y ?? 0), 0) / simNodes.length;

		let radius = 0;
		const placed = simNodes.map((sim, index) => {
			const m = measured[index];
			const x = (sim.x ?? 0) - meanX;
			const y = (sim.y ?? 0) - meanY;
			radius = Math.max(radius, Math.hypot(x, y) + Math.max(m.width, m.height) / 2);
			return { node: m.node, x, y, width: m.width, height: m.height };
		});

		return { placed, radius };
	};

	const relaxed = lobes.map((lobe) => ({ ...lobe, ...relaxLobe(lobe.members) }));

	const positionedNodes: MindMapNode[] = [];
	const centralLobe = relaxed.find((lobe) => lobe.label === centerCommunity);
	const outerLobes = relaxed.filter((lobe) => lobe !== centralLobe);

	// Ring radius: big enough that the outer lobes sit clear of the central one
	// AND of each other. The second term is the circumference test - the sum of
	// the blob diameters has to fit around the ring.
	const centralRadius = centralLobe?.radius ?? Math.max(centerWidth, centerHeight) / 2;
	const outerMaxRadius = outerLobes.reduce((max, lobe) => Math.max(max, lobe.radius), 0);
	const circumferenceNeed =
		outerLobes.reduce((sum, lobe) => sum + lobe.radius * 2 + lobeGap, 0) / (2 * Math.PI);
	const ringRadius =
		outerLobes.length === 0
			? 0
			: Math.max(centralRadius + outerMaxRadius + lobeGap, circumferenceNeed);

	const placeLobe = (
		lobe: {
			placed: Array<{ node: MindMapNode; x: number; y: number; width: number; height: number }>;
		},
		offsetX: number,
		offsetY: number
	) => {
		lobe.placed.forEach((item) => {
			const x = offsetX + item.x;
			const y = offsetY + item.y;
			const isCenterNode = item.node.id === actualCenterNodeId;
			positionedNodes.push({
				...item.node,
				x,
				y,
				width: isCenterNode ? item.width * CENTER_NODE_SCALE : item.width,
				height: isCenterNode ? item.height * CENTER_NODE_SCALE : item.height,
				depth: visited.get(item.node.id) ?? 1,
				side: x < centerX - 10 ? 'left' : 'right',
				isFocused: isCenterNode,
			});
		});
	};

	if (centralLobe) {
		placeLobe(centralLobe, centerX, centerY);
	} else {
		// The center document has no lobe of its own only when it is not in the
		// visible set at all; draw it alone at the middle so the graph still has
		// the anchor the rest of the UI expects.
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
	}

	if (ringRadius > 0) {
		// Walk the ring proportionally to each blob's own arc so a large lobe is
		// not crammed into the same slice as a single-node one.
		const totalArc = outerLobes.reduce((sum, lobe) => sum + lobe.radius * 2 + lobeGap, 0);
		let cursor = -Math.PI / 2;
		outerLobes.forEach((lobe) => {
			const share = ((lobe.radius * 2 + lobeGap) / totalArc) * 2 * Math.PI;
			const angle = cursor + share / 2;
			cursor += share;
			placeLobe(
				lobe,
				centerX + ringRadius * Math.cos(angle),
				centerY + ringRadius * Math.sin(angle)
			);
		});
	}

	if (showExternalLinks && externalNodes.length > 0) {
		positionExternalNodesBottom(externalNodes, positionedNodes, centerX, centerY);
	}

	positionOrphanNodesBottom(orphanNodes, positionedNodes, centerX, centerY, previewCharLimit);

	// Lobes are ABOUT the links, so every link between two placed nodes is drawn
	// rather than only adjacent-depth ones. A depth filter here would hide the
	// cross-cluster edges that are the whole reason to look at this layout.
	const usedLinks = filterLinks(allLinks, positionedNodes, false);
	const bounds = calculateBounds(positionedNodes);
	return { nodes: positionedNodes, links: usedLinks, bounds };
};

// ============================================================================
// Timeline Layout (Columns by last modified)
// ============================================================================

// Timeline specific constants
const TIMELINE_COLUMN_GAP = 56;
const TIMELINE_ROW_GAP = 18;
/** Height reserved above the columns for the date captions. */
const TIMELINE_AXIS_HEIGHT = 64;
/** Caption for a column, in the user's locale. `null` mtime means undated. */
function timelineColumnLabel(dayStart: number | null): string {
	if (dayStart === null) return 'Undated';
	return new Date(dayStart).toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

/**
 * Calculate a timeline layout: one column per day that has documents, oldest on
 * the left, documents stacked inside their column.
 *
 * Columns are evenly spaced by rank rather than by real elapsed time. A true
 * time axis on a corpus written in bursts is mostly empty canvas between two
 * dense clumps, and the question this layout answers - "what did I learn, and
 * in what order?" - only needs the ordering.
 *
 * Documents whose mtime never made it through (an SSH stat that reported no
 * modified time) collect in a leading "Undated" column instead of silently
 * bucketing at the epoch, which would date them to 1970 and put them first.
 */
export const calculateTimelineLayout: LayoutFunction = (
	allNodes,
	allLinks,
	adjacency,
	centerFilePath,
	maxDepth,
	canvasWidth,
	canvasHeight,
	showExternalLinks,
	previewCharLimit,
	spacingScale,
	showOrphans
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
		previewCharLimit,
		showOrphans
	);

	if (!input) {
		return {
			nodes: [],
			links: [],
			bounds: { minX: 0, maxX: canvasWidth, minY: 0, maxY: canvasHeight },
		};
	}

	const {
		actualCenterNodeId,
		visited,
		visibleDocumentNodes,
		externalNodes,
		orphanNodes,
		centerX,
		centerY,
	} = input;

	const scale = spacingScale ?? 1;
	const columnGap = TIMELINE_COLUMN_GAP * scale;
	const rowGap = TIMELINE_ROW_GAP * scale;

	// Orphans belong ON the timeline here, not in a band underneath: an
	// unlinked document still has a modification time, and "when did I write
	// this?" is exactly the question this layout answers. The band would hide
	// them from the one view that can place them.
	const timelineNodes = [...visibleDocumentNodes, ...orphanNodes];

	// Bucket by local day. `null` is the undated bucket.
	const buckets = new Map<number | null, MindMapNode[]>();
	timelineNodes.forEach((node) => {
		const mtime = node.mtime;
		let key: number | null = null;
		if (typeof mtime === 'number' && mtime > 0) {
			const date = new Date(mtime);
			key = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
		}
		if (!buckets.has(key)) buckets.set(key, []);
		buckets.get(key)!.push(node);
	});

	const columns = [...buckets.entries()]
		.map(([day, members]) => ({
			day,
			members: [...members].sort((a, b) => {
				// Newest first within a day, then alphabetical so a shared mtime
				// (a bulk copy, a checkout) still orders deterministically.
				const diff = (b.mtime ?? 0) - (a.mtime ?? 0);
				return diff !== 0 ? diff : a.label.localeCompare(b.label);
			}),
		}))
		.sort((a, b) => {
			// Undated leads, then oldest to newest left to right.
			if (a.day === null) return -1;
			if (b.day === null) return 1;
			return a.day - b.day;
		});

	const positionedNodes: MindMapNode[] = [];
	const axisLabels: LayoutAxisLabel[] = [];

	const measuredColumns = columns.map((column) => {
		const measured = column.members.map((node) => ({
			node,
			width: calculateNodeWidth(node.label, previewCharLimit),
			height: calculateNodeHeight(node.description || node.contentPreview, previewCharLimit),
		}));
		const columnWidth = measured.reduce((max, item) => Math.max(max, item.width), 0);
		const columnHeight =
			measured.reduce((sum, item) => sum + item.height, 0) +
			Math.max(0, measured.length - 1) * rowGap;
		return { ...column, measured, columnWidth, columnHeight };
	});

	const totalWidth =
		measuredColumns.reduce((sum, column) => sum + column.columnWidth, 0) +
		Math.max(0, measuredColumns.length - 1) * columnGap;
	const tallestColumn = measuredColumns.reduce((max, c) => Math.max(max, c.columnHeight), 0);

	let cursorX = centerX - totalWidth / 2;
	const columnTop = centerY - tallestColumn / 2;

	measuredColumns.forEach((column) => {
		const columnCenterX = cursorX + column.columnWidth / 2;

		axisLabels.push({
			x: columnCenterX,
			y: columnTop - TIMELINE_AXIS_HEIGHT / 2,
			text: timelineColumnLabel(column.day),
			ruleHeight: column.columnHeight + TIMELINE_AXIS_HEIGHT / 2,
		});

		let cursorY = columnTop;
		column.measured.forEach((item) => {
			const isCenterNode = item.node.id === actualCenterNodeId;
			positionedNodes.push({
				...item.node,
				x: columnCenterX,
				y: cursorY + item.height / 2,
				width: item.width,
				height: item.height,
				depth: visited.get(item.node.id) ?? 1,
				side: columnCenterX < centerX - 10 ? 'left' : 'right',
				isFocused: isCenterNode,
				// The orphan flag drives a dashed border that means "unreachable
				// from the center". That is still true here, so it is kept even
				// though these nodes are no longer in the orphan band.
				isOrphan: item.node.isOrphan || !visited.has(item.node.id),
			});
			cursorY += item.height + rowGap;
		});

		cursorX += column.columnWidth + columnGap;
	});

	if (showExternalLinks && externalNodes.length > 0) {
		positionExternalNodesBottom(externalNodes, positionedNodes, centerX, centerY);
	}

	const usedLinks = filterLinks(allLinks, positionedNodes, false);
	const bounds = calculateBounds(positionedNodes);
	// Widen the bounds upward so zoom-to-fit frames the date captions too.
	bounds.minY = Math.min(bounds.minY, columnTop - TIMELINE_AXIS_HEIGHT - CANVAS_PADDING);
	return { nodes: positionedNodes, links: usedLinks, bounds, axisLabels };
};

// ============================================================================
// Shared External Node Positioning (Mind Map)
// ============================================================================

/**
 * Position external nodes in a horizontal row at the bottom (used by mind map layout).
 */
/**
 * Lay the unreachable documents out in a band below everything else.
 *
 * Mirrors `positionExternalNodesBottom`: both handle nodes that have no place
 * in the depth rings, and both must sit clear of the positioned graph rather
 * than overlap it. Orphans go BELOW the external band when both are shown,
 * because an orphan is still a document and reads better nearest the documents.
 *
 * Rows wrap at ORPHAN_ROW_MAX so a 60-orphan scope does not render as one
 * strip several screens wide.
 */
function positionOrphanNodesBottom(
	orphanNodes: MindMapNode[],
	positionedNodes: MindMapNode[],
	centerX: number,
	centerY: number,
	previewCharLimit: number
): void {
	if (orphanNodes.length === 0) return;

	const sorted = [...orphanNodes].sort((a, b) => a.label.localeCompare(b.label));

	// Clear the lowest thing already placed, external band included.
	const maxYDistance = positionedNodes.reduce((max, n) => {
		const dist = n.y - centerY + n.height / 2;
		return dist > max ? dist : max;
	}, 0);
	const bandTop = centerY + maxYDistance + ORPHAN_CLUSTER_OFFSET;

	const perRow = Math.min(ORPHAN_ROW_MAX, sorted.length);
	const widestOrphan = sorted.reduce(
		(max, node) => Math.max(max, calculateNodeWidth(node.label, previewCharLimit)),
		0
	);
	const columnWidth = widestOrphan + ORPHAN_GAP;
	const rowStartX = centerX - ((perRow - 1) * columnWidth) / 2;

	let rowY = bandTop;
	for (let start = 0; start < sorted.length; start += perRow) {
		const row = sorted.slice(start, start + perRow);
		const heights = row.map((node) =>
			calculateNodeHeight(node.description || node.contentPreview, previewCharLimit)
		);
		const rowHeight = Math.max(...heights);
		row.forEach((node, index) => {
			positionedNodes.push({
				...node,
				x: rowStartX + index * columnWidth,
				y: rowY + rowHeight / 2,
				width: calculateNodeWidth(node.label, previewCharLimit),
				height: heights[index],
				depth: 1,
				side: 'orphan',
				isOrphan: true,
			});
		});
		rowY += rowHeight + ORPHAN_GAP;
	}
}

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
	hierarchical: calculateHierarchicalLayout,
	force: calculateForceLayout,
	lobes: calculateLobesLayout,
	timeline: calculateTimelineLayout,
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
	previewCharLimit: number,
	spacingScale: number = SPACING_SCALE_DEFAULT,
	showOrphans: boolean = false
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
		previewCharLimit,
		spacingScale,
		showOrphans
	);
}
