/**
 * @file group-chat-turn-metrics.ts
 * @description The desktop's binding of group chat turn measurement.
 *
 * The measurement lives in the library (`src/shared/maestro-lib/groupchat/turn-metrics.ts`)
 * and takes its clock as an input. This module supplies the desktop's: the sleep
 * tracker that `powerMonitor` feeds, so a turn running across a suspend does not
 * bill the night to the agent. It keeps every export name the main process
 * already imports.
 *
 * Group chat turns never touch the renderer's agent pipeline - they are batch
 * processes spawned and reaped in the main process - so this is the only thing
 * that can say how long a turn ran or what it burned.
 */

import { beginSleepAwareSpan, sleepAwareElapsedMs } from '../utils/sleep-tracker';
import {
	createGroupChatTurnMetrics,
	resolveGroupChatTurnKey,
	GROUP_CHAT_MODERATOR_NAME,
	type GroupChatTurnMeasurement,
} from '../../shared/maestro-lib/groupchat/turn-metrics';
import type { UsageStats } from '../../shared/types';

export { resolveGroupChatTurnKey, GROUP_CHAT_MODERATOR_NAME };
export type { GroupChatTurnMeasurement as GroupChatTurnMetrics };

/** The one instance the desktop's group chat engine and spawn path share. */
export const desktopTurnMetrics = createGroupChatTurnMetrics({
	spans: { begin: beginSleepAwareSpan, elapsedMs: sleepAwareElapsedMs },
});

/** Start measuring a turn. Called from the single spawn choke point. */
export function beginGroupChatTurn(sessionId: string): void {
	desktopTurnMetrics.begin(sessionId);
}

/** Fold one usage event into the turn's running total. */
export function recordGroupChatTurnUsage(sessionId: string, usage: UsageStats): void {
	desktopTurnMetrics.recordUsage(sessionId, usage);
}

/** Close out a participant's turn and report what it cost. */
export function finishGroupChatTurn(
	groupChatId: string,
	participantName: string
): GroupChatTurnMeasurement {
	return desktopTurnMetrics.finish(groupChatId, participantName);
}

/** Number of turns being measured. Test/diagnostic helper. */
export function getGroupChatTurnCount(): number {
	return desktopTurnMetrics.count();
}

/** Reset in-flight turns. Tests only. */
export function resetGroupChatTurnMetricsForTests(): void {
	desktopTurnMetrics.reset();
}
