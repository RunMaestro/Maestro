/**
 * CueDashboardStats — Top-of-dashboard stat cards: pipelines, total executions
 * (lifetime), average runtime over the recent activity log, agents in pipelines.
 */

import { Activity, Clock, GitFork, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Theme } from '../../types';
import { formatElapsedTime, formatNumber } from '../../../shared/formatters';

/** GitHub-stars style: lower-case suffix (1k, 1.1k, 10.3k). */
function formatCompactCount(n: number): string {
	return formatNumber(n).replace('K', 'k');
}

interface CueDashboardStatsProps {
	theme: Theme;
	pipelineCount: number;
	executionCount: number;
	/** Average run duration (ms) across the loaded activity log; null when no completed runs. */
	averageRuntimeMs: number | null;
	agentCount: number;
}

interface StatCardProps {
	label: string;
	value: string;
	icon: ReactNode;
	theme: Theme;
}

function StatCard({ label, value, icon, theme }: StatCardProps) {
	return (
		<div
			className="flex items-center gap-3 p-3 rounded-lg"
			style={{ backgroundColor: theme.colors.bgActivity }}
		>
			<div className="p-2 rounded-lg" style={{ backgroundColor: `${theme.colors.accent}20` }}>
				{icon}
			</div>
			<div className="min-w-0">
				<div
					className="text-lg font-semibold leading-tight"
					style={{ color: theme.colors.textMain }}
				>
					{value}
				</div>
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					{label}
				</div>
			</div>
		</div>
	);
}

export function CueDashboardStats({
	theme,
	pipelineCount,
	executionCount,
	averageRuntimeMs,
	agentCount,
}: CueDashboardStatsProps) {
	return (
		<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
			<StatCard
				theme={theme}
				label="Pipelines"
				value={formatCompactCount(pipelineCount)}
				icon={<GitFork className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			/>
			<StatCard
				theme={theme}
				label="Total Executions"
				value={formatCompactCount(executionCount)}
				icon={<Activity className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			/>
			<StatCard
				theme={theme}
				label="Average Runtime"
				value={averageRuntimeMs === null ? '—' : formatElapsedTime(averageRuntimeMs)}
				icon={<Clock className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			/>
			<StatCard
				theme={theme}
				label="Agents"
				value={formatCompactCount(agentCount)}
				icon={<Users className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			/>
		</div>
	);
}
