import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StatsAggregation } from '../../../../shared/stats-types';
import { THEMES } from '../../../../shared/themes';
import type { Session } from '../../../../renderer/types';
import {
	DashboardSection,
	UsageDashboardFooter,
	UsageDashboardHeader,
	UsageDashboardTabs,
} from '../../../../renderer/components/UsageDashboard/UsageDashboardModal/components';
import {
	ActivityView,
	AgentOverviewView,
	AgentsView,
	AutoRunView,
	OverviewView,
	ProviderQuotaUsageView,
	ShortcutsView,
} from '../../../../renderer/components/UsageDashboard/UsageDashboardModal/views';
import type { SectionId } from '../../../../renderer/components/UsageDashboard/UsageDashboardModal/sections';

vi.mock('../../../../renderer/components/AchievementShareButton', () => ({
	AchievementShareButton: () => <button>Share achievements</button>,
}));

vi.mock('../../../../renderer/components/UsageDashboard/SummaryCards', () => ({
	SummaryCards: () => <div>SummaryCards mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/YearInPixelsStrip', () => ({
	YearInPixelsStrip: () => <div>YearInPixelsStrip mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/AgentComparisonChart', () => ({
	AgentComparisonChart: () => <div>AgentComparisonChart mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/ProviderTrendsChart', () => ({
	ProviderTrendsChart: () => <div>ProviderTrendsChart mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/SourceDistributionChart', () => ({
	SourceDistributionChart: () => <div>SourceDistributionChart mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/LocationDistributionChart', () => ({
	LocationDistributionChart: () => <div>LocationDistributionChart mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/RadialActivityChart', () => ({
	RadialActivityChart: ({ mode }: { mode: string }) => <div>RadialActivityChart {mode}</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/PercentilesCard', () => ({
	PercentilesCard: ({ title }: { title: string }) => <div>{title}</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/AgentOverviewCards', () => ({
	AgentOverviewCards: ({
		onShowAgentDetails,
	}: {
		onShowAgentDetails?: (session: Session) => void;
	}) => (
		<button onClick={() => onShowAgentDetails?.({ id: 'mock-agent' } as Session)}>
			AgentOverviewCards mock
		</button>
	),
}));
vi.mock('../../../../renderer/components/UsageDashboard/SessionStats', () => ({
	SessionStats: () => <div>SessionStats mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/WorktreeAnalytics', () => ({
	WorktreeAnalytics: () => <div>WorktreeAnalytics mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/AgentEfficiencyChart', () => ({
	AgentEfficiencyChart: () => <div>AgentEfficiencyChart mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/AgentUsageChart', () => ({
	AgentUsageChart: () => <div>AgentUsageChart mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/ActivityHeatmap', () => ({
	ActivityHeatmap: () => <div>ActivityHeatmap mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/WeekdayComparisonChart', () => ({
	WeekdayComparisonChart: () => <div>WeekdayComparisonChart mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/DurationTrendsChart', () => ({
	DurationTrendsChart: () => <div>DurationTrendsChart mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/AutoRunStats', () => ({
	AutoRunStats: () => <div>AutoRunStats mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/TasksByHourChart', () => ({
	TasksByHourChart: () => <div>TasksByHourChart mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/LongestAutoRunsTable', () => ({
	LongestAutoRunsTable: () => <div>LongestAutoRunsTable mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/KeyboardStats', () => ({
	KeyboardStats: () => <div>KeyboardStats mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/ClaudePlanUsage', () => ({
	ClaudePlanUsage: () => <div>ClaudePlanUsage mock</div>,
}));
vi.mock('../../../../renderer/components/UsageDashboard/CodexPlanUsage', () => ({
	CodexPlanUsage: () => <div>CodexPlanUsage mock</div>,
}));

const theme = THEMES.dracula;
const emptyCell = String.fromCharCode(8212);

