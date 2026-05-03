/**
 * WorktreeAnalytics
 *
 * Worktree-focused analytics section in the Agents tab. Surfaces the
 * relationship between parent agents and their worktree children:
 *
 *   1. Summary row — Parent vs Worktree agent counts plus a ratio badge.
 *   2. Activity split bar — horizontal stacked bar of parent vs worktree
 *      query proportion (worktree segment uses the dashed/striped pattern
 *      established in Doc 1's visual language for worktree differentiation).
 *   3. Per-branch breakdown — one row per worktree session showing the
 *      branch name, query count, and a 7-day Sparkline, sorted by activity.
 *
 * The component is gated upstream so it only renders when at least one
 * worktree session exists; it still degrades gracefully for empty data.
 */

import React, { memo, useMemo } from 'react';
import { Layers, GitBranch } from 'lucide-react';
import type { Theme, Session } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import { getCardStyles } from './SummaryCards';
import { Sparkline } from './Sparkline';
import { isWorktreeAgent } from './chartUtils';

const SPARKLINE_DAYS = 7;

interface WorktreeAnalyticsProps {
	/** All known sessions (terminal-only sessions are filtered out). */
	sessions: Session[];
	/** Aggregated stats — worktree counts come from `worktreeQueries` / `parentQueries`. */
	data: StatsAggregation;
	/** Current theme for color-aware styling. */
	theme: Theme;
}

interface StatCardProps {
	icon: React.ReactNode;
	label: string;
	value: number | string;
	theme: Theme;
	/** 0-based index for the staggered card-enter animation. */
	animationIndex: number;
	/** Accent override for the icon background and elevated border-top. */
	accentColor?: string;
}

const StatCard = memo(function StatCard({
	icon,
	label,
	value,
	theme,
	animationIndex,
	accentColor,
}: StatCardProps) {
	const accent = accentColor ?? theme.colors.accent;
	return (
		<div
			className="card-enter relative p-4 flex items-start gap-3"
			style={{
				...getCardStyles('elevated', theme, accent),
				animationDelay: `${animationIndex * 80}ms`,
			}}
			data-testid="worktree-stat-card"
			role="group"
			aria-label={`${label}: ${value}`}
		>
			<div
				className="flex-shrink-0 p-2 rounded-md"
				style={{
					backgroundColor: `${accent}15`,
					color: accent,
				}}
			>
				{icon}
			</div>
			<div className="min-w-0 flex-1">
				<div
					className="text-xs uppercase tracking-wide mb-1"
					style={{ color: theme.colors.textDim }}
				>
					{label}
				</div>
				<div
					className="font-bold"
					style={{
						color: theme.colors.textMain,
						fontSize: 'clamp(18px, 3vw, 28px)',
					}}
				>
					{value}
				</div>
			</div>
		</div>
	);
});

/**
 * Pull the last `SPARKLINE_DAYS` entries' counts (oldest → newest), left-padding
 * with zeros so sparkline geometry stays stable for sessions with fewer than
 * seven recorded days. Mirrors the helper used by AgentOverviewCards.
 */
function buildSessionSparkline(sessionByDay: Array<{ count: number }> | undefined): number[] {
	if (!sessionByDay || sessionByDay.length === 0) {
		return new Array(SPARKLINE_DAYS).fill(0);
	}
	const counts = sessionByDay.slice(-SPARKLINE_DAYS).map((d) => d.count);
	if (counts.length >= SPARKLINE_DAYS) return counts;
	return [...new Array(SPARKLINE_DAYS - counts.length).fill(0), ...counts];
}

/**
 * Format the worktree-to-parent ratio for the badge.
 *
 * Both zero → em dash; parents only → "0×"; worktrees with no parents → "∞×";
 * otherwise `(worktrees / parents).toFixed(2)×`.
 */
