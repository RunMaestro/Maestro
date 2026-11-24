/**
 * Tab cleanup suggestions: shared, process-agnostic pieces.
 *
 * The `tab-cleanup` Local Models task reads a short list of facts about the
 * user's tabs (name, age, size, a one-line summary) and suggests which ones to
 * close, snooze, or bring back from snooze. It only ever SUGGESTS. Nothing in
 * this feature closes a tab: the Tab Cleanup Suggestions modal lists what came
 * back, the person ticks the rows they agree with, and presses Apply.
 *
 * Everything here is pure, with no Electron, Node, or DOM dependency: the reply
 * contract, the caps that keep the tab list inside a small local context, the
 * deterministic guard, and the result shape that crosses IPC and the CLI
 * bridge. Reading the tabs and calling the model is main-process only
 * (`src/main/local-models/tab-cleanup.ts`).
 *
 * The guard is the part that matters. A model can answer anything, so what it
 * says is never trusted: {@link guardTabCleanupSuggestions} drops a suggestion
 * for a tab that is busy, starred, or holding unsent composer text, whatever
 * the model said about it. The renderer runs the same {@link
 * tabCleanupProtection} against LIVE state before it shows a row and again
 * before it applies one, because the list main read is a few seconds old.
 *
 * The task can also be assigned to System One, which answers one typed choice
 * per tab ({@link tabCleanupSystemOneRequest}) instead of writing a list. Its
 * answers become the same raw suggestions, and go through the same guard.
 */

import { formatDurationWords } from './duration';
import {
	choice,
	type SystemOneAnswers,
	type SystemOneQuestions,
	type SystemOneTaskRequest,
} from './local-models/system-one';
import { formatSnoozeTarget } from './snooze';

/** What a suggestion can ask for. */
export const TAB_CLEANUP_ACTIONS = ['close', 'snooze', 'wake'] as const;

export type TabCleanupAction = (typeof TAB_CLEANUP_ACTIONS)[number];

/** Narrow an unknown value to a cleanup action. */
export function isTabCleanupAction(value: unknown): value is TabCleanupAction {
	return typeof value === 'string' && TAB_CLEANUP_ACTIONS.includes(value as TabCleanupAction);
}

/** Open in a tab strip, or parked until a wake time. */
export type TabCleanupTabKind = 'open' | 'snoozed';

/** What a snoozed entry holds. An open candidate is always an AI tab. */
export type TabCleanupTabType = 'ai' | 'file' | 'terminal' | 'browser' | 'group';

/**
 * The most tabs the model is shown in one request. A line of tab facts is
 * roughly 40 tokens, so the list at its cap is about 1,600 tokens, which leaves
 * a 4,096 token local context room for the instructions and the reply.
 */
export const TAB_CLEANUP_MAX_CANDIDATES = 40;

/** Of those, how many slots snoozed tabs may take. */
export const TAB_CLEANUP_MAX_SNOOZED = 10;

/** The most suggestions kept from one reply. */
export const TAB_CLEANUP_MAX_SUGGESTIONS = 20;

/** Longest one-line reason kept from the model. */
export const TAB_CLEANUP_REASON_MAX_LENGTH = 160;

/** Longest line of tab facts handed to the model. */
const CANDIDATE_LINE_MAX_LENGTH = 220;

/** Longest tab name or summary inside a line. */
const CANDIDATE_TEXT_MAX_LENGTH = 70;

/** Why a tab is never suggested, whatever the model says. */
export type TabCleanupProtection = 'busy' | 'starred' | 'draft';

/** The three facts the guard reads. Main and the renderer each supply their own. */
export interface TabCleanupProtectionFacts {
	/** The tab is running a turn. */
	busy: boolean;
	starred: boolean;
	/** Unsent composer text or staged images. */
	hasDraft: boolean;
}

/**
 * The reason a tab must be left alone, or `null` when it may be suggested.
 *
 * One function for both sides of the process boundary: main applies it to what
 * the sessions store and the process manager say, the renderer to the live
 * tab. Busy leads because it is the one that would destroy work in progress.
 */
