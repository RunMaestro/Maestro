/**
 * Tests for the Left Bar's drawn-row order, which Cmd+[ / Cmd+] walks.
 */
import { describe, it, expect } from 'vitest';
import {
	buildSidebarRowOrder,
	layoutGroupSections,
	layoutVirtualGroupSections,
	sidebarChildNavKey,
	sidebarNavKey,
	sidebarWorktreeChildren,
	sidebarWorktreesExpanded,
} from '../../../renderer/utils/sidebarRowOrder';
import { createMockSession } from '../../helpers/mockSession';
import type { Group, Session } from '../../../renderer/types';

const session = (id: string, overrides: Partial<Session> = {}): Session =>
	createMockSession({ id, name: id, ...overrides });

const group = (id: string, overrides: Partial<Group> = {}): Group =>
	({ id, name: id, collapsed: false, ...overrides }) as Group;

const NO_ATTENTION = { batchSessionIds: new Set<string>(), stuckOutageIds: new Set<string>() };

describe('nav keys', () => {
	it('match the computeSortedSessions navIndexMap keys', () => {
		expect(sidebarNavKey('bookmark', 'a')).toBe('bookmark:a');
		expect(sidebarNavKey('group', 'a', 'g')).toBe('group:g:a');
		expect(sidebarNavKey('group', 'a')).toBe('ungrouped:a');
		expect(sidebarNavKey('flat', 'a')).toBe('ungrouped:a');
		expect(sidebarChildNavKey('bookmark', 'c')).toBe('bookmark:wt:c');
		expect(sidebarChildNavKey('group', 'c', 'g')).toBe('group:g:wt:c');
		expect(sidebarChildNavKey('ungrouped', 'c')).toBe('ungrouped:wt:c');
	});
});

describe('worktree children', () => {
	const children = [session('a'), session('b', { state: 'busy' }), session('c')];

	it('draws every child when the unread filter is off', () => {
		const drawn = sidebarWorktreeChildren(children, {
			showUnreadAgentsOnly: false,
			activeSessionId: null,
			attentionCtx: NO_ATTENTION,
		});
		expect(drawn.map((s) => s.id)).toEqual(['a', 'b', 'c']);
	});

	it('draws only children needing attention, plus the active one, under the unread filter', () => {
		const drawn = sidebarWorktreeChildren(children, {
			showUnreadAgentsOnly: true,
			activeSessionId: 'c',
			attentionCtx: NO_ATTENTION,
		});
		expect(drawn.map((s) => s.id)).toEqual(['b', 'c']);
	});

	it('forces worktrees open under the unread filter', () => {
		const parent = session('p', { worktreesExpanded: false });
		expect(sidebarWorktreesExpanded(parent, false)).toBe(false);
		expect(sidebarWorktreesExpanded(parent, true)).toBe(true);
		expect(sidebarWorktreesExpanded(session('q'), false)).toBe(true);
	});
});

describe('layoutGroupSections', () => {
	const ctx = (overrides: Partial<Parameters<typeof layoutGroupSections>[1]> = {}) => ({
		sessionsByGroupId: new Map<string, Session[]>(),
		groupById: new Map<string, Group>(),
		childrenByParentId: new Map<string, Group[]>(),
		groupsPlusEnabled: false,
		showUnreadAgentsOnly: false,
		...overrides,
	});

	it('keeps a collapsed group collapsed with the unread filter on or off', () => {
		const g = group('g', { collapsed: true });
		const sessionsByGroupId = new Map([['g', [session('a')]]]);
		expect(layoutGroupSections([g], ctx({ sessionsByGroupId }))[0].expanded).toBe(false);
		expect(
			layoutGroupSections([g], ctx({ sessionsByGroupId, showUnreadAgentsOnly: true }))[0].expanded
		).toBe(false);
	});

	it('drops a group the unread filter emptied', () => {
		const layouts = layoutGroupSections([group('g')], ctx({ showUnreadAgentsOnly: true }));
		expect(layouts).toEqual([]);
	});

	it.each([false, true])(
		'drops a Groups+ subgroup while its parent is collapsed (unread filter %s)',
		(showUnreadAgentsOnly) => {
			const parent = group('parent', { collapsed: true });
			const child = group('child', { parentGroupId: 'parent' });
			const layouts = layoutGroupSections(
				[parent, child],
				ctx({
					groupsPlusEnabled: true,
					showUnreadAgentsOnly,
					sessionsByGroupId: new Map([['child', [session('a')]]]),
					groupById: new Map([
						['parent', parent],
						['child', child],
					]),
					childrenByParentId: new Map([['parent', [child]]]),
				})
			);
			expect(layouts.map((l) => [l.group.id, l.expanded])).toEqual([['parent', false]]);
		}
	);
});

describe('layoutVirtualGroupSections', () => {
	it('orders roots before their children and skips children of a collapsed root', () => {
		const model = {
			groups: [
				{ id: 'child', name: 'Child', parentGroupId: 'root' },
				{ id: 'root', name: 'Root' },
				{ id: 'other', name: 'Other' },
			],
			assignments: { a: 'root', b: 'child', c: 'other' },
		};
		const sessions = [session('a'), session('b'), session('c')];

		const open = layoutVirtualGroupSections(model, {}, sessions);
		expect(open.map((l) => l.group.id)).toEqual(['root', 'child', 'other']);
		expect(open[1].sessions.map((s) => s.id)).toEqual(['b']);

		const collapsed = layoutVirtualGroupSections(model, { root: true }, sessions);
		expect(collapsed.map((l) => [l.group.id, l.collapsed])).toEqual([
			['root', true],
			['other', false],
		]);
	});
});

describe('buildSidebarRowOrder', () => {
	it('flattens starred, sections with their drawn worktree children, then group chats', () => {
		const parent = session('parent');
		const rows = buildSidebarRowOrder({
			starredItems: [
				{
					kind: 'open',
					key: 'open:parent:t1',
					displayName: 'Star',
					agentName: 'parent',
					parentSessionId: 'parent',
					tabId: 't1',
				} as never,
			],
			sections: [
				{ variant: 'bookmark', sessions: [parent] },
				{ variant: 'group', groupId: 'g', sessions: [parent, session('solo')] },
			],
			drawnWorktreeChildren: (p) => (p.id === 'parent' ? [session('wt')] : []),
			groupChats: [{ id: 'gc' }],
		});
		expect(rows).toEqual([
			{ type: 'starred', id: 'parent', starredKey: 'open:parent:t1' },
			{ type: 'session', id: 'parent', navKey: 'bookmark:parent' },
			{ type: 'session', id: 'wt', navKey: 'bookmark:wt:wt' },
			{ type: 'session', id: 'parent', navKey: 'group:g:parent' },
			{ type: 'session', id: 'wt', navKey: 'group:g:wt:wt' },
			{ type: 'session', id: 'solo', navKey: 'group:g:solo' },
			{ type: 'groupChat', id: 'gc' },
		]);
	});

	it('skips a worktree child listed as a section member (it is drawn under its parent)', () => {
		const rows = buildSidebarRowOrder({
			starredItems: [],
			sections: [{ variant: 'flat', sessions: [session('wt', { parentSessionId: 'x' })] }],
			drawnWorktreeChildren: () => [],
			groupChats: [],
		});
		expect(rows).toEqual([]);
	});
});
