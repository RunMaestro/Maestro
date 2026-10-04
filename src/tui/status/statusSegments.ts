/**
 * The status line under the transcript (CH-6): provider, model, effort,
 * context usage, and cost for the tab on screen. Pure, so the wording and the
 * fitting are tested without Ink.
 *
 * Everything comes from the tab record. `usageStats` is the host's folded copy
 * (it trails a finished turn by the persistence debounce), and the context
 * figure follows the desktop gauge: tokens by the provider's own rule, over the
 * window the provider reported or the library's table.
 */

import {
	estimateContextUsage,
	formatCost,
	formatTokensCompact,
	getAgentDisplayName,
	getContextWindowForAgent,
	type AITabRecord,
	type AgentRecord,
	type ToolType,
	type UsageStats,
} from '../../shared/maestro-lib';

export type StatusTone = 'normal' | 'warn' | 'danger';

export interface StatusSegment {
	key: 'provider' | 'model' | 'effort' | 'context' | 'cost';
	text: string;
	tone: StatusTone;
}

/** Context use at which the figure turns yellow, then red. */
export const CONTEXT_WARN_PERCENT = 70;
export const CONTEXT_DANGER_PERCENT = 90;

/** Between segments. */
export const STATUS_SEPARATOR = ' · ';

/** A tab's `usageStats` is `unknown` on the record; keep it only when every count is a number. */
export function readUsageStats(value: unknown): UsageStats | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const raw = value as Record<string, unknown>;
	const num = (key: string): number => {
		const field = raw[key];
		return typeof field === 'number' && Number.isFinite(field) ? field : 0;
	};
	return {
		inputTokens: num('inputTokens'),
		outputTokens: num('outputTokens'),
		cacheReadInputTokens: num('cacheReadInputTokens'),
		cacheCreationInputTokens: num('cacheCreationInputTokens'),
		totalCostUsd: num('totalCostUsd'),
		contextWindow: num('contextWindow'),
	};
}

function contextTone(percent: number): StatusTone {
	if (percent >= CONTEXT_DANGER_PERCENT) return 'danger';
	if (percent >= CONTEXT_WARN_PERCENT) return 'warn';
	return 'normal';
}

/**
 * The context segment. A turn that chained many tool calls reports counts
 * summed across its calls, which can exceed the window; `estimateContextUsage`
 * then answers null and the agent's own stored percentage stands in, marked
 * with `~` because it is the last good reading, not this one.
 */
export function contextSegment(agent: AgentRecord, stats: UsageStats | undefined): StatusSegment {
	if (!stats) return { key: 'context', text: 'ctx -', tone: 'normal' };
	const window =
		stats.contextWindow > 0 ? stats.contextWindow : getContextWindowForAgent(agent.toolType);
	const direct = estimateContextUsage(stats, agent.toolType as ToolType);
	if (direct !== null) {
		const used = Math.round((direct / 100) * window);
		return {
			key: 'context',
			text: `ctx ${direct}% (${formatTokensCompact(used)}/${formatTokensCompact(window)})`,
			tone: contextTone(direct),
		};
	}
	const stored = typeof agent.contextUsage === 'number' ? agent.contextUsage : 0;
	if (stored > 0) {
		return {
			key: 'context',
			text: `ctx ~${stored}% of ${formatTokensCompact(window)}`,
			tone: contextTone(stored),
		};
	}
	return { key: 'context', text: `ctx ? of ${formatTokensCompact(window)}`, tone: 'normal' };
}

/** All five segments for a tab, in the order they are drawn. */
export function buildStatusSegments(agent: AgentRecord, tab: AITabRecord): StatusSegment[] {
	const stats = readUsageStats(tab.usageStats);
	return [
		{ key: 'provider', text: getAgentDisplayName(agent.toolType), tone: 'normal' },
		{ key: 'model', text: tab.customModel ?? agent.customModel ?? 'default model', tone: 'normal' },
		{
			key: 'effort',
			text: tab.customEffort ?? agent.customEffort ?? 'default effort',
			tone: 'normal',
		},
		contextSegment(agent, stats),
		{ key: 'cost', text: stats ? formatCost(stats.totalCostUsd) : '-', tone: 'normal' },
	];
}

/** Which segment goes first when the line is too wide: the least telling, so context and cost stay. */
const DROP_ORDER: ReadonlyArray<StatusSegment['key']> = ['effort', 'provider', 'model'];

/** Cells the segments take once joined. */
export function statusLineWidth(segments: readonly StatusSegment[]): number {
	if (segments.length === 0) return 0;
	return (
		segments.reduce((sum, segment) => sum + segment.text.length, 0) +
		STATUS_SEPARATOR.length * (segments.length - 1)
	);
}

/**
 * Drops segments, least telling first, until the line fits `width`. Context
 * and cost are never dropped; if they alone are too wide the view truncates.
 */
export function fitStatusSegments(
	segments: readonly StatusSegment[],
	width: number
): StatusSegment[] {
	let fitted = [...segments];
	for (const key of DROP_ORDER) {
		if (statusLineWidth(fitted) <= width) break;
		fitted = fitted.filter((segment) => segment.key !== key);
	}
	return fitted;
}
