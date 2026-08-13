/**
 * Spawn a background synopsis run after a custom AI command tab exits, then
 * persist the result to history and refresh the right panel.
 *
 * Eligibility (encoded by the caller via `synopsisData != null`):
 * - Execution queue is empty
 * - Tab or session has an `agentSessionId`
 * - Either the tab opted-in via `saveToHistory` OR a custom command is
 *   pending (`pendingAICommandForSynopsis`)
 *
 * This function owns the post-spawn handling: parsing, history-entry
 * recording, name persistence, last-synopsis-time stamp, info toast, and
 * right-panel refresh. All state writes route through `updateLastSynopsisTime`
 * supplied by the caller so the helper doesn't reach into the session store
 * directly.
 */

import { logger } from '../../../../utils/logger';
import { notifyToast } from '../../../../stores/notificationStore';
import { formatRelativeTime } from '../../../../../shared/formatters';
import { parseSynopsis } from '../../../../../shared/synopsis';
import { hasRunnableQueueItem } from '../../../../utils/executionQueue';
import type { ToolType, Session, LogEntry } from '../../../../types';
import type { UseAgentListenersDeps } from '../types';
import type { RightPanelHandle } from '../../../../components/RightPanel';

export interface SynopsisData {
	sessionId: string;
	cwd: string;
	projectRoot: string;
	agentSessionId: string;
	command: string;
	groupName: string;
	projectName: string;
	tabName?: string;
	tabId?: string;
	lastSynopsisTime?: number;
	taskDuration?: number;
	toolType?: ToolType;
	sessionConfig?: {
		customPath?: string;
		customArgs?: string;
		customEnvVars?: Record<string, string>;
		customModel?: string;
		customContextWindow?: number;
		// Claude token-source selection, forwarded so the synopsis spawn honors
		// the agent's TUI/Dynamic/API choice (it runs under a synthetic sessionId,
		// so the spawn handler can't resolve it from the persisted session).
		enableMaestroP?: boolean;
		maestroPMode?: 'interactive' | 'dynamic';
		maestroPPath?: string;
	};
}

export interface RunExitSynopsisDeps {
	spawnBackgroundSynopsisRef: UseAgentListenersDeps['spawnBackgroundSynopsisRef'];
	addHistoryEntryRef: UseAgentListenersDeps['addHistoryEntryRef'];
	rightPanelRef: UseAgentListenersDeps['rightPanelRef'];
	/** Stamp `lastSynopsisTime` on the originating tab. */
	updateLastSynopsisTime: (sessionId: string, tabId: string, time: number) => void;
	getAutorunSynopsisPrompt: () => string;
}

export function buildSynopsisPrompt(
	data: Pick<SynopsisData, 'lastSynopsisTime'>,
	getAutorunSynopsisPrompt: () => string
): string {
	const base = getAutorunSynopsisPrompt();
	if (!data.lastSynopsisTime) return base;
	const timeAgo = formatRelativeTime(data.lastSynopsisTime);
	return `${base}\n\nIMPORTANT: Only synopsize work done since the last synopsis (${timeAgo}). Do not repeat previous work.`;
}

/**
 * `synopsisData` non-null means the caller has already validated eligibility
 * (queue empty, agentSessionId present, etc.). Callers should bail before
 * invoking this when their `synopsisData` is null.
 */
export async function runExitSynopsis(
	synopsisData: SynopsisData,
	deps: RunExitSynopsisDeps
): Promise<void> {
	const spawn = deps.spawnBackgroundSynopsisRef.current;
	const addHistoryEntry = deps.addHistoryEntryRef.current;
	if (!spawn || !addHistoryEntry) return;

	const SYNOPSIS_PROMPT = buildSynopsisPrompt(synopsisData, deps.getAutorunSynopsisPrompt);
	const startTime = Date.now();
	const synopsisTime = Date.now();

	try {
		const result = await spawn(
			synopsisData.sessionId,
			synopsisData.cwd,
			synopsisData.agentSessionId,
			SYNOPSIS_PROMPT,
			synopsisData.toolType,
			synopsisData.sessionConfig
		);

		const duration = Date.now() - startTime;

		if (!result.success || !result.response) {
			if (!result.success) {
				logger.warn(
					'[onProcessExit] Synopsis generation failed - no history entry created',
					undefined,
					{
						sessionId: synopsisData.sessionId,
						agentSessionId: synopsisData.agentSessionId,
						hasResponse: !!result.response,
					}
				);
			}
			return;
		}

		const parsed = parseSynopsis(result.response);

		if (parsed.nothingToReport) {
			logger.info(
				'[onProcessExit] Synopsis returned NOTHING_TO_REPORT - skipping history entry',
				undefined,
				{
					sessionId: synopsisData.sessionId,
					agentSessionId: synopsisData.agentSessionId,
				}
			);
			return;
		}

		const liveAddHistoryEntry = deps.addHistoryEntryRef.current;
		if (!liveAddHistoryEntry) return;

		liveAddHistoryEntry({
			type: 'USER',
			summary: parsed.shortSummary,
			fullResponse: parsed.fullSynopsis,
			agentSessionId: synopsisData.agentSessionId,
			usageStats: result.usageStats,
			contextUsage: result.contextUsage,
			sessionId: synopsisData.sessionId,
			projectPath: synopsisData.cwd,
			sessionName: synopsisData.tabName,
			elapsedTimeMs: synopsisData.taskDuration,
		});

		persistTabNameAfterSynopsis(synopsisData);

		if (synopsisData.tabId) {
			deps.updateLastSynopsisTime(synopsisData.sessionId, synopsisData.tabId, synopsisTime);
		}

		notifyToast({
			type: 'info',
			title: 'Synopsis',
			message: parsed.shortSummary,
			group: synopsisData.groupName,
			project: synopsisData.projectName,
			taskDuration: duration,
			sessionId: synopsisData.sessionId,
			tabId: synopsisData.tabId,
			tabName: synopsisData.tabName,
			skipCustomNotification: true,
		});

		deps.rightPanelRef.current?.refreshHistoryPanel();
	} catch (err) {
		logger.error('[onProcessExit] Synopsis failed:', undefined, err);
	}
}

