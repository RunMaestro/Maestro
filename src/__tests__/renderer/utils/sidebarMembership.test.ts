import { describe, it, expect } from 'vitest';
import {
	sessionMatchesFilter,
	passesUnreadFilter,
	collectHiddenGroupIds,
	resolveHiddenGroupIds,
	passesHiddenGroupFilter,
} from '../../../renderer/utils/sidebarMembership';
import { createMockSession } from '../../helpers/mockSession';
import type { Group, Session } from '../../../renderer/types';

const agent = (overrides: Partial<Session> = {}) => createMockSession(overrides);

describe('sessionMatchesFilter', () => {
	it('matches everything on an empty or whitespace query', () => {
		const s = agent({ name: 'Alpha' });
		expect(sessionMatchesFilter(s, '')).toBe(true);
		expect(sessionMatchesFilter(s, '   ')).toBe(true);
	});

	it('matches the agent name, case-insensitively', () => {
		const s = agent({ name: 'Payments API' });
		expect(sessionMatchesFilter(s, 'payments')).toBe(true);
		expect(sessionMatchesFilter(s, 'PAY')).toBe(true);
		expect(sessionMatchesFilter(s, 'billing')).toBe(false);
	});

	it('matches an AI tab name', () => {
		const s = agent({
			name: 'Alpha',
			aiTabs: [{ id: 't1', name: 'Refactor parser' }] as never,
		});
		expect(sessionMatchesFilter(s, 'parser')).toBe(true);
	});

	// A hidden consult tab is not on screen, so its generated name must not keep an
	// agent in the filtered list.
	it('does not match a hidden consult tab name', () => {
		const s = agent({
			name: 'Alpha',
			aiTabs: [{ id: 't1', name: '\u21a9 Beta', hidden: true }] as never,
		});
		expect(sessionMatchesFilter(s, 'beta')).toBe(false);
	});

	// A user filtering for a branch expects the parent row that owns the worktree,
	// since the child is drawn underneath it rather than as a row of its own.
	it('matches a worktree child by branch name or by name', () => {
		const parent = agent({ id: 'p', name: 'Alpha' });
		const children = [agent({ id: 'c', name: 'Alpha (wt)', worktreeBranch: 'feat/tokens' })];
		expect(sessionMatchesFilter(parent, 'feat/tok', children)).toBe(true);
		expect(sessionMatchesFilter(parent, '(wt)', children)).toBe(true);
		expect(sessionMatchesFilter(parent, 'nope', children)).toBe(false);
	});

	it('tolerates an agent with no AI tabs and no children', () => {
		expect(sessionMatchesFilter(agent({ name: 'Alpha', aiTabs: undefined }), 'zzz')).toBe(false);
	});
});

describe('passesUnreadFilter', () => {
	const on = { showUnreadAgentsOnly: true };

	it('passes everything when the filter is off', () => {
		expect(passesUnreadFilter(agent({ state: 'idle' }), { showUnreadAgentsOnly: false })).toBe(
			true
		);
	});

	it('drops a quiet agent when the filter is on', () => {
		expect(passesUnreadFilter(agent({ id: 'a', state: 'idle', aiTabs: [] }), on)).toBe(false);
	});

	it('keeps an agent with an unread tab', () => {
		const s = agent({ id: 'a', state: 'idle', aiTabs: [{ id: 't', hasUnread: true }] as never });
		expect(passesUnreadFilter(s, on)).toBe(true);
	});

	it('keeps a busy agent', () => {
		expect(passesUnreadFilter(agent({ id: 'a', state: 'busy', aiTabs: [] }), on)).toBe(true);
	});

	// An agent that failed is the case this filter most needs to surface. It used
	// to be dropped, so a crashed agent with no unread tabs vanished from the very
	// filter you would open to find it.
	it('keeps an errored agent even with no unread tabs', () => {
		expect(passesUnreadFilter(agent({ id: 'a', state: 'error', aiTabs: [] }), on)).toBe(true);
	});

	// An Auto Run agent sits idle between prompts and a stuck one is not "unread"
	// in any literal sense, but both need attention.
	it('keeps an Auto Run agent and a stuck agent', () => {
		const s = agent({ id: 'a', state: 'idle', aiTabs: [] });
		expect(passesUnreadFilter(s, { ...on, batchSessionIds: new Set(['a']) })).toBe(true);
		expect(passesUnreadFilter(s, { ...on, stuckOutageIds: new Set(['a']) })).toBe(true);
	});

	// A filter that hides the row you are working in loses your place, and the
	// cycle would then have no valid position to move from.
	it('always keeps the active agent, and the parent of an active worktree child', () => {
		const quiet = agent({ id: 'a', state: 'idle', aiTabs: [] });
		expect(passesUnreadFilter(quiet, { ...on, activeSessionId: 'a' })).toBe(true);

		const parent = agent({ id: 'p', state: 'idle', aiTabs: [] });
		const children = [agent({ id: 'c', state: 'idle', aiTabs: [] })];
		expect(
			passesUnreadFilter(parent, { ...on, activeSessionId: 'c', worktreeChildren: children })
		).toBe(true);
	});

	it('keeps a parent whose worktree child needs attention', () => {
		const parent = agent({ id: 'p', state: 'idle', aiTabs: [] });
		const busyChild = [agent({ id: 'c', state: 'busy', aiTabs: [] })];
		expect(passesUnreadFilter(parent, { ...on, worktreeChildren: busyChild })).toBe(true);

		const errorChild = [agent({ id: 'c', state: 'error', aiTabs: [] })];
		expect(passesUnreadFilter(parent, { ...on, worktreeChildren: errorChild })).toBe(true);

		const quietChild = [agent({ id: 'c', state: 'idle', aiTabs: [] })];
		expect(passesUnreadFilter(parent, { ...on, worktreeChildren: quietChild })).toBe(false);
	});
});

