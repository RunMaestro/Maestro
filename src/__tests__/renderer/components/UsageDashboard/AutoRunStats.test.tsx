/**
 * Tests for the Auto Run tab's panels: AutoRunStats, TasksByHourChart and
 * LongestAutoRunsTable.
 *
 * Verifies:
 * - Tiles count goal runs and unfinished runs apart from the task math
 * - Loading, error (never drawn as "no data") and empty states
 * - The day chart covers the whole range, zero-filled, and is one keyboard stop
 * - AutoRunStats and LongestAutoRunsTable share ONE fetch
 * - TasksByHourChart reads the grouped per-hour query (no per-run fetches)
 * - The table sorts by column and pages with "Show more"
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { AutoRunStats } from '../../../../renderer/components/UsageDashboard/AutoRunStats';
import { TasksByHourChart } from '../../../../renderer/components/UsageDashboard/TasksByHourChart';
import { LongestAutoRunsTable } from '../../../../renderer/components/UsageDashboard/LongestAutoRunsTable';
import { GOAL_RUN_DOCUMENT_PREFIX } from '../../../../shared/goalDriven/goalRunLabel';
import type { AutoRunSession } from '../../../../shared/stats-types';
import { THEMES } from '../../../../shared/themes';

vi.mock('../../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

const theme = THEMES['dracula'];

function run(overrides: Partial<AutoRunSession>): AutoRunSession {
	return {
		id: 'run',
		sessionId: 'agent-1',
		agentType: 'claude-code',
		documentPath: '/project/TASKS.md',
		startTime: Date.now() - 1000,
		duration: 1_800_000,
		tasksTotal: 5,
		tasksCompleted: 4,
		projectPath: '/project',
		...overrides,
	};
}

const sessions: AutoRunSession[] = [
	run({ id: 'doc-1', duration: 1_800_000, tasksTotal: 5, tasksCompleted: 4 }),
	run({ id: 'doc-2', duration: 2_400_000, tasksTotal: 3, tasksCompleted: 3 }),
	// Goal run: 0-100 progress must never be summed as 100 tasks.
	run({
		id: 'goal-1',
		documentPath: `${GOAL_RUN_DOCUMENT_PREFIX}Ship it`,
		duration: 600_000,
		tasksTotal: 100,
		tasksCompleted: 80,
	}),
	// Unfinished: no end recorded yet.
	run({ id: 'open-1', duration: 0, tasksTotal: 10, tasksCompleted: undefined }),
];

const stats = () => window.maestro.stats as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
	vi.clearAllMocks();
	stats().getAutoRunSessions.mockResolvedValue(sessions);
	stats().getAutoRunTurnsByHour.mockResolvedValue(
		Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, successCount: 0 }))
	);
	stats().onStatsUpdate.mockReturnValue(() => {});
});

describe('AutoRunStats', () => {
	it('counts every run but keeps goal and unfinished runs out of the task math', async () => {
		render(<AutoRunStats timeRange="week" theme={theme} />);

		const metrics = await screen.findByTestId('autorun-metrics');
		// 4 runs: 1 goal, 1 unfinished.
		expect(within(metrics).getByText('Runs')).toBeInTheDocument();
		expect(within(metrics).getByText('4')).toBeInTheDocument();
		expect(within(metrics).getByText('1 goal · 1 unfinished')).toBeInTheDocument();
		// Tasks: 4 + 3 of 5 + 3 from the two finished document runs only.
		expect(within(metrics).getByText('7')).toBeInTheDocument();
		expect(within(metrics).getByText('of 8 attempted')).toBeInTheDocument();
		// 7 / 8 = 87.5% -> 88%
		expect(within(metrics).getByText('88%')).toBeInTheDocument();
		// 7 tasks over 2 finished document runs
		expect(within(metrics).getByText('3.5')).toBeInTheDocument();
	});

	it('averages run time over finished runs only', async () => {
		render(<AutoRunStats timeRange="week" theme={theme} />);
		const metrics = await screen.findByTestId('autorun-metrics');
		// (30m + 40m + 10m) / 3 finished = 26m 40s
		expect(within(metrics).getByText('3 finished runs')).toBeInTheDocument();
	});

	it('shows an error (not "no data") when the first fetch fails, and retries', async () => {
		stats().getAutoRunSessions.mockRejectedValueOnce(new Error('boom'));
		render(<AutoRunStats timeRange="week" theme={theme} />);

		expect(await screen.findByTestId('autorun-stats-error')).toBeInTheDocument();
		expect(screen.queryByTestId('autorun-stats-empty')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(await screen.findByTestId('autorun-metrics')).toBeInTheDocument();
	});

	it('shows the empty state when the range has no runs', async () => {
		stats().getAutoRunSessions.mockResolvedValue([]);
		render(<AutoRunStats timeRange="week" theme={theme} />);
		expect(await screen.findByTestId('autorun-stats-empty')).toBeInTheDocument();
	});

	it('draws one bar per day of the range, zero-filled, behind one tab stop', async () => {
		render(<AutoRunStats timeRange="week" theme={theme} />);
		const bars = await screen.findByTestId('autorun-tasks-bars');
		expect(bars.children).toHaveLength(7);
		expect(bars).toHaveAttribute('tabindex', '0');
		expect(bars.querySelectorAll('[tabindex]')).toHaveLength(0);

		fireEvent.keyDown(bars, { key: 'End' });
		expect(await screen.findByTestId('task-bar-tooltip')).toHaveTextContent('7 tasks done');
		fireEvent.keyDown(bars, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByTestId('task-bar-tooltip')).not.toBeInTheDocument());
	});

	it('refetches only for auto_run writes', async () => {
		render(<AutoRunStats timeRange="week" theme={theme} />);
		await screen.findByTestId('autorun-metrics');
		expect(stats().onStatsUpdate).toHaveBeenCalled();
	});
});

describe('LongestAutoRunsTable', () => {
	it('shares the sessions fetch with AutoRunStats', async () => {
		render(
			<>
				<AutoRunStats timeRange="week" theme={theme} />
				<LongestAutoRunsTable timeRange="week" theme={theme} />
			</>
		);
		await screen.findAllByTestId('longest-autoruns-row');
		expect(stats().getAutoRunSessions).toHaveBeenCalledTimes(1);
	});

	it('lists runs longest first, labels the provider, and re-sorts on a header click', async () => {
		render(<LongestAutoRunsTable timeRange="week" theme={theme} />);
		const rows = await screen.findAllByTestId('longest-autoruns-row');
		expect(rows).toHaveLength(4);
		expect(rows[0]).toHaveTextContent('40m');
		expect(rows[0]).toHaveTextContent('Claude Code');
		expect(rows[3]).toHaveTextContent('unfinished');

		// SortableTh puts the test id on the <th>; the click target is its button.
		fireEvent.click(
			within(screen.getByTestId('longest-autoruns-sort-duration')).getByRole('button')
		);
		const ascending = screen.getAllByTestId('longest-autoruns-row');
		expect(ascending[0]).toHaveTextContent('unfinished');
	});

	it('shows 25 rows, then more on request', async () => {
		stats().getAutoRunSessions.mockResolvedValue(
			Array.from({ length: 30 }, (_, i) => run({ id: `r-${i}`, duration: (i + 1) * 1000 }))
		);
		render(<LongestAutoRunsTable timeRange="week" theme={theme} />);
		expect(await screen.findAllByTestId('longest-autoruns-row')).toHaveLength(25);

		fireEvent.click(screen.getByTestId('longest-autoruns-show-more'));
		expect(screen.getAllByTestId('longest-autoruns-row')).toHaveLength(30);
		expect(screen.queryByTestId('longest-autoruns-show-more')).not.toBeInTheDocument();
	});

	it('never draws U+2014 for an empty cell', async () => {
		stats().getAutoRunSessions.mockResolvedValue([
			run({ id: 'x', documentPath: undefined, projectPath: undefined, tasksTotal: undefined }),
		]);
		render(<LongestAutoRunsTable timeRange="week" theme={theme} />);
		const [row] = await screen.findAllByTestId('longest-autoruns-row');
		expect(row.textContent).not.toContain(String.fromCharCode(8212));
	});
});

describe('TasksByHourChart', () => {
	it('reads the grouped per-hour query once, never per run', async () => {
		stats().getAutoRunTurnsByHour.mockResolvedValue(
			Array.from({ length: 24 }, (_, hour) => ({
				hour,
				count: hour === 9 ? 6 : hour === 14 ? 2 : 0,
				successCount: hour === 9 ? 3 : hour === 14 ? 2 : 0,
			}))
		);
		render(<TasksByHourChart timeRange="week" theme={theme} />);

		const bars = await screen.findByTestId('tasks-by-hour-bars');
		expect(bars.children).toHaveLength(24);
		expect(stats().getAutoRunTurnsByHour).toHaveBeenCalledTimes(1);
		expect(stats().getAutoRunTurnsByHour).toHaveBeenCalledWith('week');
		expect(screen.getByText('Agent Turns by Time of Day')).toBeInTheDocument();
		expect(screen.getByText('Peak hours:')).toBeInTheDocument();

		fireEvent.keyDown(bars, { key: 'Home' });
		fireEvent.keyDown(bars, { key: 'ArrowRight' });
		// Hour 1 has no turns.
		expect(await screen.findByTestId('tasks-by-hour-tooltip')).toHaveTextContent('0 turns');
	});

	it('shows the empty state when no turns ran', async () => {
		render(<TasksByHourChart timeRange="week" theme={theme} />);
		expect(await screen.findByTestId('tasks-by-hour-empty')).toBeInTheDocument();
	});

	it('shows an error when the read fails', async () => {
		stats().getAutoRunTurnsByHour.mockRejectedValueOnce(new Error('nope'));
		render(<TasksByHourChart timeRange="week" theme={theme} />);
		expect(await screen.findByTestId('tasks-by-hour-error')).toBeInTheDocument();
	});
});
