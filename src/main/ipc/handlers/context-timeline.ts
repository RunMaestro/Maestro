/**
 * IPC handlers for the Context Timeline capture log (finding S1).
 *
 * Main keeps the RAW per-turn usage captures (see
 * `src/main/process-listeners/context-timeline-log.ts`); the renderer fetches
 * them when it opens the Context Timeline for an agent whose buffer is empty
 * and replays them through its own guard code. That is what makes a
 * web-desktop client, a reloaded window, and a second desktop window show the
 * history that already happened instead of an empty panel.
 *
 * Deliberately reads nothing off the IPC `event`: the web-desktop bridge
 * dispatches invokes with a synthetic event that has no `sender`, so any handler
 * touching it would crash for browser clients.
 */

import { ipcMain } from 'electron';
import {
	getUsageCaptures,
	removeSessionCaptures,
	type UsageCapture,
} from '../../process-listeners/context-timeline-log';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[IPC:ContextTimeline]';

export interface ContextTimelineCapturesResponse {
	success: boolean;
	captures?: UsageCapture[];
	/** True when the main-side cap dropped older captures for this agent. */
	trimmed?: boolean;
	error?: string;
}

export function registerContextTimelineHandlers(): void {
	ipcMain.handle(
		'contextTimeline:getCaptures',
		async (_event, sessionId: string | null): Promise<ContextTimelineCapturesResponse> => {
			try {
				if (!sessionId) return { success: true, captures: [], trimmed: false };
				const { captures, trimmed } = getUsageCaptures(sessionId);
				return { success: true, captures, trimmed };
			} catch (error) {
				logger.error(`Failed to read context timeline captures: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle(
		'contextTimeline:clearCaptures',
		async (_event, sessionId: string | null): Promise<{ success: boolean; error?: string }> => {
			try {
				if (sessionId) removeSessionCaptures(sessionId);
				return { success: true };
			} catch (error) {
				logger.error(`Failed to clear context timeline captures: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	logger.info('Context Timeline IPC handlers registered', LOG_CONTEXT);
}
