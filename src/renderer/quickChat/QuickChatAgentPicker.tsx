/**
 * QuickChatAgentPicker - choose the agent a Quick Chat talks to. A
 * QuickChatPicker over the agents, in the Left Bar's order the engine sends;
 * an agent's group and provider match too, so "codex" or a group name narrows
 * the list even when no agent is named after it.
 */

import { useMemo } from 'react';
import type { QuickChatAgentOption } from '../../shared/quickChat';
import {
	QuickChatPicker,
	filterQuickChatPickerItems,
	matchQuickChatPickerItem,
	type QuickChatPickerItem,
} from './QuickChatPicker';
import type { Theme } from '../types';

interface QuickChatAgentPickerProps {
	theme: Theme;
	agents: QuickChatAgentOption[];
	/** The agent the chat is on now, highlighted and selected first. */
	currentAgentId: string | null;
	onPick: (agentId: string) => void;
	/** Close without picking. */
	onClose: () => void;
}

interface FilteredAgent {
	agent: QuickChatAgentOption;
	nameIndices: Set<number>;
	score: number;
}

function agentItem(agent: QuickChatAgentOption): QuickChatPickerItem {
	return {
		id: agent.id,
		name: agent.name,
		detail: [agent.groupName, agent.provider].filter(Boolean).join(' - ') || undefined,
		extras: [agent.groupName, agent.provider],
	};
}

/** Match one agent against the query; a name hit outranks a group or provider hit. */
export function matchQuickChatAgent(
	agent: QuickChatAgentOption,
	query: string
): FilteredAgent | null {
	const hit = matchQuickChatPickerItem(agentItem(agent), query);
	return hit ? { agent, nameIndices: hit.nameIndices, score: hit.score } : null;
}

/** Filter and order the agents for a query: given order with none, best match first with one. */
export function filterQuickChatAgents(
	agents: QuickChatAgentOption[],
	query: string
): FilteredAgent[] {
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	return filterQuickChatPickerItems(agents.map(agentItem), query).map((hit) => ({
		agent: byId.get(hit.item.id)!,
		nameIndices: hit.nameIndices,
		score: hit.score,
	}));
}

export function QuickChatAgentPicker({
	theme,
	agents,
	currentAgentId,
	onPick,
	onClose,
}: QuickChatAgentPickerProps) {
	const items = useMemo(() => agents.map(agentItem), [agents]);
	return (
		<QuickChatPicker
			theme={theme}
			items={items}
			currentId={currentAgentId}
			onPick={onPick}
			onClose={onClose}
			placeholder="Switch agent..."
			listLabel="Agents"
			emptyText="No agents to chat with"
			noMatchText={(query) => `No agent matches "${query}"`}
			testIdPrefix="quick-chat-agent"
		/>
	);
}
