/**
 * Stats domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles:
 * get_stats_aggregation, get_token_usage, get_project_token_usage, get_stats_indexing,
 * stats_query, get_achievements, generate_director_notes_synopsis.
 */

import { getStatsDB } from '../../../stats/singleton';
import { runReadonlyStatsQuery } from '../../../stats/readonly-query';
import type { StatsTimeRange } from '../../../../shared/stats-types';
import { tokenUsageQueryForRange } from '../../../../shared/tokenUsage';
import {
	getProjectTokenUsage,
	getTokenUsageAggregate,
} from '../../../stats/token-usage/token-usage-accessor';
import {
	MAX_PROJECT_TOKEN_USAGE_PROJECTS,
	PROJECT_TOKEN_USAGE_FAILED,
	parseProjectTokenUsageRequest,
	projectTokenUsageFailureFrame,
	projectTokenUsageReplyFrame,
} from '../../../../shared/projectTokenUsage';
import { getSettingsStore } from '../../../stores';
import { isEncoreFeatureEnabled } from '../../../../shared/encoreFeatureDefaults';
import { getStatsIndexingState } from '../../../stats/stats-indexing';
import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

const LOG_CONTEXT = '[StatsHandlers]';

/**
 * Refuse a stats read while Usage & Stats is off, the way the desktop never
 * opens the dashboard then. Returns true when the request was refused.
 */
function refuseWhenUsageStatsOff(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): boolean {
	if (isEncoreFeatureEnabled(getSettingsStore(), 'usageStats')) return false;
	ctx.sendError(
		client,
		'Usage & Stats is turned off. Run `maestro-cli encore enable usageStats` first.',
		{ requestId: message.requestId }
	);
	return true;
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
	if (refuseWhenUsageStatsOff(ctx, client, message)) return;
	const range = (message.range as string) || 'week';
	const validRanges = new Set(['day', 'week', 'month', 'quarter', 'year', 'all']);

	if (!validRanges.has(range)) {
		ctx.sendError(client, 'Invalid range. Must be one of: day, week, month, quarter, year, all');
		return;
	}

	try {
		const data = getStatsDB().getAggregatedStats(range as StatsTimeRange);
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
 * Handle get_token_usage message - the Usage Dashboard's Tokens payload (totals,
 * breakdowns, and per-call token speed) for a time range, read from the
 * agents' transcripts by the same accessor the Tokens tab uses.
 */
export function handleGetTokenUsage(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	if (refuseWhenUsageStatsOff(ctx, client, message)) return;
	const range = (message.range as string) || 'week';
	const validRanges = new Set(['day', 'week', 'month', 'quarter', 'year', 'all']);

	if (!validRanges.has(range)) {
		ctx.sendError(client, 'Invalid range. Must be one of: day, week, month, quarter, year, all');
		return;
	}

	// A script asking (`maestro-cli stats-tokens`) wants the whole number, so this
	// read waits for the agents on another computer to be counted.
	getTokenUsageAggregate(tokenUsageQueryForRange(range as StatsTimeRange), message.force === true, {
		waitForRemote: true,
	})
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
 * Handle get_project_token_usage - a Federation peer asking for the token usage
 * of its agents' projects on this machine (`projectTokenUsage()` over this
 * desktop's own session storages). Only numbers go back, never transcript text.
 * Not gated on this machine's Usage & Stats: the peer's dashboard is the one
 * reading, and the read touches no stats table.
 */
export function handleGetProjectTokenUsage(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const projects = parseProjectTokenUsageRequest(message as Record<string, unknown>);
	const reply = (frame: Record<string, unknown>): void => {
		ctx.send(client, { ...frame, requestId: message.requestId, timestamp: Date.now() });
	};
	if (!projects) {
		reply(
			projectTokenUsageFailureFrame(
				`Name 1 to ${MAX_PROJECT_TOKEN_USAGE_PROJECTS} projects, each with a provider and a path.`
			)
		);
		return;
	}
	getProjectTokenUsage(projects)
		.then((usage) => reply(projectTokenUsageReplyFrame(usage)))
		.catch((error) => {
			// The message can name this machine's paths: it goes to this machine's log
			// and Sentry, and the peer gets a generic error.
			logger.error('Token usage read for a peer failed', LOG_CONTEXT, {
				error: error instanceof Error ? error.message : String(error),
			});
			void captureException(error, { operation: 'tokenUsage:peerAnswer' });
			reply(projectTokenUsageFailureFrame(PROJECT_TOKEN_USAGE_FAILED));
		});
}

/**
 * Handle get_stats_indexing message - the progress of the long transcript
 * scans behind the usage caches (`maestro-cli stats-indexing`). State lives in
 * the main process, so this answers with no renderer round trip.
 */
export function handleGetStatsIndexing(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	ctx.send(client, {
		type: 'stats_indexing',
		data: getStatsIndexingState(),
		requestId: message.requestId,
		timestamp: Date.now(),
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
	if (refuseWhenUsageStatsOff(ctx, client, message)) return;
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
