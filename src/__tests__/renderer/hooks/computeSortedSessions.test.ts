import { describe, it, expect } from 'vitest';
import { computeSortedSessions } from '../../../renderer/hooks/session/computeSortedSessions';
import { createMockSession } from '../../helpers';

describe('computeSortedSessions - unread filter jump-badge visibility', () => {
	it('keeps an errored agent in visibleSessions under the unread filter', () => {
		const errored = createMockSession({ id: 'e1', name: 'Errored', state: 'error' });
		const idle = createMockSession({ id: 'i1', name: 'Idle' });

		const { visibleSessions } = computeSortedSessions({
			sessions: [errored, idle],
			groups: [],
			bookmarksCollapsed: false,
			showUnreadAgentsOnly: true,
		});

		const names = visibleSessions.map((s) => s.name);
		expect(names).toContain('Errored');
		expect(names).not.toContain('Idle');
	});

	it('keeps a parent visible when one of its worktree children is errored', () => {
		const parent = createMockSession({ id: 'p1', name: 'Parent' });
		const child = createMockSession({
			id: 'c1',
			name: 'Worktree Child',
			parentSessionId: 'p1',
			state: 'error',
		});

		const { visibleSessions } = computeSortedSessions({
			sessions: [parent, child],
			groups: [],
			bookmarksCollapsed: false,
			showUnreadAgentsOnly: true,
		});

		expect(visibleSessions.map((s) => s.name)).toContain('Parent');
	});

	it('excludes idle agents with no unread/errored children under the unread filter', () => {
		const idle = createMockSession({ id: 'a1', name: 'Idle Alone' });

		const { visibleSessions } = computeSortedSessions({
			sessions: [idle],
			groups: [],
			bookmarksCollapsed: false,
			showUnreadAgentsOnly: true,
		});

		expect(visibleSessions.map((s) => s.name)).not.toContain('Idle Alone');
	});

	it('keeps an auto-running (batch) agent in visibleSessions under the unread filter', () => {
		const batch = createMockSession({ id: 'b1', name: 'AutoRunning' });
		const idle = createMockSession({ id: 'i1', name: 'Idle' });

		const { visibleSessions } = computeSortedSessions({
			sessions: [batch, idle],
			groups: [],
			bookmarksCollapsed: false,
			showUnreadAgentsOnly: true,
			activeBatchSessionIds: ['b1'],
		});

		const names = visibleSessions.map((s) => s.name);
		expect(names).toContain('AutoRunning');
		expect(names).not.toContain('Idle');
	});

	it('keeps a stuck (outage) agent in visibleSessions under the unread filter', () => {
		const stuck = createMockSession({ id: 's1', name: 'Stuck' });
		const idle = createMockSession({ id: 'i1', name: 'Idle' });

		const { visibleSessions } = computeSortedSessions({
			sessions: [stuck, idle],
			groups: [],
			bookmarksCollapsed: false,
			showUnreadAgentsOnly: true,
			stuckOutageSessionIds: ['s1'],
		});

		const names = visibleSessions.map((s) => s.name);
		expect(names).toContain('Stuck');
		expect(names).not.toContain('Idle');
	});

	it('keeps a parent visible when a worktree child is auto-running a batch', () => {
		const parent = createMockSession({ id: 'p1', name: 'Parent' });
		const child = createMockSession({ id: 'c1', name: 'Child', parentSessionId: 'p1' });

		const { visibleSessions } = computeSortedSessions({
			sessions: [parent, child],
			groups: [],
			bookmarksCollapsed: false,
			showUnreadAgentsOnly: true,
			activeBatchSessionIds: ['c1'],
		});

		expect(visibleSessions.map((s) => s.name)).toContain('Parent');
	});

	it('keeps a parent visible when a worktree child is stuck in an outage', () => {
		const parent = createMockSession({ id: 'p1', name: 'Parent' });
		const child = createMockSession({ id: 'c1', name: 'Child', parentSessionId: 'p1' });

		const { visibleSessions } = computeSortedSessions({
			sessions: [parent, child],
			groups: [],
			bookmarksCollapsed: false,
			showUnreadAgentsOnly: true,
			stuckOutageSessionIds: ['c1'],
		});

		expect(visibleSessions.map((s) => s.name)).toContain('Parent');
	});
});

describe('computeSortedSessions - hidden groups', () => {
	const hiddenGroup = {
		id: 'g-hidden',
		name: 'PARKED',
		emoji: '\u{1F4C1}',
		collapsed: false,
		hidden: true,
	};
	const openGroup = { id: 'g-open', name: 'ACTIVE', emoji: '\u{1F4C1}', collapsed: false };

	const parked = () => createMockSession({ id: 'p1', name: 'Parked', groupId: 'g-hidden' });
	const working = () => createMockSession({ id: 'w1', name: 'Working', groupId: 'g-open' });

	// Jump badges number what is on screen, and the arrow keys step through it,
	// so neither may land on an agent the Left Bar is not drawing.
	it('drops a hidden group from the jump-badge and arrow-key projections', () => {
		const { visibleSessions, navSessions } = computeSortedSessions({
			sessions: [parked(), working()],
			groups: [hiddenGroup, openGroup],
			bookmarksCollapsed: false,
		});

		expect(visibleSessions.map((s) => s.name)).toEqual(['Working']);
		expect(navSessions.map((s) => s.name)).toEqual(['Working']);
	});

	it('restores them when "Show Hidden" is on', () => {
		const { visibleSessions, navSessions } = computeSortedSessions({
			sessions: [parked(), working()],
			groups: [hiddenGroup, openGroup],
			bookmarksCollapsed: false,
			showHiddenGroups: true,
		});

		expect(visibleSessions.map((s) => s.name).sort()).toEqual(['Parked', 'Working']);
		expect(navSessions.map((s) => s.name).sort()).toEqual(['Parked', 'Working']);
	});

	// Hiding the group you are working in would strand the cycle on a row that
	// is not on screen.
	it('keeps the active agent visible even inside a hidden group', () => {
		const { visibleSessions } = computeSortedSessions({
			sessions: [parked(), working()],
			groups: [hiddenGroup, openGroup],
			bookmarksCollapsed: false,
			activeSessionId: 'p1',
		});

		expect(visibleSessions.map((s) => s.name).sort()).toEqual(['Parked', 'Working']);
	});

	// `sortedSessions` is the full ordering other callers index into, not a
	// statement about what is drawn.
	it('leaves the complete sorted ordering untouched', () => {
		const { sortedSessions } = computeSortedSessions({
			sessions: [parked(), working()],
			groups: [hiddenGroup, openGroup],
			bookmarksCollapsed: false,
		});

		expect(sortedSessions.map((s) => s.name).sort()).toEqual(['Parked', 'Working']);
	});
});
