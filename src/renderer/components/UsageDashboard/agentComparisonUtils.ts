import type { StatsAggregation } from '../../hooks/stats/useStats';
import type { Session, Theme } from '../../types';
import { COLORBLIND_AGENT_PALETTE } from '../../constants/colorblindPalettes';
import { buildNameMap, findSessionByStatId, isWorktreeAgent } from './chartUtils';

export interface AgentData {
	key: string;
	label: string;
	agent: string;
	count: number;
	duration: number;
	durationPercentage: number;
	color: string;
	isWorktree: boolean;
}

export type AgentSplitAggregation = Record<
	string,
	{
		regular: { count: number; duration: number };
		worktree: { count: number; duration: number };
	}
>;

export function getAgentColor(
	_agentName: string,
	index: number,
	theme: Theme,
	colorBlindMode?: boolean
): string {
	if (colorBlindMode) {
		return COLORBLIND_AGENT_PALETTE[index % COLORBLIND_AGENT_PALETTE.length];
	}

	if (index === 0) {
		return theme.colors.accent;
	}

	const additionalColors = [
		'#10b981',
		'#8b5cf6',
		'#ef4444',
		'#06b6d4',
		'#ec4899',
		'#f59e0b',
		'#84cc16',
		'#6366f1',
	];

	return additionalColors[(index - 1) % additionalColors.length];
}

export function buildAgentSplitAggregation(
	data: Pick<StatsAggregation, 'bySessionByDay' | 'byAgent'>,
	sessions?: Session[]
): AgentSplitAggregation | null {
	const bySessionByDay = data.bySessionByDay;
	if (!sessions || sessions.length === 0) return null;
	if (!bySessionByDay || Object.keys(bySessionByDay).length === 0) return null;

	const result: AgentSplitAggregation = {};
	let foundWorktree = false;

	for (const [statSessionId, days] of Object.entries(bySessionByDay)) {
		const session = findSessionByStatId(statSessionId, sessions);
		if (!session) continue;
		const provider = session.toolType;
		const isWt = isWorktreeAgent(session);
		if (isWt) foundWorktree = true;

		if (!result[provider]) {
			result[provider] = {
				regular: { count: 0, duration: 0 },
				worktree: { count: 0, duration: 0 },
			};
		}
		const bucket = isWt ? result[provider].worktree : result[provider].regular;
		for (const day of days) {
			bucket.count += day.count;
			bucket.duration += day.duration;
		}
	}

	if (!foundWorktree) return null;

	for (const [provider, agentTotals] of Object.entries(data.byAgent)) {
		if (!result[provider]) {
			result[provider] = {
				regular: { count: 0, duration: 0 },
				worktree: { count: 0, duration: 0 },
			};
		}
		const reconstructedCount = result[provider].regular.count + result[provider].worktree.count;
		const reconstructedDuration =
			result[provider].regular.duration + result[provider].worktree.duration;
		const missingCount = Math.max(0, agentTotals.count - reconstructedCount);
		const missingDuration = Math.max(0, agentTotals.duration - reconstructedDuration);
		if (missingCount > 0 || missingDuration > 0) {
			result[provider].regular.count += missingCount;
			result[provider].regular.duration += missingDuration;
		}
	}

	return result;
}

export function buildAgentComparisonData({
	data,
	splitAggregation,
	theme,
	colorBlindMode,
	sessions,
}: {
	data: Pick<StatsAggregation, 'byAgent'>;
	splitAggregation: AgentSplitAggregation | null;
	theme: Theme;
	colorBlindMode: boolean;
	sessions?: Session[];
}): AgentData[] {
	const totalDuration =
		(splitAggregation
			? Object.values(splitAggregation).reduce(
					(sum, provider) => sum + provider.regular.duration + provider.worktree.duration,
					0
				)
			: Object.values(data.byAgent).reduce((sum, stats) => sum + stats.duration, 0)) || 0;

	const items: AgentData[] = [];
	const providerKeys = Array.from(
		new Set([
			...Object.keys(data.byAgent),
			...(splitAggregation ? Object.keys(splitAggregation) : []),
		])
	);
	const nameMap = buildNameMap(providerKeys, sessions);
	const resolveLabel = (provider: string) => nameMap.get(provider)?.name ?? provider;

	const providerColorIdx: Record<string, number> = {};
	const assignColor = (provider: string): string => {
		if (!(provider in providerColorIdx)) {
			providerColorIdx[provider] = Object.keys(providerColorIdx).length;
		}
		return getAgentColor(provider, providerColorIdx[provider], theme, colorBlindMode);
	};

	if (splitAggregation) {
		for (const [provider, buckets] of Object.entries(splitAggregation)) {
			const color = assignColor(provider);
			const baseLabel = resolveLabel(provider);
			if (buckets.regular.count > 0 || buckets.regular.duration > 0) {
				items.push({
					key: provider,
					label: baseLabel,
					agent: provider,
					count: buckets.regular.count,
					duration: buckets.regular.duration,
					durationPercentage:
						totalDuration > 0 ? (buckets.regular.duration / totalDuration) * 100 : 0,
					color,
					isWorktree: false,
				});
			}
			if (buckets.worktree.count > 0 || buckets.worktree.duration > 0) {
				items.push({
					key: `${provider}__worktree`,
					label: `${baseLabel} (Worktree)`,
					agent: provider,
					count: buckets.worktree.count,
					duration: buckets.worktree.duration,
					durationPercentage:
						totalDuration > 0 ? (buckets.worktree.duration / totalDuration) * 100 : 0,
					color,
					isWorktree: true,
				});
			}
		}
	} else {
		for (const [provider, stats] of Object.entries(data.byAgent)) {
			const color = assignColor(provider);
			const resolved = nameMap.get(provider);
			items.push({
				key: provider,
				label: resolved?.name ?? provider,
				agent: provider,
				count: stats.count,
				duration: stats.duration,
				durationPercentage: totalDuration > 0 ? (stats.duration / totalDuration) * 100 : 0,
				color,
				isWorktree: resolved?.isWorktree ?? false,
			});
		}
	}

	return items.sort((a, b) => b.duration - a.duration);
}
