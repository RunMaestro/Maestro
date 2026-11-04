/**
 * Tests for parking a whole tiled group.
 *
 * The promise group snooze makes is narrower than the one a single tab makes:
 * the LAYOUT survives, the contents do not necessarily. These cover the layout
 * half (replayed verbatim), the drop-and-rebalance path when a pane can no
 * longer be restored, and the fact that a group never travels through the
 * single-tab entry points.
 */

import { describe, it, expect } from 'vitest';
import {
	snoozeTab,
	snoozeTabGroup,
	wakeSnoozedTabGroup,
	wakeSnoozedTab,
	getSnoozedTabLabel,
	isSnoozedGroup,
} from '../../../renderer/utils/snoozeHelpers';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { Session, TabGroup, UnifiedTabRef, PanelLayoutNode } from '../../../renderer/types';

const HOUR = 60 * 60 * 1000;

/** A two-pane row: AI `a` beside AI `b`, `a` focused. */
function buildLayout(): PanelLayoutNode {
	return {
		kind: 'split',
		id: 'split-1',
		direction: 'row',
		children: [
			{ kind: 'leaf', id: 'leaf-a', tab: { type: 'ai', id: 'a' } },
			{ kind: 'leaf', id: 'leaf-b', tab: { type: 'ai', id: 'b' } },
		],
		sizes: [0.5, 0.5],
	};
}

/** Session holding one tiled group (`a` | `b`) plus a standalone tab `c`. */
function buildSession(overrides: Partial<Session> = {}): Session {
	const group: TabGroup = {
		id: 'g1',
		name: 'Review',
		layout: buildLayout(),
		focusedPaneId: 'leaf-a',
		createdAt: 1,
	};
	const unifiedTabOrder: UnifiedTabRef[] = [
		{ type: 'group', id: 'g1' },
		{ type: 'ai', id: 'c' },
	];
	return createMockSession({
		aiTabs: [
			createMockAITab({ id: 'a', name: 'Alpha' }),
			createMockAITab({ id: 'b', name: 'Bravo' }),
			createMockAITab({ id: 'c', name: 'Charlie' }),
		],
		tabGroups: [group],
		unifiedTabOrder,
		activeGroupId: 'g1',
		...overrides,
	});
}

describe('snoozeTabGroup', () => {
	it('parks the group and every member, and lets go of the active group', () => {
		const result = snoozeTabGroup(buildSession(), 'g1', Date.now() + HOUR, {
			note: 'finish the review',
		});

		expect(result).not.toBeNull();
		const { session, entry } = result!;
		expect(session.tabGroups).toHaveLength(0);
		expect(session.aiTabs.map((t) => t.id)).toEqual(['c']);
		expect(session.activeGroupId).toBeNull();
		expect(session.unifiedTabOrder).toEqual([{ type: 'ai', id: 'c' }]);
		expect(entry.members).toHaveLength(2);
		expect(entry.note).toBe('finish the review');
	});

	it('carries the layout tree and the focused pane, not just a member list', () => {
		const { entry } = snoozeTabGroup(buildSession(), 'g1', Date.now() + HOUR)!;
		expect(entry.group.layout).toEqual(buildLayout());
		expect(entry.group.focusedPaneId).toBe('leaf-a');
	});

	it('parks a mid-turn pane as idle so it does not come back still thinking', () => {
		const session = buildSession();
		session.aiTabs[0] = {
			...session.aiTabs[0],
			state: 'busy',
			thinkingStartTime: 123,
		};
		const { entry } = snoozeTabGroup(session, 'g1', Date.now() + HOUR)!;
		const parked = entry.members.find((m) => m.tab.id === 'a')!;
		expect(parked.type).toBe('ai');
		if (parked.type !== 'ai') throw new Error('expected an AI member');
		expect(parked.tab.state).toBe('idle');
		expect(parked.tab.thinkingStartTime).toBeUndefined();
	});

	it('returns null for an unknown group', () => {
		expect(snoozeTabGroup(buildSession(), 'nope', Date.now() + HOUR)).toBeNull();
	});

	it('returns null when every pane has already vanished', () => {
		const session = buildSession({ aiTabs: [] });
		expect(snoozeTabGroup(session, 'g1', Date.now() + HOUR)).toBeNull();
	});
});

