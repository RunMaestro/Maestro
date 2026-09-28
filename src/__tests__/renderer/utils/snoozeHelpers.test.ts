import { describe, it, expect, vi } from 'vitest';
import {
	snoozeTab,
	wakeSnoozedTab,
	removeSnoozedTab,
	updateSnoozedTab,
	getDueSnoozes,
	collectSnoozedTabs,
	getSnoozedTabLabel,
	migrateLegacySnoozedTabs,
	canSnoozeRunWakePrompt,
	collectSnoozedAiTabs,
	resolveSnoozeTarget,
	resolveWakePromptTabId,
} from '../../../renderer/utils/snoozeHelpers';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab, createMockFileTab } from '../../helpers/mockTab';
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
		const result = snoozeTab(session, 'b', Date.now() + HOUR, { note: 'check the build' });

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
		const result = snoozeTab(session, 'b', Date.now() + HOUR, { note: '   ' })!;
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
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR, { note: 'ship it' })!;
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

	it('marks the surviving tab unread when it absorbs a duplicate wake', () => {
		// The restored copy is discarded here, so the unread flag has to move to
		// the tab the user actually lands on or the return goes unmarked.
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
		const withReopened: Session = {
			...snoozed.session,
			aiTabs: [
				...snoozed.session.aiTabs,
				createMockAITab({ id: 'z', agentSessionId: 'agent-1', hasUnread: false }),
			],
		};

		const woken = wakeSnoozedTab(withReopened, snoozed.entry.id)!;
		expect(woken.session.aiTabs.find((t) => t.id === 'z')?.hasUnread).toBe(true);
	});

	it('marks the tab unread on an early manual return too', () => {
		const session = buildSession();
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR)!;
		const woken = wakeSnoozedTab(snoozed.session, snoozed.entry.id, 'unsnoozed')!;
		expect(woken.session.aiTabs.find((t) => t.id === 'b')?.hasUnread).toBe(true);
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
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR, { note: 'old' })!;
		const after = updateSnoozedTab(snoozed.session, snoozed.entry.id, 999, { note: 'new' });

		expect(after.snoozedTabs![0].wakeAt).toBe(999);
		expect(after.snoozedTabs![0].note).toBe('new');
	});

	it('keeps the existing note when none is supplied, and clears it on empty', () => {
		const session = buildSession();
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR, { note: 'keep me' })!;

		expect(updateSnoozedTab(snoozed.session, snoozed.entry.id, 42).snoozedTabs![0].note).toBe(
			'keep me'
		);
		expect(
			updateSnoozedTab(snoozed.session, snoozed.entry.id, 42, { note: '' }).snoozedTabs![0].note
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

describe('back-from-snooze transcript card', () => {
	/** The snoozeReturn-marked entry on a tab, if any. */
	function returnLog(session: Session, tabId: string) {
		return session.aiTabs.find((t) => t.id === tabId)?.logs.find((l) => l.snoozeReturn);
	}

	it('appends a card to the restored tab carrying the note', () => {
		const session = buildSession();
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR, { note: 'check the build' })!;
		const woken = wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;

		const log = returnLog(woken.session, 'b');
		expect(log).toBeDefined();
		expect(log!.source).toBe('system');
		expect(log!.snoozeReturn).toMatchObject({
			note: 'check the build',
			wakeAt: snoozed.entry.wakeAt,
			snoozedAt: snoozed.entry.snoozedAt,
			resolution: 'woke',
		});
	});

	it('puts the note in the plain text too, so cross-tab search can find it', () => {
		const session = buildSession();
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR, { note: 'ship the migration' })!;
		const woken = wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;

		expect(returnLog(woken.session, 'b')!.text).toBe('Back from snooze: ship the migration');
	});

	it('still marks the return when no note was left', () => {
		const session = buildSession();
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR)!;
		const woken = wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;

		const log = returnLog(woken.session, 'b')!;
		expect(log.text).toBe('Back from snooze');
		expect(log.snoozeReturn!.note).toBeUndefined();
		expect(log.snoozeReturn!.resolution).toBe('woke');
	});

	it('records an early return distinctly from a scheduled one', () => {
		const session = buildSession();
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR)!;
		const woken = wakeSnoozedTab(snoozed.session, snoozed.entry.id, 'unsnoozed')!;

		expect(returnLog(woken.session, 'b')!.snoozeReturn!.resolution).toBe('unsnoozed');
	});

	it('keeps the conversation that was there before the snooze', () => {
		const session = buildSession({
			aiTabs: [
				createMockAITab({
					id: 'b',
					logs: [{ id: 'old', timestamp: 1, source: 'user', text: 'earlier message' }],
				}),
			],
			unifiedTabOrder: [{ type: 'ai', id: 'b' }],
			activeTabId: 'b',
		});
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR)!;
		const woken = wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;

		const logs = woken.session.aiTabs.find((t) => t.id === 'b')!.logs;
		expect(logs[0].text).toBe('earlier message');
		// The card lands at the end, so it survives the persistence log cap and
		// reads as the seam it is.
		expect(logs[logs.length - 1].snoozeReturn).toBeDefined();
	});

	it('lands the card on the surviving tab when an equivalent one is already open', () => {
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
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR, { note: 'still relevant' })!;
		const withReopened: Session = {
			...snoozed.session,
			aiTabs: [...snoozed.session.aiTabs, createMockAITab({ id: 'z', agentSessionId: 'agent-1' })],
		};

		const woken = wakeSnoozedTab(withReopened, snoozed.entry.id)!;

		expect(woken.wasDuplicate).toBe(true);
		// The duplicate tab is discarded, so the note has to follow the user to
		// the tab they actually land on or it is lost entirely.
		expect(returnLog(woken.session, 'z')!.snoozeReturn!.note).toBe('still relevant');
	});
});

