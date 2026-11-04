// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/utils/snoozeHelpers.test.ts
// Source: src/__tests__/renderer/utils/snoozeTabGroup.test.ts
// Source: src/__tests__/renderer/utils/stagedImageOrder.test.ts
// Source: src/__tests__/renderer/utils/standaloneStatusBar.test.ts
// Source: src/__tests__/renderer/utils/svgViewBox.test.ts
// Source: src/__tests__/renderer/utils/tabDragImage.test.ts
// Source: src/__tests__/renderer/utils/terminalBuffer.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	snoozeTab as s1_snoozeTab,
	wakeSnoozedTab as s1_wakeSnoozedTab,
	removeSnoozedTab,
	updateSnoozedTab,
	getDueSnoozes,
	collectSnoozedTabs,
	getSnoozedTabLabel as s1_getSnoozedTabLabel,
	migrateLegacySnoozedTabs,
	canSnoozeRunWakePrompt,
	collectSnoozedAiTabs,
	resolveSnoozeTarget,
	resolveWakePromptTabId,
} from '../../../renderer/utils/snoozeHelpers';
import { createMockSession as s1_createMockSession } from '../../helpers/mockSession';
import { createMockAITab as s1_createMockAITab, createMockFileTab } from '../../helpers/mockTab';
import type {
	Session as S1_Session,
	UnifiedTabRef as S1_UnifiedTabRef,
} from '../../../renderer/types';
import {
	snoozeTab as s2_snoozeTab,
	snoozeTabGroup,
	wakeSnoozedTabGroup,
	wakeSnoozedTab as s2_wakeSnoozedTab,
	getSnoozedTabLabel as s2_getSnoozedTabLabel,
	isSnoozedGroup,
} from '../../../renderer/utils/snoozeHelpers';
import { createMockSession as s2_createMockSession } from '../../helpers/mockSession';
import { createMockAITab as s2_createMockAITab } from '../../helpers/mockTab';
import type {
	Session as S2_Session,
	TabGroup,
	UnifiedTabRef as S2_UnifiedTabRef,
	PanelLayoutNode,
} from '../../../renderer/types';
import {
	buildSlotRemap,
	moveStagedImage,
	renumberScreenshotReferences,
	screenshotReferenceLabel,
} from '../../../renderer/utils/stagedImageOrder';
import {
	installStandaloneStatusBarInset,
	measureStandaloneStatusBarInset,
	measureVisibleViewportHeight,
	STATUS_BAR_INSET_PROPERTY,
	VIEWPORT_HEIGHT_PROPERTY,
} from '../../../renderer/utils/standaloneStatusBar';
import { expandSvgViewBoxToContent } from '../../../renderer/utils/svgViewBox';
import type { DragEvent } from 'react';
import { setTabDragImage } from '../../../renderer/utils/tabDragImage';
import { mockTheme } from '../../helpers/mockTheme';
import {
	readLogicalLine,
	type ReadableBuffer,
	type ReadableBufferLine,
} from '../../../renderer/utils/terminalBuffer';
// Source: src/__tests__/renderer/utils/snoozeHelpers.test.ts
describe('', () => {
	const HOUR = 60 * 60 * 1000;
	/** Session with three AI tabs (a, b, c) in unified order, with `b` active. */
	function buildSession(overrides: Partial<S1_Session> = {}): S1_Session {
		const aiTabs = [
			s1_createMockAITab({ id: 'a', name: 'Alpha' }),
			s1_createMockAITab({ id: 'b', name: 'Bravo' }),
			s1_createMockAITab({ id: 'c', name: 'Charlie' }),
		];
		const unifiedTabOrder: S1_UnifiedTabRef[] = [
			{ type: 'ai', id: 'a' },
			{ type: 'ai', id: 'b' },
			{ type: 'ai', id: 'c' },
		];
		return s1_createMockSession({ aiTabs, unifiedTabOrder, activeTabId: 'b', ...overrides });
	}
	describe('snoozeTab', () => {
		it('removes the tab from aiTabs and records the snooze', () => {
			const session = buildSession();
			const result = s1_snoozeTab(session, 'b', Date.now() + HOUR, { note: 'check the build' });
			expect(result).not.toBeNull();
			expect(result!.session.aiTabs.map((t) => t.id)).toEqual(['a', 'c']);
			expect(result!.session.snoozedTabs).toHaveLength(1);
			expect(result!.entry.note).toBe('check the build');
			expect(result!.entry.tab.id).toBe('b');
		});
		it('drops the snoozed tab from the unified order so it stops rendering', () => {
			const session = buildSession();
			const result = s1_snoozeTab(session, 'b', Date.now() + HOUR)!;
			expect(result.session.unifiedTabOrder.some((ref) => ref.id === 'b')).toBe(false);
		});
		it('remembers the visual position for restore', () => {
			const session = buildSession();
			const result = s1_snoozeTab(session, 'c', Date.now() + HOUR)!;
			expect(result.entry.unifiedIndex).toBe(2);
		});
		it('selects a neighbouring tab when the snoozed tab was active', () => {
			const session = buildSession();
			const result = s1_snoozeTab(session, 'b', Date.now() + HOUR)!;
			expect(result.session.activeTabId).toBe('a');
		});
		it('does not tell main the tab closed - a snoozed tab comes back', () => {
			// snoozeTab reuses closeTab() to remove the tab, but the tab is only hidden.
			// Emitting the close notification would cancel dispatch callbacks armed
			// against a tab that is about to return.
			const notify = window.maestro.tabs.notifyAiTabClosed as ReturnType<typeof vi.fn>;
			notify.mockClear();
			const session = buildSession();
			s1_snoozeTab(session, 'b', Date.now() + HOUR);
			expect(notify).not.toHaveBeenCalled();
		});
		it('keeps the snooze out of the Cmd+Shift+T undo stack', () => {
			// A snoozed tab is scheduled to return; letting "reopen closed tab" also
			// restore it would duplicate the conversation.
			const session = buildSession();
			const result = s1_snoozeTab(session, 'b', Date.now() + HOUR)!;
			expect(result.session.closedTabHistory ?? []).toHaveLength(0);
		});
		it("leaves a fresh tab behind when snoozing an agent's only tab", () => {
			const session = s1_createMockSession({
				aiTabs: [s1_createMockAITab({ id: 'solo' })],
				unifiedTabOrder: [{ type: 'ai', id: 'solo' }],
				activeTabId: 'solo',
			});
			const result = s1_snoozeTab(session, 'solo', Date.now() + HOUR)!;
			expect(result.session.aiTabs).toHaveLength(1);
			expect(result.session.aiTabs[0].id).not.toBe('solo');
			expect(result.session.snoozedTabs).toHaveLength(1);
		});
		it('normalises a blank note to no note at all', () => {
			const session = buildSession();
			const result = s1_snoozeTab(session, 'b', Date.now() + HOUR, { note: '   ' })!;
			expect(result.entry.note).toBeUndefined();
		});
		it('clears runtime busy state so a snoozed tab never restores as thinking', () => {
			const session = buildSession({
				aiTabs: [s1_createMockAITab({ id: 'busy', state: 'busy', thinkingStartTime: 123 })],
				unifiedTabOrder: [{ type: 'ai', id: 'busy' }],
				activeTabId: 'busy',
			});
			const result = s1_snoozeTab(session, 'busy', Date.now() + HOUR)!;
			expect(result.entry.tab.state).toBe('idle');
			expect(result.entry.tab.thinkingStartTime).toBeUndefined();
		});
		it('returns null for an unknown tab', () => {
			expect(s1_snoozeTab(buildSession(), 'nope', Date.now() + HOUR)).toBeNull();
		});
	});
	describe('wakeSnoozedTab', () => {
		it('restores the tab at its original position, keeping its ID', () => {
			const session = buildSession();
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR)!;
			const woken = s1_wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;
			expect(woken.wasDuplicate).toBe(false);
			expect(woken.tabId).toBe('b');
			expect(woken.session.aiTabs.map((t) => t.id)).toEqual(['a', 'b', 'c']);
			expect(woken.session.unifiedTabOrder.map((r) => r.id)).toEqual(['a', 'b', 'c']);
			expect(woken.session.snoozedTabs).toHaveLength(0);
		});
		it('round-trips the tab contents and surfaces the note', () => {
			const session = buildSession();
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR, { note: 'ship it' })!;
			const woken = s1_wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;
			expect(woken.entry.note).toBe('ship it');
			expect(woken.session.aiTabs.find((t) => t.id === 'b')?.name).toBe('Bravo');
		});
		it('marks the restored tab unread so it is visible under the unread filter', () => {
			const session = buildSession();
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR)!;
			const woken = s1_wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;
			expect(woken.session.aiTabs.find((t) => t.id === 'b')?.hasUnread).toBe(true);
		});
		it('focuses the existing tab instead of duplicating a reopened conversation', () => {
			const session = buildSession({
				aiTabs: [
					s1_createMockAITab({ id: 'a' }),
					s1_createMockAITab({ id: 'b', agentSessionId: 'agent-1' }),
				],
				unifiedTabOrder: [
					{ type: 'ai', id: 'a' },
					{ type: 'ai', id: 'b' },
				],
				activeTabId: 'b',
			});
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR)!;
			// While snoozed, the user reopens the same agent session in a new tab.
			const withReopened: S1_Session = {
				...snoozed.session,
				aiTabs: [
					...snoozed.session.aiTabs,
					s1_createMockAITab({ id: 'z', agentSessionId: 'agent-1' }),
				],
			};
			const woken = s1_wakeSnoozedTab(withReopened, snoozed.entry.id)!;
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
					s1_createMockAITab({ id: 'a' }),
					s1_createMockAITab({ id: 'b', agentSessionId: 'agent-1' }),
				],
				unifiedTabOrder: [
					{ type: 'ai', id: 'a' },
					{ type: 'ai', id: 'b' },
				],
				activeTabId: 'b',
			});
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR)!;
			const withReopened: S1_Session = {
				...snoozed.session,
				aiTabs: [
					...snoozed.session.aiTabs,
					s1_createMockAITab({ id: 'z', agentSessionId: 'agent-1', hasUnread: false }),
				],
			};
			const woken = s1_wakeSnoozedTab(withReopened, snoozed.entry.id)!;
			expect(woken.session.aiTabs.find((t) => t.id === 'z')?.hasUnread).toBe(true);
		});
		it('marks the tab unread on an early manual return too', () => {
			const session = buildSession();
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR)!;
			const woken = s1_wakeSnoozedTab(snoozed.session, snoozed.entry.id, 'unsnoozed')!;
			expect(woken.session.aiTabs.find((t) => t.id === 'b')?.hasUnread).toBe(true);
		});
		it('returns null for an unknown snooze', () => {
			expect(s1_wakeSnoozedTab(buildSession(), 'nope')).toBeNull();
		});
	});
	describe('removeSnoozedTab / updateSnoozedTab', () => {
		it('discards the snooze without restoring the tab', () => {
			const session = buildSession();
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR)!;
			const after = removeSnoozedTab(snoozed.session, snoozed.entry.id);
			expect(after.snoozedTabs).toHaveLength(0);
			expect(after.aiTabs.map((t) => t.id)).toEqual(['a', 'c']);
		});
		it('reschedules and rewrites the note', () => {
			const session = buildSession();
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR, { note: 'old' })!;
			const after = updateSnoozedTab(snoozed.session, snoozed.entry.id, 999, { note: 'new' });
			expect(after.snoozedTabs![0].wakeAt).toBe(999);
			expect(after.snoozedTabs![0].note).toBe('new');
		});
		it('keeps the existing note when none is supplied, and clears it on empty', () => {
			const session = buildSession();
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR, { note: 'keep me' })!;
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
			const first = s1_snoozeTab(session, 'a', now + HOUR)!;
			// Backdate one entry to simulate a wake missed while the app was closed.
			const withOverdue: S1_Session = {
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
			const one = s1_snoozeTab(
				buildSession({ id: 's1', name: 'One' }),
				'a',
				now + 5 * HOUR
			)!.session;
			const two = s1_snoozeTab(buildSession({ id: 's2', name: 'Two' }), 'a', now + HOUR)!.session;
			const items = collectSnoozedTabs([one, two]);
			expect(items).toHaveLength(2);
			expect(items[0].sessionName).toBe('Two');
			expect(items[1].sessionName).toBe('One');
		});
	});
	describe('getSnoozedTabLabel', () => {
		it('prefers the tab name', () => {
			const snoozed = s1_snoozeTab(buildSession(), 'b', Date.now() + HOUR)!;
			expect(s1_getSnoozedTabLabel(snoozed.entry)).toBe('Bravo');
		});
		it('falls back to the first user message, then the session ID', () => {
			const session = buildSession({
				aiTabs: [
					s1_createMockAITab({
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
			const withLogs = s1_snoozeTab(session, 'x', Date.now() + HOUR)!;
			expect(s1_getSnoozedTabLabel(withLogs.entry)).toBe('fix the flaky test');
			const bare = s1_snoozeTab(
				buildSession({
					aiTabs: [s1_createMockAITab({ id: 'y', name: null, agentSessionId: 'abcdef1234' })],
					unifiedTabOrder: [{ type: 'ai', id: 'y' }],
					activeTabId: 'y',
				}),
				'y',
				Date.now() + HOUR
			)!;
			expect(s1_getSnoozedTabLabel(bare.entry)).toBe('abcdef12');
		});
	});
	describe('back-from-snooze transcript card', () => {
		/** The snoozeReturn-marked entry on a tab, if any. */
		function returnLog(session: S1_Session, tabId: string) {
			return session.aiTabs.find((t) => t.id === tabId)?.logs.find((l) => l.snoozeReturn);
		}
		it('appends a card to the restored tab carrying the note', () => {
			const session = buildSession();
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR, { note: 'check the build' })!;
			const woken = s1_wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;
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
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR, {
				note: 'ship the migration',
			})!;
			const woken = s1_wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;
			expect(returnLog(woken.session, 'b')!.text).toBe('Back from snooze: ship the migration');
		});
		it('still marks the return when no note was left', () => {
			const session = buildSession();
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR)!;
			const woken = s1_wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;
			const log = returnLog(woken.session, 'b')!;
			expect(log.text).toBe('Back from snooze');
			expect(log.snoozeReturn!.note).toBeUndefined();
			expect(log.snoozeReturn!.resolution).toBe('woke');
		});
		it('records an early return distinctly from a scheduled one', () => {
			const session = buildSession();
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR)!;
			const woken = s1_wakeSnoozedTab(snoozed.session, snoozed.entry.id, 'unsnoozed')!;
			expect(returnLog(woken.session, 'b')!.snoozeReturn!.resolution).toBe('unsnoozed');
		});
		it('keeps the conversation that was there before the snooze', () => {
			const session = buildSession({
				aiTabs: [
					s1_createMockAITab({
						id: 'b',
						logs: [{ id: 'old', timestamp: 1, source: 'user', text: 'earlier message' }],
					}),
				],
				unifiedTabOrder: [{ type: 'ai', id: 'b' }],
				activeTabId: 'b',
			});
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR)!;
			const woken = s1_wakeSnoozedTab(snoozed.session, snoozed.entry.id)!;
			const logs = woken.session.aiTabs.find((t) => t.id === 'b')!.logs;
			expect(logs[0].text).toBe('earlier message');
			// The card lands at the end, so it survives the persistence log cap and
			// reads as the seam it is.
			expect(logs[logs.length - 1].snoozeReturn).toBeDefined();
		});
		it('lands the card on the surviving tab when an equivalent one is already open', () => {
			const session = buildSession({
				aiTabs: [
					s1_createMockAITab({ id: 'a' }),
					s1_createMockAITab({ id: 'b', agentSessionId: 'agent-1' }),
				],
				unifiedTabOrder: [
					{ type: 'ai', id: 'a' },
					{ type: 'ai', id: 'b' },
				],
				activeTabId: 'b',
			});
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR, { note: 'still relevant' })!;
			const withReopened: S1_Session = {
				...snoozed.session,
				aiTabs: [
					...snoozed.session.aiTabs,
					s1_createMockAITab({ id: 'z', agentSessionId: 'agent-1' }),
				],
			};
			const woken = s1_wakeSnoozedTab(withReopened, snoozed.entry.id)!;
			expect(woken.wasDuplicate).toBe(true);
			// The duplicate tab is discarded, so the note has to follow the user to
			// the tab they actually land on or it is lost entirely.
			expect(returnLog(woken.session, 'z')!.snoozeReturn!.note).toBe('still relevant');
		});
	});
	describe('migrateLegacySnoozedTabs', () => {
		/** A snooze written before SnoozedTabEntry carried a kind tag. */
		function untaggedSnooze(session: S1_Session): S1_Session {
			const snoozed = s1_snoozeTab(session, 'b', Date.now() + HOUR, { note: 'legacy note' })!;
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
			expect(s1_getSnoozedTabLabel(legacy.snoozedTabs![0])).toBeUndefined();
			const migrated = migrateLegacySnoozedTabs(legacy);
			expect(s1_getSnoozedTabLabel(migrated.snoozedTabs![0])).toBe('Bravo');
		});
		it('restores the tab on wake once migrated', () => {
			const legacy = untaggedSnooze(buildSession());
			const snoozeId = legacy.snoozedTabs![0].id;
			// Untagged: the wake refuses rather than clearing the snooze and losing
			// the transcript with it.
			expect(s1_wakeSnoozedTab(legacy, snoozeId)).toBeNull();
			expect(legacy.snoozedTabs).toHaveLength(1);
			const woken = s1_wakeSnoozedTab(migrateLegacySnoozedTabs(legacy), snoozeId)!;
			expect(woken.session.aiTabs.map((t) => t.id)).toEqual(['a', 'b', 'c']);
			expect(woken.session.snoozedTabs).toHaveLength(0);
		});
		it('leaves an already-tagged session untouched', () => {
			const tagged = s1_snoozeTab(buildSession(), 'b', Date.now() + HOUR)!.session;
			expect(migrateLegacySnoozedTabs(tagged)).toBe(tagged);
		});
		it('is a no-op for a session with no snoozes', () => {
			const session = buildSession();
			expect(migrateLegacySnoozedTabs(session)).toBe(session);
		});
	});
	describe('wake prompts', () => {
		it('stores a trimmed wake prompt alongside the note', () => {
			const { entry } = s1_snoozeTab(buildSession(), 'b', Date.now() + HOUR, {
				note: 'why',
				wakePrompt: '  summarize what changed  ',
			})!;
			expect(entry.note).toBe('why');
			expect(entry.wakePrompt).toBe('summarize what changed');
		});
		it('drops a whitespace-only wake prompt rather than storing a blank one', () => {
			// A blank prompt would dispatch an empty turn on wake, so "typed nothing"
			// has to read as "no prompt" everywhere downstream.
			const { entry } = s1_snoozeTab(buildSession(), 'b', Date.now() + HOUR, {
				wakePrompt: '   ',
			})!;
			expect(entry.wakePrompt).toBeUndefined();
		});
		it('rewrites, keeps, and clears the wake prompt independently of the note', () => {
			const snoozed = s1_snoozeTab(buildSession(), 'b', Date.now() + HOUR, {
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
			const aiEntry = s1_snoozeTab(buildSession(), 'b', Date.now() + HOUR)!.entry;
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
			const { entry } = s1_snoozeTab(buildSession(), 'b', Date.now() + HOUR, {
				wakePrompt: 'carry on',
			})!;
			// wakeSnoozedTab hands back the pre-existing tab's id in that case, and the
			// prompt has to follow the tab the user actually lands on.
			expect(resolveWakePromptTabId(entry, 'already-open')).toBe('already-open');
		});
		it('resolves to null when there is no prompt to run', () => {
			const { entry } = s1_snoozeTab(buildSession(), 'b', Date.now() + HOUR)!;
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
			expect(
				resolveWakePromptTabId(groupEntry, 'g1', (member) => member.tab.id !== 'ai-dead')
			).toBe('ai-alive');
			// Every AI pane gone: nothing to prompt, and the caller has to say so
			// rather than sending the turn somewhere else.
			expect(
				resolveWakePromptTabId(groupEntry, 'g1', (member) => member.type === 'file')
			).toBeNull();
		});
	});
	describe('resolveSnoozeTarget', () => {
		/** One tab of every kind, plus a tiled group, all in the unified order. */
		function mixedSession(overrides: Partial<S1_Session> = {}): S1_Session {
			return s1_createMockSession({
				aiTabs: [s1_createMockAITab({ id: 'ai-1', name: 'Alpha' })],
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
			} as Partial<S1_Session>);
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
			} as Partial<S1_Session>);
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
			} as Partial<S1_Session>);
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
			const { entry } = s1_snoozeTab(buildSession(), 'b', Date.now() + HOUR)!;
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
});
// Source: src/__tests__/renderer/utils/snoozeTabGroup.test.ts
describe('', () => {
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
	function buildSession(overrides: Partial<S2_Session> = {}): S2_Session {
		const group: TabGroup = {
			id: 'g1',
			name: 'Review',
			layout: buildLayout(),
			focusedPaneId: 'leaf-a',
			createdAt: 1,
		};
		const unifiedTabOrder: S2_UnifiedTabRef[] = [
			{ type: 'group', id: 'g1' },
			{ type: 'ai', id: 'c' },
		];
		return s2_createMockSession({
			aiTabs: [
				s2_createMockAITab({ id: 'a', name: 'Alpha' }),
				s2_createMockAITab({ id: 'b', name: 'Bravo' }),
				s2_createMockAITab({ id: 'c', name: 'Charlie' }),
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
			expect(s2_snoozeTab(buildSession(), 'g1', Date.now() + HOUR)).toBeNull();
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
			const reopened: S2_Session = {
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
			const withTab = s2_snoozeTab(buildSession(), 'c', Date.now() + HOUR)!;
			expect(wakeSnoozedTabGroup(withTab.session, withTab.entry.id)).toBeNull();
			void entry;
		});
	});
	describe('wakeSnoozedTab leaves groups alone', () => {
		it('returns null for a group entry so the single-tab path never sees one', () => {
			const { session: parked, entry } = snoozeTabGroup(buildSession(), 'g1', Date.now() + HOUR)!;
			expect(s2_wakeSnoozedTab(parked, entry.id)).toBeNull();
		});
	});
	describe('group labelling', () => {
		it('names the group in the snoozed list', () => {
			const { entry } = snoozeTabGroup(buildSession(), 'g1', Date.now() + HOUR)!;
			expect(s2_getSnoozedTabLabel(entry)).toBe('Review');
			expect(isSnoozedGroup(entry)).toBe(true);
		});
	});
});
// Source: src/__tests__/renderer/utils/stagedImageOrder.test.ts
describe('', () => {
	describe('moveStagedImage', () => {
		it('moves an item forward using splice semantics', () => {
			expect(moveStagedImage(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
		});
		it('moves an item backward', () => {
			expect(moveStagedImage(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
		});
		it('returns a copy unchanged for no-op and out-of-range moves', () => {
			const items = ['a', 'b'];
			expect(moveStagedImage(items, 1, 1)).toEqual(['a', 'b']);
			expect(moveStagedImage(items, -1, 0)).toEqual(['a', 'b']);
			expect(moveStagedImage(items, 0, 5)).toEqual(['a', 'b']);
			expect(moveStagedImage(items, 0, 1)).not.toBe(items);
		});
	});
	describe('buildSlotRemap', () => {
		it('maps 1-based slots for a swap', () => {
			// [A, B] -> [B, A]: old slot 1 is now slot 2 and vice versa.
			const remap = buildSlotRemap(2, 0, 1);
			expect(remap.get(1)).toBe(2);
			expect(remap.get(2)).toBe(1);
			expect(remap.size).toBe(2);
		});
		it('omits slots the move did not disturb', () => {
			// [A, B, C, D] -> [B, A, C, D]: C and D keep their numbers.
			const remap = buildSlotRemap(4, 0, 1);
			expect(remap.has(3)).toBe(false);
			expect(remap.has(4)).toBe(false);
		});
		it('is empty for a no-op move', () => {
			expect(buildSlotRemap(3, 1, 1).size).toBe(0);
		});
		it('shifts the whole run when an item jumps to the end', () => {
			// [A, B, C] -> [B, C, A]
			const remap = buildSlotRemap(3, 0, 2);
			expect(remap.get(1)).toBe(3);
			expect(remap.get(2)).toBe(1);
			expect(remap.get(3)).toBe(2);
		});
	});
	describe('renumberScreenshotReferences', () => {
		it('rewrites references simultaneously rather than sequentially', () => {
			// A sequential pass would turn "1" into "2" and then back into "1".
			const remap = buildSlotRemap(2, 0, 1);
			expect(renumberScreenshotReferences('compare Screenshot 1 with Screenshot 2', remap)).toBe(
				'compare Screenshot 2 with Screenshot 1'
			);
		});
		it('preserves the writer casing and spacing', () => {
			const remap = buildSlotRemap(2, 0, 1);
			expect(renumberScreenshotReferences('screenshot 1 and SCREENSHOT  2', remap)).toBe(
				'screenshot 2 and SCREENSHOT  1'
			);
		});
		it('handles the plural form', () => {
			const remap = buildSlotRemap(2, 0, 1);
			expect(renumberScreenshotReferences('see screenshots 2', remap)).toBe('see screenshots 1');
		});
		it('leaves numbers outside the remap alone', () => {
			const remap = buildSlotRemap(4, 0, 1);
			expect(renumberScreenshotReferences('Screenshot 3 and Screenshot 9', remap)).toBe(
				'Screenshot 3 and Screenshot 9'
			);
		});
		it('does not touch other nouns that carry numbers', () => {
			const remap = buildSlotRemap(2, 0, 1);
			expect(renumberScreenshotReferences('image 1 and picture 2 and Phase 1', remap)).toBe(
				'image 1 and picture 2 and Phase 1'
			);
		});
		it('is a no-op for an empty remap or empty text', () => {
			expect(renumberScreenshotReferences('Screenshot 1', new Map())).toBe('Screenshot 1');
			expect(renumberScreenshotReferences('', buildSlotRemap(2, 0, 1))).toBe('');
		});
		it('renumbers the reference the drag affordance inserts', () => {
			const label = screenshotReferenceLabel(0);
			expect(label).toBe('Screenshot 1');
			expect(renumberScreenshotReferences(label, buildSlotRemap(3, 0, 2))).toBe('Screenshot 3');
		});
	});
});
// Source: src/__tests__/renderer/utils/standaloneStatusBar.test.ts
describe('', () => {
	const portrait = { standalone: true, screenHeight: 874, innerHeight: 812, innerWidth: 402 };
	describe('measureStandaloneStatusBarInset', () => {
		it('reports the height the viewport lost in a standalone portrait web app', () => {
			expect(measureStandaloneStatusBarInset(portrait)).toBe(62);
		});
		it('is zero when WebKit already sizes the viewport to the screen', () => {
			expect(measureStandaloneStatusBarInset({ ...portrait, innerHeight: 874 })).toBe(0);
		});
		it('is zero outside a home-screen web app', () => {
			expect(measureStandaloneStatusBarInset({ ...portrait, standalone: false })).toBe(0);
		});
		it('is zero in landscape, where iOS hides the status bar', () => {
			expect(
				measureStandaloneStatusBarInset({
					standalone: true,
					screenHeight: 874,
					innerHeight: 402,
					innerWidth: 874,
				})
			).toBe(0);
		});
		it('ignores a difference the size of the on-screen keyboard', () => {
			expect(measureStandaloneStatusBarInset({ ...portrait, innerHeight: 500 })).toBe(0);
		});
		it('rounds a fractional difference', () => {
			expect(measureStandaloneStatusBarInset({ ...portrait, innerHeight: 812.4 })).toBe(62);
		});
	});
	describe('installStandaloneStatusBarInset', () => {
		const originalInnerHeight = window.innerHeight;
		const originalInnerWidth = window.innerWidth;
		afterEach(() => {
			delete (
				window.navigator as Navigator & {
					standalone?: boolean;
				}
			).standalone;
			Object.defineProperty(window, 'innerHeight', {
				value: originalInnerHeight,
				configurable: true,
				writable: true,
			});
			Object.defineProperty(window, 'innerWidth', {
				value: originalInnerWidth,
				configurable: true,
				writable: true,
			});
			document.documentElement.style.removeProperty(STATUS_BAR_INSET_PROPERTY);
		});
		it('publishes the inset on <html>, follows resize, and stops after dispose', () => {
			const dispose = installStandaloneStatusBarInset(window);
			expect(document.documentElement.style.getPropertyValue(STATUS_BAR_INSET_PROPERTY)).toBe(
				'0px'
			);
			Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
			Object.defineProperty(window.screen, 'height', { value: 874, configurable: true });
			Object.defineProperty(window, 'innerHeight', {
				value: 812,
				configurable: true,
				writable: true,
			});
			Object.defineProperty(window, 'innerWidth', {
				value: 402,
				configurable: true,
				writable: true,
			});
			window.dispatchEvent(new Event('resize'));
			expect(document.documentElement.style.getPropertyValue(STATUS_BAR_INSET_PROPERTY)).toBe(
				'62px'
			);
			dispose();
			Object.defineProperty(window, 'innerHeight', {
				value: 874,
				configurable: true,
				writable: true,
			});
			window.dispatchEvent(new Event('resize'));
			expect(document.documentElement.style.getPropertyValue(STATUS_BAR_INSET_PROPERTY)).toBe(
				'62px'
			);
		});
	});
	/**
	 * The visible-viewport height exists for one failure: on iOS the on-screen
	 * keyboard slides OVER the layout viewport instead of shrinking it, so a
	 * full-screen phone modal sized to 100dvh keeps its full height with its
	 * bottom half behind the keys - and the results list the user opened it to
	 * scroll through is buried.
	 */
	describe('measureVisibleViewportHeight', () => {
		function win(innerHeight: number, visualHeight?: number): Window {
			return {
				innerHeight,
				visualViewport: visualHeight === undefined ? undefined : { height: visualHeight },
			} as unknown as Window;
		}
		it('prefers the visual viewport, which is what the keyboard shrinks', () => {
			expect(measureVisibleViewportHeight(win(844, 508))).toBe(508);
		});
		it('falls back to innerHeight where there is no visualViewport', () => {
			expect(measureVisibleViewportHeight(win(844))).toBe(844);
		});
		it('rounds DOWN so a fractional height cannot exceed the real viewport', () => {
			expect(measureVisibleViewportHeight(win(844, 507.6))).toBe(507);
		});
		it('falls back rather than publishing a zero height', () => {
			expect(measureVisibleViewportHeight(win(844, 0))).toBe(844);
		});
		it('publishes the visible height on <html> and follows a keyboard opening', () => {
			const visualViewport = {
				height: 844,
				listeners: new Map<string, () => void>(),
				addEventListener(type: string, cb: () => void) {
					this.listeners.set(type, cb);
				},
				removeEventListener(type: string) {
					this.listeners.delete(type);
				},
			};
			Object.defineProperty(window, 'visualViewport', {
				value: visualViewport,
				configurable: true,
			});
			const dispose = installStandaloneStatusBarInset(window);
			expect(document.documentElement.style.getPropertyValue(VIEWPORT_HEIGHT_PROPERTY)).toBe(
				'844px'
			);
			// The keyboard comes up: only the visual viewport shrinks.
			visualViewport.height = 508;
			visualViewport.listeners.get('resize')?.();
			expect(document.documentElement.style.getPropertyValue(VIEWPORT_HEIGHT_PROPERTY)).toBe(
				'508px'
			);
			dispose();
			Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
		});
	});
});
// Source: src/__tests__/renderer/utils/svgViewBox.test.ts
describe('', () => {
	/**
	 * Build an SVG element with a stubbed `getBBox`. jsdom implements no SVG
	 * geometry at all, so the content bounds have to be supplied by hand.
	 */
	function makeSvg(
		attrs: Record<string, string>,
		bbox:
			| {
					x: number;
					y: number;
					width: number;
					height: number;
			  }
			| 'throws'
			| 'missing'
	): SVGSVGElement {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
		if (bbox === 'throws') {
			(
				svg as unknown as {
					getBBox: () => DOMRect;
				}
			).getBBox = () => {
				throw new Error('Element not rendered');
			};
		} else if (bbox !== 'missing') {
			(
				svg as unknown as {
					getBBox: () => DOMRect;
				}
			).getBBox = () => bbox as DOMRect;
		}
		return svg;
	}
	describe('expandSvgViewBoxToContent', () => {
		it('widens a quadrantChart viewBox around a title that overflows both sides', () => {
			// mermaid's quadrantChart: fixed 500x500 box, title centered at x=250.
			const svg = makeSvg(
				{ viewBox: '0 0 500 500', width: '100%', style: 'max-width: 500px;' },
				{ x: -120, y: 0, width: 740, height: 500 }
			);
			expect(expandSvgViewBoxToContent(svg, 4)).toBe(true);
			expect(svg.getAttribute('viewBox')).toBe('-124 0 748 500');
			// 748/500 = 1.496, so the diagram keeps its original scale.
			expect(svg.style.maxWidth).toBe('748px');
		});
		it('leaves a diagram alone when its content already fits', () => {
			const svg = makeSvg(
				{ viewBox: '0 0 500 500', style: 'max-width: 500px;' },
				{
					x: 10,
					y: 10,
					width: 480,
					height: 480,
				}
			);
			expect(expandSvgViewBoxToContent(svg)).toBe(false);
			expect(svg.getAttribute('viewBox')).toBe('0 0 500 500');
			expect(svg.style.maxWidth).toBe('500px');
		});
		it('scales explicit width/height attributes by the same factor', () => {
			const svg = makeSvg(
				{ viewBox: '0 0 100 200', width: '100', height: '200' },
				{
					x: 0,
					y: 0,
					width: 150,
					height: 200,
				}
			);
			expect(expandSvgViewBoxToContent(svg, 0)).toBe(true);
			expect(svg.getAttribute('viewBox')).toBe('0 0 150 200');
			expect(svg.getAttribute('width')).toBe('150');
			expect(svg.getAttribute('height')).toBe('300');
		});
		it('does nothing when getBBox is unavailable or throws', () => {
			const missing = makeSvg({ viewBox: '0 0 500 500' }, 'missing');
			expect(expandSvgViewBoxToContent(missing)).toBe(false);
			expect(missing.getAttribute('viewBox')).toBe('0 0 500 500');
			const throws = makeSvg({ viewBox: '0 0 500 500' }, 'throws');
			expect(expandSvgViewBoxToContent(throws)).toBe(false);
			expect(throws.getAttribute('viewBox')).toBe('0 0 500 500');
		});
		it('ignores a missing, malformed, or degenerate viewBox', () => {
			const bbox = { x: -50, y: -50, width: 900, height: 900 };
			const none = makeSvg({}, bbox);
			expect(expandSvgViewBoxToContent(none)).toBe(false);
			const malformed = makeSvg({ viewBox: '0 0 500' }, bbox);
			expect(expandSvgViewBoxToContent(malformed)).toBe(false);
			expect(malformed.getAttribute('viewBox')).toBe('0 0 500');
			const zeroWidth = makeSvg({ viewBox: '0 0 0 500' }, bbox);
			expect(expandSvgViewBoxToContent(zeroWidth)).toBe(false);
		});
		it('ignores an empty content box', () => {
			const svg = makeSvg({ viewBox: '0 0 500 500' }, { x: 0, y: 0, width: 0, height: 0 });
			expect(expandSvgViewBoxToContent(svg)).toBe(false);
			expect(svg.getAttribute('viewBox')).toBe('0 0 500 500');
		});
	});
});
// Source: src/__tests__/renderer/utils/tabDragImage.test.ts
describe('', () => {
	type SetDragImage = (image: Element, x: number, y: number) => void;
	/**
	 * jsdom re-serializes a `border` shorthand's color from hex to its `rgb(...)`
	 * form, so the inline style read back is `1px solid rgb(189, 147, 249)`, never
	 * the original `#bd93f9`. Convert so the assertion can accept either form.
	 */
	function hexToRgb(hex: string): string {
		const pairs = hex.replace('#', '').match(/.{2}/g);
		if (!pairs) return hex;
		const [r, g, b] = pairs.map((h) => parseInt(h, 16));
		return `rgb(${r}, ${g}, ${b})`;
	}
	/** A minimal React.DragEvent whose dataTransfer exposes (or omits) setDragImage. */
	function makeDragEvent(setDragImage?: SetDragImage): DragEvent {
		return {
			dataTransfer: setDragImage
				? ({ setDragImage } as unknown as DataTransfer)
				: ({} as DataTransfer),
		} as unknown as DragEvent;
	}
	describe('setTabDragImage', () => {
		afterEach(() => {
			vi.useRealTimers();
		});
		it('mounts a themed preview node and hands it to setDragImage, then removes it', () => {
			vi.useFakeTimers();
			const setDragImage = vi.fn<SetDragImage>();
			const before = document.body.childElementCount;
			setTabDragImage(makeDragEvent(setDragImage), { label: 'Agent Tab', theme: mockTheme });
			expect(setDragImage).toHaveBeenCalledTimes(1);
			const node = setDragImage.mock.calls[0][0] as HTMLElement;
			expect(node.textContent).toBe('Agent Tab');
			// Styled from theme tokens for visual consistency with the live tab bar.
			// jsdom normalizes the hex accent to its rgb() form, so accept either.
			const accent = mockTheme.colors.accent;
			expect(
				node.style.border.includes(accent) || node.style.border.includes(hexToRgb(accent))
			).toBe(true);
			// Mounted off-screen so the OS can snapshot it before it is removed.
			expect(document.body.contains(node)).toBe(true);
			// The node is cleaned up on the next macrotask once the snapshot is taken.
			vi.runAllTimers();
			expect(document.body.contains(node)).toBe(false);
			expect(document.body.childElementCount).toBe(before);
		});
		it('is a no-op (keeps the default ghost) when setDragImage is unavailable', () => {
			const before = document.body.childElementCount;
			expect(() =>
				setTabDragImage(makeDragEvent(undefined), { label: 'x', theme: mockTheme })
			).not.toThrow();
			// Nothing is appended when the API is missing.
			expect(document.body.childElementCount).toBe(before);
		});
	});
});
// Source: src/__tests__/renderer/utils/terminalBuffer.test.ts
describe('', () => {
	/**
	 * Build a buffer from row specs. `text` is the raw row content; `wrapped` marks
	 * the row as a soft-wrap continuation of the previous one. translateToString
	 * pads to a fixed width when trimRight is false, mirroring xterm's behavior so
	 * the trimEnd path is exercised.
	 */
	function makeBuffer(
		rows: Array<{
			text: string;
			wrapped?: boolean;
		}>,
		width = 10
	): ReadableBuffer {
		const lines: ReadableBufferLine[] = rows.map((r) => ({
			isWrapped: !!r.wrapped,
			translateToString: (trimRight?: boolean) =>
				trimRight ? r.text.replace(/\s+$/, '') : r.text.padEnd(width, ' '),
		}));
		return {
			getLine: (y: number) => lines[y],
		};
	}
	describe('readLogicalLine', () => {
		it('returns a single unwrapped line, trimming trailing padding', () => {
			const buf = makeBuffer([{ text: 'hello' }]);
			expect(readLogicalLine(buf, 0)).toBe('hello');
		});
		it('reconstructs a line that soft-wraps across multiple rows', () => {
			const buf = makeBuffer([
				{ text: 'https://ex' },
				{ text: 'ample.com/', wrapped: true },
				{ text: 'path', wrapped: true },
			]);
			expect(readLogicalLine(buf, 0)).toBe('https://example.com/path');
		});
		it('walks back to the start when the clicked row is a wrapped continuation', () => {
			const buf = makeBuffer([
				{ text: 'https://ex' },
				{ text: 'ample.com/', wrapped: true },
				{ text: 'path', wrapped: true },
			]);
			// Clicking the middle or last visual row still yields the whole URL.
			expect(readLogicalLine(buf, 1)).toBe('https://example.com/path');
			expect(readLogicalLine(buf, 2)).toBe('https://example.com/path');
		});
		it('does not bleed into the next logical line', () => {
			const buf = makeBuffer([
				{ text: 'first' },
				{ text: 'second' }, // not wrapped - a separate logical line
			]);
			expect(readLogicalLine(buf, 0)).toBe('first');
			expect(readLogicalLine(buf, 1)).toBe('second');
		});
		it('stops at the previous non-wrapped boundary when walking back', () => {
			const buf = makeBuffer([
				{ text: 'intro' },
				{ text: 'long-line-' },
				{ text: 'continued', wrapped: true },
			]);
			expect(readLogicalLine(buf, 2)).toBe('long-line-continued');
		});
		it('returns empty string for a missing row', () => {
			const buf = makeBuffer([{ text: 'only' }]);
			expect(readLogicalLine(buf, 5)).toBe('');
		});
		it('returns empty string for a negative row', () => {
			const buf = makeBuffer([{ text: 'only' }]);
			expect(readLogicalLine(buf, -1)).toBe('');
		});
	});
});
