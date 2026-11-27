/**
 * SessionStats
 *
 * The "Agent Statistics" section of the Agent Overview tab: the shape of the
 * live agent list. Total agents (with how many ran a query in the selected
 * range), agents in Git repos versus plain folders, local versus remote, and a
 * bar per provider.
 *
 * Everything here describes the agents that exist NOW, except the "active"
 * footnote, which is the one number that moves with the range picker.
 */

import { memo, useMemo } from 'react';
import { Monitor, GitBranch, Folder, Laptop } from 'lucide-react';
import type { Theme, Session, ToolType } from '../../types';
import type { StatsAggregation } from '../../../shared/stats-types';
import { countActiveAgents } from '../../../shared/statsActiveAgents';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { formatNumber } from '../../../shared/formatters';
import { StatCardGrid, type StatCardDatum } from '../widgets';
import {
	isParentAgent,
	BAR_CHART_GRID_CLASS,
	BAR_CHART_GRID_STYLE,
	BAR_CHART_ROW_STYLE,
	getSeriesColor,
} from './chartUtils';

interface SessionStatsProps {
	/** Array of all sessions */
	sessions: Session[];
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
	/**
	 * Aggregated stats for the dashboard's selected range. Only used to report
	 * how many agents actually ran something in that range - omit it and the
	 * Total Agents card simply drops the "N active" footnote.
	 */
	data?: StatsAggregation;
}

/**
 * Whether an agent runs over SSH. `sshRemoteId` is set once the AI process has
 * spawned on the remote; `sessionSshRemoteConfig.enabled` is set before that,
 * so both are checked.
 */
function isRemoteAgent(session: Session): boolean {
	return (
		Boolean(session.cwd?.includes('://')) ||
		Boolean(session.sshRemoteId) ||
		Boolean(session.sessionSshRemoteConfig?.enabled)
	);
}

export const SessionStats = memo(function SessionStats({
	sessions,
	theme,
	colorBlindMode = false,
	data,
}: SessionStatsProps) {
	// Terminal sessions are not agents anywhere on the dashboard.
	const agentSessions = useMemo(
		() => sessions.filter((s) => s.toolType !== 'terminal'),
		[sessions]
	);

	const stats = useMemo(() => {
		const byProvider: Record<string, number> = {};
		let gitRepos = 0;
		let plainFolders = 0;
		let remote = 0;
		let local = 0;
		let bookmarked = 0;
		let worktreeParents = 0;

		for (const session of agentSessions) {
			byProvider[session.toolType] = (byProvider[session.toolType] || 0) + 1;
			if (session.isGitRepo) gitRepos++;
			else plainFolders++;
			if (isRemoteAgent(session)) remote++;
			else local++;
			if (session.bookmarked) bookmarked++;
			if (isParentAgent(session, agentSessions)) worktreeParents++;
		}

		return {
			total: agentSessions.length,
			byProvider,
			gitRepos,
			plainFolders,
			remote,
			local,
			bookmarked,
			worktreeParents,
		};
	}, [agentSessions]);

	// Agents that recorded work inside the dashboard's selected range. This
	// moves with the range picker, unlike every other number on this card.
	const activeAgentCount = useMemo(
		() => (data ? countActiveAgents(agentSessions, data.bySessionByDay) : null),
		[agentSessions, data]
	);

	const cards = useMemo((): StatCardDatum[] => {
		const totalCaption = [
			activeAgentCount !== null ? `${formatNumber(activeAgentCount)} active in range` : null,
			stats.bookmarked > 0 ? `${formatNumber(stats.bookmarked)} bookmarked` : null,
		]
			.filter(Boolean)
			.join(' · ');
		return [
			{
				label: 'Total Agents',
				value: stats.total,
				icon: Monitor,
				caption: totalCaption || undefined,
			},
			{
				label: 'Agents in Git Repos',
				value: stats.gitRepos,
				icon: GitBranch,
				caption:
					stats.worktreeParents > 0
						? `${formatNumber(stats.worktreeParents)} with worktrees`
						: undefined,
			},
			{ label: 'Agents in Plain Folders', value: stats.plainFolders, icon: Folder },
			{
				label: 'Local Agents',
				value: stats.local,
				icon: Laptop,
				caption: stats.remote > 0 ? `${formatNumber(stats.remote)} remote` : undefined,
			},
		];
	}, [stats, activeAgentCount]);

	// Busiest provider first. Each row is a PROVIDER, so it is labeled with the
	// provider's name - never one agent's name, even when only one agent uses it.
	const sortedProviders = useMemo(
		() =>
			Object.entries(stats.byProvider)
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([provider, count], index) => ({
					provider: provider as ToolType,
					count,
					color: getSeriesColor(index, theme, colorBlindMode),
					displayName: getAgentDisplayName(provider),
				})),
		[stats.byProvider, theme, colorBlindMode]
	);

	if (agentSessions.length === 0) {
		return (
			<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
				<h3
					className="text-sm font-medium mb-4"
					style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
				>
					Agent Statistics
				</h3>
				<div
					className="flex items-center justify-center h-24"
					style={{ color: theme.colors.textDim }}
				>
					<span className="text-sm">No agents registered</span>
				</div>
			</div>
		);
	}

	return (
		<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
			<h3
				className="text-sm font-medium mb-4"
				style={{ color: theme.colors.textMain, animation: 'card-enter 0.4s ease both' }}
			>
				Agent Statistics
			</h3>

			<div className="mb-6" data-testid="session-stats-cards">
				<StatCardGrid theme={theme} cards={cards} minColumnWidth={180} />
			</div>

			<div className="space-y-3">
				<h4
					className="text-xs font-medium uppercase tracking-wider"
					style={{ color: theme.colors.textDim }}
				>
					Agents by Provider
				</h4>
				<div className={BAR_CHART_GRID_CLASS} style={BAR_CHART_GRID_STYLE}>
					{sortedProviders.map((row) => {
						const percentage = stats.total > 0 ? (row.count / stats.total) * 100 : 0;
						return (
							<div
								key={row.provider}
								style={BAR_CHART_ROW_STYLE}
								title={`${row.displayName}: ${row.count} ${row.count === 1 ? 'agent' : 'agents'}`}
							>
								<div
									className="text-sm min-w-0 flex items-center gap-2"
									style={{ color: theme.colors.textDim }}
									data-testid="bar-chart-label"
								>
									<div
										className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
										style={{ backgroundColor: row.color }}
									/>
									<span className="truncate">{row.displayName}</span>
								</div>

								<div
									className="h-6 rounded overflow-hidden"
									style={{ backgroundColor: `${theme.colors.border}30` }}
								>
									<div
										className="h-full rounded"
										style={{
											width: `${Math.max(percentage, 2)}%`,
											backgroundColor: row.color,
											opacity: 0.85,
											transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
										}}
									/>
								</div>

								<div
									className="w-12 text-xs text-right tabular-nums"
									style={{ color: theme.colors.textDim }}
								>
									{formatNumber(row.count)}
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
});

export default SessionStats;
