/**
 * The one way a housekeeping consumer tells the user its assigned local model
 * or endpoint could not run.
 *
 * The task router never falls back (see `task-router.ts`), so an `unavailable`
 * verdict means the operation was SKIPPED: the tab stays unnamed, the summary
 * is not written. Skipping silently would read as the feature being broken, and
 * toasting on every attempt would bury the user (tab naming fires on every new
 * tab). So the notice is a non-blocking yellow toast shown once per task and
 * agent, and every occurrence is logged.
 *
 * A later success for the same task and agent re-arms the notice, so a model
 * that comes back and then breaks again is announced again.
 */

import { LOCAL_MODEL_TASKS, type LocalModelTaskId } from '../../shared/local-models/tasks';
import { logger } from '../utils/logger';
import type { SafeSendFn } from '../utils/safe-send';
import type { LocalTaskUnavailable } from './task-router';

const LOG_CONTEXT = '[LocalModels]';

/** Task + agent pairs that have already shown their notice. */
const announced = new Set<string>();

function noticeKey(taskId: LocalModelTaskId, sessionId: string | undefined): string {
	return `${taskId}\u0000${sessionId ?? ''}`;
}

export interface ReportLocalTaskUnavailableOptions {
	/** Broadcast channel to the renderers and the web-desktop bridge. */
	safeSend: SafeSendFn | undefined;
	taskId: LocalModelTaskId;
	verdict: LocalTaskUnavailable;
	/**
	 * The agent the operation was for. Scopes the deduplication and makes the
	 * toast jump to that agent. Omitted, the notice is deduplicated app-wide.
	 */
	sessionId?: string;
}

/**
 * Log an `unavailable` verdict and, the first time for this task and agent,
 * raise a yellow toast naming the reason. Returns whether a toast was sent.
 */
export function reportLocalTaskUnavailable(options: ReportLocalTaskUnavailableOptions): boolean {
	const { safeSend, taskId, verdict, sessionId } = options;
	const label = LOCAL_MODEL_TASKS[taskId].label;
	logger.warn(`${label} skipped: assigned model unavailable`, LOG_CONTEXT, {
		taskId,
		sessionId,
		source: verdict.source,
		code: verdict.code,
		reason: verdict.reason,
	});

	const key = noticeKey(taskId, sessionId);
	if (announced.has(key) || !safeSend) return false;
	announced.add(key);
	safeSend('remote:notifyToast', {
		title: `${label} skipped`,
		message: verdict.reason,
		color: 'yellow' as const,
		...(sessionId ? { sessionId } : {}),
	});
	return true;
}

/** Re-arm the notice after the task ran fine for this agent. */
export function clearLocalTaskNotice(taskId: LocalModelTaskId, sessionId?: string): void {
	announced.delete(noticeKey(taskId, sessionId));
}

/** Test seam: forget every notice shown. */
export function resetLocalTaskNotices(): void {
	announced.clear();
}