describe('migrateLegacySnoozedTabs', () => {
	/** A snooze written before SnoozedTabEntry carried a kind tag. */
	function untaggedSnooze(session: Session): Session {
		const snoozed = snoozeTab(session, 'b', Date.now() + HOUR, { note: 'legacy note' })!;
		const entry = { ...snoozed.session.snoozedTabs![0] } as Record<string, unknown>;
		delete entry.type;
		return { ...snoozed.session, snoozedTabs: [entry] as never };
	}

	it('tags a legacy untagged snooze as an AI tab', () => {
		const legacy = untaggedSnooze(buildSession());
		const migrated = migrateLegacySnoozedTabs(legacy);

		expect(migrated.snoozedTabs![0].type).toBe('ai');
		expect(migrated.snoozedTabs![0].note).toBe('legacy note');
	});

	it('gives the migrated entry a real label instead of a blank row', () => {
		const legacy = untaggedSnooze(buildSession());
		expect(getSnoozedTabLabel(legacy.snoozedTabs![0])).toBeUndefined();

		const migrated = migrateLegacySnoozedTabs(legacy);
		expect(getSnoozedTabLabel(migrated.snoozedTabs![0])).toBe('Bravo');
	});

	it('restores the tab on wake once migrated', () => {
		const legacy = untaggedSnooze(buildSession());
		const snoozeId = legacy.snoozedTabs![0].id;

		// Untagged: the wake refuses rather than clearing the snooze and losing
		// the transcript with it.
		expect(wakeSnoozedTab(legacy, snoozeId)).toBeNull();
		expect(legacy.snoozedTabs).toHaveLength(1);

		const woken = wakeSnoozedTab(migrateLegacySnoozedTabs(legacy), snoozeId)!;
		expect(woken.session.aiTabs.map((t) => t.id)).toEqual(['a', 'b', 'c']);
		expect(woken.session.snoozedTabs).toHaveLength(0);
	});

	it('leaves an already-tagged session untouched', () => {
		const tagged = snoozeTab(buildSession(), 'b', Date.now() + HOUR)!.session;
		expect(migrateLegacySnoozedTabs(tagged)).toBe(tagged);
	});

	it('is a no-op for a session with no snoozes', () => {
		const session = buildSession();
		expect(migrateLegacySnoozedTabs(session)).toBe(session);
	});
});

