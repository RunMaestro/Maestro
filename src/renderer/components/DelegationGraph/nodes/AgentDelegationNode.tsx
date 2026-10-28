/**
 * AgentDelegationNode - one agent on the Delegation Graph.
 *
 * The visual grammar is `CuePipelineEditor/nodes/AgentNode.tsx`: a colored grip
 * strip, the name over a dim caption, a corner badge, and a handle per side.
 *
 * A node is in exactly one of four states, and each one is told apart by
 * SHAPE as well as by color, so the graph still reads on a theme with weak
 * contrast and for a user who cannot tell the colors apart:
 *
 *   | State    | Border | Opacity | Marker                                         |
 *   | -------- | ------ | ------- | ---------------------------------------------- |
 *   | in-scope | solid  | full    | the group's short pill                         |
 *   | spill    | dotted | dimmed  | an arrow and the group's FULL name             |
 *   | isolated | dashed | full    | a corner badge and a "No peers" line           |
 *   | placed   | dotted | full    | the spill marker and a "No edge yet" line      |
 *
 * `spill` and `placed` are the two halves of "outside this scope": an edge
 * reaches the first, and the user put the second on the canvas and has not
 * connected it. The first edge turns a placed node into a spill node.
 *
 * The node data holds an agent id and never a name. The name, the provider and
 * the group are read from the session store on every render, so a rename shows
 * at once and a stale name has nowhere to come from.
 */