describe('snoozeTab does not accept a group', () => {
	it('refuses a group id rather than parking it as a tab', () => {
		expect(snoozeTab(buildSession(), 'g1', Date.now() + HOUR)).toBeNull();
	});
});

describe('wakeSnoozedTabGroup', () => {
	function park(session = buildSession()) {
		const { session: parked, entry } = snoozeTabGroup(session, 'g1', Date.now() + HOUR)!;
		return { parked, entry };
	}

	it('replays the layout verbatim and restores every member', () => {
		const { parked, entry } = park();
		const woke = wakeSnoozedTabGroup(parked, entry.id)!;

		expect(woke.wasDuplicate).toBe(false);
		expect(woke.droppedMembers).toHaveLength(0);
		expect(woke.session.tabGroups).toHaveLength(1);
		expect(woke.session.tabGroups![0].layout).toEqual(buildLayout());
		expect(woke.session.tabGroups![0].focusedPaneId).toBe('leaf-a');
		expect(woke.session.aiTabs.map((t) => t.id).sort()).toEqual(['a', 'b', 'c']);
		expect(woke.session.activeGroupId).toBe('g1');
		expect(woke.session.snoozedTabs).toHaveLength(0);
	});

	it('puts the group back where it was in the tab order', () => {
		const { parked, entry } = park();
		const woke = wakeSnoozedTabGroup(parked, entry.id)!;
		expect(woke.session.unifiedTabOrder).toEqual([
			{ type: 'group', id: 'g1' },
			{ type: 'ai', id: 'c' },
		]);
	});

	it('drops an unrestorable pane and rebalances, rather than restoring a dead one', () => {
		const { parked, entry } = park();
		const woke = wakeSnoozedTabGroup(parked, entry.id, (m) => m.tab.id !== 'b')!;

		expect(woke.droppedMembers).toHaveLength(1);
		expect(woke.droppedMembers[0].tab.id).toBe('b');
		expect(woke.session.aiTabs.map((t) => t.id).sort()).toEqual(['a', 'c']);

		// The survivor keeps the pane; nothing references the dropped tab.
		const layout = woke.session.tabGroups![0].layout;
		expect(JSON.stringify(layout)).not.toContain('"id":"b"');
		expect(JSON.stringify(layout)).toContain('"id":"a"');
	});

	it('restores no layout when every member is gone, but still clears the snooze', () => {
		const { parked, entry } = park();
		const woke = wakeSnoozedTabGroup(parked, entry.id, () => false)!;

		expect(woke.droppedMembers).toHaveLength(2);
		expect(woke.session.tabGroups ?? []).toHaveLength(0);
		expect(woke.session.snoozedTabs).toHaveLength(0);
	});

	it('focuses a group that is already open instead of restoring a second copy', () => {
		const { parked, entry } = park();
		const reopened: Session = {
			...parked,
			tabGroups: [entry.group],
			activeGroupId: null,
		};
		const woke = wakeSnoozedTabGroup(reopened, entry.id)!;

		expect(woke.wasDuplicate).toBe(true);
		expect(woke.session.tabGroups).toHaveLength(1);
		expect(woke.session.activeGroupId).toBe('g1');
		expect(woke.session.snoozedTabs).toHaveLength(0);
	});

	it('returns null for an unknown snooze, and for a single-tab snooze', () => {
		const { parked, entry } = park();
		expect(wakeSnoozedTabGroup(parked, 'nope')).toBeNull();

		const withTab = snoozeTab(buildSession(), 'c', Date.now() + HOUR)!;
		expect(wakeSnoozedTabGroup(withTab.session, withTab.entry.id)).toBeNull();
		void entry;
	});
});

describe('wakeSnoozedTab leaves groups alone', () => {
	it('returns null for a group entry so the single-tab path never sees one', () => {
		const { session: parked, entry } = snoozeTabGroup(buildSession(), 'g1', Date.now() + HOUR)!;
		expect(wakeSnoozedTab(parked, entry.id)).toBeNull();
	});
});

describe('group labelling', () => {
	it('names the group in the snoozed list', () => {
		const { entry } = snoozeTabGroup(buildSession(), 'g1', Date.now() + HOUR)!;
		expect(getSnoozedTabLabel(entry)).toBe('Review');
		expect(isSnoozedGroup(entry)).toBe(true);
	});
});
