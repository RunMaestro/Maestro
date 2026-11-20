/**
 * DelegationEdge - one directed peer relationship on the Delegation Graph.
 *
 * The skeleton is `CuePipelineEditor/edges/PipelineEdge.tsx`: a `BaseEdge`, a
 * glow under it when it is raised, and a midpoint label. The routing is not: see
 * `utils/graphEdgeGeometry` for why this edge runs between node bodies.
 *
 * One edge carries two independent bits, and a reader must not need color to
 * tell them apart, so each bit is written twice:
 *
 *   | Access            | Line         | Badge |
 *   | ----------------- | ------------ | ----- |
 *   | consult only      | dashed, thin | `C`   |
 *   | delegate only     | solid, thin  | `D`   |
 *   | consult, delegate | solid, thick | `CD`  |
 *
 * The badge has two fixed slots, `C` on the left and `D` on the right. A bit
 * that is off leaves its slot empty, so the POSITION of a letter says the same
 * thing as the letter.
 *
 * An edge the user wrote (an explicit peer row) is drawn at full contrast. An
 * edge a grant derived (the group grant, the worktree grant) is drawn fainter,
 * and its tooltip names the grant.
 *
 * The data holds agent ids and never a name. Both names are read from the
 * session store on every render, the same rule `AgentDelegationNode` follows.
 *
 * The badge is also the way INTO an edge. While the canvas hands the edge an
 * `onOpen` (Edit mode), the badge is a button: a click, Enter or Space opens
 * the edge editor there. The line itself is opened by the canvas
 * (`onEdgeClick`), which is why a click on the badge stops here: the badge is
 * drawn through a portal, and a React event bubbles through a portal to the
 * edge it belongs to, so the canvas would open the same edge a second time.
 */

import { memo, useCallback, type KeyboardEvent, type MouseEvent } from 'react';
import {
	BaseEdge,
	EdgeLabelRenderer,
	MarkerType,
	useStore,
	type EdgeMarker,
	type EdgeProps,
	type ReactFlowState,
} from 'reactflow';
import type { Theme } from '../../../types';
import type { DelegationGraphEdge } from '../../../../shared/delegationGraph';
import { PEER_GRANT_LABELS } from '../../../../shared/peerAgents';
import { selectSessionById, useSessionStore } from '../../../stores/sessionStore';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { removedAgentLabel } from '../nodes/AgentDelegationNode';
import { anchorOfNode, graphEdgeGeometry } from '../../../utils/graphEdgeGeometry';

/** Which of the two bits an edge carries. An edge with neither is not an edge. */
export type DelegationEdgeKind = 'consult' | 'delegate' | 'both';

/**
 * Neighbor focus, set by the view while a node is selected: the selected
 * agent's own edges are `highlighted` and every other edge is `dimmed`. Absent
 * while nothing is selected. One value and not two flags, because an edge
 * cannot be both.
 */
export type DelegationEdgeEmphasis = 'highlighted' | 'dimmed';

export interface DelegationEdgeData {
	/** The model edge, exactly as `buildDelegationGraph` returned it. */
	edge: DelegationGraphEdge;
	/** The opposite edge exists too: `isMutual(model, edge.sourceId, edge.targetId)`. */
	hasReverse: boolean;
	emphasis?: DelegationEdgeEmphasis;
	/**
	 * Open this edge for editing, at a point of the window. Present only while
	 * the canvas lets a relationship be changed; absent, the badge is a label.
	 */
	onOpen?: (edge: DelegationGraphEdge, anchor: { x: number; y: number }) => void;
	theme: Theme;
}

export interface DelegationEdgeLine {
	width: number;
	/** An SVG `stroke-dasharray`. Absent for a solid line. */
	dash?: string;
}

/** The line of each kind. The legend draws its samples from the same table. */
export const DELEGATION_EDGE_LINES: Record<DelegationEdgeKind, DelegationEdgeLine> = {
	consult: { width: 1.5, dash: '6 4' },
	delegate: { width: 1.5 },
	both: { width: 3 },
};

export const DELEGATION_EDGE_KIND_LABELS: Record<DelegationEdgeKind, string> = {
	consult: 'Consult',
	delegate: 'Delegate',
	both: 'Consult and delegate',
};

/** How much fainter an edge is when a grant derived it and no row names it. */
const DERIVED_OPACITY = 0.5;
/** How much fainter an edge is while another agent has the focus. */
const DIMMED_OPACITY = 0.3;
/** How much a raised edge thickens. Added, so thin and thick stay apart. */
const RAISED_EXTRA_WIDTH = 1;
const GLOW_EXTRA_WIDTH = 6;
const TOOLTIP_MAX_WIDTH = 280;