describe('wake prompts', () => {
	it('stores a trimmed wake prompt alongside the note', () => {
		const { entry } = snoozeTab(buildSession(), 'b', Date.now() + HOUR, {
			note: 'why',
			wakePrompt: '  summarize what changed  ',
		})!;

		expect(entry.note).toBe('why');
		expect(entry.wakePrompt).toBe('summarize what changed');
	});

	it('drops a whitespace-only wake prompt rather than storing a blank one', () => {
		// A blank prompt would dispatch an empty turn on wake, so "typed nothing"
		// has to read as "no prompt" everywhere downstream.
		const { entry } = snoozeTab(buildSession(), 'b', Date.now() + HOUR, { wakePrompt: '   ' })!;
		expect(entry.wakePrompt).toBeUndefined();
	});

	it('rewrites, keeps, and clears the wake prompt independently of the note', () => {
		const snoozed = snoozeTab(buildSession(), 'b', Date.now() + HOUR, {
			note: 'keep me',
			wakePrompt: 'old prompt',
		})!;
		const id = snoozed.entry.id;

		// Omitted field: untouched.
		const noteOnly = updateSnoozedTab(snoozed.session, id, 42, { note: 'new note' });
		expect(noteOnly.snoozedTabs![0].note).toBe('new note');
		expect(noteOnly.snoozedTabs![0].wakePrompt).toBe('old prompt');

		// Empty string: cleared, and the note it travelled with survives.
		const cleared = updateSnoozedTab(noteOnly, id, 42, { wakePrompt: '' });
		expect(cleared.snoozedTabs![0].wakePrompt).toBeUndefined();
		expect(cleared.snoozedTabs![0].note).toBe('new note');
	});

	it('only offers a wake prompt where there is a conversation to send it to', () => {
		const aiEntry = snoozeTab(buildSession(), 'b', Date.now() + HOUR)!.entry;
		expect(canSnoozeRunWakePrompt(aiEntry)).toBe(true);

		expect(
			canSnoozeRunWakePrompt({
				...aiEntry,
				type: 'terminal',
				tab: { id: 't1' },
			} as never)
		).toBe(false);
	});

	it('resolves the restored tab, not the parked one, when a duplicate was already open', () => {
		const { entry } = snoozeTab(buildSession(), 'b', Date.now() + HOUR, {
			wakePrompt: 'carry on',
		})!;
		// wakeSnoozedTab hands back the pre-existing tab's id in that case, and the
		// prompt has to follow the tab the user actually lands on.
		expect(resolveWakePromptTabId(entry, 'already-open')).toBe('already-open');
	});

	it('resolves to null when there is no prompt to run', () => {
		const { entry } = snoozeTab(buildSession(), 'b', Date.now() + HOUR)!;
		expect(resolveWakePromptTabId(entry, 'b')).toBeNull();
	});

	it('picks the first surviving AI pane of a group, skipping dropped ones', () => {
		const groupEntry = {
			type: 'group' as const,
			id: 'snooze-1',
			unifiedIndex: 0,
			snoozedAt: 0,
			wakeAt: 0,
			wakePrompt: 'pick up where we left off',
			group: { id: 'g1' },
			members: [
				{ type: 'file', tab: { id: 'f1' } },
				{ type: 'ai', tab: { id: 'ai-dead' } },
				{ type: 'ai', tab: { id: 'ai-alive' } },
			],
		} as never;

		expect(resolveWakePromptTabId(groupEntry, 'g1', (member) => member.tab.id !== 'ai-dead')).toBe(
			'ai-alive'
		);
		// Every AI pane gone: nothing to prompt, and the caller has to say so
		// rather than sending the turn somewhere else.
		expect(resolveWakePromptTabId(groupEntry, 'g1', (member) => member.type === 'file')).toBeNull();
	});
});

