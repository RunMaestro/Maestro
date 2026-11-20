/**
 * Application Stats WebSocket message handler.
 *
 * Handles: app_stats. The CLI's route to `collectAppStats()`, the same snapshot
 * the Debug: View Application Stats modal reads over `debug:getAppStats`.
 */

import { collectAppStats } from '../../../app-stats';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export async function handleAppStats(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const deps = ctx.callbacks.getDebugPackageDeps?.() ?? null;
	try {
		const snapshot = await collectAppStats({
			getProcessManager: () => deps?.getProcessManager() ?? null,
		});
		ctx.send(client, {
			type: 'app_stats_result',
			success: true,
			snapshot,
			requestId: message.requestId,
		});
	} catch (error) {
		ctx.send(client, {
			type: 'app_stats_result',
			success: false,
			error: `Failed to collect application stats: ${error instanceof Error ? error.message : String(error)}`,
			requestId: message.requestId,
		});
	}
}