/** The two slots of the badge, left to right. */
const BADGE_SLOTS: ReadonlyArray<{ letter: string; emptyFor: DelegationEdgeKind }> = [
	{ letter: 'C', emptyFor: 'delegate' },
	{ letter: 'D', emptyFor: 'consult' },
];

/** What each kind lets the source do, as the verb of a sentence about the target. */
const ACCESS_VERBS: Record<DelegationEdgeKind, string> = {
	consult: 'consult',
	delegate: 'delegate to',
	both: 'consult and delegate to',
};

/**
 * One relationship as a sentence: "Alpha may consult Beta". `already` is for a
 * relationship named beside the one being edited: "Beta may already consult
 * Alpha". The tooltip, and the edge editor, say it with this one function.
 */
export function delegationAccessSentence(
	kind: DelegationEdgeKind,
	sourceName: string,
	targetName: string,
	options: { already?: boolean } = {}
): string {
	return `${sourceName} may ${options.already ? 'already ' : ''}${ACCESS_VERBS[kind]} ${targetName}`;
}

/**
 * The kind of an edge, or `null` for one with neither bit. `resolvePeerRoster`
 * never emits such a peer, so `null` is a guard and not a state to draw.
 */
export function delegationEdgeKind(
	access: Pick<DelegationGraphEdge, 'read' | 'write'>
): DelegationEdgeKind | null {
	if (access.read && access.write) return 'both';
	if (access.read) return 'consult';
	if (access.write) return 'delegate';
	return null;
}

/** The one stroke color of every edge. The bits are never told apart by color. */
export function delegationEdgeColor(theme: Theme): string {
	return theme.colors.textMain;
}

/**
 * The arrowhead of every edge, for the `markerEnd` of the reactflow edge. It is
 * painted with the line, so it fades with the line and needs no state of its own.
 */
export function delegationEdgeMarker(theme: Theme): EdgeMarker {
	return {
		type: MarkerType.ArrowClosed,
		color: delegationEdgeColor(theme),
		width: 16,
		height: 16,
	};
}

/**
 * How opaque an edge is. The two factors multiply, so a derived edge stays
 * fainter than an explicit one in every state, dimmed included.
 */
export function delegationEdgeOpacity(
	grant: DelegationGraphEdge['source'],
	emphasis?: DelegationEdgeEmphasis
): number {
	return (
		(grant === 'explicit' ? 1 : DERIVED_OPACITY) * (emphasis === 'dimmed' ? DIMMED_OPACITY : 1)
	);
}

/**
 * The tooltip of an edge, one line per entry: what the source may do, which
 * grant says so, and the peer description when the row has one. The names are
 * passed in, so the caller decides where they come from. Empty for an edge with
 * neither bit.
 */
export function describeDelegationEdge(
	edge: Pick<DelegationGraphEdge, 'read' | 'write' | 'source' | 'description'>,
	sourceName: string,
	targetName: string
): string[] {
	const kind = delegationEdgeKind(edge);
	if (!kind) return [];
	const lines = [
		delegationAccessSentence(kind, sourceName, targetName),
		edge.source === 'explicit'
			? `Named in the peer list of ${sourceName}`
			: `From the "${PEER_GRANT_LABELS[edge.source]}" grant of ${sourceName}`,
	];
	if (edge.description) lines.push(edge.description);
	return lines;
}

export interface DelegationEdgeBadgeProps {
	kind: DelegationEdgeKind;
	theme: Theme;
}

/** The two-slot badge. Its text reads `C`, `D` or `CD`. */
export function DelegationEdgeBadge({ kind, theme }: DelegationEdgeBadgeProps) {
	const { colors } = theme;
	return (
		<span
			data-testid="delegation-edge-badge"
			data-edge-kind={kind}
			role="img"
			aria-label={DELEGATION_EDGE_KIND_LABELS[kind]}
			style={{
				display: 'inline-flex',
				backgroundColor: colors.bgMain,
				border: `1px solid ${colors.border}`,
				borderRadius: 4,
				overflow: 'hidden',
				color: colors.textMain,
				fontSize: 9,
				fontWeight: 700,
				lineHeight: '12px',
			}}
		>
			{BADGE_SLOTS.map((slot, index) => {
				const lit = kind !== slot.emptyFor;
				return (
					<span
						key={slot.letter}
						data-slot={slot.letter}
						data-lit={lit}
						style={{
							width: 12,
							height: 12,
							textAlign: 'center',
							backgroundColor: lit ? colors.bgActivity : 'transparent',
							borderLeft: index > 0 ? `1px solid ${colors.border}` : undefined,
						}}
					>
						{lit ? slot.letter : null}
					</span>
				);
			})}
		</span>
	);
}

