/**
 * contextCompaction - compact an agent's provider session in place, and mark
 * where that happened in the transcript.
 *
 * A turn refused because the conversation no longer fits the model's context
 * window ("Prompt is too long") is recoverable: the provider can summarize its
 * own session, after which the same prompt fits. `retryStore` drives that
 * recovery (compact, then resend the snapshotted prompt); this module owns the
 * two pieces it needs - the hidden compaction turn and the transcript pill.
 *
 * The compaction runs as a background turn under a synopsis process id, so
 * nothing it prints reaches the transcript. The pill is a self-contained card
 * (`isSelfContainedCard`): it raises no unread and moves no focus.
 */

import { getContextCompactCommand } from '../../shared/contextCompaction';
import { getClaudeTokenSourceFields } from '../../shared/claudeTokenMode';
import { selectSessionById, updateAiTab, useSessionStore } from '../stores/sessionStore';
import { captureQueuedTurnSettings, projectTabProvider } from '../utils/providerTabSessions';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';
import type { AITab, LogEntry, Session, ToolType } from '../types';

type CompactionRecord = NonNullable<LogEntry['contextCompaction']>;

/** Where a recorded pill lives, so it can be settled when the compaction ends. */
export interface ContextCompactionRef {
	sessionId: string;
	tabId: string;
	entryId: string;
}

/** How a compaction ended. */
export interface ContextCompactionOutcome {
	status: Exclude<CompactionRecord['status'], 'pending'>;
	error?: string;
}

export interface ContextCompactionResult {
	success: boolean;
	error?: string;
}

/**
 * The hidden-turn spawner (`spawnBackgroundSynopsis` from `useAgentExecution`),
 * narrowed to what a compaction passes it.
 */
export type HiddenTurnSpawner = (
	sessionId: string,
	cwd: string,
	resumeAgentSessionId: string,
	prompt: string,
	toolType: ToolType,
	sessionConfig: {
		customPath?: string;
		customArgs?: string;
		customEnvVars?: Record<string, string>;
		customModel?: string;
		customEffort?: string;
		customContextWindow?: number;
		enableMaestroP?: boolean;
		maestroPMode?: 'interactive' | 'dynamic';
		maestroPPath?: string;
		sessionSshRemoteConfig?: Session['sessionSshRemoteConfig'];
	},
	options: { keepTurnSettings: true; allowEmptyResponse: true }
) => Promise<ContextCompactionResult>;

/**
 * Null until `useAgentListeners` registers it (and in tests). The spawner lives
 * in a React hook; the retry engine that needs it does not, so it is handed
 * across here - the same arrangement as `registerBatchResumer`.
 */
let hiddenTurnSpawner: HiddenTurnSpawner | null = null;

/** Wire the spawner a compaction runs through. Pass null to unwire it. */
export function registerContextCompactionSpawner(fn: HiddenTurnSpawner | null): void {
	hiddenTurnSpawner = fn;
}

function findTab(session: Session | undefined, tabId: string): AITab | undefined {
	return session?.aiTabs?.find((tab) => tab.id === tabId);
}

/**
 * Whether this tab's provider session can be compacted right now: the provider
 * has a compaction command, the tab has a session to resume, and a spawner is
 * wired.
 */
export function canCompactTabContext(
	sessionId: string,
	tabId: string,
	provider?: ToolType
): boolean {
	if (!hiddenTurnSpawner) return false;
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!session) return false;
	const projected = projectTabProvider(session, findTab(session, tabId), provider);
	return !!getContextCompactCommand(projected.agent.toolType) && !!projected.tab?.agentSessionId;
}

/**
 * Compact the tab's provider session. Resolves once the hidden turn has exited;
 * never throws.
 *
 * Runs on the model and effort the tab's next turn will use rather than the
 * cheap tier a synopsis takes: the summary this produces REPLACES the
 * conversation, so every later turn is only as good as it is.
 */
export async function compactTabContext(
	sessionId: string,
	tabId: string,
	provider?: ToolType
): Promise<ContextCompactionResult> {
	const savedSession = selectSessionById(sessionId)(useSessionStore.getState());
	if (!savedSession) return { success: false, error: 'This conversation cannot be compacted.' };
	const { agent: session, tab } = projectTabProvider(
		savedSession,
		findTab(savedSession, tabId),
		provider
	);
	const command = getContextCompactCommand(session?.toolType);
	if (!hiddenTurnSpawner || !session || !tab?.agentSessionId || !command) {
		return { success: false, error: 'This conversation cannot be compacted.' };
	}

	const turnSettings = captureQueuedTurnSettings(tab, session);
	try {
		const result = await hiddenTurnSpawner(
			sessionId,
			session.cwd,
			tab.agentSessionId,
			command,
			session.toolType,
			{
				customPath: session.customPath,
				customArgs: session.customArgs,
				customEnvVars: session.customEnvVars,
				customModel: turnSettings.model ?? session.customModel,
				customEffort: turnSettings.effort ?? session.customEffort,
				customContextWindow: session.customContextWindow,
				...getClaudeTokenSourceFields(session),
				sessionSshRemoteConfig: session.sessionSshRemoteConfig,
			},
			{ keepTurnSettings: true, allowEmptyResponse: true }
		);
		return result.success ? { success: true } : { success: false, error: result.error };
	} catch (error) {
		logger.error('[contextCompaction] Compaction turn threw', undefined, error);
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Pure: the transcript entry for one compaction. Exported for unit testing. */
export function buildContextCompactionLogEntry(status: CompactionRecord['status']): LogEntry {
	return {
		id: generateId(),
		timestamp: Date.now(),
		source: 'system',
		// Plain-text fallback, and what cross-tab search matches on.
		text: 'Compacted the conversation to fit the context window',
		contextCompaction: { status },
	};
}

/**
 * Append a `pending` compaction pill to the tab's transcript. Returns where it
 * landed, or null when the tab is gone.
 */
export function recordContextCompaction(
	sessionId: string,
	tabId: string
): ContextCompactionRef | null {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!findTab(session, tabId)) return null;

	const entry = buildContextCompactionLogEntry('pending');
	updateAiTab(sessionId, tabId, (tab) => ({ ...tab, logs: [...tab.logs, entry] }));
	return { sessionId, tabId, entryId: entry.id };
}

/** Settle a pending pill. No-op if the tab or entry is gone, or it already settled. */
export function settleContextCompaction(
	ref: ContextCompactionRef,
	outcome: ContextCompactionOutcome
): void {
	updateAiTab(ref.sessionId, ref.tabId, (tab) => {
		const index = tab.logs.findIndex((log) => log.id === ref.entryId);
		const entry = index === -1 ? undefined : tab.logs[index];
		if (entry?.contextCompaction?.status !== 'pending') return tab;
		const logs = tab.logs.slice();
		logs[index] = {
			...entry,
			contextCompaction: {
				status: outcome.status,
				...(outcome.error ? { error: outcome.error } : {}),
			},
		};
		return { ...tab, logs };
	});
}
