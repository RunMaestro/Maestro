import { describe, it, expect } from 'vitest';
import {
	sessionMatchesFilter,
	passesUnreadFilter,
} from '../../../renderer/utils/sidebarMembership';
import { createMockSession } from '../../helpers/mockSession';
import type { Session } from '../../../renderer/types';

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
