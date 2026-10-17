/**
 * Stats domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: get_usage_dashboard,
 * get_stats_aggregation, get_model_usage, get_token_usage, stats_query, get_achievements,
 * generate_director_notes_synopsis.
 */

import { getStatsDB } from '../../../stats/singleton';
import { runReadonlyStatsQuery } from '../../../stats/readonly-query';
import { readModelUsage } from '../../../local-models/model-usage';
import { isStatsTimeRange, STATS_TIME_RANGES } from '../../../../shared/stats-types';
import { tokenUsageQueryForRange } from '../../../../shared/tokenUsage';
import { getTokenUsageAggregate } from '../../../stats/token-usage/token-usage-accessor';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle get_usage_dashboard message - fetch usage analytics data
 */
export function handleGetUsageDashboard(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const timeRange = (message.timeRange as string) || 'week';
	const validRanges = new Set(['day', 'week', 'month', 'all']);

	if (!validRanges.has(timeRange)) {
		ctx.sendError(client, 'Invalid timeRange. Must be one of: day, week, month, all');
		return;
	}

	if (!ctx.callbacks.getUsageDashboard) {
		ctx.sendError(client, 'Usage dashboard not available');
		return;
	}

	ctx.callbacks
		.getUsageDashboard(timeRange as 'day' | 'week' | 'month' | 'all')
		.then((data) => {
			ctx.send(client, {
				type: 'usage_dashboard',
				data,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to get usage dashboard: ${error.message}`);
		});
}

/**
 * Handle get_stats_aggregation message - return the Usage Dashboard's
 * aggregated stats (query counts, durations, per-agent/day/hour breakdowns)
 * for a time range. Reads the main-process stats singleton directly.
 */
export function handleGetStatsAggregation(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const range = (message.range as string) || 'week';

	if (!isStatsTimeRange(range)) {
		ctx.sendError(client, `Invalid range. Must be one of: ${STATS_TIME_RANGES.join(', ')}`);
		return;
	}

	try {
		const data = getStatsDB().getAggregatedStats(range);
		ctx.send(client, {
			type: 'stats_aggregation',
			data,
			requestId: message.requestId,
			timestamp: Date.now(),
		});
	} catch (error) {
		ctx.sendError(
			client,
			`Failed to get stats aggregation: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Handle get_model_usage message - what every model other than a provider's
 * own did in a range, per source, task and agent, with System One's decisions
 * and the token proxy's totals (`maestro-cli stats models`). The same record
 * the `stats:get-model-usage` IPC channel answers with. A range that is not
 * one of the six is an error; none reads the week.
 *
 * A failure answers under the reply's own type with the request's id, so the
 * caller hears it at once: an `error` message carries no id, and a CLI waiting
 * on `model_usage` would sit out its whole timeout.
 */
export async function handleGetModelUsage(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = { type: 'model_usage', requestId: message.requestId, timestamp: Date.now() };
	try {
		ctx.send(client, { ...reply, success: true, data: await readModelUsage(message.range) });
	} catch (error) {
		ctx.send(client, {
			...reply,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Handle get_token_usage message - the Usage Dashboard's Tokens payload (totals,
 * breakdowns, and per-call token speed) for a time range, read from the
 * agents' transcripts by the same accessor the Tokens tab uses.
 */
export function handleGetTokenUsage(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const range = (message.range as string) || 'week';
	if (!isStatsTimeRange(range)) {
		ctx.sendError(client, `Invalid range. Must be one of: ${STATS_TIME_RANGES.join(', ')}`);
		return;
	}

	getTokenUsageAggregate(tokenUsageQueryForRange(range), message.force === true)
		.then((data) => {
			ctx.send(client, {
				type: 'token_usage',
				data,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			ctx.sendError(
				client,
				`Failed to get token usage: ${error instanceof Error ? error.message : String(error)}`
			);
		});
}

/**
 * Handle stats_query message - run a single read-only SQL statement against
 * the stats database and return the rows. Read-only enforcement lives in
 * runReadonlyStatsQuery (dedicated readonly connection + single-statement +
 * stmt.readonly assertion).
 */
export function handleStatsQuery(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sql = message.sql as string | undefined;
	const params = Array.isArray(message.params) ? (message.params as unknown[]) : [];

	if (!sql || typeof sql !== 'string') {
		ctx.sendError(client, 'Missing required "sql" string for stats_query');
		return;
	}

	try {
		const result = runReadonlyStatsQuery(sql, params);
		ctx.send(client, {
			type: 'stats_query_result',
			columns: result.columns,
			rows: result.rows,
			rowCount: result.rowCount,
			truncated: result.truncated,
			requestId: message.requestId,
			timestamp: Date.now(),
		});
	} catch (error) {
		ctx.sendError(
			client,
			`Stats query failed: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Handle get_achievements message - fetch achievement data
 */
export function handleGetAchievements(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	if (!ctx.callbacks.getAchievements) {
		ctx.sendError(client, 'Achievements not available');
		return;
	}

	ctx.callbacks
		.getAchievements()
		.then((achievements) => {
			ctx.send(client, {
				type: 'achievements',
				achievements,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to get achievements: ${error.message}`);
		});
}

/**
 * Handle generate_director_notes_synopsis - generate AI synopsis via batch-mode agent
 */
export function handleGenerateDirectorNotesSynopsis(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	if (!ctx.callbacks.generateDirectorNotesSynopsis) {
		ctx.send(client, {
			type: 'generate_director_notes_synopsis_result',
			success: false,
			error: "Director's Notes synopsis generation not available",
			requestId: message.requestId,
		});
		return;
	}

	const lookbackDays = (message.lookbackDays as number) || 7;
	const provider = (message.provider as string) || 'claude-code';

	ctx.callbacks
		.generateDirectorNotesSynopsis(lookbackDays, provider)
		.then((result) => {
			ctx.send(client, {
				type: 'generate_director_notes_synopsis_result',
				...result,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			ctx.send(client, {
				type: 'generate_director_notes_synopsis_result',
				success: false,
				error: `Synopsis generation failed: ${error.message}`,
				requestId: message.requestId,
			});
		});
}