const data: StatsAggregation = {
	totalQueries: 4,
	totalDuration: 2000,
	avgDuration: 500,
	queryDurationPercentiles: { count: 0, min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0 },
	queryDurationPercentilesByAgent: {},
	autoRunTaskDurationPercentiles: {
		count: 0,
		min: 0,
		p50: 0,
		p75: 0,
		p90: 0,
		p95: 0,
		p99: 0,
		max: 0,
	},
	byAgent: { codex: { count: 4, duration: 2000 } },
	bySource: { user: 3, auto: 1 },
	byLocation: { local: 4, remote: 0 },
	byDay: [],
	byHour: [],
	totalSessions: 1,
	sessionsByAgent: { codex: 1 },
	sessionsByDay: [],
	avgSessionDuration: 2000,
	byAgentByDay: {},
	bySessionByDay: {},
	bySessionSource: {},
	worktreeQueries: 0,
	parentQueries: 4,
	byWorktreeStatus: {
		worktree: { count: 0, duration: 0 },
		parent: { count: 4, duration: 2000 },
	},
	imageAnnotations: 0,
};

const session = {
	id: 's1',
	name: 'Codex',
	toolType: 'codex',
	state: 'idle',
	cwd: '/repo',
	fullPath: '/repo',
	projectRoot: '/repo',
	aiLogs: [],
	shellLogs: [],
	workLog: [],
	contextUsage: 0,
	inputMode: 'ai',
	aiPid: 0,
	terminalPid: 0,
	port: 0,
	isLive: false,
	changedFiles: [],
	isGitRepo: false,
	fileTree: [],
	fileExplorerExpanded: [],
	fileExplorerScrollPos: 0,
	createdAt: 0,
} as Session;

const worktreeSession = {
	...session,
	id: 's2',
	name: 'Codex Worktree',
	parentSessionId: 's1',
} as Session;

const layout = {
	isNarrow: false,
	isMedium: false,
	isWide: true,
	chartGridCols: 2,
	summaryCardsCols: 3,
	autoRunStatsCols: 6,
};

const navigation = {
	focusedSection: null,
	setSectionRef: (_sectionId: SectionId) => vi.fn(),
	handleSectionKeyDown: vi.fn(),
};

describe('UsageDashboardModal shell components', () => {
	it('renders header controls and fires callbacks', () => {
		const onRange = vi.fn();
		const onExport = vi.fn();
		const onClose = vi.fn();

		render(
			<UsageDashboardHeader
				theme={theme}
				showNewDataIndicator
				timeRange="week"
				onTimeRangeChange={onRange}
				onExport={onExport}
				isExporting={false}
				onClose={onClose}
				autoRunStats={undefined}
				globalStats={null}
				usageStats={null}
				handsOnTimeMs={0}
				leaderboardRegistration={null}
			/>
		);

		expect(screen.getByText('Usage Dashboard')).toBeInTheDocument();
		expect(screen.getByTestId('new-data-indicator')).toHaveTextContent('Updated');
		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'month' } });
		fireEvent.click(screen.getByText('Export CSV'));
		fireEvent.click(screen.getByTitle('Close (Esc)'));
		expect(onRange).toHaveBeenCalledWith('month');
		expect(onExport).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it('renders tabs, delegates keyboard events, and switches view mode', () => {
		const switchViewMode = vi.fn();
		const onKeyDown = vi.fn();

		render(
			<UsageDashboardTabs
				theme={theme}
				viewMode="overview"
				viewModeTabs={[
					{ value: 'overview', label: 'Overview' },
					{ value: 'activity', label: 'Activity' },
				]}
				switchViewMode={switchViewMode}
				onKeyDown={onKeyDown}
			/>
		);

		fireEvent.keyDown(screen.getByTestId('view-mode-tabs'), { key: 'ArrowRight' });
		fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
		expect(onKeyDown).toHaveBeenCalled();
		expect(switchViewMode).toHaveBeenCalledWith('activity');
	});

	it('renders footer range text and exact database size formatting', () => {
		render(
			<UsageDashboardFooter theme={theme} data={data} timeRange="month" databaseSize={2048} />
		);
		expect(screen.getByText('Showing this month data')).toBeInTheDocument();
		expect(screen.getByTestId('database-size-indicator')).toHaveTextContent('2.0 KB');
		expect(screen.getByText('Press Esc to close')).toBeInTheDocument();

		render(
			<UsageDashboardFooter theme={theme} data={null} timeRange="month" databaseSize={null} />
		);
		expect(screen.getByText('No data for selected time range')).toBeInTheDocument();
		expect(emptyCell).toBe(String.fromCharCode(8212));
	});

	it('wraps dashboard sections with stable accessibility hooks', () => {
		const setSectionRef = vi.fn(() => vi.fn());
		const handleSectionKeyDown = vi.fn();

		render(
			<DashboardSection
				sectionId="summary-cards"
				focusedSection="summary-cards"
				setSectionRef={setSectionRef}
				handleSectionKeyDown={handleSectionKeyDown}
				theme={theme}
			>
				Section child
			</DashboardSection>
		);

		const section = screen.getByRole('region', { name: 'Summary Cards' });
		fireEvent.keyDown(section, { key: 'ArrowDown' });
		expect(section).toHaveAttribute('data-testid', 'section-summary-cards');
		expect(setSectionRef).toHaveBeenCalledWith('summary-cards');
		expect(handleSectionKeyDown).toHaveBeenCalledWith(expect.any(Object), 'summary-cards');
	});
});