describe('resolveSnoozeTarget', () => {
	/** One tab of every kind, plus a tiled group, all in the unified order. */
	function mixedSession(overrides: Partial<Session> = {}): Session {
		return createMockSession({
			aiTabs: [createMockAITab({ id: 'ai-1', name: 'Alpha' })],
			filePreviewTabs: [createMockFileTab({ id: 'file-1', name: 'notes', extension: '.md' })],
			terminalTabs: [
				{
					id: 'term-1',
					name: 'Build',
					shellType: 'zsh',
					pid: 0,
					cwd: '/tmp',
					createdAt: 1,
					state: 'idle',
				},
			],
			browserTabs: [{ id: 'browser-1', url: 'https://example.com', title: 'Example' }],
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'file', id: 'file-1' },
				{ type: 'terminal', id: 'term-1' },
				{ type: 'browser', id: 'browser-1' },
			],
			activeTabId: 'ai-1',
			...overrides,
		} as Partial<Session>);
	}

	it('resolves a tab of every kind, not just AI', () => {
		// The regression this exists for: the tab-strip opener searched `aiTabs`
		// alone and returned early, so Snooze Tab on the other three chips was
		// silently inert.
		const session = mixedSession();
		for (const id of ['ai-1', 'file-1', 'term-1', 'browser-1']) {
			expect(resolveSnoozeTarget(session, id)?.tabId).toBe(id);
		}
	});

	it('offers the wake prompt only for a conversation', () => {
		const session = mixedSession();
		expect(resolveSnoozeTarget(session, 'ai-1')!.canRunWakePrompt).toBe(true);
		expect(resolveSnoozeTarget(session, 'file-1')!.canRunWakePrompt).toBe(false);
		expect(resolveSnoozeTarget(session, 'term-1')!.canRunWakePrompt).toBe(false);
		expect(resolveSnoozeTarget(session, 'browser-1')!.canRunWakePrompt).toBe(false);
	});

	it('labels each kind the way its chip does', () => {
		const session = mixedSession();
		expect(resolveSnoozeTarget(session, 'ai-1')!.tabLabel).toBe('Alpha');
		expect(resolveSnoozeTarget(session, 'file-1')!.tabLabel).toBe('notes');
		expect(resolveSnoozeTarget(session, 'term-1')!.tabLabel).toBe('Build');
		expect(resolveSnoozeTarget(session, 'browser-1')!.tabLabel).toBe('Example');
	});

	it('resolves a tiled group, and offers the prompt when it holds an AI pane', () => {
		const session = mixedSession({
			tabGroups: [
				{
					id: 'g1',
					name: 'Review',
					layout: {
						kind: 'split',
						id: 'split-1',
						direction: 'row',
						children: [
							{ kind: 'leaf', id: 'leaf-a', tab: { type: 'ai', id: 'ai-1' } },
							{ kind: 'leaf', id: 'leaf-b', tab: { type: 'file', id: 'file-1' } },
						],
						sizes: [0.5, 0.5],
					},
					focusedPaneId: 'leaf-a',
					createdAt: 1,
				},
			],
		} as Partial<Session>);

		const target = resolveSnoozeTarget(session, 'g1');
		expect(target).toEqual({ tabId: 'g1', tabLabel: 'Review', canRunWakePrompt: true });
	});

	it('withholds the prompt from a group with no AI pane', () => {
		const session = mixedSession({
			tabGroups: [
				{
					id: 'g1',
					name: 'Logs',
					layout: {
						kind: 'split',
						id: 'split-1',
						direction: 'row',
						children: [
							{ kind: 'leaf', id: 'leaf-a', tab: { type: 'file', id: 'file-1' } },
							{ kind: 'leaf', id: 'leaf-b', tab: { type: 'terminal', id: 'term-1' } },
						],
						sizes: [0.5, 0.5],
					},
					focusedPaneId: 'leaf-a',
					createdAt: 1,
				},
			],
		} as Partial<Session>);

		expect(resolveSnoozeTarget(session, 'g1')!.canRunWakePrompt).toBe(false);
	});

	it('returns null for an id this session does not have, and for no session', () => {
		// Lets an opener skip a dialog whose confirm could not commit.
		expect(resolveSnoozeTarget(mixedSession(), 'ghost')).toBeNull();
		expect(resolveSnoozeTarget(null, 'ai-1')).toBeNull();
	});
});

describe('collectSnoozedAiTabs', () => {
	it('returns the one conversation an AI snooze holds', () => {
		const { entry } = snoozeTab(buildSession(), 'b', Date.now() + HOUR)!;
		expect(collectSnoozedAiTabs(entry).map((tab) => tab.id)).toEqual(['b']);
	});

	it('returns nothing for a kind that has no transcript', () => {
		const fileEntry = { type: 'file', tab: { id: 'f1' } } as never;
		expect(collectSnoozedAiTabs(fileEntry)).toEqual([]);
	});

	it('returns every AI pane of a group, skipping the other kinds', () => {
		// The mirror runs this at BOTH ends of a snooze, so a group whose panes
		// are mirrored on the way in gets each of them released on the way out.
		const groupEntry = {
			type: 'group',
			members: [
				{ type: 'file', tab: { id: 'f1' } },
				{ type: 'ai', tab: { id: 'ai-1' } },
				{ type: 'terminal', tab: { id: 't1' } },
				{ type: 'ai', tab: { id: 'ai-2' } },
			],
		} as never;

		expect(collectSnoozedAiTabs(groupEntry).map((tab) => tab.id)).toEqual(['ai-1', 'ai-2']);
	});
});
