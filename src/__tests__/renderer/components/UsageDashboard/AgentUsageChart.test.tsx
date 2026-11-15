/**
 * Tests for AgentUsageChart
 *
 * - Lines are the top 10 agents by queries, plus one "Other agents" line.
 * - Deleted agents are labeled "Deleted agent", never a prettified id.
 * - The x axis is every calendar day of the window, zero-filled.
 * - The metric is Queries or Time (no Tokens mode) and is remembered.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	AgentUsageChart,
	AGENT_USAGE_TOP_N,
	DELETED_AGENT_LABEL,
	OTHER_AGENTS_KEY,
	buildAgentUsageLines,
} from '../../../../renderer/components/UsageDashboard/AgentUsageChart';
import type { StatsAggregation } from '../../../../shared/stats-types';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';

const theme = THEMES['dracula'];

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 's1',
		name: 'Agent',
		toolType: 'claude-code',
		state: 'idle',
		...overrides,
	} as Session;
}

function dataFor(
	bySessionByDay: StatsAggregation['bySessionByDay'],
	window = { startYmd: '2026-01-01', endYmd: '2026-01-07' }
): StatsAggregation {
	return { bySessionByDay, window } as unknown as StatsAggregation;
}

const day = (date: string, count: number, duration = 0) => ({ date, count, duration });

describe('buildAgentUsageLines', () => {
	it('ranks agents by queries and folds everyone past the top N into the rest', () => {
		const bySessionByDay: StatsAggregation['bySessionByDay'] = {};
		for (let i = 0; i < AGENT_USAGE_TOP_N + 3; i++) {
			bySessionByDay[`a${i}`] = [day('2026-01-01', i + 1)];
		}
		const { top, rest } = buildAgentUsageLines(bySessionByDay, []);
		expect(top).toHaveLength(AGENT_USAGE_TOP_N);
		expect(rest).toHaveLength(3);
		expect(top[0].key).toBe(`a${AGENT_USAGE_TOP_N + 2}`);
		expect(rest.map((line) => line.totalQueries)).toEqual([3, 2, 1]);
	});

	it('labels deleted agents "Deleted agent" and numbers repeats', () => {
		const { top } = buildAgentUsageLines(
			{
				gone1: [day('2026-01-01', 5)],
				gone2: [day('2026-01-01', 4)],
				live: [day('2026-01-01', 3)],
			},
			[makeSession({ id: 'live', name: 'Backend API' })]
		);
		expect(top.map((line) => line.label)).toEqual([
			DELETED_AGENT_LABEL,
			`${DELETED_AGENT_LABEL} 2`,
			'Backend API',
		]);
	});

	it('matches agents by exact id and flags worktrees', () => {
		const { top } = buildAgentUsageLines({ wt: [day('2026-01-01', 1)] }, [
			makeSession({ id: 'wt', name: 'WT', parentSessionId: 'p' }),
		]);
		expect(top[0].isWorktree).toBe(true);
	});
});

describe('AgentUsageChart', () => {
	beforeEach(() => {
		installLocalStorageMock();
	});

	it('names the top-N cap in its subtitle', () => {
		render(<AgentUsageChart data={dataFor({ s1: [day('2026-01-02', 1)] })} theme={theme} />);
		expect(screen.getByText('Agent Usage Over Time')).toBeInTheDocument();
		expect(screen.getByText(/Top 10 agents by queries in this range/)).toBeInTheDocument();
	});

	it('shows an empty state when no agent ran a query', () => {
		render(<AgentUsageChart data={dataFor({})} theme={theme} />);
		expect(screen.getByTestId('agent-usage-empty')).toHaveTextContent('No queries in this range');
	});

	it('draws a legend entry per agent plus an Other agents line', () => {
		const bySessionByDay: StatsAggregation['bySessionByDay'] = {};
		for (let i = 0; i < AGENT_USAGE_TOP_N + 2; i++) {
			bySessionByDay[`a${i}`] = [day('2026-01-01', i + 1)];
		}
		render(<AgentUsageChart data={dataFor(bySessionByDay)} theme={theme} />);

		expect(screen.getByTestId(`agent-usage-lines-legend-${OTHER_AGENTS_KEY}`)).toHaveTextContent(
			'Other agents (2)'
		);
		expect(screen.getByText(/the other 2 share one line/)).toBeInTheDocument();
	});

	it('does not draw an Other agents line when every agent fits', () => {
		render(<AgentUsageChart data={dataFor({ s1: [day('2026-01-02', 1)] })} theme={theme} />);
		expect(
			screen.queryByTestId(`agent-usage-lines-legend-${OTHER_AGENTS_KEY}`)
		).not.toBeInTheDocument();
	});

	it('labels the axis with every calendar day of the window', () => {
		render(
			<AgentUsageChart
				data={dataFor(
					{ s1: [day('2026-01-02', 1)] },
					{ startYmd: '2026-01-01', endYmd: '2026-01-03' }
				)}
				theme={theme}
			/>
		);
		// Three days in the window, so the first and last are both labeled even
		// though only the middle one has a query.
		expect(screen.getByText('Jan 1, 2026')).toBeInTheDocument();
		expect(screen.getByText('Jan 3, 2026')).toBeInTheDocument();
	});

	it('offers Queries and Time, but no Tokens mode', () => {
		render(<AgentUsageChart data={dataFor({ s1: [day('2026-01-02', 1)] })} theme={theme} />);
		expect(screen.getByTestId('metric-mode-count')).toBeInTheDocument();
		expect(screen.getByTestId('metric-mode-duration')).toBeInTheDocument();
		expect(screen.queryByTestId('metric-mode-tokens')).not.toBeInTheDocument();
	});

	it('remembers the metric across a remount', () => {
		const data = dataFor({ s1: [day('2026-01-02', 1, 60_000)] });
		const { unmount } = render(<AgentUsageChart data={data} theme={theme} />);
		fireEvent.click(screen.getByTestId('metric-mode-duration'));
		unmount();

		render(<AgentUsageChart data={data} theme={theme} />);
		expect(screen.getByTestId('metric-mode-duration')).toHaveAttribute('aria-pressed', 'true');
	});
});
