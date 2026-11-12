import React from 'react';
import { BarChart3, MessageSquare, Database, DollarSign, Zap, Clock, Loader2 } from 'lucide-react';
import type { Theme } from '../../../types';
import { formatSize, formatTokens, formatTokensCompact } from '../../../utils/formatters';
import type { AggregateStats } from '../types';

interface SessionListStatsBarProps {
	loading: boolean;
	sessionsCount: number;
	stats: {
		totalSessions: number;
		totalMessages: number;
		totalSize: number;
		totalCost: number;
		totalTokens: number;
		tokenSplit?: AggregateStats['tokenSplit'];
		unsplitTokens?: number;
		oldestSession: Date | null;
		isComplete: boolean;
	};
	sessionSinceDate: Date | null;
	theme: Theme;
}

/**
 * Hover text for the token total. Cache reads dominate what a Claude session is
 * billed for, so the total includes them; this says how it divides.
 */
function tokenBreakdownTitle(
	split: AggregateStats['tokenSplit'],
	unsplitTokens: number | undefined
): string | undefined {
	if (!split) return undefined;
	const parts = [
		`Input ${formatTokensCompact(split.inputTokens)}`,
		`Output ${formatTokensCompact(split.outputTokens)}`,
		`Cache reads ${formatTokensCompact(split.cacheReadTokens)}`,
		`Cache writes ${formatTokensCompact(split.cacheCreationTokens)}`,
	];
	if (unsplitTokens && unsplitTokens > 0) {
		parts.push(`Archived sessions, no breakdown ${formatTokensCompact(unsplitTokens)}`);
	}
	return parts.join('\n');
}

export const SessionListStatsBar = React.memo(function SessionListStatsBar({
	loading,
	sessionsCount,
	stats,
	sessionSinceDate,
	theme,
}: SessionListStatsBarProps) {
	if (loading || sessionsCount === 0) return null;

	const pulse = !stats.isComplete ? 'animate-pulse' : '';

	return (
		<div
			className="px-6 py-3 border-b flex items-center gap-6 overflow-x-auto no-scrollbar"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity + '50' }}
		>
			<div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
				<BarChart3 className="w-4 h-4" style={{ color: theme.colors.accent }} />
				<span className={`text-xs font-medium ${pulse}`} style={{ color: theme.colors.textDim }}>
					{stats.totalSessions.toLocaleString()}{' '}
					{stats.totalSessions === 1 ? 'session' : 'sessions'}
				</span>
			</div>
			<div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
				<MessageSquare className="w-4 h-4" style={{ color: theme.colors.success }} />
				<span className={`text-xs font-medium ${pulse}`} style={{ color: theme.colors.textDim }}>
					{stats.totalMessages.toLocaleString()} messages
				</span>
			</div>
			<div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
				<Database className="w-4 h-4" style={{ color: theme.colors.warning }} />
				<span className={`text-xs font-medium ${pulse}`} style={{ color: theme.colors.textDim }}>
					{formatSize(stats.totalSize)}
				</span>
			</div>
			{(stats.totalCost > 0 || !stats.isComplete) && (
				<div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
					<DollarSign className="w-4 h-4" style={{ color: theme.colors.success }} />
					<span
						className={`text-xs font-medium font-mono ${pulse}`}
						style={{ color: theme.colors.success }}
					>
						$
						{stats.totalCost.toLocaleString('en-US', {
							minimumFractionDigits: 2,
							maximumFractionDigits: 2,
						})}
					</span>
				</div>
			)}
			{(stats.totalTokens > 0 || !stats.isComplete) && (
				<div
					className="flex items-center gap-2 shrink-0 whitespace-nowrap"
					title={tokenBreakdownTitle(stats.tokenSplit, stats.unsplitTokens)}
					data-testid="session-stats-tokens"
				>
					<Zap className="w-4 h-4" style={{ color: theme.colors.accent }} />
					<span
						className={`text-xs font-medium font-mono ${pulse}`}
						style={{ color: theme.colors.textDim }}
					>
						{formatTokens(stats.totalTokens)} tokens
					</span>
				</div>
			)}
			{sessionSinceDate && (
				<div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
					<Clock className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
						Since {sessionSinceDate.toLocaleDateString()}
					</span>
				</div>
			)}
			{!stats.isComplete && (
				<Loader2 className="w-3 h-3 animate-spin ml-auto" style={{ color: theme.colors.textDim }} />
			)}
		</div>
	);
});
