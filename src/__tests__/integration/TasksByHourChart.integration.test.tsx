import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksByHourChart } from '../../renderer/components/UsageDashboard/TasksByHourChart';
import { captureException } from '../../renderer/utils/sentry';
import { THEMES } from '../../shared/themes';

vi.mock('../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

const theme = THEMES['dracula'];

const mockStatsApi = {
	getAutoRunSessions: vi.fn(),
	getAutoRunTasks: vi.fn(),
	onStatsUpdate: vi.fn(),
};

const makeSession = (id: string) => ({
	id,
	sessionId: id,
	agentType: 'claude-code',
	startTime: new Date(2026, 4, 15, 9).getTime(),
	duration: 60_000,
});

const makeTask = (id: string, hour: number, success = true) => ({
	id,
	autoRunSessionId: 'autorun-1',
	sessionId: 'session-1',
	agentType: 'claude-code',
	taskIndex: 0,
	taskContent: 'Task',
	startTime: new Date(2026, 4, 15, hour, 30).getTime(),
	duration: 30_000,
	success,
});

describe('TasksByHourChart', () => {
	beforeEach(() => {
		(window as any).maestro = {
			stats: mockStatsApi,
		};
		vi.clearAllMocks();
		mockStatsApi.getAutoRunSessions.mockResolvedValue([]);
		mockStatsApi.getAutoRunTasks.mockResolvedValue([]);
		mockStatsApi.onStatsUpdate.mockReturnValue(vi.fn());
	});

	it('shows loading first and then an empty state when there are no tasks', async () => {
		render(<TasksByHourChart timeRange="week" theme={theme} />);

		expect(screen.getByText('Loading...')).toBeInTheDocument();
		expect(mockStatsApi.getAutoRunSessions).toHaveBeenCalledWith('week');

		await waitFor(() => {
			expect(screen.getByText('No Auto Run tasks in this time range')).toBeInTheDocument();
		});
	});

	it('groups tasks by hour, shows success-rate tooltip, and renders peak hours', async () => {
		mockStatsApi.getAutoRunSessions.mockResolvedValue([makeSession('autorun-1')]);
		mockStatsApi.getAutoRunTasks.mockResolvedValue([
			makeTask('midnight', 0),
			makeTask('noon-success', 12, true),
			makeTask('noon-failure', 12, false),
			makeTask('evening', 18),
		]);

		render(<TasksByHourChart timeRange="month" theme={theme} />);

		expect(await screen.findByTestId('tasks-by-hour-chart')).toBeInTheDocument();
		expect(screen.getByRole('img', { name: 'Tasks by hour of day' })).toBeInTheDocument();
		expect(screen.getByText('12a')).toBeInTheDocument();
		expect(screen.getByText('12p')).toBeInTheDocument();
		expect(screen.getByTitle('12:00 PM: 2 tasks')).toBeInTheDocument();

		fireEvent.mouseEnter(screen.getByTitle('12:00 PM: 2 tasks'));

		expect(screen.getAllByText('12:00 PM').length).toBeGreaterThanOrEqual(2);
		expect(screen.getByText('2 tasks')).toBeInTheDocument();
		expect(screen.getByText('50% success')).toBeInTheDocument();
		expect(screen.getByText('Peak hours:')).toBeInTheDocument();

		fireEvent.mouseLeave(screen.getByTitle('12:00 PM: 2 tasks'));
		expect(screen.queryByText('50% success')).not.toBeInTheDocument();
	});

	it('captures fetch failures and retries successfully', async () => {
		const error = new Error('task fetch failed');
		mockStatsApi.getAutoRunSessions
			.mockRejectedValueOnce(error)
			.mockResolvedValueOnce([makeSession('autorun-1')]);
		mockStatsApi.getAutoRunTasks.mockResolvedValueOnce([makeTask('retry-task', 9)]);

		render(<TasksByHourChart timeRange="year" theme={theme} />);

		await waitFor(() => {
			expect(screen.getByText('Failed to load data')).toBeInTheDocument();
			expect(captureException).toHaveBeenCalledWith(error);
		});

		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

		expect(await screen.findByTestId('tasks-by-hour-chart')).toBeInTheDocument();
		expect(screen.getByTitle('9:00 AM: 1 tasks')).toBeInTheDocument();
	});

	it('uses the default error message for non-Error fetch failures', async () => {
		mockStatsApi.getAutoRunSessions.mockRejectedValueOnce('offline');

		render(<TasksByHourChart timeRange="week" theme={theme} />);

		await waitFor(() => {
			expect(screen.getByText('Failed to load data')).toBeInTheDocument();
			expect(captureException).toHaveBeenCalledWith('offline');
		});
	});

	it('refetches on stats updates and unsubscribes on unmount', async () => {
		const unsubscribe = vi.fn();
		let updateCallback: (() => void) | undefined;
		mockStatsApi.onStatsUpdate.mockImplementation((callback: () => void) => {
			updateCallback = callback;
			return unsubscribe;
		});
		mockStatsApi.getAutoRunSessions.mockResolvedValue([makeSession('autorun-1')]);
		mockStatsApi.getAutoRunTasks
			.mockResolvedValueOnce([makeTask('first', 8)])
			.mockResolvedValueOnce([makeTask('updated', 10)]);

		const { unmount } = render(<TasksByHourChart timeRange="week" theme={theme} />);

		expect(await screen.findByTitle('8:00 AM: 1 tasks')).toBeInTheDocument();

		await act(async () => {
			updateCallback?.();
		});

		await waitFor(() => {
			expect(mockStatsApi.getAutoRunTasks).toHaveBeenCalledTimes(2);
			expect(screen.getByTitle('10:00 AM: 1 tasks')).toBeInTheDocument();
		});

		unmount();

		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
