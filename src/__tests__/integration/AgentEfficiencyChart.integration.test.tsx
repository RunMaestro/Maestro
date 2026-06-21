import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentEfficiencyChart } from '../../renderer/components/UsageDashboard/AgentEfficiencyChart';
import { COLORBLIND_AGENT_PALETTE } from '../../renderer/constants/colorblindPalettes';
import type { StatsAggregation } from '../../renderer/hooks/stats/useStats';
import { THEMES } from '../../shared/themes';

const theme = THEMES.dracula;

function makeAggregation(byAgent: StatsAggregation['byAgent']): StatsAggregation {
	return {
		totalQueries: 0,
		totalDuration: 0,
		avgDuration: 0,
		byAgent,
		bySource: { user: 0, auto: 0 },
		byLocation: { local: 0, remote: 0 },
		byDay: [],
		byHour: [],
		totalSessions: 0,
		sessionsByAgent: {},
		sessionsByDay: [],
		avgSessionDuration: 0,
		byAgentByDay: {},
		bySessionByDay: {},
	};
}

describe('AgentEfficiencyChart', () => {
	it('renders an empty state when no agents have query data', () => {
		render(<AgentEfficiencyChart data={makeAggregation({})} theme={theme} />);

		expect(screen.getByText('Agent Efficiency')).toBeInTheDocument();
		expect(screen.getByText('No agent query data available')).toBeInTheDocument();
	});

	it('sorts by average duration, filters empty agents, and formats durations', () => {
		render(
			<AgentEfficiencyChart
				data={makeAggregation({
					'claude-code': { count: 1, duration: 3_660_000 },
					opencode: { count: 1, duration: 65_000 },
					codex: { count: 1, duration: 59_000 },
					zero: { count: 2, duration: 0 },
					skipped: { count: 0, duration: 999_000 },
				})}
				theme={theme}
			/>
		);

		expect(screen.getByTitle('Zero')).toBeInTheDocument();
		expect(screen.getByTitle('Codex')).toBeInTheDocument();
		expect(screen.getByTitle('OpenCode')).toBeInTheDocument();
		expect(screen.getByTitle('Claude Code')).toBeInTheDocument();
		expect(screen.queryByTitle('skipped')).not.toBeInTheDocument();
		expect(
			screen
				.getAllByTitle(/Zero|Codex|OpenCode|Claude Code/)
				.map((agentLabel) => agentLabel.getAttribute('title'))
		).toEqual(['Zero', 'Codex', 'OpenCode', 'Claude Code']);
		expect(screen.getByText('0s')).toBeInTheDocument();
		expect(screen.getByText('59s')).toBeInTheDocument();
		expect(screen.getAllByText('1m 5s').length).toBeGreaterThan(0);
		expect(screen.getAllByText('1h 1m').length).toBeGreaterThan(0);
		expect(screen.getByText('2 queries')).toBeInTheDocument();
	});

	it('uses the colorblind-safe palette when requested', () => {
		render(
			<AgentEfficiencyChart
				data={makeAggregation({
					codex: { count: 1, duration: 1000 },
				})}
				theme={theme}
				colorBlindMode
			/>
		);

		expect(screen.getByTitle('Codex').firstElementChild).toHaveStyle({
			backgroundColor: COLORBLIND_AGENT_PALETTE[0],
		});
	});

	it('uses the minimum visible bar width when all average durations are zero', () => {
		render(
			<AgentEfficiencyChart
				data={makeAggregation({
					codex: { count: 2, duration: 0 },
					opencode: { count: 1, duration: 0 },
				})}
				theme={theme}
			/>
		);

		expect(screen.getByTitle('Codex')).toBeInTheDocument();
		expect(screen.getByTitle('OpenCode')).toBeInTheDocument();
		expect(screen.getAllByText('0s')).toHaveLength(2);

		const codexRow = screen.getByTitle('Codex').parentElement!;
		const codexBar = codexRow.children[1].firstElementChild;

		expect(codexBar).toHaveStyle({ width: '8%' });
	});
});
