import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RichOverview } from '../../../../renderer/components/DirectorNotes/RichOverview';
import { mockTheme } from '../../../helpers/mockTheme';

// Narrative markdown is rendered through a stub so we can assert its content.
vi.mock('../../../../renderer/components/MarkdownRenderer', () => ({
	MarkdownRenderer: ({ content }: { content: string }) => (
		<div data-testid="markdown-renderer">{content}</div>
	),
}));

// Error boundary is a passthrough in tests (no error path exercised here).
vi.mock('../../../../renderer/components/UsageDashboard/ChartErrorBoundary', () => ({
	ChartErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Prose styles are irrelevant to behavior here.
vi.mock('../../../../renderer/utils/markdownConfig', () => ({
	generateTerminalProseStyles: () => '',
}));

// Deterministic lookback conversion so we can assert the IPC call arguments.
vi.mock('../../../../renderer/components/DirectorNotes/lookback', () => ({
	daysToLookbackHours: (days: number) => (days <= 0 ? null : 168),
	bucketCountForLookback: () => 28,
}));

// Settings store: colorblind off.
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: (selector: (s: { colorBlindMode: boolean }) => unknown) =>
		selector({ colorBlindMode: false }),
}));

const mockGetRichOverviewStats = vi.fn();

const SYNOPSIS = '# Director Notes\n\nNarrative body.';
const STATS = { agentCount: 9, entryCount: 99, durationMs: 5000 };

// Deterministic stats object returned by the single IPC the Rich dashboard now
// reads from. Every widget number is mapped from here.
const RICH_STATS = {
	totalEntries: 100,
	agentCount: 4,
	sessionCount: 4,
	autoCount: 30,
	userCount: 60,
	cueCount: 10,
	successCount: 80,
	failureCount: 20,
	successRate: 0.8,
	totalElapsedMs: 12000, // formatDurationLong -> "12s"
	avgElapsedMs: 1200,
	timelineBuckets: [
		{ startTime: 1, auto: 2, user: 1, cue: 0 },
		{ startTime: 2, auto: 0, user: 3, cue: 1 },
	],
	perAgent: [
		{ sessionId: 's1', agentName: 'alpha', entryCount: 2, successCount: 2, failureCount: 0 },
		{ sessionId: 's2', agentName: 'beta', entryCount: 1, successCount: 1, failureCount: 0 },
	],
	lookbackDays: 7,
	generatedAt: 123,
};

beforeEach(() => {
	mockGetRichOverviewStats.mockResolvedValue(RICH_STATS);

	(window as unknown as { maestro: unknown }).maestro = {
		directorNotes: {
			getRichOverviewStats: mockGetRichOverviewStats,
		},
	};
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('RichOverview', () => {
	it('queries getRichOverviewStats with derived args on mount', async () => {
		render(<RichOverview theme={mockTheme} stats={STATS} synopsis={SYNOPSIS} lookbackDays={7} />);

		await waitFor(() => {
			expect(mockGetRichOverviewStats).toHaveBeenCalledWith({ lookbackDays: 7, bucketCount: 28 });
		});
	});

	it('renders headline stat cards from the deterministic stats', async () => {
		render(<RichOverview theme={mockTheme} stats={STATS} synopsis={SYNOPSIS} lookbackDays={7} />);

		await waitFor(() => {
			expect(screen.getByText('Total Entries')).toBeInTheDocument();
		});
		expect(screen.getByText('Agents')).toBeInTheDocument();
		expect(screen.getByText('Success Rate')).toBeInTheDocument();
		expect(screen.getByText('Time Spent')).toBeInTheDocument();
		// Success rate as a percentage (also appears in the success/failure widget).
		expect(screen.getAllByText('80%').length).toBeGreaterThanOrEqual(1);
		// Total time spent, formatted from totalElapsedMs via formatDurationLong.
		expect(screen.getByText('12s')).toBeInTheDocument();
		// Generation-time card from the synopsis stats prop.
		expect(screen.getByText('Generation Time')).toBeInTheDocument();
		expect(screen.getByText('5s')).toBeInTheDocument();
	});

	it('renders the success/failure widget from successCount vs failureCount', async () => {
		render(<RichOverview theme={mockTheme} stats={STATS} synopsis={SYNOPSIS} lookbackDays={7} />);

		await waitFor(() => {
			expect(screen.getByText('Success vs Failure')).toBeInTheDocument();
		});
		expect(screen.getByText('Success')).toBeInTheDocument();
		expect(screen.getByText('Failure')).toBeInTheDocument();
		// 80 success / 20 failure -> 80% / 20%.
		expect(screen.getAllByText('80%').length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText('20%')).toBeInTheDocument();
	});

	it('renders the source breakdown percentages over the AUTO/USER/CUE total', async () => {
		render(<RichOverview theme={mockTheme} stats={STATS} synopsis={SYNOPSIS} lookbackDays={7} />);

		await waitFor(() => {
			// user 60/100, auto 30/100, cue 10/100
			expect(screen.getByText('60%')).toBeInTheDocument();
		});
		expect(screen.getByText('30%')).toBeInTheDocument();
		expect(screen.getByText('10%')).toBeInTheDocument();
	});

	it('renders per-agent bars from the perAgent rollup', async () => {
		render(<RichOverview theme={mockTheme} stats={STATS} synopsis={SYNOPSIS} lookbackDays={7} />);

		await waitFor(() => {
			expect(screen.getByText('alpha')).toBeInTheDocument();
		});
		expect(screen.getByText('beta')).toBeInTheDocument();
	});

	it('renders the AI narrative markdown below the widgets', async () => {
		render(<RichOverview theme={mockTheme} stats={STATS} synopsis={SYNOPSIS} lookbackDays={7} />);

		await waitFor(() => {
			expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
		});
		expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('Narrative body.');
	});

	it('omits the generation-time card when no stats are provided', async () => {
		render(<RichOverview theme={mockTheme} stats={null} synopsis={SYNOPSIS} lookbackDays={7} />);

		await waitFor(() => {
			expect(screen.getByText('Total Entries')).toBeInTheDocument();
		});
		expect(screen.queryByText('Generation Time')).not.toBeInTheDocument();
	});

	it('refetches when the lookback window changes', async () => {
		const { rerender } = render(
			<RichOverview theme={mockTheme} stats={STATS} synopsis={SYNOPSIS} lookbackDays={7} />
		);
		await waitFor(() => {
			expect(mockGetRichOverviewStats).toHaveBeenCalledTimes(1);
		});

		rerender(
			<RichOverview theme={mockTheme} stats={STATS} synopsis={SYNOPSIS} lookbackDays={30} />
		);
		await waitFor(() => {
			expect(mockGetRichOverviewStats).toHaveBeenCalledTimes(2);
		});
		expect(mockGetRichOverviewStats).toHaveBeenLastCalledWith({
			lookbackDays: 30,
			bucketCount: 28,
		});
	});
});