export const DelegationEdge = memo(function DelegationEdge({
	id,
	source,
	target,
	sourceX,
	sourceY,
	targetX,
	targetY,
	data,
	selected,
	markerEnd,
}: EdgeProps<DelegationEdgeData>) {
	// The node bodies the line runs between. A node object is replaced when it
	// moves or is measured, so each selector wakes this edge only for its own ends.
	const sourceNode = useStore(
		useCallback((state: ReactFlowState) => state.nodeInternals.get(source), [source])
	);
	const targetNode = useStore(
		useCallback((state: ReactFlowState) => state.nodeInternals.get(target), [target])
	);

	const sourceId = data?.edge.sourceId ?? source;
	const targetId = data?.edge.targetId ?? target;
	const sourceName = useSessionStore((store) => selectSessionById(sourceId)(store)?.name);
	const targetName = useSessionStore((store) => selectSessionById(targetId)(store)?.name);

	const kind = data ? delegationEdgeKind(data.edge) : null;
	if (!data || !kind) return null;
	const { edge, hasReverse, emphasis, onOpen, theme } = data;

	const { path, labelX, labelY } = graphEdgeGeometry(
		anchorOfNode(sourceNode, sourceX, sourceY),
		anchorOfNode(targetNode, targetX, targetY),
		hasReverse
	);

	const line = DELEGATION_EDGE_LINES[kind];
	const opacity = delegationEdgeOpacity(edge.source, emphasis);
	const raised = selected || emphasis === 'highlighted';
	// An agent can be deleted a render before the graph drops its edges.
	const sourceLabel = sourceName ?? removedAgentLabel(sourceId);
	const targetLabel = targetName ?? removedAgentLabel(targetId);
	const lines = describeDelegationEdge(edge, sourceLabel, targetLabel);

	const openAtPointer = (event: MouseEvent) => {
		// The canvas opens the line. See the file comment.
		event.stopPropagation();
		onOpen?.(edge, { x: event.clientX, y: event.clientY });
	};
	const openAtBadge = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		event.stopPropagation();
		const rect = event.currentTarget.getBoundingClientRect();
		onOpen?.(edge, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
	};

	return (
		<>
			{/* Glow underlay for a raised edge */}
			{raised && (
				<path
					data-testid="delegation-edge-glow"
					d={path}
					fill="none"
					style={{
						stroke: theme.colors.accent,
						strokeWidth: line.width + GLOW_EXTRA_WIDTH,
						strokeLinecap: 'round',
						opacity: 0.3,
						pointerEvents: 'none',
					}}
				/>
			)}
			<BaseEdge
				id={id}
				path={path}
				markerEnd={markerEnd}
				style={{
					stroke: delegationEdgeColor(theme),
					strokeWidth: raised ? line.width + RAISED_EXTRA_WIDTH : line.width,
					strokeDasharray: line.dash,
					opacity,
				}}
			/>

			<EdgeLabelRenderer>
				<div
					className="nodrag nopan"
					data-testid="delegation-edge-label"
					data-edge-id={id}
					data-edge-grant={edge.source}
					{...(onOpen
						? {
								role: 'button',
								tabIndex: 0,
								'aria-label': `Edit the edge from ${sourceLabel} to ${targetLabel}`,
								onClick: openAtPointer,
								onKeyDown: openAtBadge,
							}
						: {})}
					style={{
						position: 'absolute',
						transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
						pointerEvents: 'all',
						display: 'flex',
						cursor: onOpen ? 'pointer' : undefined,
						opacity,
					}}
				>
					<HoverTooltip
						theme={theme}
						maxWidth={TOOLTIP_MAX_WIDTH}
						label={lines.map((text, index) => (
							<span
								key={index}
								style={{
									display: 'block',
									color: index === 0 ? theme.colors.textMain : theme.colors.textDim,
								}}
							>
								{text}
							</span>
						))}
					>
						<DelegationEdgeBadge kind={kind} theme={theme} />
					</HoverTooltip>
				</div>
			</EdgeLabelRenderer>
		</>
	);
});

/** The `edgeTypes` of the Delegation Graph canvas. */
export const delegationEdgeTypes = {
	delegation: DelegationEdge,
};