function formatRatio(parents: number, worktrees: number): string {
	if (parents === 0 && worktrees === 0) return '—';
	if (parents === 0) return '∞×';
	return `${(worktrees / parents).toFixed(2)}×`;
}

export const WorktreeAnalytics = memo(function WorktreeAnalytics({
	sessions,
	data,
	theme,
}: WorktreeAnalyticsProps) {
	// Terminal-only sessions are not "agents" — exclude them so counts match
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
			else parents++;
		}
		return {
			parentCount: parents,
			worktreeCount: worktrees,
			ratioLabel: formatRatio(parents, worktrees),
		};
	}, [agentSessions]);

	const { parentQueries, worktreeQueries, totalQueries, parentPct, worktreePct } = useMemo(() => {
		const wq = data.worktreeQueries ?? 0;
		const pq = data.parentQueries ?? 0;
		const total = wq + pq;
		return {
			parentQueries: pq,
			worktreeQueries: wq,
			totalQueries: total,
			parentPct: total > 0 ? (pq / total) * 100 : 0,
			worktreePct: total > 0 ? (wq / total) * 100 : 0,
		};
	}, [data.worktreeQueries, data.parentQueries]);

	const perBranch = useMemo(() => {
		const items: Array<{ session: Session; count: number; sparkline: number[] }> = [];
		for (const s of agentSessions) {
			if (!isWorktreeAgent(s)) continue;
			const sessionByDay = data.bySessionByDay?.[s.id];
			const count = sessionByDay ? sessionByDay.reduce((sum, d) => sum + d.count, 0) : 0;
			items.push({
				session: s,
				count,
				sparkline: buildSessionSparkline(sessionByDay),
			});
		}
		items.sort((a, b) => b.count - a.count);
		return items;
	}, [agentSessions, data.bySessionByDay]);

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
					className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
					style={{
						backgroundColor: `${theme.colors.accent}20`,
						color: theme.colors.accent,
					}}
					data-testid="worktree-ratio-badge"
					title="Worktree-to-parent ratio"
				>
					{ratioLabel}
				</span>
			</div>

			<div className="grid grid-cols-2 gap-3 mb-6">
				<StatCard
					icon={<Layers className="w-4 h-4" />}
					label="Parent Agents"
					value={parentCount}
					theme={theme}
					animationIndex={0}
					accentColor={theme.colors.accent}
				/>
				<StatCard
					icon={<GitBranch className="w-4 h-4" />}
					label="Worktree Agents"
					value={worktreeCount}
					theme={theme}
					animationIndex={1}
					accentColor={theme.colors.success}
				/>
			</div>

			<div className="mb-6" data-testid="worktree-activity-split">
				<div
					className="flex items-center justify-between text-[10px] uppercase tracking-wider mb-2"
					style={{ color: theme.colors.textDim }}
				>
					<span>Query Activity</span>
					<span>{totalQueries} total</span>
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
						No query activity yet
					</div>
				) : (
					<div
						className="flex h-7 rounded overflow-hidden"
						style={{ backgroundColor: `${theme.colors.border}30` }}
						data-testid="worktree-split-bar"
						role="img"
						aria-label={`Parent ${Math.round(parentPct)}%, Worktree ${Math.round(worktreePct)}%`}
					>
						<div
							className="flex items-center justify-center px-2"
							style={{
								width: `${parentPct}%`,
								backgroundColor: theme.colors.accent,
								opacity: 0.85,
								transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
							}}
							data-testid="worktree-split-parent"
						>
							{parentPct >= 12 && (
								<span
									className="text-[10px] font-medium text-white whitespace-nowrap"
									style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
								>
									Parent · {parentQueries}
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
						>
							{worktreePct >= 12 && (
								<span
									className="text-[10px] font-medium text-white whitespace-nowrap"
									style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
								>
									Worktree · {worktreeQueries}
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
											className="text-[10px] truncate"
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
										{entry.count}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
});

export default WorktreeAnalytics;