/**
 * Persist the tab name to the agent's session origins store so the session
 * remains searchable in TabSwitcherModal's "All Named" view after it closes.
 * Skip UUID-prefix fallback names (8 hex chars) - those aren't real
 * user-facing names.
 */
function persistTabNameAfterSynopsis(synopsisData: SynopsisData): void {
	const persistName = synopsisData.tabName;
	if (!persistName) return;
	const isUuidPrefix = /^[0-9A-F]{8}$/.test(persistName);
	if (isUuidPrefix) return;
	if (!synopsisData.agentSessionId || !synopsisData.projectRoot) return;

	const persistAgentId = synopsisData.toolType || 'claude-code';
	const persistProjectRoot = synopsisData.projectRoot;
	const persistSessionId = synopsisData.agentSessionId;

	if (persistAgentId === 'claude-code') {
		window.maestro.claude
			.updateSessionName(persistProjectRoot, persistSessionId, persistName)
			.catch((err) =>
				logger.warn('[onProcessExit] Failed to persist synopsis tab name', undefined, err)
			);
	} else {
		window.maestro.agentSessions
			.setSessionName(persistAgentId, persistProjectRoot, persistSessionId, persistName)
			.catch((err) =>
				logger.warn('[onProcessExit] Failed to persist synopsis tab name', undefined, err)
			);
	}
}

/**
 * Pure eligibility check used by callers BEFORE invoking `runExitSynopsis`.
 *
 * The session must have an empty execution queue, an `agentSessionId`
 * (either on the completed tab or on the session), AND either the tab opted
 * in via `saveToHistory` OR a `pendingAICommandForSynopsis` is set.
 */
export function shouldRunSynopsisOnExit(
	session: {
		executionQueue: Session['executionQueue'];
		agentSessionId?: Session['agentSessionId'];
		pendingAICommandForSynopsis?: Session['pendingAICommandForSynopsis'];
	},
	completedTab:
		| {
				agentSessionId?: NonNullable<Session['aiTabs']>[number]['agentSessionId'];
				saveToHistory?: NonNullable<Session['aiTabs']>[number]['saveToHistory'];
		  }
		| undefined
): boolean {
	// Paused items won't auto-run, so a queue with only held items still counts
	// as "done" for synopsis purposes.
	if (hasRunnableQueueItem(session.executionQueue)) return false;
	const hasAgentSessionId = !!(completedTab?.agentSessionId || session.agentSessionId);
	if (!hasAgentSessionId) return false;
	const optedIn = !!(completedTab?.saveToHistory || session.pendingAICommandForSynopsis);
	return optedIn;
}

/**
 * Activity gate: did the just-completed turn do work worth synopsizing?
 *
 * A synopsis is a full session-resume spawn (a second agent round-trip), so a
 * turn that only exchanged text - a plain question answered with prose, no tool
 * use - isn't worth the cost or a History entry. We treat "ran at least one
 * tool" as the bar for meaningful work: edits, writes, file reads, searches, and
 * shell commands all surface as `source: 'tool'` log entries (including in
 * maestro-p text-stream turns), so research-only turns still qualify.
 *
 * The "turn" is everything after the last user message in the tab's logs. A
 * custom AI command (`/commit` and friends) always counts as work - it was an
 * explicit action, and its `pendingAICommandForSynopsis` path may not leave a
 * tool log of its own.
 *
 * @param logs The completed tab's full log history.
 * @param isCustomCommand True when this exit was driven by a pending custom AI command.
 * @param toolLogsObservable Whether this tab actually records tool logs. Tabs with
 *   thinking display off never emit `source: 'tool'` entries (see
 *   `thinkingLogsRecorded`), so the scan below cannot distinguish a genuine no-op
 *   turn from a tool-heavy one. When false we record the turn rather than risk
 *   silently dropping its History entry - the pre-activity-gate behavior.
 */
export function turnDidMeaningfulWork(
	logs: ReadonlyArray<{ source: LogEntry['source'] }>,
	isCustomCommand = false,
	toolLogsObservable = true
): boolean {
	if (isCustomCommand) return true;
	if (!toolLogsObservable) return true;
	let lastUserIdx = -1;
	for (let i = logs.length - 1; i >= 0; i--) {
		if (logs[i].source === 'user') {
			lastUserIdx = i;
			break;
		}
	}
	for (let i = lastUserIdx + 1; i < logs.length; i++) {
		if (logs[i].source === 'tool') return true;
	}
	return false;
}

// Re-export the right-panel handle type for ergonomic test imports.
export type { RightPanelHandle };