export function tabCleanupProtection(
	facts: TabCleanupProtectionFacts
): TabCleanupProtection | null {
	if (facts.busy) return 'busy';
	if (facts.starred) return 'starred';
	if (facts.hasDraft) return 'draft';
	return null;
}

/** Why a tab is protected, for a person. */
export function describeTabCleanupProtection(protection: TabCleanupProtection): string {
	switch (protection) {
		case 'busy':
			return 'The agent is working in this tab.';
		case 'starred':
			return 'This tab is starred.';
		case 'draft':
			return 'This tab has an unsent draft.';
	}
}

/** The facts about one tab, as read from the app. */
export interface TabCleanupTab extends TabCleanupProtectionFacts {
	agentId: string;
	agentName: string;
	/** The tab's own id; the group's id for a parked group. */
	tabId: string;
	kind: TabCleanupTabKind;
	tabType: TabCleanupTabType;
	/** Snoozed only: the handle a wake needs. */
	snoozeId?: string;
	/** Display label: the tab's name, or how it would be named in a list. */
	label: string;
	/** Newest transcript entry, else when the tab was created or parked. */
	lastActivityAt: number;
	/** Messages the user sent, within what Maestro keeps of the transcript. */
	messageCount: number;
	/** The newest thing the user asked, flattened to one line. */
	summary?: string;
	/** Snoozed only: when it comes back by itself. */
	wakeAt?: number;
	/** Snoozed only: the note the user left themselves. */
	note?: string;
}

/** One tab the model is asked about. */
export interface TabCleanupCandidate extends TabCleanupTab {
	/**
	 * The short handle the model answers with (`T3`). The model never sees a
	 * real id: two UUIDs per tab would cost more tokens than every other fact
	 * on the line, and a small model that miscopies one character names nothing.
	 */
	ref: string;
}

/** One suggestion that survived the guard. Crosses IPC and the CLI bridge. */
export interface TabCleanupSuggestion {
	tabId: string;
	agentId: string;
	action: TabCleanupAction;
	/** One line from the model on why. */
	reason: string;
	agentName: string;
	label: string;
	kind: TabCleanupTabKind;
	tabType: TabCleanupTabType;
	/** Present on a `wake`: the snooze to bring back. */
	snoozeId?: string;
	lastActivityAt: number;
	messageCount: number;
	wakeAt?: number;
}

/**
 * Why a run produced no suggestions list.
 *
 * - `off`          - the task is switched off (the default).
 * - `unavailable`  - the assigned model or endpoint could not run.
 * - `unusable`     - the model answered, but not with the reply object.
 * - `cancelled`    - the model took too long.
 */
export type TabCleanupFailure = 'off' | 'unavailable' | 'unusable' | 'cancelled';

export type TabCleanupResult =
	| {
			success: true;
			suggestions: TabCleanupSuggestion[];
			/** Tabs the model was shown. */
			considered: number;
			/** Tabs left out before the model was asked: busy, starred, or drafting. */
			protectedCount: number;
			/** Suggestions the guard removed from the model's reply. */
			droppedCount: number;
			/** True when there were more tabs than {@link TAB_CLEANUP_MAX_CANDIDATES}. */
			truncated: boolean;
			/** The local model or endpoint that answered, named for a person. */
			producedBy?: string;
	  }
	| {
			success: false;
			status: TabCleanupFailure;
			/** Written for a person. Shown in the modal and printed by the CLI. */
			error: string;
			producedBy?: string;
	  };

/** The handle for the candidate at `index` (zero-based): `T1`, `T2`, ... */
export function tabCleanupRef(index: number): string {
	return `T${index + 1}`;
}

/**
 * The reply shape `tab-cleanup-local.md` asks for.
 *
 * `tab` is an enum of every handle a request can use, so a model running under
 * a grammar cannot invent one. It is the SAME schema for every request (not one
 * built from the handles in play) because the local engine caches a compiled
 * grammar per schema: a schema per tab count would compile and hold forty of
 * them. A handle past the end of this request's list is the guard's to drop.
 */
