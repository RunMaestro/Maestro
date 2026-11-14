/**
 * Tab cleanup suggestions: ask the `tab-cleanup` Local Models assignment which
 * tabs could be closed, snoozed, or brought back from snooze.
 *
 * One implementation for both callers: the Tab Cleanup Suggestions modal
 * (`localModels:suggestTabCleanup`) and `maestro-cli tab suggest-cleanup`
 * (`local_models_tab_cleanup` over the CLI bridge). Both read the same tabs,
 * the same assignment, and get the same result shape.
 *
 * It only ever returns a list. Nothing here closes, snoozes, or wakes a tab:
 * the modal applies what the person ticks, through the same close and snooze
 * paths a click takes, and the CLI applies nothing at all (an agent uses
 * `maestro-cli tab close` and `maestro-cli snooze` for that).
 *
 * What the model says is never trusted. A tab that is busy, starred, or
 * holding unsent composer text is left out of the prompt, and the reply is
 * then guarded against a SECOND read of the app taken after the model
 * answered, so a tab that started a turn or gained a draft in the meantime is
 * dropped too. See `guardTabCleanupSuggestions` in `src/shared/tabCleanup.ts`.
 *
 * The verdicts, none of which falls back to an agent:
 *   - `off` is the default. Tab cleanup is new with Local Models and has no
 *     agent path, so there is nothing to keep using.
 *   - `unavailable` and `cancelled` fail with the reason, which the modal shows
 *     in place of the list.
 *
 * Assigned to System One, the engine in force is asked one typed choice per
 * tab (`runSystemOneTask`) instead of a model writing a list. Its answers are
 * read as the same raw suggestions and go through the same guard, so a caller
 * sees one result shape; `producedBy` names the engine.
 */

import { getSessionIdsBusyWithCli } from '../../shared/cli-activity';
import {
	LOCAL_MODEL_TASKS,
	localModelAssignmentSourceLabel,
	resolveLocalModelAssignment,
} from '../../shared/local-models/tasks';
import { taskAssignmentLocation } from '../../shared/local-models/settings-location';
import { snoozedEntryLabel, type SnoozedEntryLabelSource } from '../../shared/snooze';
import {
	TAB_CLEANUP_REPLY_SCHEMA,
	formatTabCleanupInput,
	guardTabCleanupSuggestions,
	parseTabCleanupReply,
	rebindTabCleanupCandidates,
	selectTabCleanupCandidates,
	tabCleanupReplyFromSystemOne,
	type RawTabCleanupSuggestion,
	type TabCleanupResult,
	type TabCleanupSelection,
	type TabCleanupTab,
	type TabCleanupTabType,
} from '../../shared/tabCleanup';
import { getPrompt } from '../prompt-manager';
import { isAiTabProcessActive, type ProcessLivenessProbe } from '../utils/agent-busy';
import { logger } from '../utils/logger';
import { getConfiguredLocalModelEndpoints } from './endpoint-service';
import { readLocalModelAssignments } from './sources';
import { runLocalTask, runSystemOneTask } from './task-router';

const LOG_CONTEXT = '[TabCleanup]';

const TASK_ID = 'tab-cleanup';

/** Where a person assigns the task's source, for refusal text. */
const ASSIGNMENT_LOCATION = taskAssignmentLocation(TASK_ID);

/** Room for the suggestion cap at about forty tokens a row, as JSON. */
const TAB_CLEANUP_MAX_TOKENS = 900;

/**
 * How long the model may take. Long enough for a cold local model to load and
 * write a few hundred tokens; the person is watching a spinner in a modal.
 */
export const TAB_CLEANUP_TIMEOUT_MS = 120 * 1000;

const SNOOZED_TYPES: readonly TabCleanupTabType[] = ['ai', 'file', 'terminal', 'browser', 'group'];

interface StoredLog {
	timestamp?: unknown;
	source?: unknown;
	text?: unknown;
}

interface StoredAiTab {
	id?: unknown;
	name?: unknown;
	hidden?: unknown;
	starred?: unknown;
	inputValue?: unknown;
	stagedImages?: unknown;
	createdAt?: unknown;
	logs?: unknown;
}