describe('UsageDashboardModal view modules', () => {
	it('renders overview chart sections with mocked children', () => {
		render(
			<OverviewView
				data={data}
				timeRange="week"
				theme={theme}
				colorBlindMode={false}
				sessions={[session]}
				layout={layout}
				cueSourceTotals={null}
				{...navigation}
			/>
		);

		expect(screen.getByText('SummaryCards mock')).toBeInTheDocument();
		expect(screen.getByText('Query Duration Percentiles')).toBeInTheDocument();
		expect(screen.getByText('RadialActivityChart hours')).toBeInTheDocument();
	});

	it('renders Agents view empty and detail-capable states', () => {
		const onShowAgentDetails = vi.fn();
		const { rerender } = render(
			<AgentsView
				data={data}
				timeRange="week"
				theme={theme}
				colorBlindMode={false}
				sessions={[]}
				layout={layout}
				onShowAgentDetails={onShowAgentDetails}
				{...navigation}
			/>
		);
		expect(screen.getByText('No active agents')).toBeInTheDocument();

		rerender(
			<AgentsView
				data={data}
				timeRange="week"
				theme={theme}
				colorBlindMode={false}
				sessions={[session]}
				layout={layout}
				onShowAgentDetails={onShowAgentDetails}
				{...navigation}
			/>
		);
		fireEvent.click(screen.getByText('AgentOverviewCards mock'));
		expect(onShowAgentDetails).toHaveBeenCalledWith(expect.objectContaining({ id: 'mock-agent' }));
	});

	it('renders the remaining non-Cue views with mocked children', () => {
		const common = {
			data,
			timeRange: 'week' as const,
			theme,
			colorBlindMode: false,
			sessions: [session],
			layout,
			...navigation,
		};
		const { rerender } = render(<AgentOverviewView {...common} />);
		expect(screen.getByText('SessionStats mock')).toBeInTheDocument();
		expect(screen.getByText('AgentUsageChart mock')).toBeInTheDocument();
		expect(screen.queryByText('WorktreeAnalytics mock')).not.toBeInTheDocument();
		expect(screen.getByRole('tabpanel')).toHaveAttribute('tabindex', '0');

		rerender(<AgentOverviewView {...common} sessions={[session, worktreeSession]} />);
		expect(screen.getByText('WorktreeAnalytics mock')).toBeInTheDocument();
		expect(screen.getByTestId('section-worktree-analytics')).toBeInTheDocument();

		rerender(<ActivityView {...common} />);
		expect(screen.getByText('ActivityHeatmap mock')).toBeInTheDocument();

		rerender(<AutoRunView {...common} />);
		expect(screen.getByText('AutoRunStats mock')).toBeInTheDocument();

		rerender(<ShortcutsView timeRange="week" theme={theme} />);
		expect(screen.getByText('KeyboardStats mock')).toBeInTheDocument();
	});

	it('renders provider quota views', () => {
		const { rerender } = render(
			<ProviderQuotaUsageView provider="anthropic" theme={theme} {...navigation} />
		);
		expect(screen.getByText('ClaudePlanUsage mock')).toBeInTheDocument();

		rerender(<ProviderQuotaUsageView provider="codex" theme={theme} {...navigation} />);
		expect(screen.getByText('CodexPlanUsage mock')).toBeInTheDocument();
	});
});