export const TAB_CLEANUP_REPLY_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		suggestions: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					tab: {
						type: 'string',
						enum: Array.from({ length: TAB_CLEANUP_MAX_CANDIDATES }, (_, i) => tabCleanupRef(i)),
					},
					action: { type: 'string', enum: [...TAB_CLEANUP_ACTIONS] },
					reason: { type: 'string', maxLength: TAB_CLEANUP_REASON_MAX_LENGTH },
				},
				required: ['tab', 'action', 'reason'],
				additionalProperties: false,
			},
		},
	},
	required: ['suggestions'],
	additionalProperties: false,
};

/** A suggestion as the model wrote it, before anything is checked. */
export interface RawTabCleanupSuggestion {
	ref: string;
	action: TabCleanupAction;
	reason: string;
}

/** Flatten to one line and cap the length. */
function flattenToLine(value: string, maxLength: number): string {
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length > maxLength ? `${flat.slice(0, maxLength - 3).trimEnd()}...` : flat;
}

/**
 * Read a reply written against {@link TAB_CLEANUP_REPLY_SCHEMA}.
 *
 * `json` is the parsed reply when it parsed, else undefined. Returns `null`
 * when the reply is not the object at all (the run is unusable), and a list,
 * possibly empty, when it is: "nothing to clean up" is a real answer. An entry
 * that is malformed on its own is skipped rather than failing the reply, since
 * an endpoint that ignores the schema can still get most rows right.
 */
export function parseTabCleanupReply(json: unknown): RawTabCleanupSuggestion[] | null {
	if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
	const list = (json as Record<string, unknown>).suggestions;
	if (!Array.isArray(list)) return null;

	const suggestions: RawTabCleanupSuggestion[] = [];
	for (const item of list) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;
		if (typeof record.tab !== 'string' || !isTabCleanupAction(record.action)) continue;
		const ref = record.tab.trim().toUpperCase();
		if (ref === '') continue;
		suggestions.push({
			ref,
			action: record.action,
			reason:
				typeof record.reason === 'string'
					? flattenToLine(record.reason, TAB_CLEANUP_REASON_MAX_LENGTH)
					: '',
		});
	}
	return suggestions;
}

/** Why the guard removed a suggestion. */
export type TabCleanupDropReason =
	| TabCleanupProtection
	/** The handle names no tab in this request. */
	| 'unknown-tab'
	/** `wake` on an open tab, or `close` / `snooze` on a parked one. */
	| 'wrong-action'
	/** A second suggestion for a tab that already has one. */
	| 'duplicate'
	/** Past {@link TAB_CLEANUP_MAX_SUGGESTIONS}. */
	| 'over-limit';

export interface TabCleanupDrop {
	ref: string;
	action: TabCleanupAction;
	why: TabCleanupDropReason;
}

/** Whether `action` means anything for a tab of this kind. */
export function isTabCleanupActionValidFor(
	action: TabCleanupAction,
	kind: TabCleanupTabKind
): boolean {
	return kind === 'snoozed' ? action === 'wake' : action !== 'wake';
}

/**
 * The deterministic guard: turn what the model said into what may be shown.
 *
 * Runs AFTER the model and trusts nothing it wrote. `candidates` carries each
 * tab's facts as they are NOW (see {@link rebindTabCleanupCandidates}), so a
 * tab that became busy, starred, or gained a draft while the model was
 * thinking is caught here even though no protected tab is ever put in the
 * prompt. The first suggestion for a tab wins.
 */
