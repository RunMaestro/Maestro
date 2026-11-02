/**
 * DelegationGraphPlacement - putting an agent on the Delegation Graph that is
 * not drawn there.
 *
 * Only a group's graph leaves agents out: it draws the group's agents and the
 * agents an edge joins to them. An agent outside the group that no edge reaches
 * has no node, so there is nothing to draw an edge to. Three pieces fix that,
 * all of them offered in Edit only:
 *
 *   - `DelegationAddAgentSelect`: the "Add agent" control of the toolbar. It
 *     lists the agents with no node, under the group each one is in.
 *   - `DelegationDropOverlay`: drawn while an agent row is dragged over the
 *     canvas, to say what a drop does.
 *   - `DelegationPlacedNotice`: stays while an added agent has no edge.
 *
 * PLACING IS A LAYOUT GESTURE. It writes no peer row, and it does NOT move the
 * agent into the group: that would change what the agent can reach as a side
 * effect of arranging a picture. The agent is on the canvas for as long as the
 * graph is open on that scope, and an edge is what keeps it there afterwards.
 * `placedAgentHint` is the one home of the sentence that says so, and both the
 * overlay and the notice read it.
 */

import { X } from 'lucide-react';
import type { Group, Theme } from '../../types';
import type { DelegationOffGraphAgent } from '../../../shared/delegationGraph';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import { HeaderActionButton } from '../ui/HeaderActionButton';

/** The agents of one group that the "Add agent" control offers. */
export interface DelegationAddAgentSection {
	key: string;
	label: string;
	agents: DelegationOffGraphAgent[];
}

type GroupLabelInput = Pick<Group, 'name' | 'emoji'>;

const UNGROUPED_KEY = 'ungrouped';
const UNGROUPED_LABEL = 'Ungrouped';

/** A group as one line of a picker: its emoji, when it has one, and its name. */
export function delegationGroupLabel(group: GroupLabelInput): string {
	return group.emoji ? `${group.emoji} ${group.name}` : group.name;
}

/**
 * The groups a graph can be opened on, in the order every picker lists them:
 * the scope select of the graph and the command palette. Every group is one,
 * a hidden group and a worktree group included.
 */
