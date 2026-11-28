/**
 * Usage Dashboard reads and export over the WebSocket bridge, behind the
 * `maestro-cli stats-*` verbs.
 *
 * Handles: get_delegation_stats, get_cue_stats, get_plan_usage,
 * get_agent_count_stats, get_activity_stats, stats_export.
 *
 * Every handler calls the same main-process function the dashboard's IPC
 * handler does (`src/main/stats/usage-dashboard-reads.ts`,
 * `src/main/stats/usage-export.ts`), so the CLI and the panels cannot disagree.
 */

import { app } from 'electron';
import type { StatsTimeRange, UsageExportFormat } from '../../../../shared/stats-types';
import { getSettingsStore } from '../../../stores/getters';
import {
	getAgentCountStats,
	getDelegationStats,
	getPlanUsageReport,
	getUsageActivityStats,
	getUsageDashboardCueStats,
} from '../../../stats/usage-dashboard-reads';
import { exportUsageData } from '../../../stats/usage-export';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

const VALID_RANGES = new Set<StatsTimeRange>(['day', 'week', 'month', 'quarter', 'year', 'all']);

/** The message's range (default week), or null after reporting an invalid one. */
function readRange(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): StatsTimeRange | null {
	const range = (message.range as string) || 'week';
	if (!VALID_RANGES.has(range as StatsTimeRange)) {
		fail(
			ctx,
			client,
			message,
			'Invalid range. Must be one of: day, week, month, quarter, year, all'
		);
		return null;
	}
	return range as StatsTimeRange;
}

/** An error frame carrying the request id, so the CLI fails fast instead of timing out. */
function fail(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage,
	text: string
): void {
	ctx.sendError(client, text, { requestId: message.requestId });
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function reply(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage,
	type: string,
	data: unknown
): void {
	ctx.send(client, { type, data, requestId: message.requestId, timestamp: Date.now() });
}

/** get_delegation_stats - interactive vs Auto Run vs Cue, totals and by day. */
export function handleGetDelegationStats(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const range = readRange(ctx, client, message);
	if (!range) return;
	try {
		reply(ctx, client, message, 'delegation_stats', getDelegationStats(range));
	} catch (error) {
		fail(ctx, client, message, `Failed to get delegation stats: ${errorText(error)}`);
	}
}

/** get_cue_stats - the Cue tab's statistics for a range. */
export function handleGetCueStats(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const range = readRange(ctx, client, message);
	if (!range) return;
	const excludeTriggerTypes = Array.isArray(message.excludeTriggerTypes)
		? message.excludeTriggerTypes.filter((t): t is string => typeof t === 'string' && t.length > 0)
		: [];

	getUsageDashboardCueStats(range, getSettingsStore(), { excludeTriggerTypes })
		.then((data) => {
			if (!data) {
				fail(
					ctx,
					client,
					message,
					'Cue statistics are off: turn on the Usage Dashboard and Maestro Cue Encore Features'
				);
				return;
			}
			reply(ctx, client, message, 'cue_stats', data);
		})
		.catch((error) => {
			fail(ctx, client, message, `Failed to get Cue stats: ${errorText(error)}`);
		});
}

/** get_plan_usage - the cached Anthropic / OpenAI plan usage per account. */
export function handleGetPlanUsage(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	getPlanUsageReport()
		.then((data) => reply(ctx, client, message, 'plan_usage', data))
		.catch((error) => {
			fail(ctx, client, message, `Failed to get plan usage: ${errorText(error)}`);
		});
}

/** get_agent_count_stats - Agents Over Time for a range. */
export function handleGetAgentCountStats(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const range = readRange(ctx, client, message);
	if (!range) return;
	try {
		reply(ctx, client, message, 'agent_count_stats', getAgentCountStats(range));
	} catch (error) {
		fail(ctx, client, message, `Failed to get agent count: ${errorText(error)}`);
	}
}

/** get_activity_stats - Auto Run, wizard, resilience and shortcut daily counts. */
export function handleGetActivityStats(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const range = readRange(ctx, client, message);
	if (!range) return;
	try {
		reply(ctx, client, message, 'activity_stats', getUsageActivityStats(range));
	} catch (error) {
		fail(ctx, client, message, `Failed to get activity stats: ${errorText(error)}`);
	}
}

/** stats_export - write the dashboard export to an absolute path. */
export function handleStatsExport(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const range = readRange(ctx, client, message);
	if (!range) return;
	const format = message.format as UsageExportFormat;
	const filePath = message.path as string;

	exportUsageData({
		range,
		format,
		filePath,
		settingsStore: getSettingsStore(),
		appVersion: app.getVersion(),
	})
		.then((data) => reply(ctx, client, message, 'stats_export_result', data))
		.catch((error) => {
			fail(ctx, client, message, `Export failed: ${errorText(error)}`);
		});
}
