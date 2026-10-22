/**
 * Tab cleanup suggestions, renderer half: check a suggestion against the LIVE
 * tab, and apply the ones the user ticked.
 *
 * The list comes from main (`window.maestro.localModels.suggestTabCleanup`),
 * which reads the sessions store. That store is a few seconds behind this
 * process, and the model that wrote the list is not trusted at all, so every
 * suggestion is checked here against the tab as it is right now, with the same
 * `tabCleanupProtection` rule main used: a tab that is busy, starred, or
 * holding an unsent draft is never acted on. The check runs twice, when a row
 * is drawn and again the instant before it is applied, because the modal can
 * sit open while an agent starts a turn.
 *
 * Applying is three existing paths and nothing new: a close goes through
 * `closeAiTabInSession` (so it lands in the closed-tab history and Reopen
 * Closed Tab brings it back), a snooze through `snoozeTabWithMirror`, a wake
 * through `wakeSnoozeNow`. Nothing here runs without a row the user ticked.
 *
 * Module functions, not a hook: the apply step reads the store per suggestion
 * so an earlier action in the same batch is seen by the next one.
 */

import {
	tabCleanupProtection,
	type TabCleanupAction,
	type TabCleanupProtection,
	type TabCleanupSuggestion,
} from '../../shared/tabCleanup';
import { useSessionStore } from '../stores/sessionStore';
import type { Session } from '../types';
import { hasActiveWizard, hasDraft, visibleAiTabs } from '../utils/tabHelpers';
import { closeAiTabInSession } from './aiTabClose';
import { snoozeTabWithMirror, wakeSnoozeNow } from './snoozeActions';

/** What a suggestion's tab looks like right now. */
export type TabCleanupLiveState =
	| { status: 'ok' }
	/** The agent, the tab, or the snooze is no longer there. */
	| { status: 'gone' }
	| { status: 'protected'; protection: TabCleanupProtection };

/** Stable key for one suggestion: list keys, the ticked set. */
export function tabCleanupSuggestionKey(suggestion: TabCleanupSuggestion): string {
	return [
		suggestion.agentId,
		suggestion.action,
		suggestion.kind === 'snoozed' ? (suggestion.snoozeId ?? '') : suggestion.tabId,
	].join(':');
}

/**
 * Check one suggestion against the live sessions.
 *
 * An open tab is looked up among the VISIBLE AI tabs only: a hidden consult tab
 * has no chip, so a suggestion can never act on one even if an id matched. A
 * tab in the middle of an inline wizard counts as busy, since closing it throws
 * the wizard away.
 */
export function resolveTabCleanupLiveState(
	sessions: readonly Session[],
	suggestion: TabCleanupSuggestion
): TabCleanupLiveState {
	const session = sessions.find((s) => s.id === suggestion.agentId);
	if (!session) return { status: 'gone' };

	if (suggestion.kind === 'snoozed') {
		const entry = session.snoozedTabs?.find((s) => s.id === suggestion.snoozeId);
		if (!entry) return { status: 'gone' };
		const protection =
			entry.type === 'ai'
				? tabCleanupProtection({
						busy: false,
						starred: entry.tab.starred === true,
						hasDraft: hasDraft(entry.tab),
					})
				: null;
		return protection ? { status: 'protected', protection } : { status: 'ok' };
	}

	const tab = visibleAiTabs(session.aiTabs).find((t) => t.id === suggestion.tabId);
	if (!tab) return { status: 'gone' };
	const protection = tabCleanupProtection({
		busy: tab.state === 'busy' || hasActiveWizard(tab),
		starred: tab.starred === true,
		hasDraft: hasDraft(tab),
	});
	return protection ? { status: 'protected', protection } : { status: 'ok' };
}

/** Why a ticked suggestion was not applied. */
export type TabCleanupSkipReason = 'gone' | TabCleanupProtection | 'failed';

export interface TabCleanupApplyOutcome {
	applied: TabCleanupSuggestion[];
	skipped: Array<{ suggestion: TabCleanupSuggestion; why: TabCleanupSkipReason }>;
}

export interface TabCleanupApplyOptions {
	/** When every snoozed tab in this batch comes back (ms epoch). */
	snoozeUntil?: number;
}

/**
 * Apply the suggestions the user ticked, in order.
 *
 * Each one is re-checked against the store immediately before it runs, so a
 * tab that started a turn while the modal was open is skipped rather than
 * closed, and a suggestion made redundant by an earlier one in the batch is
 * reported as gone. A snooze with no wake time is skipped as failed rather
 * than being given one the user never chose.
 */
export function applyTabCleanupSuggestions(
	suggestions: readonly TabCleanupSuggestion[],
	options: TabCleanupApplyOptions = {}
): TabCleanupApplyOutcome {
	const outcome: TabCleanupApplyOutcome = { applied: [], skipped: [] };

	for (const suggestion of suggestions) {
		const live = resolveTabCleanupLiveState(useSessionStore.getState().sessions, suggestion);
		if (live.status !== 'ok') {
			outcome.skipped.push({
				suggestion,
				why: live.status === 'protected' ? live.protection : 'gone',
			});
			continue;
		}

		let done = false;
		switch (suggestion.action) {
			case 'close':
				done = closeAiTabInSession(suggestion.agentId, suggestion.tabId);
				break;
			case 'snooze':
				done =
					options.snoozeUntil !== undefined &&
					snoozeTabWithMirror(suggestion.tabId, options.snoozeUntil, undefined, {
						sessionId: suggestion.agentId,
						// One summary for the batch, not a flash per tab.
						announce: false,
					}) !== null;
				break;
			case 'wake':
				done =
					suggestion.snoozeId !== undefined &&
					wakeSnoozeNow(suggestion.agentId, suggestion.snoozeId) !== null;
				break;
		}

		if (done) outcome.applied.push(suggestion);
		else outcome.skipped.push({ suggestion, why: 'failed' });
	}
	return outcome;
}

const ACTION_PAST_TENSE: Record<TabCleanupAction, string> = {
	close: 'closed',
	snooze: 'snoozed',
	wake: 'woke',
};

/** `"Closed 2, snoozed 1"`: what a batch did, for the confirmation flash. */
export function describeTabCleanupOutcome(applied: readonly TabCleanupSuggestion[]): string {
	const parts: string[] = [];
	for (const action of ['close', 'snooze', 'wake'] as const) {
		const count = applied.filter((s) => s.action === action).length;
		if (count > 0) parts.push(`${ACTION_PAST_TENSE[action]} ${count}`);
	}
	const text = parts.join(', ');
	return text.charAt(0).toUpperCase() + text.slice(1);
}
