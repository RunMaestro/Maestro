import { describe, it, expect, vi } from 'vitest';
import {
	snoozeTab,
	wakeSnoozedTab,
	removeSnoozedTab,
	updateSnoozedTab,
	getDueSnoozes,
	collectSnoozedTabs,
	getSnoozedTabLabel,
} from '../../../renderer/utils/snoozeHelpers';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { Session, UnifiedTabRef } from '../../../renderer/types';

const HOUR = 60 * 60 * 1000;

/** Session with three AI tabs (a, b, c) in unified order, with `b` active. */
function buildSession(overrides: Partial<Session> = {}): Session {
	const aiTabs = [
		createMockAITab({ id: 'a', name: 'Alpha' }),
		createMockAITab({ id: 'b', name: 'Bravo' }),
		createMockAITab({ id: 'c', name: 'Charlie' }),
	];
	const unifiedTabOrder: UnifiedTabRef[] = [
		{ type: 'ai', id: 'a' },
		{ type: 'ai', id: 'b' },
		{ type: 'ai', id: 'c' },
	];
	return createMockSession({ aiTabs, unifiedTabOrder, activeTabId: 'b', ...overrides });
}

describe('snoozeTab', () => {
	it('removes the tab from aiTabs and records the snooze', () => {
		const session = buildSession();
		const result = snoozeTab(session, 'b', Date.now() + HOUR, 'check the build');

		expect(result).not.toBeNull();
		expect(result!.session.aiTabs.map((t) => t.id)).toEqual(['a', 'c']);
		expect(result!.session.snoozedTabs).toHaveLength(1);
		expect(result!.entry.note).toBe('check the build');
		expect(result!.entry.tab.id).toBe('b');
	});

	it('drops the snoozed tab from the unified order so it stops rendering', () => {
		const session = buildSession();
		const result = snoozeTab(session, 'b', Date.now() + HOUR)!;
		expect(result.session.unifiedTabOrder.some((ref) => ref.id === 'b')).toBe(false);
	});

	it('remembers the visual position for restore', () => {
		const session = buildSession();
		const result = snoozeTab(session, 'c', Date.now() + HOUR)!;
		expect(result.entry.unifiedIndex).toBe(2);
	});

	it('selects a neighbouring tab when the snoozed tab was active', () => {
		const session = buildSession();
		const result = snoozeTab(session, 'b', Date.now() + HOUR)!;
		expect(result.session.activeTabId).toBe('a');
	});

	it('does not tell main the tab closed - a snoozed tab comes back', () => {
		// snoozeTab reuses closeTab() to remove the tab, but the tab is only hidden.
		// Emitting the close notification would cancel dispatch callbacks armed
		// against a tab that is about to return.
		const notify = window.maestro.tabs.notifyAiTabClosed as ReturnType<typeof vi.fn>;
		notify.mockClear();
		const session = buildSession();
		snoozeTab(session, 'b', Date.now() + HOUR);
		expect(notify).not.toHaveBeenCalled();
	});

	it('keeps the snooze out of the Cmd+Shift+T undo stack', () => {
		// A snoozed tab is scheduled to return; letting "reopen closed tab" also
		// restore it would duplicate the conversation.
		const session = buildSession();
		const result = snoozeTab(session, 'b', Date.now() + HOUR)!;
		expect(result.session.closedTabHistory ?? []).toHaveLength(0);
	});

	it("leaves a fresh tab behind when snoozing an agent's only tab", () => {
		const session = createMockSession({
			aiTabs: [createMockAITab({ id: 'solo' })],
			unifiedTabOrder: [{ type: 'ai', id: 'solo' }],
			activeTabId: 'solo',
		});
		const result = snoozeTab(session, 'solo', Date.now() + HOUR)!;

		expect(result.session.aiTabs).toHaveLength(1);
		expect(result.session.aiTabs[0].id).not.toBe('solo');
		expect(result.session.snoozedTabs).toHaveLength(1);
	});

	it('normalises a blank note to no note at all', () => {
		const session = buildSession();
		const result = snoozeTab(session, 'b', Date.now() + HOUR, '   ')!;
		expect(result.entry.note).toBeUndefined();
	});

	it('clears runtime busy state so a snoozed tab never restores as thinking', () => {
		const session = buildSession({
			aiTabs: [createMockAITab({ id: 'busy', state: 'busy', thinkingStartTime: 123 })],
			unifiedTabOrder: [{ type: 'ai', id: 'busy' }],
			activeTabId: 'busy',
		});
		const result = snoozeTab(session, 'busy', Date.now() + HOUR)!;
		expect(result.entry.tab.state).toBe('idle');
		expect(result.entry.tab.thinkingStartTime).toBeUndefined();
	});

	it('returns null for an unknown tab', () => {
		expect(snoozeTab(buildSession(), 'nope', Date.now() + HOUR)).toBeNull();
	});
});

