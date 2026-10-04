import { describe, it, expect } from 'vitest';
import {
	agentHasUnread,
	buildAgentTree,
	groupSectionKey,
	type AgentTreeSection,
} from '../agent-tree';
import type { AgentRecord, GroupRecord } from '../records';

function agent(id: string, name: string, extra: Partial<AgentRecord> = {}): AgentRecord {
	return { id, name, toolType: 'claude-code', ...extra };
}

const GROUPS: GroupRecord[] = [
	{ id: 'g-web', name: 'Web', emoji: '🌐', collapsed: true },
	{ id: 'g-core', name: '🎼 Core', emoji: '🎼', collapsed: false },
	{ id: 'g-empty', name: 'Empty' },
];

const names = (section: AgentTreeSection | undefined) =>
	section?.nodes.map((node) => node.agent.name);

describe('buildAgentTree', () => {
	it('orders sections as bookmarks, groups by name, then ungrouped', () => {
		const sections = buildAgentTree(
			[
				agent('a', 'Alpha', { groupId: 'g-core', bookmarked: true }),
				agent('b', 'Beta', { groupId: 'g-web' }),
				agent('c', 'Gamma'),
			],
			GROUPS
		);
		expect(sections.map((section) => section.key)).toEqual([
			'bookmarks',
			groupSectionKey('g-core'),
			groupSectionKey('g-empty'),
			groupSectionKey('g-web'),
			'ungrouped',
		]);
	});

	it('sorts names ignoring a leading emoji and lists a bookmarked agent in its group too', () => {
		const sections = buildAgentTree(
			[
				agent('z', '🍌 Zulu', { groupId: 'g-core' }),
				agent('a', '🎉 Alpha', { groupId: 'g-core', bookmarked: true }),
				agent('m', 'Mike', { groupId: 'g-core' }),
			],
			GROUPS
		);
		const core = sections.find((section) => section.groupId === 'g-core');
		expect(names(core)).toEqual(['🎉 Alpha', 'Mike', '🍌 Zulu']);
		expect(names(sections.find((section) => section.kind === 'bookmarks'))).toEqual(['🎉 Alpha']);
	});

	it('draws a worktree child under its parent and never as its own row', () => {
		const sections = buildAgentTree(
			[
				agent('p', 'Parent'),
				agent('w2', 'wt-b', { parentSessionId: 'p', groupId: 'g-core' }),
				agent('w1', 'wt-a', { parentSessionId: 'p' }),
			],
			GROUPS
		);
		const ungrouped = sections.find((section) => section.kind === 'ungrouped');
		expect(ungrouped?.nodes).toHaveLength(1);
		expect(ungrouped?.nodes[0].children.map((child) => child.name)).toEqual(['wt-a', 'wt-b']);
		expect(names(sections.find((section) => section.groupId === 'g-core'))).toEqual([]);
	});

	it('skips the pinned Pianola agent and treats an unknown group id as ungrouped', () => {
		const sections = buildAgentTree(
			[
				agent('pi', 'Pianola', { isPianola: true }),
				agent('x', 'Stray', { groupId: 'deleted-group' }),
			],
			GROUPS
		);
		expect(names(sections.find((section) => section.kind === 'ungrouped'))).toEqual(['Stray']);
		expect(sections.flatMap((section) => section.nodes.map((n) => n.agent.id))).toEqual(['x']);
	});

	it('keeps empty groups, carries the saved collapse default, and omits empty bookmarks', () => {
		const sections = buildAgentTree([], GROUPS);
		expect(sections.map((section) => section.kind)).toEqual(['group', 'group', 'group']);
		expect(sections.find((section) => section.groupId === 'g-web')?.collapsedByDefault).toBe(true);
		expect(sections.find((section) => section.groupId === 'g-core')?.emoji).toBe('🎼');
	});

	it('hands back the stored agent objects, unknown keys intact', () => {
		const stored = agent('a', 'Alpha', { rcOnly: { keep: true } });
		const [section] = buildAgentTree([stored], []);
		expect(section.nodes[0].agent).toBe(stored);
	});
});

describe('agentHasUnread', () => {
	it('counts a visible unread tab and ignores a hidden consult tab', () => {
		expect(agentHasUnread(agent('a', 'A', { aiTabs: [{ id: 't', hasUnread: true }] }))).toBe(true);
		expect(
			agentHasUnread(agent('a', 'A', { aiTabs: [{ id: 't', hasUnread: true, hidden: true }] }))
		).toBe(false);
		expect(agentHasUnread(agent('a', 'A'))).toBe(false);
	});
});