const group = (id: string, overrides: Partial<Group> = {}): Group => ({
	id,
	name: id.toUpperCase(),
	emoji: '\u{1F4C1}',
	collapsed: false,
	...overrides,
});

describe('collectHiddenGroupIds', () => {
	it('is empty when nothing is hidden', () => {
		expect(collectHiddenGroupIds([group('a'), group('b')]).size).toBe(0);
	});

	it('collects every group flagged hidden', () => {
		const ids = collectHiddenGroupIds([group('a', { hidden: true }), group('b')]);
		expect([...ids]).toEqual(['a']);
	});

	// A child renders as its own indented row, so a parent hidden without its
	// children leaves the children indented under a header that is not there.
	it('inherits suppression from a hidden parent down to its children', () => {
		const ids = collectHiddenGroupIds([
			group('parent', { hidden: true }),
			group('child', { parentGroupId: 'parent' }),
			group('other'),
		]);
		expect([...ids].sort()).toEqual(['child', 'parent']);
	});

	// A group is only hidden when it says so - being nested under a VISIBLE
	// parent is not a reason to disappear.
	it('leaves a child of a visible parent alone', () => {
		const ids = collectHiddenGroupIds([
			group('parent'),
			group('child', { parentGroupId: 'parent' }),
		]);
		expect(ids.size).toBe(0);
	});
});

describe('resolveHiddenGroupIds', () => {
	it('suppresses nothing while "Show Hidden" is on', () => {
		const groups = [group('a', { hidden: true })];
		expect(resolveHiddenGroupIds(groups, { showHiddenGroups: true }).size).toBe(0);
	});

	it('suppresses hidden groups while "Show Hidden" is off', () => {
		const groups = [group('a', { hidden: true }), group('b')];
		expect([...resolveHiddenGroupIds(groups, { showHiddenGroups: false })]).toEqual(['a']);
	});

	// A list that hides the row you are working in loses your place, and the
	// arrow-key cycle is then positioned on an agent that is not on screen.
	it('keeps the group holding the active agent on screen', () => {
		const groups = [group('a', { hidden: true }), group('b', { hidden: true })];
		const ids = resolveHiddenGroupIds(groups, { showHiddenGroups: false, activeGroupId: 'a' });
		expect([...ids]).toEqual(['b']);
	});

	// The surviving child would otherwise draw indented under a header that is
	// not being rendered.
	it('exempts the parent of the active group too', () => {
		const groups = [group('parent', { hidden: true }), group('child', { parentGroupId: 'parent' })];
		const ids = resolveHiddenGroupIds(groups, { showHiddenGroups: false, activeGroupId: 'child' });
		expect(ids.size).toBe(0);
	});

	it('ignores an active group that was never hidden', () => {
		const groups = [group('a', { hidden: true }), group('b')];
		const ids = resolveHiddenGroupIds(groups, { showHiddenGroups: false, activeGroupId: 'b' });
		expect([...ids]).toEqual(['a']);
	});
});

describe('passesHiddenGroupFilter', () => {
	it('passes everything when nothing is suppressed', () => {
		expect(passesHiddenGroupFilter(agent({ groupId: 'a' }), new Set())).toBe(true);
	});

	// Hiding is a property of a GROUP, so there is no such thing as a hidden
	// agent outside one.
	it('always passes an ungrouped agent', () => {
		expect(passesHiddenGroupFilter(agent({ groupId: undefined }), new Set(['a']))).toBe(true);
	});

	it('drops an agent whose group is suppressed', () => {
		expect(passesHiddenGroupFilter(agent({ groupId: 'a' }), new Set(['a']))).toBe(false);
		expect(passesHiddenGroupFilter(agent({ groupId: 'b' }), new Set(['a']))).toBe(true);
	});
});
