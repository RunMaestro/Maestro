/**
 * SessionStats
 *
 * Displays statistics about registered sessions in the Agents tab.
 * Shows breakdown by: total count, agent type, git vs folder, remote vs local.
 *
 * Features:
 * - Summary cards showing key session metrics
 * - Breakdown by agent type with color-coded indicators
 * - Repository vs plain folder breakdown
 * - Remote (SSH) vs local breakdown
 */

import React, { useMemo } from 'react';
import { Monitor, GitBranch, Folder, Laptop } from 'lucide-react';
import type { Theme, Session, ToolType } from '../../types';
import { COLORBLIND_AGENT_PALETTE } from '../../constants/colorblindPalettes';

interface SessionStatsProps {
	/** Array of all sessions */
	sessions: Session[];
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
}

interface StatCardProps {
	label: string;
	value: number | string;
	icon: React.ReactNode;
	theme: Theme;
	subValue?: string;
}

function StatCard({ label, value, icon, theme, subValue }: StatCardProps) {
	return (
		<div
			className="flex items-center gap-3 p-3 rounded-lg"
			style={{ backgroundColor: theme.colors.bgActivity }}
		>
			<div className="p-2 rounded-lg" style={{ backgroundColor: `${theme.colors.accent}20` }}>
				{icon}
			</div>
			<div>
				<div className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
					{value}
				</div>
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					{label}
				</div>
				{subValue && (
					<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim, opacity: 0.7 }}>
						{subValue}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Get color for an agent type
 */
function getAgentColor(index: number, theme: Theme, colorBlindMode?: boolean): string {
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

/**
 * Format agent type display name
 */
function formatAgentName(toolType: ToolType): string {
	const names: Record<string, string> = {
		'claude-code': 'Claude Code',
		opencode: 'OpenCode',
		'openai-codex': 'OpenAI Codex',
		'gemini-cli': 'Gemini CLI',
		'qwen3-coder': 'Qwen3 Coder',
		aider: 'Aider',
		terminal: 'Terminal',
	};
	return names[toolType] || toolType;
}

export function SessionStats({ sessions, theme, colorBlindMode = false }: SessionStatsProps) {
	// Filter out terminal-only sessions for meaningful stats
	const agentSessions = useMemo(
		() => sessions.filter((s) => s.toolType !== 'terminal'),
		[sessions]
	);

	// Calculate stats
	const stats = useMemo(() => {
		const byAgent: Record<string, number> = {};
		let gitRepos = 0;
		let plainFolders = 0;
		let remoteSessions = 0;
		let localSessions = 0;
		let bookmarked = 0;
		let withWorktrees = 0;

		for (const session of agentSessions) {
			// Count by agent type
			byAgent[session.toolType] = (byAgent[session.toolType] || 0) + 1;

			// Git vs folder
			if (session.isGitRepo) {
				gitRepos++;
			} else {
				plainFolders++;
			}

			// Remote vs local - check both sshRemoteId (set after AI spawn) and sessionSshRemoteConfig.enabled
			// (set before spawn). See CLAUDE.md "SSH Remote Sessions" for why both are needed.
			const isRemote =
				session.cwd?.includes('://') ||
				!!(session as any).sshRemoteId ||
				!!(session as any).sessionSshRemoteConfig?.enabled;
			if (isRemote) {
				remoteSessions++;
			} else {
				localSessions++;
			}

			// Bookmarked
			if (session.bookmarked) {
				bookmarked++;
			}

			// Worktrees
			if (session.worktreeConfig || session.parentSessionId) {
				withWorktrees++;
			}
		}

		return {
			total: agentSessions.length,
			byAgent,
			gitRepos,
			plainFolders,
			remoteSessions,
			localSessions,
			bookmarked,
			withWorktrees,
		};
	}, [agentSessions]);

	// Sort agents by count (descending)
	const sortedAgents = useMemo(
		() =>
			Object.entries(stats.byAgent)
				.sort((a, b) => b[1] - a[1])
				.map(([agent, count], index) => ({
					agent: agent as ToolType,
					count,
					color: getAgentColor(index, theme, colorBlindMode),
				})),
		[stats.byAgent, theme, colorBlindMode]
	);

	if (agentSessions.length === 0) {
		return (
			<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
				<h3 className="text-sm font-medium mb-4" style={{ color: theme.colors.textMain }}>
					Agent Statistics
				</h3>
				<div
					className="flex items-center justify-center h-24"
					style={{ color: theme.colors.textDim }}
				>
					<span className="text-sm">No agent sessions registered</span>
				</div>
			</div>
		);
	}

	return (
		<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
			<h3 className="text-sm font-medium mb-4" style={{ color: theme.colors.textMain }}>
				Agent Statistics
			</h3>

			{/* Summary Cards */}
			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
				<StatCard
					label="Total Agents"
					value={stats.total}
					icon={<Monitor className="w-4 h-4" style={{ color: theme.colors.accent }} />}
					theme={theme}
					subValue={stats.bookmarked > 0 ? `${stats.bookmarked} bookmarked` : undefined}
				/>
				<StatCard
					label="Git Repositories"
					value={stats.gitRepos}
					icon={<GitBranch className="w-4 h-4" style={{ color: theme.colors.accent }} />}
					theme={theme}
					subValue={stats.withWorktrees > 0 ? `${stats.withWorktrees} with worktrees` : undefined}
				/>
				<StatCard
					label="Plain Folders"
					value={stats.plainFolders}
					icon={<Folder className="w-4 h-4" style={{ color: theme.colors.accent }} />}
					theme={theme}
				/>
				<StatCard
					label="Local Agents"
					value={stats.localSessions}
					icon={<Laptop className="w-4 h-4" style={{ color: theme.colors.accent }} />}
					theme={theme}
					subValue={stats.remoteSessions > 0 ? `${stats.remoteSessions} remote` : undefined}
				/>
			</div>

			{/* Agent Type Breakdown */}
			<div className="space-y-3">
				<h4
					className="text-xs font-medium uppercase tracking-wider"
					style={{ color: theme.colors.textDim }}
				>
					By Agent Type
				</h4>
				<div className="space-y-2">
					{sortedAgents.map((agent) => {
						const percentage = stats.total > 0 ? (agent.count / stats.total) * 100 : 0;
						return (
							<div key={agent.agent} className="flex items-center gap-3">
								{/* Agent name */}
								<div
									className="w-28 text-sm truncate flex-shrink-0 flex items-center gap-2"
									style={{ color: theme.colors.textDim }}
								>
									<div
										className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
										style={{ backgroundColor: agent.color }}
									/>
									{formatAgentName(agent.agent)}
								</div>

								{/* Bar */}
								<div
									className="flex-1 h-6 rounded overflow-hidden"
									style={{ backgroundColor: `${theme.colors.border}30` }}
								>
									<div
										className="h-full rounded flex items-center"
										style={{
											width: `${Math.max(percentage, 2)}%`,
											backgroundColor: agent.color,
											opacity: 0.85,
											transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
										}}
									>
										{percentage > 20 && (
											<span
												className="text-xs font-medium px-2 text-white"
												style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
											>
												{agent.count}
											</span>
										)}
									</div>
								</div>

								{/* Count */}
								<div
									className="w-12 text-xs text-right flex-shrink-0"
									style={{ color: theme.colors.textDim }}
								>
									{agent.count}
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}

export default SessionStats;