function fail(
	status: Extract<TabCleanupResult, { success: false }>['status'],
	error: string,
	producedBy?: string
): TabCleanupResult {
	return { success: false, status, error, ...(producedBy && { producedBy }) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Unsent composer text or staged images, the same test the close path asks. */
function hasStoredDraft(tab: StoredAiTab): boolean {
	const text = typeof tab.inputValue === 'string' ? tab.inputValue : '';
	return text.trim() !== '' || (Array.isArray(tab.stagedImages) && tab.stagedImages.length > 0);
}

/** What a tab's persisted transcript says about its size and age. */
function transcriptFacts(tab: StoredAiTab): {
	lastLogAt: number | undefined;
	messageCount: number;
	lastAsked: string | undefined;
} {
	const logs = Array.isArray(tab.logs) ? (tab.logs as StoredLog[]) : [];
	let lastLogAt: number | undefined;
	let messageCount = 0;
	let lastAsked: string | undefined;
	for (const log of logs) {
		if (!log) continue;
		const at = finiteNumber(log.timestamp);
		if (at !== undefined && (lastLogAt === undefined || at > lastLogAt)) lastLogAt = at;
		if (log.source === 'user' && typeof log.text === 'string' && log.text.trim() !== '') {
			messageCount += 1;
			lastAsked = log.text;
		}
	}
	return { lastLogAt, messageCount, lastAsked };
}

/** What an AI tab's own record says, wherever the tab is (open or parked). */
type AiTabFacts = Pick<
	TabCleanupTab,
	'label' | 'messageCount' | 'summary' | 'starred' | 'hasDraft'
> & { lastLogAt: number | undefined };

/** The facts for one AI tab, open or parked. */
function aiTabFacts(tab: StoredAiTab): AiTabFacts {
	const { lastLogAt, messageCount, lastAsked } = transcriptFacts(tab);
	const label = snoozedEntryLabel({ type: 'ai', tab: tab as SnoozedEntryLabelSource['tab'] });
	// An unnamed tab is labeled by its opening message. When that is also the
	// only thing asked, repeating it as the summary would spend the line twice.
	const summary = lastAsked !== undefined && messageCount > 1 ? lastAsked : undefined;
	return {
		label,
		messageCount,
		...(summary ? { summary } : {}),
		starred: tab.starred === true,
		hasDraft: hasStoredDraft(tab),
		lastLogAt,
	};
}

export interface TabCleanupCollectOptions {
	/** Whether a live agent process is attached to this tab. */
	isTabBusy: (agentId: string, tabId: string, isActiveTab: boolean) => boolean;
	/** Agents the CLI is running a playbook against; every tab of one counts as busy. */
	cliBusyAgentIds?: ReadonlySet<string>;
}

/**
 * Every tab a cleanup may be asked about, read from the sessions store.
 *
 * - An agent's VISIBLE AI tabs. A hidden tab (a cross-agent consult answered
 *   in the background) has no chip in the tab strip, so it is never listed:
 *   suggesting one would ask the user to act on a tab they were never shown.
 * - Its snoozed tabs, of every kind, since any parked tab can be woken.
 *
 * Busy cannot be read from the stored record, which is rewritten to idle on
 * its way to disk, so it is asked of the process manager per tab. The store is
 * a few seconds behind the app, which is why the renderer checks the live tab
 * again before it shows or applies a suggestion.
 */
export function collectTabCleanupTabs(
	sessions: ReadonlyArray<Record<string, unknown>>,
	options: TabCleanupCollectOptions
): TabCleanupTab[] {
	const tabs: TabCleanupTab[] = [];
	for (const session of sessions) {
		const agentId = typeof session?.id === 'string' ? session.id : '';
		if (agentId === '') continue;
		const agentName =
			typeof session.name === 'string' && session.name.trim() !== '' ? session.name : agentId;
		const cliBusy = options.cliBusyAgentIds?.has(agentId) === true;

		const aiTabs = Array.isArray(session.aiTabs) ? (session.aiTabs as StoredAiTab[]) : [];
		for (const tab of aiTabs) {
			if (!tab || typeof tab.id !== 'string' || tab.id === '' || tab.hidden === true) continue;
			const { lastLogAt, ...facts } = aiTabFacts(tab);
			tabs.push({
				agentId,
				agentName,
				tabId: tab.id,
				kind: 'open',
				tabType: 'ai',
				...facts,
				lastActivityAt: lastLogAt ?? finiteNumber(tab.createdAt) ?? 0,
				busy: cliBusy || options.isTabBusy(agentId, tab.id, tab.id === session.activeTabId),
			});
		}

		const snoozed = Array.isArray(session.snoozedTabs) ? session.snoozedTabs : [];
		for (const value of snoozed) {
			const entry = asRecord(value);
			if (!entry || typeof entry.id !== 'string' || entry.id === '') continue;
			const tabType = SNOOZED_TYPES.find((type) => type === entry.type);
			if (!tabType) continue;
			const payload = asRecord(tabType === 'group' ? entry.group : entry.tab);
			if (!payload || typeof payload.id !== 'string' || payload.id === '') continue;

			const ai = tabType === 'ai' ? aiTabFacts(payload as StoredAiTab) : null;
			const wakeAt = finiteNumber(entry.wakeAt);
			const note = typeof entry.note === 'string' ? entry.note.trim() : '';
			tabs.push({
				agentId,
				agentName,
				tabId: payload.id,
				kind: 'snoozed',
				tabType,
				snoozeId: entry.id,
				label: ai?.label ?? snoozedEntryLabel(entry as unknown as SnoozedEntryLabelSource),
				// A parked tab is not being used, so when it was parked is when it
				// was last touched.
				lastActivityAt: finiteNumber(entry.snoozedAt) ?? ai?.lastLogAt ?? 0,
				messageCount: ai?.messageCount ?? 0,
				...(ai?.summary ? { summary: ai.summary } : {}),
				...(wakeAt !== undefined ? { wakeAt } : {}),
				...(note ? { note } : {}),
				// A parked tab has no process to be busy with.
				busy: false,
				starred: ai?.starred ?? false,
				hasDraft: ai?.hasDraft ?? false,
			});
		}
	}
	return tabs;
}

/** Where a running app keeps what this reads. Injected so a test passes arrays. */
export interface TabCleanupStores {
	/** Every agent record in the sessions store. */
	sessions: () => Array<Record<string, unknown>>;
	/** The process manager, or null before it exists. */
	processManager: () => ProcessLivenessProbe | null;
	/** Agents with a live CLI playbook run. Defaults to the CLI activity file. */
	cliBusyAgentIds?: () => ReadonlySet<string>;
	now?: () => number;
}

let configured: TabCleanupStores | null = null;

/** Point the task at the app's stores. Called once at startup. `null` unsets it. */
export function configureTabCleanup(stores: TabCleanupStores | null): void {
	configured = stores;
}

function readTabs(stores: TabCleanupStores): TabCleanupTab[] {
	const processManager = stores.processManager();
	return collectTabCleanupTabs(stores.sessions(), {
		isTabBusy: (agentId, tabId, isActiveTab) =>
			isAiTabProcessActive(processManager, agentId, tabId, isActiveTab),
		cliBusyAgentIds: (stores.cliBusyAgentIds ?? getSessionIdsBusyWithCli)(),
	});
}

/**
 * Turn what was answered into what may be shown, whoever answered.
 *
 * Guards against the app as it is NOW. A model may have taken a minute, and a
 * tab can start a turn or gain a draft in that time.
 */
function guardedResult(
	raw: readonly RawTabCleanupSuggestion[],
	selection: TabCleanupSelection,
	stores: TabCleanupStores,
	producedBy: string | undefined,
	logged: Record<string, unknown>
): TabCleanupResult {
	const current = rebindTabCleanupCandidates(selection.shown, readTabs(stores));
	const { suggestions, dropped } = guardTabCleanupSuggestions(raw, current);
	logger.info('Tab cleanup suggestions ready', LOG_CONTEXT, {
		...logged,
		considered: selection.shown.length,
		suggested: suggestions.length,
		dropped: dropped.map((drop) => drop.why),
	});
	return {
		success: true,
		suggestions,
		considered: selection.shown.length,
		protectedCount: selection.protectedCount,
		droppedCount: dropped.length,
		truncated: selection.truncated,
		...(producedBy && { producedBy }),
	};
}

/**
 * Suggest tabs to close, snooze, or wake, across every agent.
 *
 * Throws only for an unclassified failure inside the model engine, which is a
 * bug (the task router reports it; see `runLocalTask`).
 */
export async function suggestTabCleanup(
	stores: TabCleanupStores | null = configured
): Promise<TabCleanupResult> {
	const task = LOCAL_MODEL_TASKS[TASK_ID];
	const offMessage = `${task.label} is off. Assign it a local model or an endpoint in ${ASSIGNMENT_LOCATION}.`;

	// Answer `off` before reading a single tab: a task that is switched off
	// reads nothing. Same resolver the router uses below.
	const assignment = resolveLocalModelAssignment(readLocalModelAssignments(), TASK_ID);
	if (assignment.type === 'off') return fail('off', offMessage);

	if (!stores) {
		// A transport can be asked before startup has wired the stores.
		return fail('unavailable', 'Tab cleanup is not ready yet. Maestro is still starting.');
	}
	const now = (stores.now ?? Date.now)();

	const selection = selectTabCleanupCandidates(readTabs(stores));
	if (selection.shown.length === 0) {
		// Nothing the model could be asked about, so it is not asked.
		return {
			success: true,
			suggestions: [],
			considered: 0,
			protectedCount: selection.protectedCount,
			droppedCount: 0,
			truncated: false,
		};
	}

	// System One first: it answers `not-assigned` for any other assignment and
	// touches nothing, so the model path below runs exactly as it did. The
	// budget is the one a model gets, because the local judge answers one tab
	// at a time.
	const judged = await runSystemOneTask(
		TASK_ID,
		{ candidates: selection.shown, now },
		{ timeoutMs: TAB_CLEANUP_TIMEOUT_MS }
	);
	switch (judged.status) {
		case 'not-assigned':
			break;
		case 'cancelled':
			return fail('cancelled', `${judged.engineLabel} was stopped before it answered. Try again.`);
		case 'failed-open':
		case 'failed-closed':
		case 'unavailable':
			logger.warn('Tab cleanup skipped: System One gave no answer', LOG_CONTEXT, {
				engine: judged.engine,
				code: judged.code,
				reason: judged.reason,
			});
			return fail(judged.code === 'timeout' ? 'cancelled' : 'unavailable', judged.reason);
		case 'ok': {
			const raw = tabCleanupReplyFromSystemOne(judged.answers, selection.shown, judged.engineLabel);
			if (!raw) {
				logger.warn('System One returned no usable tab cleanup answers', LOG_CONTEXT, {
					engine: judged.engine,
				});
				return fail(
					'unusable',
					`${judged.engineLabel} did not answer for any tab. Try again.`,
					judged.engineLabel
				);
			}
			return guardedResult(raw, selection, stores, judged.engineLabel, {
				engine: judged.engine,
				durationMs: judged.latencyMs,
			});
		}
	}

	const verdict = await runLocalTask(TASK_ID, {
		system: getPrompt('tab-cleanup-local'),
		prompt: formatTabCleanupInput(selection.shown, now),
		maxTokens: TAB_CLEANUP_MAX_TOKENS,
		jsonSchema: TAB_CLEANUP_REPLY_SCHEMA,
		signal: AbortSignal.timeout(TAB_CLEANUP_TIMEOUT_MS),
	});

	switch (verdict.status) {
		case 'off':
			// The assignment changed between the check above and the call.
			return fail('off', offMessage);
		case 'use-utility-agent':
			// The registry refuses this assignment for the task; a hand-edited
			// settings file is the only way here. There is no agent path to keep.
			return fail(
				'unavailable',
				`${task.label} cannot run on the Utility Agent. Assign it a local model or an endpoint in ${ASSIGNMENT_LOCATION}.`
			);
		case 'cancelled':
			logger.warn('Tab cleanup timed out', LOG_CONTEXT, { source: verdict.source });
			return fail('cancelled', 'The assigned model took too long to answer. Try again.');
		case 'unavailable':
			logger.warn('Tab cleanup skipped: assigned model unavailable', LOG_CONTEXT, {
				source: verdict.source,
				code: verdict.code,
				reason: verdict.reason,
			});
			return fail('unavailable', verdict.reason);
		case 'ok': {
			const producedBy =
				localModelAssignmentSourceLabel(verdict.source, getConfiguredLocalModelEndpoints()) ??
				undefined;
			const raw = parseTabCleanupReply(verdict.json);
			if (!raw) {
				logger.warn('Assigned model returned no usable tab cleanup reply', LOG_CONTEXT, {
					source: verdict.source,
					responseLength: verdict.text.length,
				});
				return fail(
					'unusable',
					'The model did not return a usable list. Try again, or assign a larger model.',
					producedBy
				);
			}

			return guardedResult(raw, selection, stores, producedBy, {
				source: verdict.source,
				durationMs: verdict.durationMs,
			});
		}
	}
}
