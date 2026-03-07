import React, { memo } from 'react';
import { Layers, Hash, Bot, User, BarChart3, Loader2, ListOrdered } from 'lucide-react';
import type { Theme } from '../../types';

export interface HistoryStats {
	agentCount: number;
	sessionCount: number;
	autoCount: number;
	userCount: number;
	totalCount: number;
	/** Number of agents currently in 'busy' state (live indicator) */
	activeAgentCount?: number;
	/** Total queued messages across all agents (live indicator) */
	totalQueuedItems?: number;
}

interface HistoryStatsBarProps {
	stats: HistoryStats;
	theme: Theme;
}

interface StatItemProps {
	icon: React.ReactNode;
	label: string;
	value: number;
	color: string;
	theme: Theme;
}

function StatItem({ icon, label, value, color, theme }: StatItemProps) {
	return (
		<div className="flex items-center gap-1.5">
			<span
				className="flex items-center justify-center w-5 h-5 rounded"
				style={{ backgroundColor: color + '15', color }}
			>
				{icon}
			</span>
			<span
				className="text-[10px] uppercase tracking-wider"
				style={{ color: theme.colors.textDim }}
			>
				{label}
			</span>
			<span className="text-xs font-bold tabular-nums" style={{ color: theme.colors.textMain }}>
				{value.toLocaleString()}
			</span>
		</div>
	);
}

const showLiveIndicators = (stats: HistoryStats) =>
	(stats.activeAgentCount !== undefined && stats.activeAgentCount > 0) ||
	(stats.totalQueuedItems !== undefined && stats.totalQueuedItems > 0);

export const HistoryStatsBar = memo(function HistoryStatsBar({
	stats,
	theme,
}: HistoryStatsBarProps) {
	return (
		<div className="flex items-center justify-center gap-4 py-2 mb-3 flex-wrap">
			<StatItem
				icon={<Layers className="w-3 h-3" />}
				label="Agents"
				value={stats.agentCount}
				color={theme.colors.accent}
				theme={theme}
			/>
			<StatItem
				icon={<Hash className="w-3 h-3" />}
				label="Sessions"
				value={stats.sessionCount}
				color={theme.colors.accent}
				theme={theme}
			/>
			<div className="w-px h-4 flex-shrink-0" style={{ backgroundColor: theme.colors.border }} />
			<StatItem
				icon={<User className="w-3 h-3" />}
				label="User"
				value={stats.userCount}
				color={theme.colors.accent}
				theme={theme}
			/>
			<StatItem
				icon={<Bot className="w-3 h-3" />}
				label="Auto"
				value={stats.autoCount}
				color={theme.colors.warning}
				theme={theme}
			/>
			<div className="w-px h-4 flex-shrink-0" style={{ backgroundColor: theme.colors.border }} />
			<StatItem
				icon={<BarChart3 className="w-3 h-3" />}
				label="Total"
				value={stats.totalCount}
				color={theme.colors.textMain}
				theme={theme}
			/>

			{/* Live activity indicators — only shown when provided and > 0 */}
			{showLiveIndicators(stats) && (
				<>
					<div
						className="w-px h-4 flex-shrink-0"
						style={{ backgroundColor: theme.colors.border }}
					/>
					{stats.activeAgentCount !== undefined && stats.activeAgentCount > 0 && (
						<div className="flex items-center gap-1.5">
							<span
								className="flex items-center justify-center w-5 h-5 rounded"
								style={{
									backgroundColor: theme.colors.warning + '15',
									color: theme.colors.warning,
								}}
							>
								<Loader2 className="w-3 h-3 animate-spin" />
							</span>
							<span
								className="text-[10px] uppercase tracking-wider"
								style={{ color: theme.colors.textDim }}
							>
								Active
							</span>
							<span
								className="text-xs font-bold tabular-nums"
								style={{ color: theme.colors.warning }}
							>
								{stats.activeAgentCount}
							</span>
						</div>
					)}
					{stats.totalQueuedItems !== undefined && stats.totalQueuedItems > 0 && (
						<StatItem
							icon={<ListOrdered className="w-3 h-3" />}
							label="Queued"
							value={stats.totalQueuedItems}
							color={theme.colors.accent}
							theme={theme}
						/>
					)}
				</>
			)}
		</div>
	);
});
