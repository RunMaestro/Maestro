/**
 * AgentEfficiencyChart
 *
 * Displays efficiency metrics for each agent type using data from stats.
 * Shows average duration per query for each agent, allowing comparison
 * of which agents respond faster on average.
 *
 * Features:
 * - Horizontal bar chart showing avg duration per query
 * - Color-coded by agent
 * - Sorted by efficiency (fastest first)
 * - Colorblind-friendly palette option
 */

import { useMemo } from 'react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import { COLORBLIND_AGENT_PALETTE } from '../../constants/colorblindPalettes';

interface AgentEfficiencyChartProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
	if (ms === 0) return '0s';

	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

/**
 * Format agent type display name
 */
function formatAgentName(agent: string): string {
	const names: Record<string, string> = {
		'claude-code': 'Claude Code',
		opencode: 'OpenCode',
		'openai-codex': 'OpenAI Codex',
		codex: 'Codex',
		'gemini-cli': 'Gemini CLI',
		'qwen3-coder': 'Qwen3 Coder',
		'factory-droid': 'Factory Droid',
		terminal: 'Terminal',
	};
	return names[agent] || agent;
}

/**
 * Get color for an agent
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

export function AgentEfficiencyChart({
	data,
	theme,
	colorBlindMode = false,
}: AgentEfficiencyChartProps) {
	// Calculate efficiency data (avg duration per query) for each agent
	const efficiencyData = useMemo(() => {
		const agents = Object.entries(data.byAgent)
			.map(([agent, stats]) => ({
				agent,
				avgDuration: stats.count > 0 ? stats.duration / stats.count : 0,
				totalQueries: stats.count,
				totalDuration: stats.duration,
			}))
			.filter((a) => a.totalQueries > 0) // Only show agents with data
			.sort((a, b) => a.avgDuration - b.avgDuration); // Fastest first

		return agents;
	}, [data.byAgent]);

	// Get max duration for bar scaling
	const maxDuration = useMemo(() => {
		if (efficiencyData.length === 0) return 0;
		return Math.max(...efficiencyData.map((a) => a.avgDuration));
	}, [efficiencyData]);

	if (efficiencyData.length === 0) {
		return (
			<div className="p-4 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
				<h3 className="text-sm font-medium mb-4" style={{ color: theme.colors.textMain }}>
					Agent Efficiency
				</h3>
				<div
					className="flex items-center justify-center h-24"
					style={{ color: theme.colors.textDim }}
				>
					<span className="text-sm">No agent query data available</span>
				</div>
			</div>
		);
	}

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="agent-efficiency-chart"
		>
			<h3 className="text-sm font-medium mb-4" style={{ color: theme.colors.textMain }}>
				Agent Efficiency
				<span className="text-xs font-normal ml-2" style={{ color: theme.colors.textDim }}>
					(avg response time per query)
				</span>
			</h3>

			<div className="space-y-3">
				{efficiencyData.map((agent, index) => {
					const percentage = maxDuration > 0 ? (agent.avgDuration / maxDuration) * 100 : 0;
					const color = getAgentColor(index, theme, colorBlindMode);

					return (
						<div key={agent.agent} className="flex items-center gap-3">
							{/* Agent name */}
							<div
								className="w-28 text-sm truncate flex-shrink-0 flex items-center gap-2"
								style={{ color: theme.colors.textDim }}
								title={formatAgentName(agent.agent)}
							>
								<div
									className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
									style={{ backgroundColor: color }}
								/>
								{formatAgentName(agent.agent)}
							</div>

							{/* Bar */}
							<div
								className="flex-1 h-6 rounded overflow-hidden"
								style={{ backgroundColor: `${theme.colors.border}30` }}
							>
								<div
									className="h-full rounded flex items-center justify-end"
									style={{
										width: `${Math.max(percentage, 8)}%`,
										backgroundColor: color,
										opacity: 0.85,
										transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
									}}
								>
									{percentage > 25 && (
										<span
											className="text-xs font-medium px-2 text-white whitespace-nowrap"
											style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
										>
											{formatDuration(agent.avgDuration)}
										</span>
									)}
								</div>
							</div>

							{/* Duration label */}
							<div
								className="w-20 text-xs text-right flex-shrink-0 flex flex-col"
								style={{ color: theme.colors.textDim }}
							>
								<span className="font-medium" style={{ color: theme.colors.textMain }}>
									{formatDuration(agent.avgDuration)}
								</span>
								<span className="text-[10px] opacity-70">{agent.totalQueries} queries</span>
							</div>
						</div>
					);
				})}
			</div>

			{/* Legend */}
			<div
				className="mt-4 pt-3 border-t text-xs flex items-center gap-4"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				<span>Sorted by efficiency (fastest first)</span>
			</div>
		</div>
	);
}

export default AgentEfficiencyChart;
