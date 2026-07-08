import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { UsageDashboardModal } from '../../renderer/components/UsageDashboard/UsageDashboardModal';
import { logger } from '../../renderer/utils/logger';
import type { Session, Theme } from '../../renderer/types';

type StatsUpdateListener = () => void;

function createTheme(): Theme {
	return {
		id: 'custom',
		name: 'Integration Theme',
		mode: 'dark',
		colors: {
			bgMain: '#111827',
			bgSidebar: '#1f2937',
			bgActivity: '#0f172a',
			border: '#374151',
			textMain: '#f9fafb',
			textDim: '#9ca3af',
			accent: '#2563eb',
			accentDim: '#1d4ed8',
			accentText: '#93c5fd',
			accentForeground: '#ffffff',
			success: '#16a34a',
			warning: '#f59e0b',
			error: '#dc2626',
		},
	};
}

function createStatsData() {
	return {
		totalQueries: 150,
		totalDuration: 3_600_000,
		avgDuration: 24_000,
		byAgent: {
			'claude-code': { count: 100, duration: 2_400_000 },
			codex: { count: 50, duration: 1_200_000 },
		},
		bySource: { user: 100, auto: 50 },
		byLocation: { local: 120, remote: 30 },
		byDay: [
			{ date: '2026-05-21', count: 25, duration: 600_000 },
			{ date: '2026-05-22', count: 30, duration: 720_000 },
			{ date: '2026-05-23', count: 45, duration: 1_080_000 },
			{ date: '2026-05-24', count: 50, duration: 1_200_000 },
		],
		byHour: [
			{ hour: 9, count: 20, duration: 480_000 },
			{ hour: 10, count: 35, duration: 840_000 },
			{ hour: 14, count: 45, duration: 1_080_000 },
			{ hour: 15, count: 50, duration: 1_200_000 },
		],
		totalSessions: 25,
		sessionsByAgent: { 'claude-code': 15, codex: 10 },
		sessionsByDay: [
			{ date: '2026-05-21', count: 5 },
			{ date: '2026-05-22', count: 7 },
			{ date: '2026-05-23', count: 6 },
			{ date: '2026-05-24', count: 7 },
		],
		avgSessionDuration: 144_000,
		byAgentByDay: {
			'claude-code': [
				{ date: '2026-05-23', count: 4, duration: 300_000 },
				{ date: '2026-05-24', count: 6, duration: 420_000 },
			],
			codex: [{ date: '2026-05-24', count: 3, duration: 240_000 }],
		},
		bySessionByDay: {
			'session-1': [
				{ date: '2026-05-23', count: 2, duration: 180_000 },
				{ date: '2026-05-24', count: 3, duration: 240_000 },
			],
		},
	};
}

function createAutoRunSessions() {
	return [
		{
			id: 'autorun-1',
			sessionId: 'session-1',
			agentType: 'claude-code',
			documentPath: '/workspace/project/plan.md',
			startTime: new Date('2026-05-24T10:15:00Z').getTime(),
			duration: 120_000,
			tasksTotal: 4,
			tasksCompleted: 3,
			projectPath: '/workspace/project',
		},
		{
			id: 'autorun-2',
			sessionId: 'session-2',
			agentType: 'codex',
			documentPath: '/workspace/project/fix.md',
			startTime: new Date('2026-05-24T15:30:00Z').getTime(),
			duration: 240_000,
			tasksTotal: 2,
			tasksCompleted: 2,
			projectPath: '/workspace/project',
		},
	];
}

function createAutoRunTasks(sessionId: string) {
	return [
		{
			id: `${sessionId}-task-1`,
			autoRunSessionId: sessionId,
			sessionId: 'session-1',
			agentType: 'claude-code',
			taskIndex: 0,
			taskContent: 'Prepare plan',
			startTime: new Date('2026-05-24T10:15:00Z').getTime(),
			duration: 60_000,
			success: true,
		},
		{
			id: `${sessionId}-task-2`,
			autoRunSessionId: sessionId,
			sessionId: 'session-1',
			agentType: 'claude-code',
			taskIndex: 1,
			taskContent: 'Verify plan',
			startTime: new Date('2026-05-24T15:30:00Z').getTime(),
			duration: 90_000,
			success: sessionId === 'autorun-1',
		},
	];
}