export function guardTabCleanupSuggestions(
	raw: readonly RawTabCleanupSuggestion[],
	candidates: readonly TabCleanupCandidate[]
): { suggestions: TabCleanupSuggestion[]; dropped: TabCleanupDrop[] } {
	const byRef = new Map(candidates.map((candidate) => [candidate.ref.toUpperCase(), candidate]));
	const suggestions: TabCleanupSuggestion[] = [];
	const dropped: TabCleanupDrop[] = [];
	const seen = new Set<string>();

	for (const item of raw) {
		const drop = (why: TabCleanupDropReason) =>
			dropped.push({ ref: item.ref, action: item.action, why });

		const candidate = byRef.get(item.ref.toUpperCase());
		if (!candidate) {
			drop('unknown-tab');
			continue;
		}
		const protection = tabCleanupProtection(candidate);
		if (protection) {
			drop(protection);
			continue;
		}
		if (!isTabCleanupActionValidFor(item.action, candidate.kind)) {
			drop('wrong-action');
			continue;
		}
		if (candidate.kind === 'snoozed' && !candidate.snoozeId) {
			// A wake with no snooze to name could not be applied.
			drop('unknown-tab');
			continue;
		}
		if (seen.has(candidate.ref)) {
			drop('duplicate');
			continue;
		}
		if (suggestions.length >= TAB_CLEANUP_MAX_SUGGESTIONS) {
			drop('over-limit');
			continue;
		}
		seen.add(candidate.ref);
		suggestions.push({
			tabId: candidate.tabId,
			agentId: candidate.agentId,
			action: item.action,
			reason: item.reason,
			agentName: candidate.agentName,
			label: candidate.label,
			kind: candidate.kind,
			tabType: candidate.tabType,
			...(candidate.snoozeId ? { snoozeId: candidate.snoozeId } : {}),
			lastActivityAt: candidate.lastActivityAt,
			messageCount: candidate.messageCount,
			...(candidate.wakeAt !== undefined ? { wakeAt: candidate.wakeAt } : {}),
		});
	}
	return { suggestions, dropped };
}

/** Candidates split into what the model is shown and what it is not. */
export interface TabCleanupSelection {
	/** In prompt order, each with its final `ref`. */
	shown: TabCleanupCandidate[];
	/** Left out because they are busy, starred, or drafting. */
	protectedCount: number;
	/** True when eligible tabs were left out to fit the cap. */
	truncated: boolean;
}

/**
 * Pick the tabs the model is shown, and number them.
 *
 * Protected tabs are left out before the model is asked: it cannot suggest
 * what it never saw, and they would only spend the context. When there are
 * more eligible tabs than fit, the ones left longest untouched are kept, since
 * those are the ones a cleanup is about. Snoozed tabs get a bounded share so a
 * long snooze list cannot crowd out every open tab.
 */
export function selectTabCleanupCandidates(tabs: readonly TabCleanupTab[]): TabCleanupSelection {
	const eligible = tabs.filter((tab) => tabCleanupProtection(tab) === null);
	const oldestFirst = (a: TabCleanupTab, b: TabCleanupTab) => a.lastActivityAt - b.lastActivityAt;

	const snoozed = eligible
		.filter((tab) => tab.kind === 'snoozed')
		.sort(oldestFirst)
		.slice(0, TAB_CLEANUP_MAX_SNOOZED);
	const open = eligible
		.filter((tab) => tab.kind === 'open')
		.sort(oldestFirst)
		.slice(0, TAB_CLEANUP_MAX_CANDIDATES - snoozed.length);

	const shown = [...open, ...snoozed].map((tab, index) => ({ ...tab, ref: tabCleanupRef(index) }));
	return {
		shown,
		protectedCount: tabs.length - eligible.length,
		truncated: shown.length < eligible.length,
	};
}

/** What makes two reads of the app name the same tab. */
function tabCleanupKey(
	tab: Pick<TabCleanupTab, 'agentId' | 'kind' | 'tabId' | 'snoozeId'>
): string {
	return [tab.agentId, tab.kind, tab.kind === 'snoozed' ? (tab.snoozeId ?? '') : tab.tabId].join(
		'\n'
	);
}

/**
 * Bring the tabs the model was shown up to date with a second read of the app.
 *
 * A local model can take a minute to answer, and in that minute a tab can
 * start a turn, be starred, gain a draft, be closed, or wake. So the guard is
 * run against what is true AFTER the model answered, not what was true when it
 * was asked: each shown tab keeps its handle and takes the fresh facts, and a
 * tab that is no longer there is left out, which makes any suggestion for it
 * an unknown handle.
 */
export function rebindTabCleanupCandidates(
	shown: readonly TabCleanupCandidate[],
	fresh: readonly TabCleanupTab[]
): TabCleanupCandidate[] {
	const byKey = new Map(fresh.map((tab) => [tabCleanupKey(tab), tab]));
	const rebound: TabCleanupCandidate[] = [];
	for (const candidate of shown) {
		const current = byKey.get(tabCleanupKey(candidate));
		if (current) rebound.push({ ...current, ref: candidate.ref });
	}
	return rebound;
}

