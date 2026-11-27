/**
 * Edge routing shared by the graph canvas and the relationship editor.
 *
 * An edge runs between the two node BODIES and not between two handles. A
 * delegation graph is drawn as rows, as a physics cluster, as rings, or however
 * the user dragged it, so a peer can sit on any side of an agent. A line pinned
 * to a bottom handle and a top handle is right in one of those and loops around
 * the node in the rest. This one aims at the other node's center and stops at
 * each border, so it is the short way in every layout.
 *
 * Two agents that reach each other are TWO edges, one per direction. Aimed
 * center to center they would be one line with an arrowhead at each end, which
 * reads as a single bidirectional relationship, and the two can differ (a
 * manager delegates down, an employee only consults up). So each edge of such a
 * pair keeps to one side of its own direction of travel, the way traffic does:
 * its ends are shifted sideways and its body bows further out. The opposite
 * edge travels the other way, so the same rule puts it on the other side, and
 * neither edge has to know which of the two it is.
 *
 * Pure arithmetic. No React and no reactflow import, so the tests run it bare.
 */

/** A node as the router sees it: its center and half its size. */
export interface GraphEdgeAnchor {
	centerX: number;
	centerY: number;
	halfWidth: number;
	halfHeight: number;
}

export interface GraphEdgePoint {
	x: number;
	y: number;
}

export interface GraphEdgeGeometry {
	/** The SVG path, from the source's border to the target's border. */
	path: string;
	/** Where the path leaves the source node. */
	start: GraphEdgePoint;
	/** Where the path meets the target node. The arrowhead points here. */
	end: GraphEdgePoint;
	/** Quadratic control point for a reciprocal pair's separate lane. */
	control?: GraphEdgePoint;
	/** The middle of the drawn line, where the badge sits. */
	labelX: number;
	labelY: number;
}

/** How far each end of an edge moves aside when the opposite edge exists. */
export const REVERSE_PAIR_SHIFT = 8;
/** How far the middle of that edge bows beyond its shifted ends. */
export const REVERSE_PAIR_BOW = 14;

/** Two centers closer than this have no direction to route along. */
const MIN_ROUTABLE_DISTANCE = 0.5;

/** The fields of a reactflow node the anchor reads. Unmeasured ones are absent or null. */
interface MeasuredNodeLike {
	positionAbsolute?: GraphEdgePoint;
	width?: number | null;
	height?: number | null;
}

/**
 * The anchor of a node reactflow has measured. Before the first measurement
 * there is no rectangle to stop at, so the anchor is the bare fallback point
 * (the handle position reactflow passed to the edge) with no size.
 */
export function anchorOfNode(
	node: MeasuredNodeLike | undefined,
	fallbackX: number,
	fallbackY: number
): GraphEdgeAnchor {
	const position = node?.positionAbsolute;
	if (!node || !position || !node.width || !node.height) {
		return { centerX: fallbackX, centerY: fallbackY, halfWidth: 0, halfHeight: 0 };
	}
	return {
		centerX: position.x + node.width / 2,
		centerY: position.y + node.height / 2,
		halfWidth: node.width / 2,
		halfHeight: node.height / 2,
	};
}

/** Two decimals: a path the tests can read, and no `-0` from a rounded negative. */
function round(value: number): number {
	const rounded = Math.round(value * 100) / 100;
	return rounded === 0 ? 0 : rounded;
}

/**
 * Walk from a point inside a node (its center, moved aside by `offset`) along
 * `direction` and return where the walk crosses the node's border. A point that
 * is already outside (an unmeasured node, or a node thinner than the shift)
 * stays where it is.
 */
function borderPoint(
	anchor: GraphEdgeAnchor,
	offsetX: number,
	offsetY: number,
	directionX: number,
	directionY: number
): GraphEdgePoint {
	let distance = Infinity;
	if (directionX !== 0) {
		distance = Math.min(
			distance,
			(Math.sign(directionX) * anchor.halfWidth - offsetX) / directionX
		);
	}
	if (directionY !== 0) {
		distance = Math.min(
			distance,
			(Math.sign(directionY) * anchor.halfHeight - offsetY) / directionY
		);
	}
	if (!Number.isFinite(distance) || distance < 0) distance = 0;
	return {
		x: anchor.centerX + offsetX + directionX * distance,
		y: anchor.centerY + offsetY + directionY * distance,
	};
}

/**
 * Route one edge. `hasReverse` says the edge from the target back to the source
 * exists too, and moves this one into its own lane.
 */
export function graphEdgeGeometry(
	source: GraphEdgeAnchor,
	target: GraphEdgeAnchor,
	hasReverse: boolean
): GraphEdgeGeometry {
	const deltaX = target.centerX - source.centerX;
	const deltaY = target.centerY - source.centerY;
	const length = Math.hypot(deltaX, deltaY);

	// One node dropped exactly on another. There is no line to draw, and both
	// nodes cover the spot, so park a zero-length path there instead of dividing
	// by zero.
	if (length < MIN_ROUTABLE_DISTANCE) {
		const x = round(source.centerX);
		const y = round(source.centerY);
		return {
			path: `M ${x},${y} L ${x},${y}`,
			start: { x, y },
			end: { x, y },
			labelX: x,
			labelY: y,
		};
	}

	const alongX = deltaX / length;
	const alongY = deltaY / length;
	// A quarter turn from the direction of travel. It flips with the direction,
	// which is what puts the opposite edge on the other side.
	const asideX = -alongY;
	const asideY = alongX;

	const shift = hasReverse ? REVERSE_PAIR_SHIFT : 0;
	const start = borderPoint(source, asideX * shift, asideY * shift, alongX, alongY);
	const end = borderPoint(target, asideX * shift, asideY * shift, -alongX, -alongY);
	const middleX = (start.x + end.x) / 2;
	const middleY = (start.y + end.y) / 2;

	const rounded = {
		start: { x: round(start.x), y: round(start.y) },
		end: { x: round(end.x), y: round(end.y) },
	};

	if (!hasReverse) {
		return {
			path: `M ${rounded.start.x},${rounded.start.y} L ${rounded.end.x},${rounded.end.y}`,
			...rounded,
			labelX: round(middleX),
			labelY: round(middleY),
		};
	}

	// A quadratic curve passes halfway between its chord and its control point,
	// so the control point sits at twice the bow.
	const controlX = round(middleX + asideX * REVERSE_PAIR_BOW * 2);
	const controlY = round(middleY + asideY * REVERSE_PAIR_BOW * 2);
	return {
		path: `M ${rounded.start.x},${rounded.start.y} Q ${controlX},${controlY} ${rounded.end.x},${rounded.end.y}`,
		control: { x: controlX, y: controlY },
		...rounded,
		labelX: round(middleX + asideX * REVERSE_PAIR_BOW),
		labelY: round(middleY + asideY * REVERSE_PAIR_BOW),
	};
}
