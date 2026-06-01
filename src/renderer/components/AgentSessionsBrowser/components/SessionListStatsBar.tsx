import React from 'react';
import { BarChart3, MessageSquare, Database, DollarSign, Zap, Clock, Loader2 } from 'lucide-react';
import type { Theme } from '../../../types';
import { formatSize, formatTokens } from '../../../utils/formatters';

interface SessionListStatsBarProps {
	loading: boolean;
	sessionsCount: number;
	stats: {
		totalSessions: number;
		totalMessages: number;
		totalSize: number;
		totalCost: number;
		totalTokens: number;
		oldestSession: Date | null;
		isComplete: boolean;
	};
	sessionSinceDate: Date | null;
	theme: Theme;
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
			className="px-6 py-3 border-b flex items-center gap-6"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity + '50' }}
		>
			<div className="flex items-center gap-2">
				<BarChart3 className="w-4 h-4" style={{ color: theme.colors.accent }} />
				<span className={`text-xs font-medium ${pulse}`} style={{ color: theme.colors.textDim }}>
					{stats.totalSessions.toLocaleString()}{' '}
					{stats.totalSessions === 1 ? 'session' : 'sessions'}
				</span>
			</div>
			<div className="flex items-center gap-2">
				<MessageSquare className="w-4 h-4" style={{ color: theme.colors.success }} />
				<span className={`text-xs font-medium ${pulse}`} style={{ color: theme.colors.textDim }}>
					{stats.totalMessages.toLocaleString()} messages
				</span>
			</div>
			<div className="flex items-center gap-2">
				<Database className="w-4 h-4" style={{ color: theme.colors.warning }} />
				<span className={`text-xs font-medium ${pulse}`} style={{ color: theme.colors.textDim }}>
					{formatSize(stats.totalSize)}
				</span>
			</div>
			{(stats.totalCost > 0 || !stats.isComplete) && (
				<div className="flex items-center gap-2">
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
				<div className="flex items-center gap-2">
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
				<div className="flex items-center gap-2">
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