/**
 * How long ago a tab was last touched, as the model and the list read it:
 * `"3 weeks ago"`, `"just now"`. One unit, because the question a cleanup asks
 * is days against weeks, and an absolute date means nothing to a model that is
 * not told today's.
 */
export function formatTabCleanupAge(at: number, now: number): string {
	const age = now - at;
	if (!Number.isFinite(age) || age < 60_000) return 'just now';
	return `${formatDurationWords(age, 1)} ago`;
}

/** The facts about one candidate, in the order a line states them. No handle. */
function candidateFacts(candidate: TabCleanupCandidate, now: number): string[] {
	const parts = [
		candidate.kind === 'snoozed' && candidate.wakeAt !== undefined
			? `snoozed until ${formatSnoozeTarget(candidate.wakeAt, now)}`
			: candidate.kind,
		`agent "${flattenToLine(candidate.agentName, 40)}"`,
		`"${flattenToLine(candidate.label, CANDIDATE_TEXT_MAX_LENGTH)}"`,
		`last active ${formatTabCleanupAge(candidate.lastActivityAt, now)}`,
	];
	if (candidate.tabType === 'ai') {
		parts.push(
			`${candidate.messageCount} ${candidate.messageCount === 1 ? 'message' : 'messages'}`
		);
	} else {
		parts.push(candidate.tabType);
	}
	if (candidate.note)
		parts.push(`note: ${flattenToLine(candidate.note, CANDIDATE_TEXT_MAX_LENGTH)}`);
	if (candidate.summary) {
		parts.push(`last asked: ${flattenToLine(candidate.summary, CANDIDATE_TEXT_MAX_LENGTH)}`);
	}
	return parts;
}

/** One candidate as a line of facts, led by its handle. */
function formatCandidateLine(candidate: TabCleanupCandidate, now: number): string {
	return flattenToLine(
		[candidate.ref, ...candidateFacts(candidate, now)].join(' | '),
		CANDIDATE_LINE_MAX_LENGTH
	);
}

/**
 * The user-turn text for the model: one line of facts per tab. `shown` is what
 * {@link selectTabCleanupCandidates} returned, already capped and numbered.
 */
export function formatTabCleanupInput(shown: readonly TabCleanupCandidate[], now: number): string {
	return ['Tabs:', ...shown.map((candidate) => formatCandidateLine(candidate, now))].join('\n');
}

/** What the task asks a System One engine about: the tabs the model path would be shown. */
export interface TabCleanupSystemOneInput {
	/** What {@link selectTabCleanupCandidates} returned, already capped. */
	candidates: readonly TabCleanupCandidate[];
	now: number;
}

/** The option that leaves a tab as it is. Never becomes a suggestion. */
export const TAB_CLEANUP_KEEP_OPTION = 'keep';

/** What every tab's question is judged against. A state cannot be empty. */
const TAB_CLEANUP_SYSTEM_ONE_STATE =
	'A person is tidying the tabs of Maestro, a desktop app that runs AI coding agents. Each question describes one tab and asks what to do with it. Nothing is done without their confirmation.';

/**
 * The id of the question about one tab: the tab's own id, or the snooze's id
 * for a parked one (the handle a wake needs). Never the tab's place in the
 * list: an engine answers by question id, so the real id costs nothing here,
 * and an answer can only ever name the tab it was asked about.
 */
export function tabCleanupQuestionId(
	candidate: Pick<TabCleanupCandidate, 'kind' | 'tabId' | 'snoozeId'>
): string {
	return candidate.kind === 'snoozed' ? (candidate.snoozeId ?? candidate.tabId) : candidate.tabId;
}

/**
 * The cleanup as a System One request: one choice per tab, keyed by the tab's
 * id, with the tab's facts INSIDE its own question. An engine is never asked
 * to find one tab in a list of forty, which is where indexed answers go wrong.
 *
 * An open tab is offered close, snooze or keep, and a snoozed one wake or
 * keep, in the words `tab-cleanup-local` gives a model, so an action that
 * means nothing for a tab cannot be answered. `keep` is the answer for a tab
 * the engine is not sure about.
 */
