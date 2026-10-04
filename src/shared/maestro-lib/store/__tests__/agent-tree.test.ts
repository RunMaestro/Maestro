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

describe('Parity: agent tree order, group membership, and tab list', () => {
	/**
	 * M0 exit criterion: the TUI's agent tree order, group membership, and tab
	 * list derived from the same fixture files match what the desktop would derive.
	 */
	it('builds the same agent tree as the desktop from a comprehensive fixture', () => {
		const agents: AgentRecord[] = [
			// Core group: bookmarked, provider badges, multiple tabs, unread
			agent('a-maestro', 'Maestro', {
				toolType: 'claude-code',
				groupId: 'g-core',
				bookmarked: true,
				state: 'busy',
				customModel: 'opus',
				aiTabs: [
					{ id: 't1', name: 'lib-audit', hasUnread: true },
					{ id: 't2', agentSessionId: '8535e0e3-aaaa-bbbb-cccc-dddddddddddd' },
				],
			}),
			agent('a-cue', 'Cue', {
				toolType: 'codex',
				groupId: 'g-core',
				state: 'error',
				aiTabs: [{ id: 't3', agentSessionId: 'abc-def' }],
			}),
			// Web group (collapsed): different provider
			agent('a-web', 'Pedsidian', {
				toolType: 'opencode',
				groupId: 'g-web',
				aiTabs: [
					{ id: 't4', name: 'docs' },
					{ id: 't5', name: 'draft', hasUnread: false },
				],
			}),
			// Ungrouped: no group id
			agent('a-scratch', 'Scratch', {
				toolType: 'claude-code',
				aiTabs: [{ id: 't6', agentSessionId: 'xyz-123' }],
			}),
			// Worktree children: appear under parent, not as top-level rows
			agent('a-wt-a', 'wt-main', {
				toolType: 'claude-code',
				parentSessionId: 'a-maestro',
				worktreeBranch: 'main',
			}),
			agent('a-wt-b', 'wt-feature', {
				toolType: 'claude-code',
				parentSessionId: 'a-maestro',
				worktreeBranch: 'feature/tui',
			}),
			// Pianola (internal): should be skipped
			agent('a-piano', 'Pianola Manager', {
				toolType: 'terminal',
				isPianola: true,
			}),
			// Agent with unknown group: should be ungrouped
			agent('a-unknown-group', 'Orphan', {
				toolType: 'claude-code',
				groupId: 'deleted-group-id',
			}),
		];

		const groups: GroupRecord[] = [
			{ id: 'g-core', name: 'Core', emoji: '🎼', collapsed: false },
			{ id: 'g-web', name: 'Web', emoji: '🌐', collapsed: true },
			{ id: 'g-empty', name: 'Empty' }, // No emoji, collapsed undefined
		];

		const sections = buildAgentTree(agents, groups);

		// 1. Section order: bookmarks, groups by name, ungrouped
		expect(sections.map((s) => s.key)).toEqual([
			'bookmarks',
			groupSectionKey('g-core'),
			groupSectionKey('g-empty'),
			groupSectionKey('g-web'),
			'ungrouped',
		]);

		// 2. Bookmarks section: contains the bookmarked agent
		const bookmarks = sections.find((s) => s.kind === 'bookmarks');
		expect(bookmarks?.nodes.map((n) => n.agent.name)).toEqual(['Maestro']);

		// 3. Core group: agents sorted by name (ignoring emoji in Core)
		const core = sections.find((s) => s.groupId === 'g-core');
		expect(core?.kind).toBe('group');
		expect(core?.title).toBe('Core');
		expect(core?.emoji).toBe('🎼');
		expect(core?.collapsedByDefault).toBe(false);
		expect(core?.nodes.map((n) => n.agent.name)).toEqual(['Cue', 'Maestro']);

		// 4. Maestro's worktree children appear under it
		const maestroNode = core?.nodes.find((n) => n.agent.name === 'Maestro');
		expect(maestroNode?.children.map((c) => c.name)).toEqual(['wt-feature', 'wt-main']);

		// 5. Empty group: kept even with no members
		const empty = sections.find((s) => s.groupId === 'g-empty');
		expect(empty?.kind).toBe('group');
		expect(empty?.title).toBe('Empty');
		expect(empty?.nodes).toHaveLength(0);
		expect(empty?.collapsedByDefault).toBe(false); // undefined becomes false

		// 6. Web group: saved collapse state and emoji
		const web = sections.find((s) => s.groupId === 'g-web');
		expect(web?.collapsedByDefault).toBe(true);
		expect(web?.emoji).toBe('🌐');
		expect(web?.nodes.map((n) => n.agent.name)).toEqual(['Pedsidian']);

		// 7. Ungrouped section: orphaned agents and unknown-group agent
		const ungrouped = sections.find((s) => s.kind === 'ungrouped');
		expect(ungrouped?.nodes.map((n) => n.agent.name)).toEqual(['Orphan', 'Scratch']);

		// 8. Tab list: verify tab names and counts
		expect(maestroNode?.agent.aiTabs).toBeDefined();
		expect(maestroNode?.agent.aiTabs).toHaveLength(2);
		expect(maestroNode?.agent.aiTabs?.[0].name).toBe('lib-audit');
		expect(maestroNode?.agent.aiTabs?.[0].hasUnread).toBe(true);
		expect(maestroNode?.agent.aiTabs?.[1].agentSessionId).toBe(
			'8535e0e3-aaaa-bbbb-cccc-dddddddddddd'
		);

		// 9. Pianola is skipped entirely
		const allAgents = sections.flatMap((s) => s.nodes.map((n) => n.agent.id));
		expect(allAgents).not.toContain('a-piano');

		// 10. Verify agent objects are stored as-is, preserving unknown fields
		const stored = agent('test', 'Test', { rcOnly: { custom: 'field' } });
		const [firstSection] = buildAgentTree([stored], []);
		expect(firstSection.nodes[0].agent).toBe(stored);
		expect((firstSection.nodes[0].agent as unknown as Record<string, unknown>).rcOnly).toEqual({
			custom: 'field',
		});
	});
});