export function delegationScopeGroups<T extends GroupLabelInput>(groups: readonly T[]): T[] {
	return [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
}

/**
 * What a user must know at the moment an agent lands on a group's graph. Said
 * before the drop (the overlay) and after it (the notice).
 */
export function placedAgentHint(groupName: string | undefined): string {
	const group = groupName ?? 'this group';
	return `Adding an agent here does not move it into ${group}. Draw an edge between it and an agent of the group, and it stays on this graph as an agent outside the group. With no edge, it is gone from the graph when you close the graph or change the scope.`;
}

/**
 * Cut the agents that can be added into one section per group, in the order
 * `groups` is in, with the agents in no group last. An agent whose group is
 * gone is listed with them. `agents` keeps its own order inside a section.
 */
export function sectionAgentsForAdding(
	agents: readonly DelegationOffGraphAgent[],
	groups: ReadonlyArray<Pick<Group, 'id'> & GroupLabelInput>
): DelegationAddAgentSection[] {
	const groupIds = new Set(groups.map((group) => group.id));
	const byGroup = new Map<string, DelegationOffGraphAgent[]>();
	for (const agent of agents) {
		const key = agent.groupId && groupIds.has(agent.groupId) ? agent.groupId : UNGROUPED_KEY;
		byGroup.set(key, [...(byGroup.get(key) ?? []), agent]);
	}

	const sections: DelegationAddAgentSection[] = [];
	for (const group of groups) {
		const inGroup = byGroup.get(group.id);
		if (inGroup) {
			sections.push({ key: group.id, label: delegationGroupLabel(group), agents: inGroup });
		}
	}
	const ungrouped = byGroup.get(UNGROUPED_KEY);
	if (ungrouped) {
		sections.push({ key: UNGROUPED_KEY, label: UNGROUPED_LABEL, agents: ungrouped });
	}
	return sections;
}

export interface DelegationAddAgentSelectProps {
	theme: Theme;
	sections: readonly DelegationAddAgentSection[];
	/** Why nothing can be added right now. The control is disabled while it is set. */
	disabledReason?: string;
	onAdd: (sessionId: string) => void;
}

/**
 * The "Add agent" control. A native select that always reads "Add agent...":
 * picking an agent adds it, and the control goes back to its label.
 */
export function DelegationAddAgentSelect({
	theme,
	sections,
	disabledReason,
	onAdd,
}: DelegationAddAgentSelectProps) {
	const { colors } = theme;
	return (
		<select
			value=""
			onChange={(event) => {
				if (event.target.value) onAdd(event.target.value);
			}}
			disabled={disabledReason !== undefined}
			aria-label="Add agent"
			title={
				disabledReason ??
				'Put an agent that is not drawn on this graph, so an edge can be drawn to it. The agent is not moved into the group'
			}
			data-testid="delegation-graph-add-agent"
			className="px-3 py-1.5 rounded text-sm cursor-pointer outline-none shrink-0 max-w-[160px] disabled:opacity-50 disabled:cursor-not-allowed"
			style={{
				backgroundColor: `${colors.accent}10`,
				color: colors.textDim,
			}}
		>
			<option value="">Add agent...</option>
			{sections.map((section) => (
				<optgroup key={section.key} label={section.label}>
					{section.agents.map((agent) => (
						<option key={agent.sessionId} value={agent.sessionId}>
							{agent.name}
						</option>
					))}
				</optgroup>
			))}
		</select>
	);
}

export interface DelegationDropOverlayProps {
	theme: Theme;
	/** The agent in the user's hand. */
	agentName: string;
	/** The agent has a node already: a drop selects it and adds nothing. */
	alreadyDrawn: boolean;
	/** The group whose graph this is. Absent on the graph of every agent. */
	groupName?: string;
}

/**
 * Drawn over the canvas while an agent is dragged across it. It takes no
 * pointer event, so the drop still lands on the canvas under it.
 */
export function DelegationDropOverlay({
	theme,
	agentName,
	alreadyDrawn,
	groupName,
}: DelegationDropOverlayProps) {
	const { colors } = theme;
	return (
		<div
			data-testid="delegation-graph-drop-overlay"
			data-already-drawn={String(alreadyDrawn)}
			className="absolute inset-0 pointer-events-none flex items-center justify-center"
			style={{
				zIndex: 6,
				border: `2px dashed ${colors.accent}`,
				backgroundColor: `${colors.accent}14`,
			}}
		>
			<div
				role="status"
				className="rounded-lg shadow-lg px-3 py-2 text-xs space-y-1"
				style={{
					maxWidth: 420,
					backgroundColor: `${colors.bgActivity}f5`,
					border: `1px solid ${colors.accent}`,
					color: colors.textMain,
				}}
			>
				<p className="font-medium">
					{alreadyDrawn ? `${agentName} is already on this graph` : `Drop to add ${agentName}`}
				</p>
				<p style={{ color: colors.textDim }}>
					{alreadyDrawn ? 'Drop to select it.' : placedAgentHint(groupName)}
				</p>
			</div>
		</div>
	);
}

export interface DelegationPlacedNoticeProps {
	theme: Theme;
	/** The agents on the graph that are outside the scope and have no edge. */
	agentNames: readonly string[];
	groupName?: string;
	/** Take those agents off the graph again. Nothing was written for them. */
	onClear: () => void;
}

/** Says what an added agent is, and is not, for as long as it has no edge. */
export function DelegationPlacedNotice({
	theme,
	agentNames,
	groupName,
	onClear,
}: DelegationPlacedNoticeProps) {
	const { colors } = theme;
	return (
		<div
			data-testid="delegation-graph-placed"
			role="status"
			className="absolute top-3 left-1/2 -translate-x-1/2 rounded-lg shadow-lg px-3 py-2 text-xs space-y-2 select-text"
			style={{
				maxWidth: 440,
				zIndex: 5,
				backgroundColor: `${colors.bgActivity}f5`,
				border: `1px solid ${colors.accent}`,
				color: colors.textMain,
			}}
		>
			<p>
				<span className="font-medium">{agentNames.join(', ')}</span>{' '}
				{agentNames.length === 1 ? 'has' : 'have'} no edge yet.
			</p>
			<p style={{ color: colors.textDim }}>{placedAgentHint(groupName)}</p>
			<HeaderActionButton
				theme={theme}
				variant="ghost"
				onClick={onClear}
				icon={<X />}
				title="Remove from this graph every agent that was added and has no edge. No agent is changed"
				testId="delegation-graph-placed-clear"
			>
				Take off the graph
			</HeaderActionButton>
		</div>
	);
}
