/**
 * Tests for the WizardStats dashboard section.
 *
 * Verifies:
 * - The four questions the section exists to answer (time, runs, docs, tasks)
 * - Derived metrics: hit rate, tasks per document, docs per productive run
 * - Duration comes from each run's active time, never its open-to-close window
 * - Empty state when no wizard runs are in range; error state when the read fails
 * - Refetches when the dashboard broadcasts a wizard_runs update
 * - The timeline covers every calendar day of the range and is one tab stop
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { WizardRun } from '../../../../shared/stats-types';
import { WizardStats } from '../../../../renderer/components/UsageDashboard/WizardStats';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

/** A StatCard tile by its label: label span -> label row -> card. */
async function tile(label: string): Promise<HTMLElement> {
	const labelEl = await screen.findByText(label);
	return labelEl.parentElement!.parentElement as HTMLElement;
}

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
		activeMs: 10 * MINUTE,
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

		expect(await screen.findByTestId('wizard-stats-empty')).toHaveTextContent(
			/No wizard runs in this time range/i
		);
	});

	it('shows an error, not the empty state, when the read fails', async () => {
		mockStatsApi.getWizardRuns.mockRejectedValueOnce(new Error('db locked'));
		render(<WizardStats timeRange="week" theme={theme} />);

		expect(await screen.findByTestId('wizard-stats-error')).toHaveTextContent(/db locked/);
		expect(screen.queryByTestId('wizard-stats-empty')).not.toBeInTheDocument();
	});

	it('sums active time, not the open-to-close window of a tab left open', async () => {
		const now = Date.now();
		mockStatsApi.getWizardRuns.mockResolvedValue([
			// Open for a full day, 20 minutes of it actually spent in the wizard.
			makeRun({
				id: 'a',
				startedAt: now - 30 * HOUR,
				endedAt: now - 6 * HOUR,
				activeMs: 20 * MINUTE,
			}),
			makeRun({
				id: 'b',
				startedAt: now - HOUR,
				endedAt: now - HOUR + 10 * MINUTE,
				activeMs: 10 * MINUTE,
			}),
		]);

		render(<WizardStats timeRange="week" theme={theme} />);

		const card = await tile('Time in the Wizard');
		expect(card).toHaveTextContent(/30m/);
		expect(card).toHaveTextContent(/15m 0s per run/i);
	});

	it('leaves runs recorded before active time out of the time figures', async () => {
		const now = Date.now();
		mockStatsApi.getWizardRuns.mockResolvedValue([
			makeRun({
				id: 'legacy',
				startedAt: now - 30 * HOUR,
				endedAt: now - 4 * HOUR,
				activeMs: undefined,
			}),
			makeRun({ id: 'timed', activeMs: 12 * MINUTE }),
		]);

		render(<WizardStats timeRange="week" theme={theme} />);

		const card = await tile('Time in the Wizard');
		expect(card).toHaveTextContent(/12m 0s per run · 1 earlier untimed/i);
	});

	it('shows a dash rather than 0m when no run in range was timed', async () => {
		mockStatsApi.getWizardRuns.mockResolvedValue([makeRun({ activeMs: undefined })]);

		render(<WizardStats timeRange="week" theme={theme} />);

		const card = await tile('Time in the Wizard');
		expect(card).toHaveTextContent(/^Time in the Wizard-/);
		expect(card).toHaveTextContent(/1 earlier untimed/i);
	});

	it('counts runs and splits them by surface', async () => {
		mockStatsApi.getWizardRuns.mockResolvedValue([
			makeRun({ id: 'a' }),
			makeRun({ id: 'b' }),
			makeRun({ id: 'c', surface: 'onboarding' }),
		]);

		render(<WizardStats timeRange="week" theme={theme} />);

		const card = await tile('Wizard Runs');
		expect(card).toHaveTextContent(/^Wizard Runs3/);
		expect(card).toHaveTextContent(/2 inline/i);
		expect(card).toHaveTextContent(/1 onboarding/i);
	});

	it('totals documents and tasks across runs with per-document math', async () => {
		mockStatsApi.getWizardRuns.mockResolvedValue([
			makeRun({ id: 'a', documents: 2, tasks: 10 }),
			makeRun({ id: 'b', documents: 2, tasks: 14 }),
		]);

		render(<WizardStats timeRange="week" theme={theme} />);

		expect(await tile('Docs Produced')).toHaveTextContent(/^Docs Produced4/);
		const tasksTile = await tile('Tasks Written');
		expect(tasksTile).toHaveTextContent(/^Tasks Written24/);
		expect(tasksTile).toHaveTextContent(/6 per document/i);
	});

	it('reports the share of runs that actually produced documents', async () => {
		mockStatsApi.getWizardRuns.mockResolvedValue([
			makeRun({ id: 'a', documents: 1, tasks: 4 }),
			makeRun({ id: 'b', documents: 0, tasks: 0, outcome: 'abandoned' }),
			makeRun({ id: 'c', documents: 0, tasks: 0, outcome: 'in-progress' }),
			makeRun({ id: 'd', documents: 1, tasks: 2, mode: 'iterate' }),
		]);

		render(<WizardStats timeRange="week" theme={theme} />);

		const card = await tile('Runs That Shipped');
		expect(card).toHaveTextContent(/50%/);
		expect(card).toHaveTextContent(/2 of 4/i);
		expect(card).toHaveTextContent(/1 revised existing docs/i);
	});

	it('counts every message sent, including runs that produced nothing', async () => {
		mockStatsApi.getWizardRuns.mockResolvedValue([
			makeRun({ id: 'a', exchanges: 5 }),
			makeRun({ id: 'b', exchanges: 3, documents: 0, tasks: 0, outcome: 'abandoned' }),
		]);

		render(<WizardStats timeRange="week" theme={theme} />);

		const card = await tile('Messages Sent');
		expect(card).toHaveTextContent(/^Messages Sent8/);
		expect(card).toHaveTextContent(/4 per run/i);
	});

	it('refetches when the dashboard broadcasts a stats update', async () => {
		let broadcast: ((table?: string) => void) | undefined;
		mockStatsApi.onStatsUpdate.mockImplementation((cb: (table?: string) => void) => {
			broadcast = cb;
			return () => {};
		});
		mockStatsApi.getWizardRuns.mockResolvedValue([makeRun()]);

		render(<WizardStats timeRange="week" theme={theme} />);
		await tile('Wizard Runs');

		mockStatsApi.getWizardRuns.mockResolvedValue([makeRun(), makeRun({ id: 'b' })]);
		// A write to another table does not refetch; a wizard_runs write does.
		broadcast?.('shortcut_usage');
		broadcast?.('wizard_runs');

		await waitFor(
			async () => {
				expect(await tile('Wizard Runs')).toHaveTextContent(/^Wizard Runs2/);
			},
			{ timeout: 3000 }
		);
		expect(mockStatsApi.getWizardRuns).toHaveBeenCalledTimes(2);
	});

	it('renders a bar per calendar day of the range, behind one tab stop', async () => {
		const now = Date.now();
		mockStatsApi.getWizardRuns.mockResolvedValue([
			makeRun({ id: 'a', startedAt: now - 2 * 24 * HOUR, endedAt: now - 2 * 24 * HOUR + MINUTE }),
			makeRun({ id: 'b', startedAt: now, endedAt: now + MINUTE }),
		]);

		render(<WizardStats timeRange="week" theme={theme} />);

		const timeline = await screen.findByRole('group', { name: /Wizard runs per day/i });
		// Every day of the 7-day range, quiet days kept as gaps.
		expect(timeline.children).toHaveLength(7);
		expect(timeline).toHaveAttribute('tabindex', '0');

		fireEvent.keyDown(timeline, { key: 'End' });
		expect(await screen.findByTestId('wizard-timeline-tooltip')).toHaveTextContent(
			/1 run produced 2 docs/
		);
	});

	it('starts an all-time timeline at the first run', async () => {
		const now = Date.now();
		mockStatsApi.getWizardRuns.mockResolvedValue([
			makeRun({ id: 'a', startedAt: now - 2 * 24 * HOUR, endedAt: now - 2 * 24 * HOUR + MINUTE }),
			makeRun({ id: 'b', startedAt: now, endedAt: now + MINUTE }),
		]);

		render(<WizardStats timeRange="all" theme={theme} />);

		const timeline = await screen.findByRole('group', { name: /Wizard runs per day/i });
		expect(timeline.children).toHaveLength(3);
	});
});
