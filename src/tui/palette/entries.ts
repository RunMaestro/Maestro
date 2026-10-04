/**
 * What the command palette lists: every action in the keymap, then every agent,
 * then every visible tab. The action rows come straight from `KEYMAP`, so a
 * binding added there is in the palette without further work.
 */

import {
	getAgentDisplayName,
	getTabDisplayName,
	visibleAiTabsOf,
	type AgentRecord,
} from '../../shared/maestro-lib';
import { KEYMAP, formatBindingKeys, type Binding, type KeyAction } from '../keymap';

export type PaletteTarget =
	| { kind: 'action'; action: KeyAction }
	| { kind: 'agent'; agentId: string }
	| { kind: 'tab'; agentId: string; tabId: string };

export interface PaletteEntry {
	/** Unique across kinds; the list keys on it. */
	id: string;
	target: PaletteTarget;
	/** The text the query is matched against and the row shows. */
	label: string;
	/** Dim text after the label: the keys of an action, the provider of an agent. */
	detail: string;
}

export function buildPaletteEntries(
	agents: readonly AgentRecord[],
	keymap: readonly Binding[] = KEYMAP
): PaletteEntry[] {
	const entries: PaletteEntry[] = keymap.map((binding) => ({
		id: `action:${binding.action}`,
		target: { kind: 'action', action: binding.action },
		label: binding.description,
		detail: formatBindingKeys(binding),
	}));
	// A bookmarked agent can reach us twice; one row each is enough.
	const seen = new Set<string>();
	for (const agent of agents) {
		if (seen.has(agent.id)) continue;
		seen.add(agent.id);
		entries.push({
			id: `agent:${agent.id}`,
			target: { kind: 'agent', agentId: agent.id },
			label: agent.name,
			detail: getAgentDisplayName(agent.toolType),
		});
	}
	seen.clear();
	for (const agent of agents) {
		if (seen.has(agent.id)) continue;
		seen.add(agent.id);
		for (const tab of visibleAiTabsOf(agent)) {
			entries.push({
				id: `tab:${agent.id}:${tab.id}`,
				target: { kind: 'tab', agentId: agent.id, tabId: tab.id },
				label: `${agent.name} / ${getTabDisplayName(tab)}`,
				detail: 'tab',
			});
		}
	}
	return entries;
}
