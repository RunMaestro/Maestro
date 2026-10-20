/**
 * The command-palette routes for Move Tab Left / Move Tab Right.
 *
 * Both ship with `keys: []`, so the palette is how they are reached until a
 * user binds a chord. Two things about these rows are not obvious and are what
 * these tests hold in place:
 *
 *   1. WHEN THE ROW EXISTS. The guard asks `moveActiveUnifiedTabByOne` whether
 *      the move would do anything rather than comparing `activeUnifiedIndex`
 *      against `unifiedTabCount`, because those two count tab refs the strip
 *      does not draw (a snoozed AI tab, an unopened consult). An index-based
 *      guard offers a dead row for a tab that is last among the VISIBLE tabs
 *      with a hidden ref behind it.
 *   2. HOW THE MOVE LANDS. Straight through `updateSessionWith` with the same
 *      canonical helper the keyboard handler calls, so the palette and the
 *      chord cannot disagree about where the tab goes.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Session } from '../../../../../renderer/types';
import { buildTabCommands } from '../../../../../renderer/components/QuickActionsModal/commands/tabCommands';
import { getActiveTabInfo } from '../../../../../renderer/components/QuickActionsModal/utils/activeTabInfo';
import { TAB_SHORTCUTS } from '../../../../../renderer/constants/shortcuts';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';

const updateSessionWith = vi.fn();

vi.mock('../../../../../renderer/stores/sessionStore', () => ({
	updateSessionWith: (id: string, updater: (session: Session) => Session) =>
		updateSessionWith(id, updater),
}));

const setQuickActionOpen = vi.fn();

/** Three visible AI tabs, with `activeTabId` naming which one is on screen. */
function threeTabs(activeTabId: string, extra: Partial<Session> = {}): Session {
	return createMockSession({
		aiTabs: [
			createMockAITab({ id: 'a1' }),
			createMockAITab({ id: 'a2' }),
			createMockAITab({ id: 'a3' }),
		],
		unifiedTabOrder: [
			{ type: 'ai', id: 'a1' },
			{ type: 'ai', id: 'a2' },
			{ type: 'ai', id: 'a3' },
		],
		activeTabId,
		...extra,
	});
}

function build(session: Session | undefined) {
	return buildTabCommands({
		activeSession: session,
		isAiMode: true,
		activeTabInfo: getActiveTabInfo(session, true),
		enterToSendAI: true,
		setQuickActionOpen,
		shortcuts: {},
		tabShortcuts: {
			moveTabLeft: TAB_SHORTCUTS.moveTabLeft,
			moveTabRight: TAB_SHORTCUTS.moveTabRight,
		},
		toggleInputMode: vi.fn(),
	});
}

function ids(session: Session | undefined): string[] {
	return build(session).map((command) => command.id);
}

function entry(session: Session, id: string) {
	const found = build(session).find((command) => command.id === id);
	if (!found) throw new Error(`no palette entry for ${id}`);
	return found;
}

describe('buildTabCommands - move the active tab one position', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('offers both directions for a tab with a visible neighbor on each side', () => {
		expect(ids(threeTabs('a2'))).toEqual(expect.arrayContaining(['moveTabLeft', 'moveTabRight']));
	});

	it('labels the rows the way the shortcut table does', () => {
		const session = threeTabs('a2');
		expect(entry(session, 'moveTabLeft').label).toBe(TAB_SHORTCUTS.moveTabLeft.label);
		expect(entry(session, 'moveTabRight').label).toBe(TAB_SHORTCUTS.moveTabRight.label);
	});

	it('hands each row its own chord badge', () => {
		const session = threeTabs('a2');
		expect(entry(session, 'moveTabLeft').shortcut).toBe(TAB_SHORTCUTS.moveTabLeft);
		expect(entry(session, 'moveTabRight').shortcut).toBe(TAB_SHORTCUTS.moveTabRight);
	});

	it('omits Move Tab Left for the first tab - there is no wrap to offer', () => {
		const list = ids(threeTabs('a1'));
		expect(list).not.toContain('moveTabLeft');
		expect(list).toContain('moveTabRight');
	});

	it('omits Move Tab Right for the last tab', () => {
		const list = ids(threeTabs('a3'));
		expect(list).toContain('moveTabLeft');
		expect(list).not.toContain('moveTabRight');
	});

	it('omits the row when the only neighbor that way is a HIDDEN tab', () => {
		// a2 is last in the strip; h1 sits behind it in the order but is drawn
		// nowhere, so a press right would move nothing. An index-based guard
		// (activeUnifiedIndex 1 < unifiedTabCount 3) would have offered the row.
		const session = createMockSession({
			aiTabs: [
				createMockAITab({ id: 'a1' }),
				createMockAITab({ id: 'a2' }),
				createMockAITab({ id: 'h1', hidden: true }),
			],
			unifiedTabOrder: [
				{ type: 'ai', id: 'a1' },
				{ type: 'ai', id: 'a2' },
				{ type: 'ai', id: 'h1' },
			],
			activeTabId: 'a2',
		});
		expect(ids(session)).not.toContain('moveTabRight');
		expect(ids(session)).toContain('moveTabLeft');
	});

	it('offers neither row for a single-tab agent', () => {
		const session = createMockSession({
			aiTabs: [createMockAITab({ id: 'a1' })],
			unifiedTabOrder: [{ type: 'ai', id: 'a1' }],
			activeTabId: 'a1',
		});
		expect(ids(session)).not.toContain('moveTabLeft');
		expect(ids(session)).not.toContain('moveTabRight');
	});

	it('offers neither row with no agent at all', () => {
		expect(ids(undefined)).not.toContain('moveTabLeft');
		expect(ids(undefined)).not.toContain('moveTabRight');
	});

	it('writes the reorder against the active agent and closes the palette', () => {
		const session = threeTabs('a2');
		entry(session, 'moveTabRight').action();

		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		expect(updateSessionWith).toHaveBeenCalledTimes(1);
		const [sessionId, updater] = updateSessionWith.mock.calls[0];
		expect(sessionId).toBe(session.id);

		// The updater runs against the LIVE session, not the one captured at build
		// time, so apply it here the way the store would.
		expect(updater(session).unifiedTabOrder.map((ref) => ref.id)).toEqual(['a1', 'a3', 'a2']);
	});

	it('moves left through the same path', () => {
		const session = threeTabs('a2');
		entry(session, 'moveTabLeft').action();

		const [, updater] = updateSessionWith.mock.calls[0];
		expect(updater(session).unifiedTabOrder.map((ref) => ref.id)).toEqual(['a2', 'a1', 'a3']);
	});

	it('steps past a hidden tab in one press, like the chord does', () => {
		const session = createMockSession({
			aiTabs: [
				createMockAITab({ id: 'a1' }),
				createMockAITab({ id: 'h1', hidden: true }),
				createMockAITab({ id: 'a2' }),
			],
			unifiedTabOrder: [
				{ type: 'ai', id: 'a1' },
				{ type: 'ai', id: 'h1' },
				{ type: 'ai', id: 'a2' },
			],
			activeTabId: 'a1',
		});
		entry(session, 'moveTabRight').action();

		const [, updater] = updateSessionWith.mock.calls[0];
		expect(updater(session).unifiedTabOrder.map((ref) => ref.id)).toEqual(['h1', 'a2', 'a1']);
	});
});
