/**
 * Tests for src/renderer/services/tabCleanup.ts
 *
 * This is the last check between a model's suggestion and a tab. The failures
 * it exists to prevent cannot be undone by the user who caused them:
 *
 *  - Closing a tab that started a turn, was starred, or gained a draft after
 *    the list was made.
 *  - Acting on a hidden consult tab, which has no chip to bring it back from.
 *  - Closing a tab on an agent other than the one named, or one that is gone.
 *
 * The three real paths (close, snooze, wake) run against the real session
 * store here, so a suggestion that "applied" is one that changed the tabs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../renderer/utils/snoozeTranscriptMirror', () => ({
	mirrorSnoozedTranscript: vi.fn(),
	releaseSnoozedTranscript: vi.fn(),
}));

vi.mock('../../../renderer/stores/snoozeHistoryStore', () => ({
	recordSnoozeResolution: vi.fn(),
	useSnoozeHistoryStore: { getState: () => ({ entries: [] }) },
}));

const notifyCenterFlash = vi.fn();
vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: (...args: unknown[]) => notifyCenterFlash(...args),
}));

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

vi.mock('../../../renderer/services/snoozeWakePrompt', () => ({
	runSnoozeWakePrompt: vi.fn(),
	runSnoozeWakePromptAfterGroupWake: vi.fn(),
}));

vi.mock('../../../renderer/utils/starredSessions', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/utils/starredSessions')>()),
	snapshotClosedTabTranscript: vi.fn(),
}));

import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	applyTabCleanupSuggestions,
	describeTabCleanupOutcome,
	resolveTabCleanupLiveState,
	tabCleanupSuggestionKey,
} from '../../../renderer/services/tabCleanup';
import { snoozeTabWithMirror } from '../../../renderer/services/snoozeActions';
import { setLiveDraft, clearLiveDraft } from '../../../renderer/utils/liveDraftStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { AITab, Session } from '../../../renderer/types';
import type { TabCleanupSuggestion } from '../../../shared/tabCleanup';

const HOUR = 60 * 60 * 1000;

function agentWith(id: string, tabs: AITab[]): Session {
	return createMockSession({
		id,
		name: `Agent ${id}`,
		aiTabs: tabs,
		unifiedTabOrder: tabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
		activeTabId: tabs[0]?.id,
	});
}

function setSessions(...sessions: Session[]): void {
	useSessionStore.setState({ sessions, activeSessionId: sessions[0]?.id ?? '' });
}

function sessions(): Session[] {
	return useSessionStore.getState().sessions;
}

function tabIds(sessionId: string): string[] {
	return sessions()
		.find((s) => s.id === sessionId)!
		.aiTabs.map((tab) => tab.id);
}

function suggestion(overrides: Partial<TabCleanupSuggestion> = {}): TabCleanupSuggestion {
	return {
		tabId: 't1',
		agentId: 'a1',
		action: 'close',
		reason: 'Untouched for a month.',
		agentName: 'Agent a1',
		label: 'One',
		kind: 'open',
		tabType: 'ai',
		lastActivityAt: 0,
		messageCount: 3,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	for (const id of ['t1', 't2', 't3']) clearLiveDraft(id);
	setSessions(
		agentWith('a1', [
			createMockAITab({ id: 't1', name: 'One' }),
			createMockAITab({ id: 't2', name: 'Two' }),
		]),
		agentWith('a2', [createMockAITab({ id: 't3', name: 'Three' })])
	);
});

describe('resolveTabCleanupLiveState', () => {
	it('is ok for an idle, unstarred tab with an empty composer', () => {
		expect(resolveTabCleanupLiveState(sessions(), suggestion())).toEqual({ status: 'ok' });
	});

	it('is gone when the agent or the tab no longer exists', () => {
		expect(resolveTabCleanupLiveState(sessions(), suggestion({ agentId: 'nope' }))).toEqual({
			status: 'gone',
		});
		expect(resolveTabCleanupLiveState(sessions(), suggestion({ tabId: 'nope' }))).toEqual({
			status: 'gone',
		});
	});

	it('does not find a tab on the wrong agent', () => {
		expect(resolveTabCleanupLiveState(sessions(), suggestion({ agentId: 'a2' }))).toEqual({
			status: 'gone',
		});
	});

	it('never resolves a hidden consult tab', () => {
		setSessions(agentWith('a1', [createMockAITab({ id: 't1', hidden: true })]));
		expect(resolveTabCleanupLiveState(sessions(), suggestion())).toEqual({ status: 'gone' });
	});

	it.each([
		['busy', { state: 'busy' as const }],
		['starred', { starred: true }],
		['draft', { inputValue: 'half a thought' }],
		['draft', { stagedImages: ['maestro-image://store/abc.png'] }],
	])('protects a %s tab', (protection, tab) => {
		setSessions(agentWith('a1', [createMockAITab({ id: 't1', ...tab })]));
		expect(resolveTabCleanupLiveState(sessions(), suggestion())).toEqual({
			status: 'protected',
			protection,
		});
	});

	it('sees a draft still being typed, before it reaches the session', () => {
		setLiveDraft('t1', 'typing right now');
		expect(resolveTabCleanupLiveState(sessions(), suggestion())).toEqual({
			status: 'protected',
			protection: 'draft',
		});
	});

	it('treats a tab in the middle of an inline wizard as busy', () => {
		setSessions(
			agentWith('a1', [
				createMockAITab({
					id: 't1',
					wizardState: { isActive: true } as AITab['wizardState'],
				}),
			])
		);
		expect(resolveTabCleanupLiveState(sessions(), suggestion())).toEqual({
			status: 'protected',
			protection: 'busy',
		});
	});

	it('resolves a snoozed tab by its snooze id', () => {
		const entry = snoozeTabWithMirror('t2', Date.now() + HOUR, undefined, {
			sessionId: 'a1',
			announce: false,
		})!;
		const wake = suggestion({ action: 'wake', kind: 'snoozed', tabId: 't2', snoozeId: entry.id });

		expect(resolveTabCleanupLiveState(sessions(), wake)).toEqual({ status: 'ok' });
		expect(resolveTabCleanupLiveState(sessions(), { ...wake, snoozeId: 'nope' })).toEqual({
			status: 'gone',
		});
	});

	it('protects a starred snoozed tab', () => {
		setSessions(
			agentWith('a1', [createMockAITab({ id: 't1' }), createMockAITab({ id: 't2', starred: true })])
		);
		const entry = snoozeTabWithMirror('t2', Date.now() + HOUR, undefined, {
			sessionId: 'a1',
			announce: false,
		})!;

		expect(
			resolveTabCleanupLiveState(
				sessions(),
				suggestion({ action: 'wake', kind: 'snoozed', tabId: 't2', snoozeId: entry.id })
			)
		).toEqual({ status: 'protected', protection: 'starred' });
	});
});

describe('applyTabCleanupSuggestions', () => {
	it('closes a tab on the agent it names and keeps it reopenable', () => {
		const outcome = applyTabCleanupSuggestions([suggestion({ agentId: 'a1', tabId: 't2' })]);

		expect(outcome.applied.map((s) => s.tabId)).toEqual(['t2']);
		expect(outcome.skipped).toEqual([]);
		expect(tabIds('a1')).toEqual(['t1']);
		expect(tabIds('a2')).toEqual(['t3']);
		const a1 = sessions().find((s) => s.id === 'a1')!;
		expect(a1.unifiedClosedTabHistory?.[0]).toMatchObject({ type: 'ai', tab: { id: 't2' } });
	});

	it('closes a tab on an agent that is not the active one', () => {
		const outcome = applyTabCleanupSuggestions([suggestion({ agentId: 'a2', tabId: 't3' })]);

		expect(outcome.applied).toHaveLength(1);
		expect(tabIds('a2')).not.toContain('t3');
		expect(tabIds('a1')).toEqual(['t1', 't2']);
	});

	it('snoozes until the chosen time, without a flash per tab', () => {
		const until = Date.now() + 5 * HOUR;
		const outcome = applyTabCleanupSuggestions([suggestion({ action: 'snooze', tabId: 't2' })], {
			snoozeUntil: until,
		});

		expect(outcome.applied).toHaveLength(1);
		const a1 = sessions().find((s) => s.id === 'a1')!;
		expect(a1.aiTabs.map((tab) => tab.id)).toEqual(['t1']);
		expect(a1.snoozedTabs).toHaveLength(1);
		expect(a1.snoozedTabs![0]).toMatchObject({ type: 'ai', wakeAt: until, tab: { id: 't2' } });
		expect(notifyCenterFlash).not.toHaveBeenCalled();
	});

	it('does not invent a wake time for a snooze', () => {
		const snooze = suggestion({ action: 'snooze', tabId: 't2' });
		const outcome = applyTabCleanupSuggestions([snooze]);

		expect(outcome.applied).toEqual([]);
		expect(outcome.skipped).toEqual([{ suggestion: snooze, why: 'failed' }]);
		expect(tabIds('a1')).toEqual(['t1', 't2']);
	});

	it('wakes a snoozed tab', () => {
		const entry = snoozeTabWithMirror('t2', Date.now() + HOUR, undefined, {
			sessionId: 'a1',
			announce: false,
		})!;
		expect(tabIds('a1')).toEqual(['t1']);

		const outcome = applyTabCleanupSuggestions([
			suggestion({ action: 'wake', kind: 'snoozed', tabId: 't2', snoozeId: entry.id }),
		]);

		expect(outcome.applied).toHaveLength(1);
		expect(tabIds('a1')).toContain('t2');
		expect(sessions().find((s) => s.id === 'a1')!.snoozedTabs ?? []).toEqual([]);
	});

	it.each([
		['busy', { state: 'busy' as const }],
		['starred', { starred: true }],
		['draft', { inputValue: 'do not lose this' }],
	])('leaves a %s tab alone even though it was ticked', (why, tab) => {
		setSessions(
			agentWith('a1', [createMockAITab({ id: 't1' }), createMockAITab({ id: 't2', ...tab })])
		);
		const close = suggestion({ tabId: 't2' });

		const outcome = applyTabCleanupSuggestions([close]);

		expect(outcome.applied).toEqual([]);
		expect(outcome.skipped).toEqual([{ suggestion: close, why }]);
		expect(tabIds('a1')).toEqual(['t1', 't2']);
	});

	it('reports a tab that is already gone, and keeps going', () => {
		const missing = suggestion({ tabId: 'nope' });
		const outcome = applyTabCleanupSuggestions([missing, suggestion({ tabId: 't2' })]);

		expect(outcome.skipped).toEqual([{ suggestion: missing, why: 'gone' }]);
		expect(outcome.applied.map((s) => s.tabId)).toEqual(['t2']);
	});

	it('checks each suggestion against what the one before it did', () => {
		// Two suggestions for one tab: the second finds it already closed.
		const outcome = applyTabCleanupSuggestions(
			[suggestion({ tabId: 't2' }), suggestion({ tabId: 't2', action: 'snooze' })],
			{ snoozeUntil: Date.now() + HOUR }
		);

		expect(outcome.applied.map((s) => s.action)).toEqual(['close']);
		expect(outcome.skipped.map((s) => s.why)).toEqual(['gone']);
	});

	it('does nothing for an empty batch', () => {
		expect(applyTabCleanupSuggestions([])).toEqual({ applied: [], skipped: [] });
		expect(tabIds('a1')).toEqual(['t1', 't2']);
	});
});

describe('helpers', () => {
	it('keys a suggestion by agent, action, and target', () => {
		expect(tabCleanupSuggestionKey(suggestion())).toBe('a1:close:t1');
		expect(
			tabCleanupSuggestionKey(
				suggestion({ action: 'wake', kind: 'snoozed', tabId: 't2', snoozeId: 's9' })
			)
		).toBe('a1:wake:s9');
	});

	it('summarizes what a batch did', () => {
		expect(
			describeTabCleanupOutcome([
				suggestion(),
				suggestion({ tabId: 't2' }),
				suggestion({ action: 'snooze' }),
				suggestion({ action: 'wake' }),
			])
		).toBe('Closed 2, snoozed 1, woke 1');
		expect(describeTabCleanupOutcome([suggestion({ action: 'wake' })])).toBe('Woke 1');
	});
});