describe('wakeSnoozedTab', () => {
	it('restores the tab at its original position, keeping its ID', () => {
		const session = buildSession();
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR)!;
		const woken = wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;

		expect(woken.wasDuplicate).toBe(false);
		expect(woken.tabId).toBe('b');
		expect(woken.session.aiTabs.map((t) => t.id)).toEqual(['a', 'b', 'c']);
		expect(woken.session.unifiedTabOrder.map((r) => r.id)).toEqual(['a', 'b', 'c']);
		expect(woken.session.snoozedTabs).toHaveLength(0);
	});

	it('round-trips the tab contents and surfaces the note', () => {
		const session = buildSession();
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR, 'ship it')!;
		const woken = wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;

		expect(woken.entry.note).toBe('ship it');
		expect(woken.session.aiTabs.find((t) => t.id === 'b')?.name).toBe('Bravo');
	});

	it('marks the restored tab unread so it is visible under the unread filter', () => {
		const session = buildSession();
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR)!;
		const woken = wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;
		expect(woken.session.aiTabs.find((t) => t.id === 'b')?.hasUnread).toBe(true);
	});

	it('focuses the existing tab instead of duplicating a reopened conversation', () => {
		const session = buildSession({
			aiTabs: [
				createMockAITab({ id: 'a' }),
				createMockAITab({ id: 'b', agentSessionId: 'agent-1' }),
			],
			unifiedTabOrder: [
				{ type: 'ai', id: 'a' },
				{ type: 'ai', id: 'b' },
			],
			activeTabId: 'b',
		});
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR)!;

		// While snoozed, the user reopens the same agent session in a new tab.
		const withReopened: Session = {
			...snoozed.session,
			aiTabs: [...snoozed.session.aiTabs, createMockAITab({ id: 'z', agentSessionId: 'agent-1' })],
		};

		const woken = wakeSnoozedTab(withReopened, snoozed.entry.id)!;
		expect(woken.wasDuplicate).toBe(true);
		expect(woken.tabId).toBe('z');
		expect(woken.session.aiTabs.filter((t) => t.agentSessionId === 'agent-1')).toHaveLength(1);
		expect(woken.session.snoozedTabs).toHaveLength(0);
	});

	it('returns null for an unknown snooze', () => {
		expect(wakeSnoozedTab(buildSession(), 'nope')).toBeNull();
	});
});

describe('removeSnoozedTab / updateSnoozedTab', () => {
	it('discards the snooze without restoring the tab', () => {
		const session = buildSession();
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR)!;
		const after = removeSnoozedTab(snoozed.session, snoozed.entry.id);

		expect(after.snoozedTabs).toHaveLength(0);
		expect(after.aiTabs.map((t) => t.id)).toEqual(['a', 'c']);
	});

	it('reschedules and rewrites the note', () => {
		const session = buildSession();
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR, 'old')!;
		const after = updateSnoozedTab(snoozed.session, snoozed.entry.id, 999, 'new');

		expect(after.snoozedTabs![0].wakeAt).toBe(999);
		expect(after.snoozedTabs![0].note).toBe('new');
	});

	it('keeps the existing note when none is supplied, and clears it on empty', () => {
		const session = buildSession();
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR, 'keep me')!;

		expect(updateSnoozedTab(snoozed.session, snoozed.entry.id, 42).snoozedTabs![0].note).toBe(
			'keep me'
		);
		expect(
			updateSnoozedTab(snoozed.session, snoozed.entry.id, 42, '').snoozedTabs![0].note
		).toBeUndefined();
	});

	it('returns the session untouched for an unknown snooze', () => {
		const session = buildSession();
		expect(removeSnoozedTab(session, 'nope')).toBe(session);
		expect(updateSnoozedTab(session, 'nope', 1)).toBe(session);
	});
});

describe('getDueSnoozes', () => {
	it('returns snoozes at or past their wake time, including overdue ones', () => {
		const now = Date.now();
		const session = buildSession();
		const first = snoozeTab(session, 'a', now + HOUR)!;
		// Backdate one entry to simulate a wake missed while the app was closed.
		const withOverdue: Session = {
			...first.session,
			snoozedTabs: [
				...first.session.snoozedTabs!,
				{ ...first.entry, id: 'overdue', wakeAt: now - 5 * HOUR },
			],
		};

		const due = getDueSnoozes(withOverdue, now);
		expect(due.map((e) => e.id)).toEqual(['overdue']);
	});

	it('returns nothing when no snoozes exist', () => {
		expect(getDueSnoozes(buildSession())).toEqual([]);
	});
});

describe('collectSnoozedTabs', () => {
	it('flattens across agents, soonest wake first', () => {
		const now = Date.now();
		const one = snoozeTab(buildSession({ id: 's1', name: 'One' }), 'a', now + 5 * HOUR)!.session;
		const two = snoozeTab(buildSession({ id: 's2', name: 'Two' }), 'a', now + HOUR)!.session;

		const items = collectSnoozedTabs([one, two]);
		expect(items).toHaveLength(2);
		expect(items[0].sessionName).toBe('Two');
		expect(items[1].sessionName).toBe('One');
	});
});

describe('getSnoozedTabLabel', () => {
	it('prefers the tab name', () => {
		const snoozed = snoozeTab(buildSession(), 'b', Date.now() + HOUR)!;
		expect(getSnoozedTabLabel(snoozed.entry)).toBe('Bravo');
	});

	it('falls back to the first user message, then the session ID', () => {
		const session = buildSession({
			aiTabs: [
				createMockAITab({
					id: 'x',
					name: null,
					logs: [
						{ id: 'l1', timestamp: 0, source: 'user', text: 'fix the flaky test\nsecond line' },
					],
				}),
			],
			unifiedTabOrder: [{ type: 'ai', id: 'x' }],
			activeTabId: 'x',
		});
		const withLogs = snoozeTab(session, 'x', Date.now() + HOUR)!;
		expect(getSnoozedTabLabel(withLogs.entry)).toBe('fix the flaky test');

		const bare = snoozeTab(
			buildSession({
				aiTabs: [createMockAITab({ id: 'y', name: null, agentSessionId: 'abcdef1234' })],
				unifiedTabOrder: [{ type: 'ai', id: 'y' }],
				activeTabId: 'y',
			}),
			'y',
			Date.now() + HOUR
		)!;
		expect(getSnoozedTabLabel(bare.entry)).toBe('abcdef12');
	});
});
