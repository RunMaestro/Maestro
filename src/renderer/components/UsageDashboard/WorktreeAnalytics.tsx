/**
 * WorktreeAnalytics
 *
 * Worktree-focused analytics section in the Agent Overview tab. Surfaces the
 * relationship between parent agents and their worktree children:
 *
 *   1. Summary cards - parent agents (agents a live worktree was spawned from)
 *      and worktree agents, plus a worktrees-per-parent badge.
 *   2. Query split bar - queries from worktree agents versus every other agent
 *      in the selected range, from the worktree flag recorded on each query
 *      (`worktreeQueries` / `parentQueries`), so it stays exact after a
 *      worktree agent is deleted.
 *   3. By Branch - one row per live worktree agent with its query count and a
 *      7-day calendar sparkline, plus a "Deleted worktree agents" remainder row
 *      so the rows add up to the bar's worktree total.
 *
 * The component is gated upstream so it only renders when at least one
 * worktree agent exists; it still degrades gracefully for empty data.
 */

import { memo, useMemo } from 'react';
import { Layers, GitBranch } from 'lucide-react';
import type { Theme, Session } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import { formatNumber } from '../../../shared/formatters';
import { Sparkline, StatCardGrid, type StatCardDatum } from '../widgets';
import { isParentAgent, isWorktreeAgent } from './chartUtils';
import { AGENT_SPARKLINE_DAYS, buildCalendarSparkline } from './agentOverviewUtils';

interface WorktreeAnalyticsProps {
	/** All known sessions (terminal-only sessions are filtered out). */
	sessions: Session[];
	/** Aggregated stats - worktree counts come from `worktreeQueries` / `parentQueries`. */
	data: StatsAggregation;
	/** Current theme for color-aware styling. */
	theme: Theme;
}

/**
 * Format the worktrees-per-parent ratio for the badge.
 *
 * Both zero: a hyphen; worktrees whose parents were all deleted: infinity;
 * otherwise `(worktrees / parents).toFixed(2)x`.
 */
function formatRatio(parents: number, worktrees: number): string {
	if (parents === 0 && worktrees === 0) return '-';
	if (parents === 0) return '∞×';
	return `${(worktrees / parents).toFixed(2)}×`;
}

