import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LongestAutoRunsTable } from '../../renderer/components/UsageDashboard/LongestAutoRunsTable';
import { captureException } from '../../renderer/utils/sentry';
import { THEMES } from '../../shared/themes';

vi.mock('../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

const theme = THEMES['dracula'];

const mockStatsApi = {
	getAutoRunSessions: vi.fn(),
	onStatsUpdate: vi.fn(),
};

const makeSession = (overrides: Record<string, unknown> = {}) => ({
	id: 'autorun-1',
	sessionId: 'session-1',
	agentType: 'claude-code',
	documentPath: '/repo/docs/plan.md',
	startTime: Date.UTC(2026, 4, 15, 14, 5),
	duration: 60_000,
	tasksTotal: 3,
	tasksCompleted: 2,
	projectPath: '/repo/project',
	...overrides,
});

const expectedDate = (timestamp: number) =>
	new Date(timestamp).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});

const expectedTime = (timestamp: number) =>
	new Date(timestamp).toLocaleTimeString('en-US', {
		hour: 'numeric',
		minute: '2-digit',
	});

describe('LongestAutoRunsTable', () => {
	beforeEach(() => {
		(window as any).maestro = {
			stats: mockStatsApi,
		};
		vi.clearAllMocks();
		mockStatsApi.getAutoRunSessions.mockResolvedValue([]);
		mockStatsApi.onStatsUpdate.mockReturnValue(vi.fn());
	});

	it('shows a loading state before the first fetch resolves, then hides the table for empty data', async () => {
		const { container } = render(<LongestAutoRunsTable timeRange="week" theme={theme} />);

		expect(screen.getByTestId('longest-autoruns-loading')).toHaveTextContent(
			'Loading longest Auto Runs...'
		);
		expect(mockStatsApi.getAutoRunSessions).toHaveBeenCalledWith('week');

		await waitFor(() => {
			expect(screen.queryByTestId('longest-autoruns-loading')).not.toBeInTheDocument();
		});
		expect(container.firstChild).toBeNull();
	});

	it('sorts by duration, formats table values, caps visible rows, and handles row hover state', async () => {
		const timestamp = Date.UTC(2026, 4, 15, 14, 5);
		const manySessions = [
			makeSession({
				id: 'short',
				duration: 42_000,
				agentType: 'custom-agent',
				documentPath: undefined,
				projectPath: undefined,
				tasksTotal: undefined,
			}),
			makeSession({
				id: 'long',
				duration: 3 * 60 * 60 * 1000 + 5 * 60 * 1000 + 9_000,
				documentPath: 'C:\\repo\\docs\\long-plan.md',
				projectPath: '/repo/main-project',
				startTime: timestamp,
			}),
			makeSession({
				id: 'medium',
				duration: 7 * 60 * 1000 + 5_000,
				agentType: 'opencode',
				tasksTotal: 4,
				tasksCompleted: undefined,
			}),
			makeSession({ id: 'zero', duration: 0 }),
			...Array.from({ length: 23 }, (_, index) =>
				makeSession({
					id: `filler-${index}`,
					duration: 1_000 + index,
					documentPath: `/docs/filler-${index}.md`,
				})
			),
		];
		mockStatsApi.getAutoRunSessions.mockResolvedValue(manySessions);

		render(<LongestAutoRunsTable timeRange="month" theme={theme} />);

		const table = await screen.findByTestId('longest-autoruns-table');
		expect(table).toHaveAccessibleName('Top 25 longest Auto Run sessions');
		expect(screen.getByText('Top 25 Longest Auto Runs')).toBeInTheDocument();
		expect(screen.getByText('(27 total)')).toBeInTheDocument();

		const rows = screen.getAllByRole('row').slice(1);
		expect(rows).toHaveLength(25);

		expect(within(rows[0]).getByText('1')).toBeInTheDocument();
		expect(within(rows[0]).getByText('3h 5m')).toBeInTheDocument();
		expect(within(rows[0]).getByText(expectedDate(timestamp))).toBeInTheDocument();
		expect(within(rows[0]).getByText(expectedTime(timestamp))).toBeInTheDocument();
		expect(within(rows[0]).getByText('Claude Code')).toBeInTheDocument();
		expect(within(rows[0]).getByText('long-plan.md')).toBeInTheDocument();
		expect(within(rows[0]).getByText('2 / 3')).toBeInTheDocument();
		expect(within(rows[0]).getByText('main-project')).toBeInTheDocument();

		expect(within(rows[1]).getByText('7m 5s')).toBeInTheDocument();
		expect(within(rows[1]).getByText('OpenCode')).toBeInTheDocument();
		expect(within(rows[1]).getByText('0 / 4')).toBeInTheDocument();
		expect(within(rows[2]).getByText('42s')).toBeInTheDocument();
		expect(within(rows[2]).getByText('custom-agent')).toBeInTheDocument();

		const initialBackground = rows[0].style.backgroundColor;
		fireEvent.mouseEnter(rows[0]);
		expect(rows[0].style.backgroundColor).not.toBe(initialBackground);
		fireEvent.mouseLeave(rows[0]);
		expect(rows[0].style.backgroundColor).toBe(initialBackground);

		const oddInitialBackground = rows[1].style.backgroundColor;
		fireEvent.mouseEnter(rows[1]);
		expect(rows[1].style.backgroundColor).not.toBe(oddInitialBackground);
		fireEvent.mouseLeave(rows[1]);
		expect(rows[1].style.backgroundColor).toBe(oddInitialBackground);
	});

	it('renders zero-duration sessions and trailing path fallbacks', async () => {
		mockStatsApi.getAutoRunSessions.mockResolvedValue([
			makeSession({
				duration: 0,
				documentPath: '/repo/docs/',
				projectPath: '/',
				tasksTotal: undefined,
			}),
		]);

		render(<LongestAutoRunsTable timeRange="week" theme={theme} />);

		const row = (await screen.findAllByRole('row'))[1];
		expect(within(row).getByText('0s')).toBeInTheDocument();
		expect(within(row).getAllByText('-')).toHaveLength(3);
	});

	it('refetches when stats update and unsubscribes on unmount', async () => {
		const unsubscribe = vi.fn();
		let updateCallback: (() => void) | undefined;
		mockStatsApi.onStatsUpdate.mockImplementation((callback: () => void) => {
			updateCallback = callback;
			return unsubscribe;
		});
		mockStatsApi.getAutoRunSessions
			.mockResolvedValueOnce([makeSession({ id: 'first', duration: 60_000 })])
			.mockResolvedValueOnce([makeSession({ id: 'updated', duration: 120_000 })]);

		const { unmount } = render(<LongestAutoRunsTable timeRange="week" theme={theme} />);

		expect(await screen.findByText('1m 0s')).toBeInTheDocument();

		await act(async () => {
			updateCallback?.();
		});

		await waitFor(() => {
			expect(mockStatsApi.getAutoRunSessions).toHaveBeenCalledTimes(2);
			expect(screen.getByText('2m 0s')).toBeInTheDocument();
		});

		unmount();

		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it('captures fetch failures and renders no table after loading completes', async () => {
		const error = new Error('stats unavailable');
		mockStatsApi.getAutoRunSessions.mockRejectedValue(error);
		const { container } = render(<LongestAutoRunsTable timeRange="year" theme={theme} />);

		await waitFor(() => {
			expect(captureException).toHaveBeenCalledWith(error);
		});
		expect(container.firstChild).toBeNull();
	});
});