import { memo, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { useShallow } from 'zustand/react/shallow';
import { ArrowUpRight, GripVertical, Unplug } from 'lucide-react';
import type { Theme } from '../../../types';
import type { DelegationGraphNode } from '../../../../shared/delegationGraph';
import { getAgentDisplayName } from '../../../../shared/agentMetadata';
import { readableTextOn } from '../../../../shared/colorContrast';
import { getAgentIcon } from '../../../constants/agentIcons';
import { selectSessionById, useSessionStore } from '../../../stores/sessionStore';
import { GroupPill } from '../../ui/GroupPill';
import {
	AGENT_DELEGATION_NODE_HEIGHT,
	AGENT_DELEGATION_NODE_MIN_WIDTH,
} from './agentDelegationNodeSize';

export {
	AGENT_DELEGATION_NODE_HEIGHT,
	AGENT_DELEGATION_NODE_MIN_WIDTH,
	estimateAgentDelegationNodeWidth,
} from './agentDelegationNodeSize';

/**
 * How a node is drawn. One value and not two flags, because the states exclude
 * each other: where the agent is (in the scope or outside it) and whether an
 * edge touches it give exactly four combinations.
 */
export type AgentDelegationNodeState = 'in-scope' | 'spill' | 'isolated' | 'placed';

export interface AgentDelegationNodeData {
	sessionId: string;
	state: AgentDelegationNodeState;
	theme: Theme;
}

/** How far a spill node is dimmed. A selected spill node is drawn at full opacity. */
export const AGENT_DELEGATION_SPILL_OPACITY = 0.55;

/** The group line of a spill agent that is in no group. */
const UNGROUPED = { name: 'Ungrouped' };

/** The border of each state. The legend draws its samples from the same table. */
export const AGENT_DELEGATION_NODE_BORDER_STYLE: Record<
	AgentDelegationNodeState,
	CSSProperties['borderStyle']
> = {
	'in-scope': 'solid',
	spill: 'dotted',
	isolated: 'dashed',
	placed: 'dotted',
};

/**
 * The name drawn for an agent that is gone. An agent can be deleted a render
 * before the graph drops its node and its edges, and both still need a name.
 */
export function removedAgentLabel(sessionId: string): string {
	return `Removed agent ${sessionId.slice(0, 8)}`;
}

/**
 * The state of one model node. `connectedIds` is `connectedAgentIds(model)`,
 * computed once for the graph and not once per node.
 */
export function agentDelegationNodeState(
	node: Pick<DelegationGraphNode, 'sessionId' | 'scope'>,
	connectedIds: ReadonlySet<string>
): AgentDelegationNodeState {
	const connected = connectedIds.has(node.sessionId);
	if (node.scope === 'spill') return connected ? 'spill' : 'placed';
	return connected ? 'in-scope' : 'isolated';
}

/**
 * A handle on one side of the node. While the graph is in View (`isConnectable`
 * is false) the handle is only an anchor for edges: it is drawn as nothing and
 * sits on the border, so an edge ends at the node and not at an invisible dot
 * beside it. In Edit it is the dot an edge is dragged from and dropped on.
 */
function handleStyle(
	side: Position,
	color: string,
	background: string,
	isConnectable: boolean
): CSSProperties {
	if (!isConnectable) {
		return {
			[side]: -1,
			width: 2,
			height: 2,
			minWidth: 0,
			minHeight: 0,
			border: 'none',
			opacity: 0,
			pointerEvents: 'none',
		};
	}
	return {
		[side]: -8,
		width: 16,
		height: 16,
		backgroundColor: color,
		border: `3px solid ${background}`,
		boxShadow: `0 0 0 2px ${color}`,
		zIndex: 10,
	};
}

export const AgentDelegationNode = memo(function AgentDelegationNode({
	data,
	selected,
	isConnectable,
	sourcePosition = Position.Bottom,
	targetPosition = Position.Top,
}: NodeProps<AgentDelegationNodeData>) {
	const { sessionId, state, theme } = data;
	const { colors } = theme;

	// Three plain fields, compared shallowly: a node must not re-render on every
	// streamed token of the agent it draws.
	const agent = useSessionStore(
		useShallow((store) => {
			const session = selectSessionById(sessionId)(store);
			return session
				? { name: session.name, toolType: session.toolType, groupId: session.groupId }
				: null;
		})
	);
	const groupId = agent?.groupId;
	const group = useSessionStore((store) =>
		groupId ? store.groups.find((candidate) => candidate.id === groupId) : undefined
	);

	const isSpill = state === 'spill';
	const isIsolated = state === 'isolated';
	const isPlaced = state === 'placed';
	// Outside the scope, with an edge or without one: the group is named in full.
	const isOutside = isSpill || isPlaced;

	// The agent can be deleted a render before the graph drops its node. Keep the
	// node whole for that render: an edge with no handle to land on throws.
	const name = agent?.name ?? removedAgentLabel(sessionId);
	const provider = agent ? getAgentDisplayName(agent.toolType) : '';

	const stateColor = isIsolated ? colors.warning : isOutside ? colors.border : colors.accent;
	const borderColor = selected ? colors.accent : isIsolated ? colors.warning : colors.border;
	const glowColor = selected ? colors.accent : stateColor;

	const summary = [
		name,
		provider,
		group?.name,
		isOutside ? 'outside this group' : undefined,
		isIsolated ? 'no peers' : undefined,
		isPlaced ? 'no edge yet' : undefined,
	]
		.filter(Boolean)
		.join(', ');

	return (
		<div
			data-testid="agent-delegation-node"
			data-node-state={state}
			title={summary}
			style={{
				minWidth: AGENT_DELEGATION_NODE_MIN_WIDTH,
				height: AGENT_DELEGATION_NODE_HEIGHT,
				width: 'max-content',
				borderRadius: 8,
				willChange: 'transform',
				backgroundColor: colors.bgMain,
				borderWidth: 2,
				borderStyle: AGENT_DELEGATION_NODE_BORDER_STYLE[state],
				borderColor,
				boxShadow: selected ? `0 4px 16px ${glowColor}30` : '0 2px 8px rgba(0,0,0,0.3)',
				opacity: isSpill && !selected ? AGENT_DELEGATION_SPILL_OPACITY : 1,
				display: 'flex',
				flexDirection: 'row',
				overflow: 'visible',
				cursor: 'default',
				transition: 'border-color 0.15s, box-shadow 0.15s, opacity 0.15s',
				position: 'relative',
			}}
		>
			{/* Drag handle */}
			<div
				className="drag-handle"
				style={{
					width: 32,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					cursor: 'grab',
					color: readableTextOn(colors.accentForeground, [stateColor]),
					flexShrink: 0,
					backgroundColor: stateColor,
					borderRadius: '6px 0 0 6px',
				}}
				title="Drag to move"
			>
				<GripVertical size={16} />
			</div>

			{/* Content */}
			<div
				style={{
					flex: 1,
					display: 'flex',
					flexDirection: 'column',
					justifyContent: 'center',
					padding: '8px 14px 8px 10px',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
					<span
						style={{
							color: colors.textMain,
							fontSize: 13,
							fontWeight: 600,
							whiteSpace: 'nowrap',
							flex: 1,
						}}
					>
						{name}
					</span>
					{!isOutside && group && (
						<GroupPill theme={theme} group={group} testId="agent-delegation-node-group" />
					)}
				</div>

				{agent && (
					<span
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 4,
							color: colors.textDim,
							fontSize: 11,
							marginTop: 2,
							whiteSpace: 'nowrap',
						}}
					>
						<span aria-hidden="true" data-testid="agent-delegation-node-glyph">
							{getAgentIcon(agent.toolType)}
						</span>
						{provider}
					</span>
				)}

				{isOutside && (
					<span
						data-testid="agent-delegation-node-spill-group"
						title="Outside this group"
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 3,
							color: colors.textDim,
							marginTop: 4,
						}}
					>
						<ArrowUpRight size={11} style={{ flexShrink: 0 }} />
						<GroupPill theme={theme} group={group ?? UNGROUPED} full />
					</span>
				)}

				{isIsolated && (
					<span
						style={{
							color: readableTextOn(colors.warning, [colors.bgMain]),
							fontSize: 10,
							fontWeight: 600,
							marginTop: 4,
							whiteSpace: 'nowrap',
						}}
					>
						No peers
					</span>
				)}

				{isPlaced && (
					<span
						data-testid="agent-delegation-node-placed"
						title="Placed on this graph. Draw an edge to or from it to keep it here"
						style={{
							color: colors.textDim,
							fontSize: 10,
							fontWeight: 600,
							marginTop: 4,
							whiteSpace: 'nowrap',
						}}
					>
						No edge yet
					</span>
				)}
			</div>

			{/* Isolated badge */}
			{isIsolated && (
				<div
					data-testid="agent-delegation-node-isolated"
					title="No agent can reach this one, and it can reach none"
					style={{
						position: 'absolute',
						top: -6,
						right: -6,
						width: 20,
						height: 20,
						borderRadius: '50%',
						backgroundColor: colors.warning,
						color: readableTextOn(colors.accentForeground, [colors.warning]),
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						border: `2px solid ${colors.bgMain}`,
					}}
				>
					<Unplug size={11} />
				</div>
			)}

			<Handle
				type="target"
				position={targetPosition}
				isConnectable={isConnectable}
				style={handleStyle(targetPosition, stateColor, colors.bgMain, isConnectable)}
			/>
			<Handle
				type="source"
				position={sourcePosition}
				isConnectable={isConnectable}
				style={handleStyle(sourcePosition, stateColor, colors.bgMain, isConnectable)}
			/>
		</div>
	);
});
