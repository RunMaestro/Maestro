/**
 * The Left Bar's agent tree, derived from the store files.
 *
 * Pure: no I/O and no view state. A client hands in the agents and groups it
 * read (`agentsOf`, `groupsOf`) and gets back the sections the desktop's Left
 * Bar draws, in the order it draws them. Collapse state is a view concern and
 * stays with the client; `GroupRecord.collapsed` is only the desktop's saved
 * default for it.
 *
 * Mirrors `useSessionCategories` (`src/renderer/hooks/session/`):
 *   - a worktree child (`parentSessionId`) is drawn under its parent, never on
 *     its own, and the pinned Pianola manager has its own section, so neither
 *     is a top-level row here;
 *   - names sort with `compareNamesIgnoringEmojis`, so "🍎 Apple" files under A;
 *   - a bookmarked agent is listed in Bookmarks AND still in its group;
 *   - an agent whose `groupId` names no existing group is ungrouped.
 */

import { compareNamesIgnoringEmojis } from '../../emojiUtils';
import type { AgentRecord, GroupRecord } from './records';

/** One top-level row of a section: an agent and the worktree agents under it. */
export interface AgentTreeNode {
	agent: AgentRecord;
	/** Worktree children, sorted by name. */
	children: AgentRecord[];
}

export type AgentTreeSectionKind = 'bookmarks' | 'group' | 'ungrouped';

export interface AgentTreeSection {
	/** Stable across reads: `bookmarks`, `ungrouped`, or `group:<id>`. */
	key: string;
	kind: AgentTreeSectionKind;
	title: string;
	/** Present for a group section that has one. */
	emoji?: string;
	/** Present for a group section: the group's id. */
	groupId?: string;
	/** The group's own saved collapse state; false for the other kinds. */
	collapsedByDefault: boolean;
	nodes: AgentTreeNode[];
}

export const BOOKMARKS_SECTION_KEY = 'bookmarks';
export const UNGROUPED_SECTION_KEY = 'ungrouped';

export function groupSectionKey(groupId: string): string {
	return `group:${groupId}`;
}

function byName(a: AgentRecord, b: AgentRecord): number {
	return compareNamesIgnoringEmojis(a.name, b.name);
}

/**
 * Does any tab the user can see carry the unread mark? A hidden consult tab is
 * answered in the background and has no chip, so a mark on one could never be
 * cleared: it never counts (same rule as `hasUnreadVisibleTab` on the desktop).
 */
export function agentHasUnread(agent: AgentRecord): boolean {
	return (agent.aiTabs ?? []).some((tab) => tab?.hasUnread === true && tab.hidden !== true);
}

/**
 * Section order, as the Left Bar draws it: Bookmarks (when there are any), the
 * groups by name, then Ungrouped (when there are any). An empty group is kept,
 * because a group the user made is still theirs to see.
 */
export function buildAgentTree(
	agents: readonly AgentRecord[],
	groups: readonly GroupRecord[]
): AgentTreeSection[] {
	const childrenByParent = new Map<string, AgentRecord[]>();
	const topLevel: AgentRecord[] = [];
	for (const agent of agents) {
		if (agent.isPianola === true) continue;
		if (agent.parentSessionId) {
			const siblings = childrenByParent.get(agent.parentSessionId);
			if (siblings) siblings.push(agent);
			else childrenByParent.set(agent.parentSessionId, [agent]);
		} else {
			topLevel.push(agent);
		}
	}

	const toNode = (agent: AgentRecord): AgentTreeNode => ({
		agent,
		children: [...(childrenByParent.get(agent.id) ?? [])].sort(byName),
	});

	const groupIds = new Set(groups.map((group) => group.id));
	const bookmarked: AgentRecord[] = [];
	const ungrouped: AgentRecord[] = [];
	const byGroup = new Map<string, AgentRecord[]>();
	for (const agent of topLevel) {
		if (agent.bookmarked === true) bookmarked.push(agent);
		if (agent.groupId && groupIds.has(agent.groupId)) {
			const members = byGroup.get(agent.groupId);
			if (members) members.push(agent);
			else byGroup.set(agent.groupId, [agent]);
		} else {
			ungrouped.push(agent);
		}
	}

	const sections: AgentTreeSection[] = [];
	if (bookmarked.length > 0) {
		sections.push({
			key: BOOKMARKS_SECTION_KEY,
			kind: 'bookmarks',
			title: 'Bookmarks',
			collapsedByDefault: false,
			nodes: bookmarked.sort(byName).map(toNode),
		});
	}
	for (const group of [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name))) {
		sections.push({
			key: groupSectionKey(group.id),
			kind: 'group',
			title: group.name,
			...(group.emoji ? { emoji: group.emoji } : {}),
			groupId: group.id,
			collapsedByDefault: group.collapsed === true,
			nodes: (byGroup.get(group.id) ?? []).sort(byName).map(toNode),
		});
	}
	if (ungrouped.length > 0) {
		sections.push({
			key: UNGROUPED_SECTION_KEY,
			kind: 'ungrouped',
			title: 'Ungrouped',
			collapsedByDefault: false,
			nodes: ungrouped.sort(byName).map(toNode),
		});
	}
	return sections;
}
