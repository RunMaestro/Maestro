/**
 * Tests for the WizardStats dashboard section.
 *
 * Verifies:
 * - The four questions the section exists to answer (time, runs, docs, tasks)
 * - Derived metrics: hit rate, tasks per document, docs per productive run
 * - Duration comes from the run window, not wall clock since the first run
 * - Empty state when no wizard runs are in range
 * - Refetches when the dashboard broadcasts a stats update
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { WizardRun } from '../../../../shared/stats-types';
import { WizardStats } from '../../../../renderer/components/UsageDashboard/WizardStats';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function makeRun(overrides: Partial<WizardRun> = {}): WizardRun {
	const startedAt = Date.now() - HOUR;
	return {
		id: 'run-1',
		sessionId: 'session-1',
		agentType: 'claude-code',
		surface: 'inline',
		mode: 'new',
		outcome: 'generated',
		startedAt,
		endedAt: startedAt + 10 * MINUTE,
		exchanges: 3,
		documents: 2,
		tasks: 10,
		projectPath: '/project',
		...overrides,
	};
}

const mockStatsApi = {
	getWizardRuns: vi.fn(),
	onStatsUpdate: vi.fn(() => () => {}),
};

beforeEach(() => {
	(window as unknown as { maestro: unknown }).maestro = { stats: mockStatsApi };
	vi.clearAllMocks();
	mockStatsApi.onStatsUpdate.mockReturnValue(() => {});
	mockStatsApi.getWizardRuns.mockResolvedValue([]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('WizardStats', () => {
	it('shows the empty state when no runs are in range', async () => {
		render(<WizardStats timeRange="week" theme={theme} />);

		await waitFor(() => {
			expect(screen.getByText(/No wizard runs in this time range/i)).toBeInTheDocument();
		});
		expect(screen.queryByTestId('wizard-stats')).not.toBeInTheDocument();
	});

	it('sums time in conversation from each run window, not wall clock', async () => {
		const now = Date.now();
		mockStatsApi.getWizardRuns.mockResolvedValue([
			makeRun({ id: 'a', startedAt: now - 5 * HOUR, endedAt: now - 5 * HOUR + 20 * MINUTE }),
			makeRun({ id: 'b', startedAt: now - HOUR, endedAt: now - HOUR + 10 * MINUTE }),
		]);

		render(<WizardStats timeRange="week" theme={theme} />);

		// 30m total across two runs spanning five hours of wall clock.
		const tile = await screen.findByLabelText(/^Time in the Wizard: 30m/i);
		expect(tile).toHaveAccessibleName(/15m 0s per run/i);
	});

	it('counts runs and splits them by surface', async () => {
		mockStatsApi.getWizardRuns.mockResolvedValue([
			makeRun({ id: 'a' }),
			makeRun({ id: 'b' }),
			makeRun({ id: 'c', surface: 'onboarding' }),
		]);

		render(<WizardStats timeRange="week" theme={theme} />);

		const tile = await screen.findByLabelText(/^Wizard Runs: 3/i);
		expect(tile).toHaveAccessibleName(/2 inline/i);
		expect(tile).toHaveAccessibleName(/1 onboarding/i);
	});

	it('totals documents and tasks across runs with per-document math', async () => {
		mockStatsApi.getWizardRuns.mockResolvedValue([
			makeRun({ id: 'a', documents: 2, tasks: 10 }),
			makeRun({ id: 'b', documents: 2, tasks: 14 }),
		]);

		render(<WizardStats timeRange="week" theme={theme} />);

		expect(await screen.findByLabelText(/^Docs Produced: 4/i)).toBeInTheDocument();
		const tasksTile = await screen.findByLabelText(/^Tasks Written: 24/i);
		expect(tasksTile).toHaveAccessibleName(/6 per document/i);
	});

	it('reports the share of runs that actually produced documents', async () => {
		mockStatsApi.getWizardRuns.mockResolvedValue([
			makeRun({ id: 'a', documents: 1, tasks: 4 }),
			makeRun({ id: 'b', documents: 0, tasks: 0, outcome: 'abandoned' }),
			makeRun({ id: 'c', documents: 0, tasks: 0, outcome: 'in-progress' }),
			makeRun({ id: 'd', documents: 1, tasks: 2, mode: 'iterate' }),
		]);

		render(<WizardStats timeRange="week" theme={theme} />);

		const tile = await screen.findByLabelText(/^Runs That Shipped: 50%/i);
		expect(tile).toHaveAccessibleName(/2 of 4/i);
		expect(tile).toHaveAccessibleName(/1 revised existing docs/i);
	});

	it('counts every message sent, including runs that produced nothing', async () => {
		mockStatsApi.getWizardRuns.mockResolvedValue([
			makeRun({ id: 'a', exchanges: 5 }),
			makeRun({ id: 'b', exchanges: 3, documents: 0, tasks: 0, outcome: 'abandoned' }),
		]);

		render(<WizardStats timeRange="week" theme={theme} />);

		const tile = await screen.findByLabelText(/^Messages Sent: 8/i);
		expect(tile).toHaveAccessibleName(/4 per run/i);
	});

	it('refetches when the dashboard broadcasts a stats update', async () => {
		let broadcast: (() => void) | undefined;
		mockStatsApi.onStatsUpdate.mockImplementation((cb: () => void) => {
			broadcast = cb;
			return () => {};
		});
		mockStatsApi.getWizardRuns.mockResolvedValue([makeRun()]);

		render(<WizardStats timeRange="week" theme={theme} />);
		await screen.findByTestId('wizard-stats');

		mockStatsApi.getWizardRuns.mockResolvedValue([makeRun(), makeRun({ id: 'b' })]);
		broadcast?.();

		await waitFor(() => {
			expect(screen.getByLabelText(/^Wizard Runs: 2/i)).toBeInTheDocument();
		});
	});

	it('renders a bar per calendar day between the first run and today', async () => {
		const now = Date.now();
		mockStatsApi.getWizardRuns.mockResolvedValue([
			makeRun({ id: 'a', startedAt: now - 2 * 24 * HOUR, endedAt: now - 2 * 24 * HOUR + MINUTE }),
			makeRun({ id: 'b', startedAt: now, endedAt: now + MINUTE }),
		]);

		render(<WizardStats timeRange="week" theme={theme} />);

		const timeline = await screen.findByRole('img', { name: /Wizard runs per day/i });
		// Two days back plus today, with the quiet middle day kept as a gap.
		expect(timeline.children).toHaveLength(3);
	});
});