export function tabCleanupSystemOneRequest(input: TabCleanupSystemOneInput): SystemOneTaskRequest {
	const questions: SystemOneQuestions = {};
	for (const candidate of input.candidates) {
		const facts = flattenToLine(
			candidateFacts(candidate, input.now).join(' | '),
			CANDIDATE_LINE_MAX_LENGTH
		);
		questions[tabCleanupQuestionId(candidate)] = choice(
			`What should be done with this tab? ${facts}`,
			candidate.kind === 'snoozed'
				? {
						wake: 'Bring it back: its note or last request looks relevant again, or its wake time has already passed.',
						[TAB_CLEANUP_KEEP_OPTION]: 'Leave it snoozed. Choose this when not sure.',
					}
				: {
						close:
							'It looks finished or abandoned: not touched in weeks, empty, or its last request reads as done.',
						snooze:
							'It has gone quiet but looks like unfinished work the person will come back to.',
						[TAB_CLEANUP_KEEP_OPTION]:
							'Leave it open. Choose this when not sure, and for a tab that was active in the last day.',
					}
		);
	}
	return { state: TAB_CLEANUP_SYSTEM_ONE_STATE, questions };
}

/**
 * Read System One answers as the raw suggestions a model reply would hold, so
 * {@link guardTabCleanupSuggestions} checks them exactly as it checks a model.
 *
 * An engine gives a choice and no sentence, so the reason says who chose and,
 * when the engine reports one, how likely it held the choice to be. `keep`
 * suggests nothing. Returns `null` when no tab got a choice at all (the run is
 * unusable); a tab with no usable answer of its own is skipped.
 */
export function tabCleanupReplyFromSystemOne(
	answers: SystemOneAnswers,
	candidates: readonly TabCleanupCandidate[],
	engineLabel: string
): RawTabCleanupSuggestion[] | null {
	const suggestions: RawTabCleanupSuggestion[] = [];
	let answered = 0;
	for (const candidate of candidates) {
		const answer = answers[tabCleanupQuestionId(candidate)];
		if (answer?.type !== 'choice') continue;
		answered += 1;
		if (!isTabCleanupAction(answer.choice)) continue;
		const probability = answer.probabilities?.[answer.choice];
		const likelihood =
			typeof probability === 'number' && Number.isFinite(probability)
				? `, ${Math.round(probability * 100)}% likely`
				: '';
		suggestions.push({
			ref: candidate.ref,
			action: answer.choice,
			reason: flattenToLine(
				`${engineLabel} chose ${answer.choice}${likelihood}.`,
				TAB_CLEANUP_REASON_MAX_LENGTH
			),
		});
	}
	return answered === 0 && candidates.length > 0 ? null : suggestions;
}

/** One line on what a successful run looked at, for the modal footer and the CLI. */
export function describeTabCleanupCoverage(
	result: Extract<TabCleanupResult, { success: true }>
): string {
	const parts = [`${result.considered} ${result.considered === 1 ? 'tab' : 'tabs'} reviewed`];
	if (result.protectedCount > 0) {
		parts.push(`${result.protectedCount} left out (busy, starred, or with a draft)`);
	}
	if (result.truncated) parts.push('more tabs than fit, the oldest were reviewed');
	return parts.join(', ');
}

/**
 * The `maestro-cli` command that applies one suggestion.
 *
 * `maestro-cli tab suggest-cleanup` is read-only, so it prints this beside each
 * row: an agent that agrees with a suggestion runs the ordinary verb for it,
 * which is the same path the modal's Apply takes. A snooze needs a wake time
 * only the caller can choose, so it is left as `<when>`.
 */
export function tabCleanupApplyCommand(
	suggestion: Pick<TabCleanupSuggestion, 'action' | 'tabId' | 'agentId' | 'snoozeId'>
): string {
	switch (suggestion.action) {
		case 'close':
			return `maestro-cli tab close ${suggestion.tabId}`;
		case 'snooze':
			return `maestro-cli snooze tab ${suggestion.tabId} <when> --agent ${suggestion.agentId}`;
		case 'wake':
			return `maestro-cli snooze wake ${suggestion.snoozeId ?? '<snooze-id>'}`;
	}
}