function createSessions(): Session[] {
	return [
		{
			id: 'session-1',
			name: 'Planning',
			toolType: 'claude-code',
			cwd: '/workspace/project',
			projectRoot: '/workspace/project',
			logs: [],
			state: 'idle',
			createdAt: 1700000000000,
			isGitRepo: true,
			bookmarked: true,
		} as Session,
		{
			id: 'session-2',
			name: 'Remote Fix',
			toolType: 'codex',
			cwd: 'ssh://prod/workspace/project',
			projectRoot: '/workspace/project',
			logs: [],
			state: 'idle',
			createdAt: 1700000100000,
			isGitRepo: false,
		} as Session,
	];
}

function renderDashboard(
	overrides: Partial<React.ComponentProps<typeof UsageDashboardModal>> = {}
) {
	const props = {
		isOpen: true,
		onClose: vi.fn(),
		theme: createTheme(),
		colorBlindMode: true,
		defaultTimeRange: 'week',
		sessions: createSessions(),
		...overrides,
	} satisfies React.ComponentProps<typeof UsageDashboardModal>;

	const result = render(
		<LayerStackProvider>
			<UsageDashboardModal {...props} />
		</LayerStackProvider>
	);

	return { props, ...result };
}

describe('UsageDashboardModal integration', () => {
	let statsListeners: StatsUpdateListener[];
	let writeFileMock: ReturnType<typeof vi.fn>;
	let now = 0;

	beforeEach(() => {
		vi.clearAllMocks();
		statsListeners = [];
		now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => {
			now += 10;
			return now;
		});
		Element.prototype.scrollIntoView = vi.fn();

		vi.mocked(window.maestro.stats.getAggregation).mockResolvedValue(createStatsData());
		vi.mocked(window.maestro.stats.getDatabaseSize).mockResolvedValue(5 * 1024 * 1024);
		vi.mocked(window.maestro.stats.getAutoRunSessions).mockResolvedValue(createAutoRunSessions());
		vi.mocked(window.maestro.stats.getAutoRunTasks).mockImplementation((sessionId: string) =>
			Promise.resolve(createAutoRunTasks(sessionId))
		);
		vi.mocked(window.maestro.stats.exportCsv).mockResolvedValue('date,count\n2026-05-24,50');
		vi.mocked(window.maestro.stats.onStatsUpdate).mockImplementation((listener) => {
			statsListeners.push(listener);
			return vi.fn();
		});
		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValue('/tmp/maestro-usage.csv');
		writeFileMock = vi.fn().mockResolvedValue({ success: true });
		Object.assign(window.maestro.fs, { writeFile: writeFileMock });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('renders nothing while closed and loads the requested default range when opened', async () => {
		const { container, rerender } = render(
			<LayerStackProvider>
				<UsageDashboardModal isOpen={false} onClose={vi.fn()} theme={createTheme()} />
			</LayerStackProvider>
		);

		expect(container.firstChild).toBeNull();

		rerender(
			<LayerStackProvider>
				<UsageDashboardModal
					isOpen={true}
					onClose={vi.fn()}
					theme={createTheme()}
					defaultTimeRange="month"
					sessions={createSessions()}
				/>
			</LayerStackProvider>
		);

		expect(await screen.findByRole('dialog', { name: 'Usage Dashboard' })).toBeInTheDocument();
		expect(await screen.findByTestId('usage-dashboard-content')).toBeInTheDocument();
		await waitFor(() => {
			expect(window.maestro.stats.getAggregation).toHaveBeenCalledWith('month');
		});
		expect(screen.getByText('Usage Dashboard')).toBeInTheDocument();
		expect(screen.getByText('Total Queries')).toBeInTheDocument();
		expect(screen.getByTestId('database-size-indicator')).toHaveTextContent('5.0 MB');
	});

	it('changes time range, exports CSV, and closes through controls and the layer stack', async () => {
		const { props } = renderDashboard();

		await screen.findByTestId('usage-dashboard-content');
		expect(screen.getByRole('combobox')).toHaveValue('week');

		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'quarter' } });
		await waitFor(() => {
			expect(window.maestro.stats.getAggregation).toHaveBeenCalledWith('quarter');
		});

		fireEvent.click(screen.getByText('Export CSV'));
		await waitFor(() => {
			expect(window.maestro.dialog.saveFile).toHaveBeenCalledWith(
				expect.objectContaining({
					title: 'Export Usage Data',
					defaultPath: expect.stringMatching(/^maestro-usage-quarter-\d{4}-\d{2}-\d{2}\.csv$/),
				})
			);
			expect(window.maestro.stats.exportCsv).toHaveBeenCalledWith('quarter');
			expect(writeFileMock).toHaveBeenCalledWith(
				'/tmp/maestro-usage.csv',
				'date,count\n2026-05-24,50'
			);
		});

		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => {
			expect(props.onClose).toHaveBeenCalledTimes(1);
		});

		fireEvent.click(screen.getByLabelText('Close usage dashboard'));
		expect(props.onClose).toHaveBeenCalledTimes(2);
	});

	it('formats database sizes across byte, kilobyte, and gigabyte ranges', async () => {
		vi.mocked(window.maestro.stats.getDatabaseSize).mockResolvedValueOnce(512);
		const byteView = renderDashboard();
		expect(await screen.findByTestId('database-size-indicator')).toHaveTextContent('512 B');
		byteView.unmount();

		vi.mocked(window.maestro.stats.getDatabaseSize).mockResolvedValueOnce(2 * 1024);
		const kilobyteView = renderDashboard();
		expect(await screen.findByTestId('database-size-indicator')).toHaveTextContent('2.0 KB');
		kilobyteView.unmount();

		vi.mocked(window.maestro.stats.getDatabaseSize).mockResolvedValueOnce(2 * 1024 * 1024 * 1024);
		renderDashboard();
		expect(await screen.findByTestId('database-size-indicator')).toHaveTextContent('2.00 GB');
	});

	it('warns for slow stats fetches and uses responsive layout breakpoints', async () => {
		const originalOffsetWidth = Object.getOwnPropertyDescriptor(
			HTMLElement.prototype,
			'offsetWidth'
		);
		const loggerWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		now = 0;
		vi.mocked(performance.now).mockImplementation(() => {
			now += 250;
			return now;
		});

		let offsetWidth = 500;
		Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
			configurable: true,
			get() {
				return offsetWidth;
			},
		});

		try {
			const narrowView = renderDashboard();
			await screen.findByTestId('usage-dashboard-content');
			await waitFor(() => {
				expect(
					screen.getByTestId('section-source-distribution').parentElement?.style.gridTemplateColumns
				).toContain('repeat(1');
			});
			expect(loggerWarn).toHaveBeenCalledWith(
				expect.stringContaining('[UsageDashboard] fetchStats took'),
				undefined,
				expect.objectContaining({ timeRange: 'week', totalQueries: 150 })
			);
			narrowView.unmount();

			offsetWidth = 700;
			const mediumView = renderDashboard();
			await screen.findByTestId('usage-dashboard-content');
			await waitFor(() => {
				expect(
					screen.getByTestId('section-source-distribution').parentElement?.style.gridTemplateColumns
				).toContain('repeat(2');
			});
			mediumView.unmount();

			const transientView = renderDashboard();
			transientView.unmount();
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		} finally {
			if (originalOffsetWidth) {
				Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
			}
		}
	});

	it('handles export cancellation, export failure, and control hover states', async () => {
		renderDashboard();
		await screen.findByTestId('usage-dashboard-content');

		const exportButton = screen.getByRole('button', { name: 'Export CSV' });
		const closeButton = screen.getByTitle('Close (Esc)');
		fireEvent.mouseEnter(exportButton);
		fireEvent.mouseLeave(exportButton);
		fireEvent.mouseEnter(closeButton);
		fireEvent.mouseLeave(closeButton);

		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValueOnce(undefined);
		fireEvent.click(exportButton);
		await waitFor(() => {
			expect(window.maestro.dialog.saveFile).toHaveBeenCalledTimes(1);
		});
		expect(window.maestro.stats.exportCsv).not.toHaveBeenCalled();

		const exportError = new Error('disk full');
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValueOnce('/tmp/failing-export.csv');
		vi.mocked(window.maestro.stats.exportCsv).mockRejectedValueOnce(exportError);

		fireEvent.click(exportButton);
		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith('Failed to export CSV:', undefined, exportError);
		});
		expect(writeFileMock).not.toHaveBeenCalled();
	});

	it('switches dashboard views and supports section keyboard navigation', async () => {
		renderDashboard();

		await screen.findByTestId('usage-dashboard-content');
		const tablist = screen.getByTestId('view-mode-tabs');
		const getTab = (name: string) => screen.getByRole('tab', { name });

		fireEvent.click(getTab('Agent Overview'));
		expect(await screen.findByTestId('section-session-stats')).toBeInTheDocument();
		expect(screen.getByTestId('section-agent-usage')).toBeInTheDocument();

		fireEvent.click(getTab('Agents'));
		expect(await screen.findByTestId('section-agent-overview-cards')).toBeInTheDocument();

		fireEvent.click(getTab('Activity'));
		expect(await screen.findByTestId('section-weekday-comparison')).toBeInTheDocument();

		fireEvent.click(getTab('Auto Run'));
		expect(await screen.findByTestId('section-autorun-stats')).toBeInTheDocument();
		await waitFor(() => {
			expect(window.maestro.stats.getAutoRunSessions).toHaveBeenCalledWith('week');
			expect(window.maestro.stats.getAutoRunTasks).toHaveBeenCalledWith('autorun-1');
		});

		fireEvent.click(getTab('Overview'));
		expect(await screen.findByTestId('section-year-in-pixels')).toBeInTheDocument();

		fireEvent.keyDown(tablist, { key: 'Tab' });
		const firstOverviewSection = screen.getByTestId('section-year-in-pixels');
		expect(document.activeElement).toBe(firstOverviewSection);

		fireEvent.keyDown(firstOverviewSection, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(screen.getByTestId('section-summary-cards'));

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		expect(await screen.findByTestId('section-session-stats')).toBeInTheDocument();

		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
		expect(await screen.findByTestId('section-year-in-pixels')).toBeInTheDocument();
	});

	it('exercises tab and section keyboard handlers across every dashboard view', async () => {
		renderDashboard();

		await screen.findByTestId('usage-dashboard-content');
		const tablist = screen.getByTestId('view-mode-tabs');
		const tabs = screen.getAllByRole('tab');
		const getTab = (name: string) => screen.getByRole('tab', { name });
		const expectSelectedTab = (name: string) => {
			expect(getTab(name)).toHaveAttribute('aria-selected', 'true');
		};
		const moveFocusThroughSections = async (sectionIds: string[]) => {
			tablist.focus();
			fireEvent.keyDown(tablist, { key: 'Tab' });
			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByTestId(`section-${sectionIds[0]}`));
			});

			if (sectionIds.length > 1) {
				fireEvent.keyDown(screen.getByTestId(`section-${sectionIds[0]}`), { key: 'Tab' });
				await waitFor(() => {
					expect(document.activeElement).toBe(screen.getByTestId(`section-${sectionIds[1]}`));
				});
			}

			for (let index = 2; index < sectionIds.length; index += 1) {
				fireEvent.keyDown(screen.getByTestId(`section-${sectionIds[index - 1]}`), {
					key: 'ArrowDown',
				});
				await waitFor(() => {
					expect(document.activeElement).toBe(screen.getByTestId(`section-${sectionIds[index]}`));
				});
			}

			fireEvent.keyDown(screen.getByTestId(`section-${sectionIds[sectionIds.length - 1]}`), {
				key: 'PageDown',
			});
		};

		fireEvent.mouseEnter(tabs[1]);
		fireEvent.mouseLeave(tabs[1]);
		fireEvent.mouseEnter(tabs[0]);
		fireEvent.mouseLeave(tabs[0]);

		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
		expectSelectedTab('Shortcuts');

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		expect(await screen.findByTestId('section-year-in-pixels')).toBeInTheDocument();

		fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
		expectSelectedTab('Shortcuts');

		fireEvent.keyDown(tablist, { key: 'ArrowUp' });
		expect(await screen.findByTestId('section-autorun-stats')).toBeInTheDocument();

		fireEvent.keyDown(tablist, { key: 'ArrowDown' });
		expectSelectedTab('Shortcuts');

		fireEvent.keyDown(tablist, { key: 'ArrowRight' });
		expect(await screen.findByTestId('section-year-in-pixels')).toBeInTheDocument();

		fireEvent.keyDown(tablist, { key: 'Tab' });
		expect(document.activeElement).toBe(screen.getByTestId('section-year-in-pixels'));

		fireEvent.keyDown(screen.getByTestId('section-year-in-pixels'), {
			key: 'Tab',
			shiftKey: true,
		});
		expect(document.activeElement).toBe(tablist);

		fireEvent.keyDown(tablist, { key: 'Tab' });
		const firstOverviewSection = screen.getByTestId('section-year-in-pixels');
		fireEvent.keyDown(firstOverviewSection, { key: 'ArrowDown' });
		const summarySection = screen.getByTestId('section-summary-cards');
		expect(document.activeElement).toBe(summarySection);
		fireEvent.keyDown(summarySection, { key: 'ArrowUp' });
		expect(document.activeElement).toBe(firstOverviewSection);

		const overviewSections = [
			'year-in-pixels',
			'summary-cards',
			'query-percentiles',
			'agent-comparison',
			'provider-trends',
			'source-distribution',
			'location-distribution',
			'radial-activity',
		];
		await moveFocusThroughSections(overviewSections);
		for (const sectionId of overviewSections) {
			fireEvent.keyDown(screen.getByTestId(`section-${sectionId}`), { key: 'Home' });
		}
		fireEvent.keyDown(screen.getByTestId('section-radial-activity'), { key: 'End' });
		fireEvent.keyDown(screen.getByTestId('section-radial-activity'), { key: 'ArrowDown' });

		fireEvent.click(getTab('Agent Overview'));
		expect(await screen.findByTestId('section-session-stats')).toBeInTheDocument();
		const agentSections = ['session-stats', 'agent-efficiency', 'agent-usage'];
		await moveFocusThroughSections(agentSections);
		for (const sectionId of agentSections) {
			fireEvent.keyDown(screen.getByTestId(`section-${sectionId}`), { key: 'Home' });
		}

		fireEvent.click(getTab('Agents'));
		expect(await screen.findByTestId('section-agent-overview-cards')).toBeInTheDocument();
		await moveFocusThroughSections(['agent-overview-cards']);

		fireEvent.click(getTab('Activity'));
		expect(await screen.findByTestId('section-weekday-comparison')).toBeInTheDocument();
		const activitySections = ['activity-heatmap', 'weekday-comparison', 'duration-trends'];
		await moveFocusThroughSections(activitySections);
		for (const sectionId of activitySections) {
			fireEvent.keyDown(screen.getByTestId(`section-${sectionId}`), { key: 'Home' });
		}

		fireEvent.click(getTab('Auto Run'));
		expect(await screen.findByTestId('section-autorun-stats')).toBeInTheDocument();
		const autoRunSections = [
			'autorun-stats',
			'autorun-task-percentiles',
			'tasks-by-hour',
			'longest-autoruns',
		];
		await moveFocusThroughSections(autoRunSections);
		for (const sectionId of autoRunSections) {
			fireEvent.keyDown(screen.getByTestId(`section-${sectionId}`), { key: 'Home' });
		}
	});

	it('does not move focus into dashboard sections before data has loaded', async () => {
		vi.useFakeTimers();
		vi.mocked(window.maestro.stats.getAggregation).mockImplementationOnce(
			() => new Promise((resolve) => setTimeout(() => resolve(createStatsData()), 50))
		);

		const { unmount } = renderDashboard();
		const tablist = screen.getByTestId('view-mode-tabs');
		fireEvent.keyDown(tablist, { key: 'Home' });
		fireEvent.keyDown(tablist, { key: 'Tab' });

		expect(document.activeElement).not.toBe(screen.queryByTestId('section-summary-cards'));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(50);
		});
		unmount();
	});

	it('handles real-time stats updates, empty data, and recoverable fetch errors', async () => {
		const { rerender } = renderDashboard();
		await screen.findByTestId('usage-dashboard-content');

		vi.useFakeTimers();
		await act(async () => {
			statsListeners[0]();
			statsListeners[0]();
			await vi.advanceTimersByTimeAsync(1000);
		});

		expect(window.maestro.stats.getAggregation).toHaveBeenCalledTimes(2);
		expect(screen.getByTestId('new-data-indicator')).toBeInTheDocument();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(screen.queryByTestId('new-data-indicator')).not.toBeInTheDocument();
		vi.useRealTimers();

		vi.mocked(window.maestro.stats.getAggregation).mockResolvedValueOnce({
			...createStatsData(),
			totalQueries: 0,
			totalDuration: 0,
			avgDuration: 0,
			byAgent: {},
			bySource: { user: 0, auto: 0 },
			byLocation: { local: 0, remote: 0 },
			byDay: [],
			byHour: [],
		});
		rerender(
			<LayerStackProvider>
				<UsageDashboardModal
					isOpen={true}
					onClose={vi.fn()}
					theme={createTheme()}
					defaultTimeRange="day"
				/>
			</LayerStackProvider>
		);
		expect(await screen.findByText('No usage data yet')).toBeInTheDocument();

		const fetchError = new Error('stats unavailable');
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.stats.getAggregation)
			.mockRejectedValueOnce(fetchError)
			.mockResolvedValueOnce(createStatsData());

		rerender(
			<LayerStackProvider>
				<UsageDashboardModal
					isOpen={true}
					onClose={vi.fn()}
					theme={createTheme()}
					defaultTimeRange="year"
				/>
			</LayerStackProvider>
		);
		expect(await screen.findByText('Failed to load usage data')).toBeInTheDocument();
		expect(loggerError).toHaveBeenCalledWith('Failed to fetch usage stats:', undefined, fetchError);

		fireEvent.click(screen.getByText('Retry'));
		expect(await screen.findByTestId('usage-dashboard-content')).toBeInTheDocument();

		vi.mocked(window.maestro.stats.getAggregation)
			.mockRejectedValueOnce('stats unavailable')
			.mockResolvedValueOnce(createStatsData());

		rerender(
			<LayerStackProvider>
				<UsageDashboardModal
					isOpen={true}
					onClose={vi.fn()}
					theme={createTheme()}
					defaultTimeRange="all"
				/>
			</LayerStackProvider>
		);
		expect(await screen.findByText('Failed to load usage data')).toBeInTheDocument();
		expect(loggerError).toHaveBeenCalledWith(
			'Failed to fetch usage stats:',
			undefined,
			'stats unavailable'
		);

		fireEvent.click(screen.getByText('Retry'));
		expect(await screen.findByTestId('usage-dashboard-content')).toBeInTheDocument();
	});
});