export const WorktreeAnalytics = memo(function WorktreeAnalytics({
	sessions,
	data,
	theme,
}: WorktreeAnalyticsProps) {
	// Terminal-only sessions are not "agents" - exclude them so counts match
	// the rest of the dashboard (SessionStats / AgentOverviewCards).
	const agentSessions = useMemo(
		() => sessions.filter((s) => s.toolType !== 'terminal'),
		[sessions]
	);

	const { parentCount, worktreeCount, ratioLabel } = useMemo(() => {
		let parents = 0;
		let worktrees = 0;
		for (const s of agentSessions) {
			if (isWorktreeAgent(s)) worktrees++;
			else if (isParentAgent(s, agentSessions)) parents++;
		}
		return {
			parentCount: parents,
			worktreeCount: worktrees,
			ratioLabel: formatRatio(parents, worktrees),
		};
	}, [agentSessions]);

	const cards = useMemo(
		(): StatCardDatum[] => [
			{ label: 'Parent Agents', value: parentCount, icon: Layers },
			{
				label: 'Worktree Agents',
				value: worktreeCount,
				icon: GitBranch,
				color: theme.colors.success,
			},
		],
		[parentCount, worktreeCount, theme.colors.success]
	);

	const { otherQueries, worktreeQueries, totalQueries, otherPct, worktreePct } = useMemo(() => {
		const wq = data.worktreeQueries ?? 0;
		const oq = data.parentQueries ?? 0;
		const total = wq + oq;
		return {
			otherQueries: oq,
			worktreeQueries: wq,
			totalQueries: total,
			otherPct: total > 0 ? (oq / total) * 100 : 0,
			worktreePct: total > 0 ? (wq / total) * 100 : 0,
		};
	}, [data.worktreeQueries, data.parentQueries]);

	const { perBranch, deletedWorktreeQueries } = useMemo(() => {
		const items: Array<{ session: Session; count: number; sparkline: number[] }> = [];
		let liveTotal = 0;
		for (const s of agentSessions) {
			if (!isWorktreeAgent(s)) continue;
			const sessionByDay = data.bySessionByDay?.[s.id];
			const count = sessionByDay ? sessionByDay.reduce((sum, d) => sum + d.count, 0) : 0;
			liveTotal += count;
			items.push({
				session: s,
				count,
				sparkline: buildCalendarSparkline(sessionByDay, data.window, AGENT_SPARKLINE_DAYS),
			});
		}
		items.sort((a, b) => b.count - a.count);
		// Worktree queries no live worktree agent accounts for: their agent was
		// deleted. Shown as one row so the list adds up to the bar above it.
		return {
			perBranch: items,
			deletedWorktreeQueries: Math.max(0, (data.worktreeQueries ?? 0) - liveTotal),
		};
	}, [agentSessions, data.bySessionByDay, data.window, data.worktreeQueries]);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="worktree-analytics"
			role="region"
			aria-label="Worktree Analytics"
		>
			<div className="flex items-center justify-between mb-4">
				<h3
					className="text-sm font-medium"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
					Worktrees
				</h3>
				<span
					className="px-2 py-0.5 rounded text-2xs font-bold uppercase tracking-wider"
					style={{
						backgroundColor: `${theme.colors.accent}20`,
						color: theme.colors.accent,
					}}
					data-testid="worktree-ratio-badge"
					title="Worktree agents per parent agent"
				>
					{ratioLabel}
				</span>
			</div>

			<div className="mb-6" data-testid="worktree-stat-cards">
				<StatCardGrid theme={theme} cards={cards} minColumnWidth={180} />
			</div>

			<div className="mb-6" data-testid="worktree-activity-split">
				<div
					className="flex items-center justify-between text-2xs uppercase tracking-wider mb-2"
					style={{ color: theme.colors.textDim }}
				>
					<span>Queries in range</span>
					<span>{formatNumber(totalQueries)} total</span>
				</div>
				{totalQueries === 0 ? (
					<div
						className="h-7 rounded flex items-center justify-center text-xs"
						style={{
							backgroundColor: `${theme.colors.border}30`,
							color: theme.colors.textDim,
						}}
						data-testid="worktree-split-bar-empty"
					>
						No queries in this range
					</div>
				) : (
					<div
						className="flex h-7 rounded overflow-hidden"
						style={{ backgroundColor: `${theme.colors.border}30` }}
						data-testid="worktree-split-bar"
						role="img"
						aria-label={`Other agents ${Math.round(otherPct)}%, Worktree agents ${Math.round(worktreePct)}%`}
					>
						<div
							className="flex items-center justify-center px-2"
							style={{
								width: `${otherPct}%`,
								backgroundColor: theme.colors.accent,
								opacity: 0.85,
								transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
							}}
							data-testid="worktree-split-other"
							title={`Other agents: ${formatNumber(otherQueries)} queries`}
						>
							{otherPct >= 12 && (
								<span
									className="text-2xs font-medium text-white whitespace-nowrap"
									style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
								>
									Other agents · {formatNumber(otherQueries)}
								</span>
							)}
						</div>
						<div
							className="flex items-center justify-center px-2"
							style={{
								width: `${worktreePct}%`,
								backgroundColor: theme.colors.success,
								backgroundImage:
									'repeating-linear-gradient(45deg, rgba(255,255,255,0.22) 0 4px, transparent 4px 8px)',
								opacity: 0.85,
								transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
							}}
							data-testid="worktree-split-worktree"
							title={`Worktree agents: ${formatNumber(worktreeQueries)} queries`}
						>
							{worktreePct >= 12 && (
								<span
									className="text-2xs font-medium text-white whitespace-nowrap"
									style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
								>
									Worktrees · {formatNumber(worktreeQueries)}
								</span>
							)}
						</div>
					</div>
				)}
			</div>

			<div>
				<h4
					className="text-xs font-medium uppercase tracking-wider mb-3"
					style={{ color: theme.colors.textDim }}
				>
					By Branch
				</h4>
				{perBranch.length === 0 ? (
					<div
						className="text-xs"
						style={{ color: theme.colors.textDim }}
						data-testid="worktree-branch-empty"
					>
						No worktree agents to display.
					</div>
				) : (
					<div className="space-y-2" data-testid="worktree-branch-list">
						{perBranch.map((entry, index) => {
							const branch = entry.session.worktreeBranch || entry.session.name;
							return (
								<div
									key={entry.session.id}
									className="card-enter flex items-center gap-3 p-2 rounded"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px dashed ${theme.colors.success}66`,
										animationDelay: `${(index + 2) * 60}ms`,
									}}
									data-testid="worktree-branch-row"
									role="group"
									aria-label={`${branch}: ${entry.count} ${
										entry.count === 1 ? 'query' : 'queries'
									}`}
								>
									<GitBranch
										className="w-3.5 h-3.5 flex-shrink-0"
										style={{ color: theme.colors.success }}
										aria-hidden="true"
									/>
									<div className="flex-1 min-w-0">
										<div
											className="text-sm truncate"
											style={{ color: theme.colors.textMain }}
											title={branch}
											data-testid="worktree-branch-name"
										>
											{branch}
										</div>
										<div
											className="text-2xs truncate"
											style={{ color: theme.colors.textDim }}
											title={entry.session.name}
										>
											{entry.session.name}
										</div>
									</div>
									<div className="flex-shrink-0 opacity-80 pointer-events-none">
										<Sparkline
											data={entry.sparkline}
											color={theme.colors.success}
											width={70}
											height={20}
										/>
									</div>
									<div
										className="w-10 text-right text-xs flex-shrink-0"
										style={{ color: theme.colors.textDim }}
										data-testid="worktree-branch-count"
									>
										{formatNumber(entry.count)}
									</div>
								</div>
							);
						})}
						{deletedWorktreeQueries > 0 && (
							<div
								className="flex items-center gap-3 p-2 rounded"
								style={{
									backgroundColor: theme.colors.bgActivity,
									border: `1px dashed ${theme.colors.border}`,
								}}
								data-testid="worktree-branch-deleted"
								role="group"
								aria-label={`Deleted worktree agents: ${deletedWorktreeQueries} ${
									deletedWorktreeQueries === 1 ? 'query' : 'queries'
								}`}
								title="Queries from worktree agents that have since been deleted"
							>
								<GitBranch
									className="w-3.5 h-3.5 flex-shrink-0"
									style={{ color: theme.colors.textDim }}
									aria-hidden="true"
								/>
								<div
									className="flex-1 min-w-0 text-sm truncate"
									style={{ color: theme.colors.textDim }}
								>
									Deleted worktree agents
								</div>
								<div
									className="w-10 text-right text-xs flex-shrink-0"
									style={{ color: theme.colors.textDim }}
									data-testid="worktree-branch-deleted-count"
								>
									{formatNumber(deletedWorktreeQueries)}
								</div>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
});

export default WorktreeAnalytics;
