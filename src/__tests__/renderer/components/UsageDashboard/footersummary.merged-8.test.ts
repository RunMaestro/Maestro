// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/components/UsageDashboard/footerSummary.test.ts
// Source: src/__tests__/renderer/components/UsageDashboard/AgentOverviewUtils.test.ts
// Source: src/__tests__/renderer/components/UsageDashboard/chartUtils.test.ts
// Source: src/__tests__/renderer/components/UsageDashboard/AutoRunUtils.test.ts
// Source: src/__tests__/renderer/components/UsageDashboard/AgentComparisonUtils.test.ts
// Source: src/__tests__/renderer/components/UsageDashboard/delegationTrendUtils.test.ts
// Source: src/__tests__/renderer/components/UsageDashboard/quotaLastRefreshed.test.ts
// Source: src/__tests__/renderer/components/UsageDashboard/ActivityHeatmapUtils.test.ts
import { describe, it, expect } from 'vitest';
import {
	buildActivitySummary,
	buildAgentOverviewSummary,
	buildAgentsSummary,
	buildAutoRunSummary,
	buildCueSummary,
	buildGroupsSummary,
	buildModalOwnedFooterSummary,
	buildOverviewSummary,
	buildQuotaSummary,
	buildShortcutsSummary,
	buildTokensSummary,
} from '../../../../renderer/components/UsageDashboard/footerSummary';
import type { StatsAggregation as S1_StatsAggregation } from '../../../../shared/stats-types';
import type { Session as S1_Session } from '../../../../renderer/types';
import type { StatsAggregation as S2_StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session as S2_Session } from '../../../../renderer/types';
import { THEMES as S2_THEMES } from '../../../../shared/themes';
import {
	buildSessionSparkline,
	getSessionAutoPercent,
	getSessionLastQueryAt,
	getSessionQueryCount,
	getStatusColor,
	isSessionHighlighted,
	sortAgentOverviewSessions,
} from '../../../../renderer/components/UsageDashboard/agentOverviewUtils';
import {
	isWorktreeAgent,
	isParentAgent,
	findSessionByStatId,
	prettifyAgentType,
	resolveAgentDisplayName,
	buildNameMap,
	computeAxisLabelIndices,
	PHONE_AXIS_LABELS,
	BAR_CHART_GRID_STYLE,
	BAR_CHART_ROW_STYLE,
	DONUT_CHART,
	describeDonutArc,
	getSeriesColor,
	chunkIntoEqualGroups,
} from '../../../../renderer/components/UsageDashboard/chartUtils';
import { COLORBLIND_AGENT_PALETTE as S3_COLORBLIND_AGENT_PALETTE } from '../../../../renderer/constants/colorblindPalettes';
import { mockTheme } from '../../../helpers/mockTheme';
import type { Session as S3_Session } from '../../../../renderer/types';
import type { AutoRunSession, AutoRunTask } from '../../../../shared/stats-types';
import { GOAL_RUN_DOCUMENT_PREFIX } from '../../../../shared/goalDriven/goalRunLabel';
import {
	computeAutoRunMetrics,
	formatDateLabel,
	formatFullDate,
	getAutoRunChartMax,
	groupSessionsByDate,
} from '../../../../renderer/components/UsageDashboard/autoRunStatsUtils';
import {
	extractFileName,
	extractProjectName,
	formatAgentName,
	formatAutoRunDate,
	formatAutoRunTasksLabel,
	getTopAutoRunSessions,
} from '../../../../renderer/components/UsageDashboard/autoRunTableUtils';
import {
	buildHourlyTaskData,
	formatHourFull,
	formatHourShort,
	getMaxHourlyTaskCount,
	getPeakHours,
} from '../../../../renderer/components/UsageDashboard/tasksByHourUtils';
import type { StatsAggregation as S5_StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session as S5_Session } from '../../../../renderer/types';
import { THEMES as S5_THEMES } from '../../../../shared/themes';
import {
	buildAgentComparisonData,
	buildAgentSplitAggregation,
	getAgentColor,
} from '../../../../renderer/components/UsageDashboard/agentComparisonUtils';
import { COLORBLIND_AGENT_PALETTE as S5_COLORBLIND_AGENT_PALETTE } from '../../../../renderer/constants/colorblindPalettes';
import {
	bucketDelegatedPercent,
	bucketDelegatedValue,
	bucketInteractiveValue,
	buildDelegationSeries,
	toYmd,
} from '../../../../renderer/components/UsageDashboard/delegationTrendUtils';
import type { DelegationDay } from '../../../../shared/delegation';
import {
	isSampleBehindLatest,
	resolveLatestSampledAt,
	STALE_ROW_LAG_MS,
} from '../../../../renderer/components/UsageDashboard/quota/quotaFormatting';
import { COLORBLIND_HEATMAP_SCALE } from '../../../../renderer/constants/colorblindPalettes';
import {
	calculateIntensity,
	getDaysForRange,
	getIntensityColor,
	shouldUse4HourBlockMode,
	shouldUseSingleDayMode,
	TIME_BLOCK_LABELS,
} from '../../../../renderer/components/UsageDashboard/activityHeatmapUtils';
import { THEMES as S8_THEMES } from '../../../../shared/themes';
// Source: src/__tests__/renderer/components/UsageDashboard/footerSummary.test.ts
describe('', () => {
	const buildData = (overrides: Partial<S1_StatsAggregation> = {}): S1_StatsAggregation =>
		({
			totalQueries: 0,
			totalDuration: 0,
			avgDuration: 0,
			byAgent: {},
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
			bySessionSource: {},
			bySessionTokens: {},
			...overrides,
		}) as S1_StatsAggregation;
	const buildSession = (overrides: Partial<S1_Session>): S1_Session =>
		({
			id: 'sess-1',
			name: 'Agent One',
			toolType: 'claude-code',
			state: 'idle',
			contextUsage: 0,
			...overrides,
		}) as S1_Session;
	describe('buildOverviewSummary', () => {
		it('states volume, fleet size, and active days', () => {
			const data = buildData({
				totalQueries: 2100,
				byDay: [
					{ date: '2026-09-01', count: 100, duration: 0 },
					{ date: '2026-09-02', count: 2000, duration: 0 },
				],
			});
			const sessions = [
				buildSession({ id: 's1' }),
				buildSession({ id: 's2' }),
				buildSession({ id: 's3', toolType: 'terminal' }),
			];
			expect(buildOverviewSummary(data, sessions)).toBe('2.1K queries · 2 agents · 2 active days');
		});
		it('drops the agent count when no sessions are supplied', () => {
			const data = buildData({
				totalQueries: 5,
				byDay: [{ date: '2026-09-01', count: 5, duration: 0 }],
			});
			expect(buildOverviewSummary(data)).toBe('5 queries · 1 active day');
		});
		it('says nothing for an empty range', () => {
			expect(buildOverviewSummary(buildData())).toBeNull();
		});
	});
	describe('buildAgentOverviewSummary', () => {
		it('reports fleet size, provider spread, and range activity', () => {
			const sessions = [
				buildSession({ id: 's1' }),
				buildSession({ id: 's2', toolType: 'codex' }),
				buildSession({ id: 's3', toolType: 'terminal' }),
			];
			const data = buildData({
				bySessionByDay: { s1: [{ date: '2026-09-01', count: 4, duration: 0 }] },
			});
			expect(buildAgentOverviewSummary(sessions, data)).toBe('2 agents · 2 providers · 1 active');
		});
		it('adds the worktree count only when worktrees exist', () => {
			const sessions = [
				buildSession({ id: 's1' }),
				buildSession({ id: 's2', parentSessionId: 's1' }),
			];
			expect(buildAgentOverviewSummary(sessions, buildData())).toBe(
				'2 agents · 1 provider · 0 active · 1 worktree'
			);
		});
	});
	describe('buildAgentsSummary', () => {
		it('shows a bare total when nothing is filtered', () => {
			// "84 of 84" would send the user hunting for a filter they never set.
			expect(buildAgentsSummary(84, 84)).toBe('84 agents');
		});
		it('shows the fraction when filters are narrowing the grid', () => {
			expect(buildAgentsSummary(24, 84)).toBe('24 of 84 agents');
		});
		it('reports an empty result against the real total', () => {
			expect(buildAgentsSummary(0, 84)).toBe('0 of 84 agents');
		});
		it('says nothing when there are no agents at all', () => {
			expect(buildAgentsSummary(0, 0)).toBeNull();
		});
	});
	describe('buildGroupsSummary', () => {
		it('pairs the group count with the unfiled remainder', () => {
			expect(buildGroupsSummary(7, 7, 23)).toBe('7 groups · 23 agents unfiled');
		});
		it('omits the remainder when every agent is filed', () => {
			expect(buildGroupsSummary(7, 7, 0)).toBe('7 groups');
		});
		it('shows the fraction while the group filter is narrowing', () => {
			expect(buildGroupsSummary(3, 7, 1)).toBe('3 of 7 groups · 1 agent unfiled');
		});
	});
	describe('buildTokensSummary', () => {
		it('states the coverage fraction behind the cost', () => {
			// Rows written before the token columns existed report no usage, so a
			// total drawn from half the turns must say so.
			const data = buildData({
				totalQueries: 2000,
				bySessionTokens: {
					s1: {
						inputTokens: 500,
						outputTokens: 400,
						cacheReadTokens: 100,
						cacheCreationTokens: 0,
						costUsd: 12.5,
						pricedQueries: 1000,
					},
				},
			});
			expect(buildTokensSummary(data)).toBe('1.0K tokens · ~$12.50 · 1.0K of 2.0K turns priced');
		});
		it('drops the caveat when every turn is priced', () => {
			const data = buildData({
				totalQueries: 10,
				bySessionTokens: {
					s1: {
						inputTokens: 10,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						costUsd: 1,
						pricedQueries: 10,
					},
				},
			});
			expect(buildTokensSummary(data)).toBe('10 tokens · ~$1.00');
		});
		it('says nothing when no session reported usage', () => {
			expect(buildTokensSummary(buildData())).toBeNull();
		});
	});
	describe('buildActivitySummary', () => {
		it('names the peak hour and the busiest day', () => {
			const data = buildData({
				totalQueries: 214,
				byHour: [
					{ hour: 9, count: 50, duration: 0 },
					{ hour: 20, count: 164, duration: 0 },
				],
				byDay: [
					{ date: '2026-08-21', count: 50, duration: 0 },
					{ date: '2026-08-22', count: 164, duration: 0 },
				],
			});
			expect(buildActivitySummary(data)).toBe(
				'Peak hour 8 PM · busiest Aug 22 with 164 · 2 active days'
			);
		});
		it('says nothing for an empty range', () => {
			expect(buildActivitySummary(buildData())).toBeNull();
		});
	});
	describe('buildAutoRunSummary', () => {
		it('keeps the completion rate attached to the fraction it describes', () => {
			expect(buildAutoRunSummary({ runs: 48, tasksCompleted: 312, tasksAttempted: 340 })).toBe(
				'48 runs · 312 of 340 tasks done (92%)'
			);
		});
		it('reports runs alone when no run declared a task total', () => {
			expect(buildAutoRunSummary({ runs: 3, tasksCompleted: 0, tasksAttempted: 0 })).toBe('3 runs');
		});
		it('says nothing when nothing ran', () => {
			expect(buildAutoRunSummary({ runs: 0, tasksCompleted: 0, tasksAttempted: 0 })).toBeNull();
		});
	});
	describe('buildCueSummary', () => {
		it('leads with failures when there are any', () => {
			// A comfortable "94% success" buries the eight runs that broke.
			expect(buildCueSummary({ runs: 126, failures: 8, pipelines: 12 })).toBe(
				'126 runs · 12 pipelines · 8 failed'
			);
		});
		it('falls back to a success rate when nothing failed', () => {
			expect(buildCueSummary({ runs: 126, failures: 0, pipelines: 12 })).toBe(
				'126 runs · 12 pipelines · 100% success'
			);
		});
	});
	describe('buildShortcutsSummary', () => {
		it('states presses, mastery fraction, and level', () => {
			expect(
				buildShortcutsSummary({ presses: 1200, used: 47, bound: 180, levelName: 'Virtuoso' })
			).toBe('1.2K presses · 47 of 180 shortcuts used · Virtuoso');
		});
		it('omits the press count when nothing was pressed in range', () => {
			expect(buildShortcutsSummary({ presses: 0, used: 5, bound: 180 })).toBe(
				'5 of 180 shortcuts used'
			);
		});
	});
	describe('buildQuotaSummary', () => {
		it('surfaces the tightest window across accounts', () => {
			expect(
				buildQuotaSummary({ accounts: 3, needsLogin: 0, peakPercent: 87.4, sampledAtMs: null })
			).toBe('3 accounts · peak window 87%');
		});
		it('calls out accounts that are locked out', () => {
			expect(
				buildQuotaSummary({ accounts: 3, needsLogin: 1, peakPercent: null, sampledAtMs: null })
			).toBe('3 accounts · 1 needs login');
		});
		it('says nothing when no account feeds the panel', () => {
			expect(
				buildQuotaSummary({ accounts: 0, needsLogin: 0, peakPercent: 50, sampledAtMs: null })
			).toBeNull();
		});
	});
	describe('buildModalOwnedFooterSummary', () => {
		const data = buildData({
			totalQueries: 10,
			byDay: [{ date: '2026-09-01', count: 10, duration: 0 }],
		});
		it('describes the tabs the modal has data for', () => {
			expect(buildModalOwnedFooterSummary('overview', { data, sessions: [] })).toBe(
				'10 queries · 0 agents · 1 active day'
			);
		});
		it('defers to the panel for panel-owned tabs', () => {
			// These tabs fetch their own data, so the modal must not guess at them.
			for (const tab of ['agents', 'groups', 'autorun', 'cue', 'shortcuts'] as const) {
				expect(buildModalOwnedFooterSummary(tab, { data, sessions: [] })).toBeNull();
			}
		});
		it('says nothing before stats have loaded', () => {
			expect(buildModalOwnedFooterSummary('overview', { data: null, sessions: [] })).toBeNull();
		});
	});
});
// Source: src/__tests__/renderer/components/UsageDashboard/AgentOverviewUtils.test.ts
describe('', () => {
	const theme = S2_THEMES.dracula;
	function makeSession(overrides: Partial<S2_Session>): S2_Session {
		return {
			id: 's1',
			name: 'Agent',
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
			...overrides,
		} as S2_Session;
	}
	const data: S2_StatsAggregation = {
		totalQueries: 12,
		totalDuration: 1200,
		avgDuration: 100,
		byAgent: {
			codex: { count: 10, duration: 1000 },
			'claude-code': { count: 2, duration: 200 },
		},
		bySource: { user: 8, auto: 4 },
		byLocation: { local: 12, remote: 0 },
		byDay: [],
		byHour: [],
		totalSessions: 2,
		sessionsByAgent: { codex: 1, 'claude-code': 1 },
		sessionsByDay: [],
		avgSessionDuration: 600,
		byAgentByDay: {},
		bySessionByDay: {
			codexSession: [
				{ date: '2026-01-01', count: 2, duration: 100 },
				{ date: '2026-01-02', count: 3, duration: 200 },
			],
		},
		bySessionSource: {
			codexSession: { user: 1, auto: 3 },
			emptySession: { user: 0, auto: 0 },
		},
		bySessionLastQuery: {
			codexSession: 1700000000000,
			claude: 1700000500000,
		},
		worktreeQueries: 0,
		parentQueries: 12,
		byWorktreeStatus: {
			worktree: { count: 0, duration: 0 },
			parent: { count: 12, duration: 1200 },
		},
		imageAnnotations: 0,
	};
	describe('agentOverviewUtils', () => {
		it('maps status colors and pads session sparklines', () => {
			expect(getStatusColor('idle', theme)).toBe(theme.colors.success);
			expect(getStatusColor('busy', theme)).toBe(theme.colors.warning);
			expect(getStatusColor('error', theme)).toBe(theme.colors.error);
			expect(getStatusColor('connecting', theme)).toBe(theme.colors.textDim);
			expect(buildSessionSparkline(undefined)).toEqual([0, 0, 0, 0, 0, 0, 0]);
			expect(
				buildSessionSparkline([
					{ date: '2026-01-01', count: 2, duration: 100 },
					{ date: '2026-01-02', count: 3, duration: 100 },
				])
			).toEqual([0, 0, 0, 0, 0, 2, 3]);
		});
		it('resolves per-session counts and provider fallback safely', () => {
			const codex = makeSession({ id: 'codexSession', toolType: 'codex' });
			const codexPeer = makeSession({ id: 'peer', toolType: 'codex' });
			const claude = makeSession({ id: 'claude', toolType: 'claude-code' });
			expect(getSessionQueryCount(codex, data, [codex, codexPeer])).toBe(5);
			expect(getSessionQueryCount(codexPeer, data, [codex, codexPeer])).toBe(0);
			expect(getSessionQueryCount(claude, data, [claude])).toBe(2);
		});
		it('computes auto percent and filter highlighting', () => {
			const parent = makeSession({ id: 'codexSession', toolType: 'codex' });
			const worktree = makeSession({
				id: 'worktree',
				toolType: 'codex',
				parentSessionId: 'codexSession',
			});
			const empty = makeSession({ id: 'emptySession', toolType: 'codex' });
			expect(getSessionAutoPercent(parent, data)).toBe(75);
			expect(getSessionAutoPercent(empty, data)).toBeNull();
			expect(isSessionHighlighted(parent, 'codex')).toBe(true);
			expect(isSessionHighlighted(parent, 'codex__worktree')).toBe(false);
			expect(isSessionHighlighted(worktree, 'codex__worktree')).toBe(true);
			expect(isSessionHighlighted(worktree, 'worktree')).toBe(true);
		});
		it('reads the last-query timestamp, and reports null when the agent has none', () => {
			const codex = makeSession({ id: 'codexSession' });
			const quiet = makeSession({ id: 'emptySession' });
			expect(getSessionLastQueryAt(codex, data)).toBe(1700000000000);
			expect(getSessionLastQueryAt(quiet, data)).toBeNull();
		});
		it('sorts visible agents by name, created date, query count, tabs, and auto percent', () => {
			const alpha = makeSession({
				id: 'codexSession',
				name: 'Alpha',
				toolType: 'codex',
				createdAt: 100,
				aiTabs: [{ id: 'a' }] as any,
			});
			const beta = makeSession({
				id: 'claude',
				name: 'Beta',
				toolType: 'claude-code',
				createdAt: 200,
				aiTabs: [{ id: 'a' }, { id: 'b' }] as any,
			});
			const terminal = makeSession({ id: 'terminal', name: 'Terminal', toolType: 'terminal' });
			const sessions = [terminal, beta, alpha];
			expect(
				sortAgentOverviewSessions(sessions, data, 'name').map((session) => session.name)
			).toEqual(['Alpha', 'Beta']);
			expect(sortAgentOverviewSessions(sessions, data, 'created')[0].name).toBe('Beta');
			expect(sortAgentOverviewSessions(sessions, data, 'queries')[0].name).toBe('Alpha');
			expect(sortAgentOverviewSessions(sessions, data, 'tabs')[0].name).toBe('Beta');
			expect(sortAgentOverviewSessions(sessions, data, 'auto')[0].name).toBe('Alpha');
		});
		// A hidden consult tab has no chip, so ranking by it would order the grid on a
		// tab count each agent's own strip contradicts.
		it('ranks by tabs the strip draws, ignoring hidden consult tabs', () => {
			const alpha = makeSession({
				id: 'codexSession',
				name: 'Alpha',
				toolType: 'codex',
				aiTabs: [{ id: 'a' }, { id: 'b' }] as any,
			});
			const beta = makeSession({
				id: 'claude',
				name: 'Beta',
				toolType: 'claude-code',
				aiTabs: [
					{ id: 'a' },
					{ id: 'consult-1', hidden: true },
					{ id: 'consult-2', hidden: true },
				] as any,
			});
			expect(
				sortAgentOverviewSessions([beta, alpha], data, 'tabs').map((session) => session.name)
			).toEqual(['Alpha', 'Beta']);
		});
		it('sorts by most recently queried and sinks agents with no queries in range', () => {
			// Alpha was created later and has more queries, but Beta queried last.
			const alpha = makeSession({
				id: 'codexSession',
				name: 'Alpha',
				toolType: 'codex',
				createdAt: 300,
			});
			const beta = makeSession({
				id: 'claude',
				name: 'Beta',
				toolType: 'claude-code',
				createdAt: 200,
			});
			const quiet = makeSession({
				id: 'emptySession',
				name: 'Aardvark',
				toolType: 'codex',
				createdAt: 100,
			});
			expect(
				sortAgentOverviewSessions([quiet, alpha, beta], data, 'recent').map(
					(session) => session.name
				)
			).toEqual(['Beta', 'Alpha', 'Aardvark']);
		});
	});
});
// Source: src/__tests__/renderer/components/UsageDashboard/chartUtils.test.ts
describe('', () => {
	let idCounter = 0;
	function makeSession(overrides: Partial<S3_Session> = {}): S3_Session {
		idCounter++;
		return {
			id: `s${idCounter}`,
			name: `Session ${idCounter}`,
			toolType: 'claude-code',
			state: 'idle',
			cwd: '/tmp',
			fullPath: '/tmp',
			projectRoot: '/tmp',
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
			...overrides,
		} as S3_Session;
	}
	describe('chartUtils', () => {
		describe('isWorktreeAgent', () => {
			it('returns true when parentSessionId is set', () => {
				const session = makeSession({ parentSessionId: 'parent-id' });
				expect(isWorktreeAgent(session)).toBe(true);
			});
			it('returns false when parentSessionId is undefined', () => {
				const session = makeSession();
				expect(isWorktreeAgent(session)).toBe(false);
			});
			it('returns false when parentSessionId is an empty string', () => {
				const session = makeSession({ parentSessionId: '' });
				expect(isWorktreeAgent(session)).toBe(false);
			});
		});
		describe('isParentAgent', () => {
			it('returns true when worktreeConfig is set', () => {
				const session = makeSession({
					worktreeConfig: { basePath: '/tmp/wt', watchEnabled: true },
				});
				expect(isParentAgent(session)).toBe(true);
			});
			it('returns false when worktreeConfig is undefined', () => {
				const session = makeSession();
				expect(isParentAgent(session)).toBe(false);
			});
			it('does not flag worktree children as parents', () => {
				const session = makeSession({ parentSessionId: 'p1' });
				expect(isParentAgent(session)).toBe(false);
			});
		});
		describe('findSessionByStatId', () => {
			it('returns the session whose id is a prefix of the stat id', () => {
				const a = makeSession({ id: 'sess-aaa' });
				const b = makeSession({ id: 'sess-bbb' });
				expect(findSessionByStatId('sess-bbb-ai-tab1', [a, b])).toBe(b);
			});
			it('matches when stat id equals session id exactly', () => {
				const a = makeSession({ id: 'exact-match' });
				expect(findSessionByStatId('exact-match', [a])).toBe(a);
			});
			it('returns undefined when no session matches', () => {
				const a = makeSession({ id: 'sess-aaa' });
				expect(findSessionByStatId('unrelated-id', [a])).toBeUndefined();
			});
			it('returns undefined for an empty or missing sessions list', () => {
				expect(findSessionByStatId('any-id', undefined)).toBeUndefined();
				expect(findSessionByStatId('any-id', [])).toBeUndefined();
			});
			it('does not mis-match when one session id is a prefix of another (delimited)', () => {
				const sess1 = makeSession({ id: 'sess-1' });
				const sess10 = makeSession({ id: 'sess-10' });
				// Stats key for the longer id should resolve to the longer session
				// regardless of array order.
				expect(findSessionByStatId('sess-10-ai-tab1', [sess1, sess10])).toBe(sess10);
				expect(findSessionByStatId('sess-10-ai-tab1', [sess10, sess1])).toBe(sess10);
				// And for the shorter id with a suffix, the shorter one wins.
				expect(findSessionByStatId('sess-1-ai-tab1', [sess1, sess10])).toBe(sess1);
			});
			it('prefers exact match even when a longer id starts with the same string', () => {
				const sess1 = makeSession({ id: 'sess-1' });
				const sess10 = makeSession({ id: 'sess-10' });
				expect(findSessionByStatId('sess-1', [sess1, sess10])).toBe(sess1);
				expect(findSessionByStatId('sess-10', [sess1, sess10])).toBe(sess10);
			});
		});
		describe('prettifyAgentType', () => {
			it('returns the canonical display name for known agent ids', () => {
				expect(prettifyAgentType('claude-code')).toBe('Claude Code');
				expect(prettifyAgentType('factory-droid')).toBe('Factory Droid');
				expect(prettifyAgentType('opencode')).toBe('OpenCode');
			});
			it('falls back to splitting on hyphens and capitalizing each word', () => {
				expect(prettifyAgentType('my-custom-agent')).toBe('My Custom Agent');
				expect(prettifyAgentType('single')).toBe('Single');
			});
			it('handles empty strings without crashing', () => {
				expect(prettifyAgentType('')).toBe('');
			});
		});
		describe('resolveAgentDisplayName', () => {
			it('matches by session id (with stat suffix) and returns the user name', () => {
				const session = makeSession({ id: 'sess-aaa', name: 'Backend API' });
				expect(resolveAgentDisplayName('sess-aaa-ai-tab1', [session])).toEqual({
					name: 'Backend API',
					isWorktree: false,
				});
			});
			it('flags worktree children via isWorktree', () => {
				const session = makeSession({
					id: 'sess-aaa',
					name: 'Frontend WT',
					parentSessionId: 'parent-id',
				});
				expect(resolveAgentDisplayName('sess-aaa', [session])).toEqual({
					name: 'Frontend WT',
					isWorktree: true,
				});
			});
			it('returns the single matching session name when key is a toolType', () => {
				const session = makeSession({ id: 'sess-bbb', name: 'My Project', toolType: 'codex' });
				expect(resolveAgentDisplayName('codex', [session])).toEqual({
					name: 'My Project',
					isWorktree: false,
				});
			});
			it('returns the prettified type when multiple sessions share the toolType', () => {
				const a = makeSession({ id: 'sess-aaa', name: 'A', toolType: 'claude-code' });
				const b = makeSession({ id: 'sess-bbb', name: 'B', toolType: 'claude-code' });
				expect(resolveAgentDisplayName('claude-code', [a, b])).toEqual({
					name: 'Claude Code',
					isWorktree: false,
				});
			});
			it('falls back to prettifying the key when no session matches', () => {
				expect(resolveAgentDisplayName('claude-code', [])).toEqual({
					name: 'Claude Code',
					isWorktree: false,
				});
				expect(resolveAgentDisplayName('my-custom-thing', undefined)).toEqual({
					name: 'My Custom Thing',
					isWorktree: false,
				});
			});
			it('uses the prettified toolType when a matched session has no name', () => {
				const session = makeSession({ id: 'sess-aaa', name: '', toolType: 'claude-code' });
				expect(resolveAgentDisplayName('sess-aaa', [session])).toEqual({
					name: 'Claude Code',
					isWorktree: false,
				});
			});
		});
		describe('buildNameMap', () => {
			it('resolves each key to its display name and worktree flag', () => {
				const a = makeSession({ id: 'sess-aaa', name: 'Backend' });
				const b = makeSession({ id: 'sess-bbb', name: 'Frontend', parentSessionId: 'p1' });
				const map = buildNameMap(['sess-aaa', 'sess-bbb', 'claude-code'], [a, b]);
				expect(map.get('sess-aaa')).toEqual({ name: 'Backend', isWorktree: false });
				expect(map.get('sess-bbb')).toEqual({ name: 'Frontend', isWorktree: true });
				expect(map.get('claude-code')).toEqual({ name: 'Claude Code', isWorktree: false });
			});
			it('disambiguates collisions with " (2)", " (3)" suffixes in input order', () => {
				const a = makeSession({ id: 'sess-aaa', name: 'API' });
				const b = makeSession({ id: 'sess-bbb', name: 'API' });
				const c = makeSession({ id: 'sess-ccc', name: 'API' });
				const map = buildNameMap(['sess-aaa', 'sess-bbb', 'sess-ccc'], [a, b, c]);
				expect(map.get('sess-aaa')?.name).toBe('API');
				expect(map.get('sess-bbb')?.name).toBe('API (2)');
				expect(map.get('sess-ccc')?.name).toBe('API (3)');
			});
			it('disambiguates collisions across resolution sources (session vs prettified type)', () => {
				const a = makeSession({ id: 'sess-aaa', name: 'Claude Code' });
				const map = buildNameMap(['sess-aaa', 'claude-code'], [a]);
				expect(map.get('sess-aaa')?.name).toBe('Claude Code');
				expect(map.get('claude-code')?.name).toBe('Claude Code (2)');
			});
			it('handles empty input lists', () => {
				expect(buildNameMap([], [])).toEqual(new Map());
			});
			it('returns one entry per key even if keys repeat', () => {
				const a = makeSession({ id: 'sess-aaa', name: 'Backend' });
				const map = buildNameMap(['sess-aaa', 'sess-aaa'], [a]);
				expect(map.size).toBe(1);
				expect(map.get('sess-aaa')?.name).toBe('Backend');
			});
		});
	});
	describe('computeAxisLabelIndices', () => {
		/** Smallest distance between any two chosen labels. */
		function minGap(indices: Set<number>): number {
			const sorted = [...indices].sort((a, b) => a - b);
			if (sorted.length < 2) return Infinity;
			let min = Infinity;
			for (let i = 1; i < sorted.length; i++) min = Math.min(min, sorted[i] - sorted[i - 1]);
			return min;
		}
		/** The density heuristic the charts use: aim for ~7 labels. */
		function interval(count: number): number {
			return count > 14 ? Math.ceil(count / 7) : count > 7 ? 2 : 1;
		}
		it('returns nothing for an empty axis', () => {
			expect(computeAxisLabelIndices(0).size).toBe(0);
		});
		it('labels every tick when the axis is short', () => {
			expect([...computeAxisLabelIndices(5)]).toEqual([0, 1, 2, 3, 4]);
		});
		it('always labels the first and last tick', () => {
			for (const count of [1, 8, 20, 31, 44, 90]) {
				const indices = computeAxisLabelIndices(count);
				expect(indices.has(0)).toBe(true);
				expect(indices.has(count - 1)).toBe(true);
			}
		});
		it('never spaces labels tighter than the interval, so they cannot overlap', () => {
			// Counts like 20/32/44 are the regression: forcing the final label used to
			// place it 1 slot after the previous one, printing the two on top of
			// each other at the right edge of the chart.
			for (let count = 2; count <= 120; count++) {
				expect(minGap(computeAxisLabelIndices(count))).toBeGreaterThanOrEqual(interval(count));
			}
		});
		it('drops the penultimate label rather than colliding with the forced last one', () => {
			// 32 ticks, interval 5: naive picks ...25, 30, then forces 31.
			const indices = computeAxisLabelIndices(32);
			expect(indices.has(31)).toBe(true);
			expect(indices.has(30)).toBe(false);
			expect(indices.has(25)).toBe(true);
		});
		it('keeps the natural last label when it already lands on the interval', () => {
			// 31 ticks, interval 5: 30 is both on-interval and last - nothing dropped.
			const indices = computeAxisLabelIndices(31);
			expect([...indices]).toEqual([0, 5, 10, 15, 20, 25, 30]);
		});
		// Seven "Aug 20"-sized labels need about 300px, and a phone gives a chart
		// roughly 340px, so a narrow caller says so rather than printing them on
		// top of each other.
		it('thins the labels when the caller declares a smaller budget', () => {
			const wide = computeAxisLabelIndices(31);
			const narrow = computeAxisLabelIndices(31, PHONE_AXIS_LABELS);
			expect(narrow.size).toBeLessThan(wide.size);
			expect(narrow.size).toBeLessThanOrEqual(PHONE_AXIS_LABELS + 1);
			expect(minGap(narrow)).toBeGreaterThan(minGap(wide));
		});
		it('still labels both ends under a smaller budget', () => {
			for (const count of [1, 8, 20, 31, 90]) {
				const indices = computeAxisLabelIndices(count, PHONE_AXIS_LABELS);
				expect(indices.has(0)).toBe(true);
				expect(indices.has(count - 1)).toBe(true);
			}
		});
		it('never goes below two labels, however small the budget', () => {
			// A budget of 0 or 1 would otherwise divide the axis by zero labels.
			expect(computeAxisLabelIndices(20, 0).size).toBeGreaterThanOrEqual(2);
			expect(computeAxisLabelIndices(20, 1).size).toBeGreaterThanOrEqual(2);
		});
		it('is unchanged at the default budget', () => {
			expect([...computeAxisLabelIndices(31, 7)]).toEqual([...computeAxisLabelIndices(31)]);
		});
	});
	describe('chunkIntoEqualGroups', () => {
		it('keeps one item per group when the series fits', () => {
			expect(chunkIntoEqualGroups([1, 2, 3], 5)).toEqual([[1], [2], [3]]);
		});
		it('groups into equal runs with a shorter final run', () => {
			expect(chunkIntoEqualGroups([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
		});
		it('never returns more groups than asked for', () => {
			const items = Array.from({ length: 365 }, (_, i) => i);
			const groups = chunkIntoEqualGroups(items, 120);
			expect(groups.length).toBeLessThanOrEqual(120);
			expect(groups.flat()).toEqual(items);
		});
		it('treats a non-positive limit as one group', () => {
			expect(chunkIntoEqualGroups([1, 2], 0)).toEqual([[1, 2]]);
		});
	});
	describe('DONUT_CHART geometry', () => {
		it('leaves the hovered slice inside the svg box', () => {
			expect(DONUT_CHART.outerRadius + DONUT_CHART.hoverExpansion).toBeLessThanOrEqual(
				DONUT_CHART.size / 2
			);
		});
		it('keeps the center label narrower than the hole so it cannot reach the ring', () => {
			expect(DONUT_CHART.centerLabelWidth).toBeLessThan(DONUT_CHART.innerRadius * 2);
		});
		it('keeps a visible ring between the hole and the outer edge', () => {
			expect(DONUT_CHART.outerRadius).toBeGreaterThan(DONUT_CHART.innerRadius);
		});
	});
	describe('describeDonutArc', () => {
		it('draws a single arc pair for a partial sweep', () => {
			const d = describeDonutArc(100, 100, 88, 62, 0, 90);
			expect(d.match(/M /g)).toHaveLength(1);
			expect(d).toContain('Z');
		});
		it('sets the large-arc flag only past a half turn', () => {
			expect(describeDonutArc(100, 100, 88, 62, 0, 90)).toMatch(/A 88 88 0 0 1/);
			expect(describeDonutArc(100, 100, 88, 62, 0, 270)).toMatch(/A 88 88 0 1 1/);
		});
		it('splits a full circle into two sub-paths so it renders at all', () => {
			const d = describeDonutArc(100, 100, 88, 62, 0, 360);
			expect(d.match(/M /g)).toHaveLength(2);
		});
	});
	describe('bar chart grid', () => {
		it('sizes the name column to its widest label, capped so the bars keep room', () => {
			expect(BAR_CHART_GRID_STYLE.gridTemplateColumns).toBe('fit-content(50%) minmax(0, 1fr) auto');
		});
		it('rows join the parent columns through subgrid', () => {
			expect(BAR_CHART_ROW_STYLE).toMatchObject({
				display: 'grid',
				gridTemplateColumns: 'subgrid',
				gridColumn: '1 / -1',
			});
		});
	});
	describe('getSeriesColor', () => {
		it('gives the first series the theme accent and cycles a fixed palette after it', () => {
			expect(getSeriesColor(0, mockTheme)).toBe(mockTheme.colors.accent);
			expect(getSeriesColor(1, mockTheme)).toBe('#10b981');
			expect(getSeriesColor(9, mockTheme)).toBe('#10b981');
		});
		it('uses the colorblind palette when asked', () => {
			expect(getSeriesColor(2, mockTheme, true)).toBe(S3_COLORBLIND_AGENT_PALETTE[2]);
		});
	});
});
// Source: src/__tests__/renderer/components/UsageDashboard/AutoRunUtils.test.ts
describe('', () => {
	const emptyCell = String.fromCharCode(8212);
	function makeSession(overrides: Partial<AutoRunSession>): AutoRunSession {
		return {
			id: 'session',
			sessionId: 'maestro-session',
			agentType: 'claude-code',
			documentPath: '/repo/TASKS.md',
			projectPath: '/repo',
			startTime: new Date(2026, 0, 2, 10).getTime(),
			duration: 60000,
			tasksTotal: 1,
			tasksCompleted: 1,
			...overrides,
		} as AutoRunSession;
	}
	function makeTask(startHour: number, success: boolean): AutoRunTask {
		return {
			id: `task-${startHour}-${success}`,
			autoRunSessionId: 'session',
			sessionId: 'maestro-session',
			agentType: 'claude-code',
			taskIndex: 0,
			taskContent: 'Task',
			startTime: new Date(2026, 0, 2, startHour, 15).getTime(),
			duration: 1000,
			success,
		} as AutoRunTask;
	}
	describe('autoRunStatsUtils', () => {
		it('computes session metrics from completed and attempted task counts', () => {
			const metrics = computeAutoRunMetrics([
				makeSession({ duration: 60000, tasksTotal: 4, tasksCompleted: 3 }),
				makeSession({ duration: 120000, tasksTotal: 2, tasksCompleted: 1 }),
			]);
			expect(metrics).toEqual({
				totalSessions: 2,
				totalTasksCompleted: 4,
				totalTasksAttempted: 6,
				avgTasksPerSession: '2.0',
				successRate: 67,
				avgSessionDuration: 90000,
				avgTaskDuration: 45000,
				totalDuration: 180000,
				goalDrivenDuration: 0,
				specDrivenDuration: 180000,
			});
		});
		it('splits Auto Run time by kind, counting unlabeled runs as spec-driven', () => {
			const metrics = computeAutoRunMetrics([
				makeSession({ duration: 60000, kind: 'goal-driven' }),
				makeSession({ duration: 30000, kind: 'spec-driven' }),
				// Pre-migration row: no kind at all.
				makeSession({ duration: 20000 }),
				// Unknown value from a newer build.
				makeSession({ duration: 5000, kind: 'loop-driven' as never }),
				// A goal-looking path is still spec-driven unless the kind says otherwise.
				makeSession({ duration: 1000, documentPath: `${GOAL_RUN_DOCUMENT_PREFIX}ship it` }),
			]);
			expect(metrics.goalDrivenDuration).toBe(60000);
			expect(metrics.specDrivenDuration).toBe(56000);
			expect(metrics.totalDuration).toBe(116000);
			expect(metrics.totalDuration).toBe(metrics.goalDrivenDuration + metrics.specDrivenDuration);
		});
		it('groups sessions by local date and keeps completion-only days', () => {
			const grouped = groupSessionsByDate([
				makeSession({
					startTime: new Date(2026, 0, 2, 9).getTime(),
					tasksTotal: 0,
					tasksCompleted: 2,
				}),
				makeSession({
					startTime: new Date(2026, 0, 2, 12).getTime(),
					tasksTotal: 3,
					tasksCompleted: 1,
				}),
				makeSession({
					startTime: new Date(2026, 0, 3, 8).getTime(),
					tasksTotal: 0,
					tasksCompleted: 0,
				}),
			]);
			expect(grouped).toEqual([{ date: '2026-01-02', count: 3, successCount: 3 }]);
			expect(getAutoRunChartMax(grouped)).toBe(3);
			expect(formatDateLabel('2026-01-02')).toBe('Jan 2');
			expect(formatFullDate('2026-01-02')).toContain('Jan 2, 2026');
		});
	});
	describe('autoRunTableUtils', () => {
		it('formats table aliases and path fallbacks without changing display behavior', () => {
			expect(formatAgentName('claude-code')).toBe('Claude Code');
			expect(formatAgentName('unknown-agent')).toBe('unknown-agent');
			expect(extractFileName('/repo/docs/TASKS.md')).toBe('TASKS.md');
			expect(extractProjectName('/Users/me/repo')).toBe('repo');
			expect(extractFileName()).toBe(emptyCell);
			expect(extractProjectName()).toBe(emptyCell);
			expect(formatAutoRunDate(new Date(2026, 0, 2, 10).getTime())).toBe('Jan 2, 2026');
		});
		it('sorts longest sessions and formats document and goal task labels', () => {
			const sessions = [
				makeSession({ id: 'short', duration: 1000, tasksTotal: undefined }),
				makeSession({ id: 'long', duration: 5000, tasksTotal: 5, tasksCompleted: 4 }),
				makeSession({
					id: 'goal',
					duration: 3000,
					documentPath: `${GOAL_RUN_DOCUMENT_PREFIX}Ship dashboard`,
					tasksCompleted: 75,
					tasksTotal: 100,
				}),
			];
			expect(getTopAutoRunSessions(sessions, 2).map((session) => session.id)).toEqual([
				'long',
				'goal',
			]);
			expect(formatAutoRunTasksLabel(sessions[0])).toBe(emptyCell);
			expect(formatAutoRunTasksLabel(sessions[1])).toBe('4 / 5');
			expect(formatAutoRunTasksLabel(sessions[2])).toBe('75%');
		});
	});
	describe('tasksByHourUtils', () => {
		it('builds hourly buckets, peak hours, and labels', () => {
			const hourlyData = buildHourlyTaskData([
				makeTask(9, true),
				makeTask(9, false),
				makeTask(14, true),
			]);
			expect(hourlyData).toHaveLength(24);
			expect(hourlyData[9]).toEqual({ hour: 9, count: 2, successCount: 1 });
			expect(hourlyData[14]).toEqual({ hour: 14, count: 1, successCount: 1 });
			expect(getMaxHourlyTaskCount(hourlyData)).toBe(2);
			expect(getPeakHours(hourlyData, 2)).toEqual([9, 14]);
			expect(formatHourShort(0)).toBe('12a');
			expect(formatHourShort(12)).toBe('12p');
			expect(formatHourShort(23)).toBe('11p');
			expect(formatHourFull(0)).toBe('12:00 AM');
			expect(formatHourFull(13)).toBe('1:00 PM');
		});
	});
});
// Source: src/__tests__/renderer/components/UsageDashboard/AgentComparisonUtils.test.ts
describe('', () => {
	const theme = S5_THEMES.dracula;
	function makeSession(overrides: Partial<S5_Session>): S5_Session {
		return {
			id: 's1',
			name: 'Agent',
			toolType: 'claude-code',
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
			...overrides,
		} as S5_Session;
	}
	const data: S5_StatsAggregation = {
		totalQueries: 10,
		totalDuration: 1000,
		avgDuration: 100,
		byAgent: {
			'claude-code': { count: 10, duration: 1000 },
		},
		bySource: { user: 6, auto: 4 },
		byLocation: { local: 10, remote: 0 },
		byDay: [],
		byHour: [],
		totalSessions: 2,
		sessionsByAgent: { 'claude-code': 2 },
		sessionsByDay: [],
		avgSessionDuration: 500,
		byAgentByDay: {},
		bySessionByDay: {
			parent: [{ date: '2026-01-01', count: 3, duration: 300 }],
			worktree: [{ date: '2026-01-01', count: 4, duration: 400 }],
		},
		bySessionSource: {},
		worktreeQueries: 4,
		parentQueries: 6,
		byWorktreeStatus: {
			worktree: { count: 4, duration: 400 },
			parent: { count: 6, duration: 600 },
		},
		imageAnnotations: 0,
	};
	describe('agentComparisonUtils', () => {
		it('assigns theme and colorblind colors', () => {
			expect(getAgentColor('claude-code', 0, theme, false)).toBe(theme.colors.accent);
			expect(getAgentColor('codex', 1, theme, false)).toBe('#10b981');
			expect(getAgentColor('codex', 2, theme, true)).toBe(
				S5_COLORBLIND_AGENT_PALETTE[2 % S5_COLORBLIND_AGENT_PALETTE.length]
			);
		});
		it('splits worktree and regular usage while reconciling historical remainder', () => {
			const parent = makeSession({ id: 'parent', name: 'Parent', toolType: 'claude-code' });
			const worktree = makeSession({
				id: 'worktree',
				name: 'Worktree',
				toolType: 'claude-code',
				parentSessionId: 'parent',
			});
			const split = buildAgentSplitAggregation(data, [parent, worktree]);
			expect(split).toEqual({
				'claude-code': {
					regular: { count: 6, duration: 600 },
					worktree: { count: 4, duration: 400 },
				},
			});
		});
		it('returns null split when there is no worktree signal', () => {
			const parent = makeSession({ id: 'parent', name: 'Parent', toolType: 'claude-code' });
			expect(buildAgentSplitAggregation(data, [parent])).toBeNull();
			expect(buildAgentSplitAggregation(data, [])).toBeNull();
		});
		it('builds sorted comparison rows from split and legacy aggregations', () => {
			const parent = makeSession({ id: 'parent', name: 'Parent', toolType: 'claude-code' });
			const worktree = makeSession({
				id: 'worktree',
				name: 'Worktree',
				toolType: 'claude-code',
				parentSessionId: 'parent',
			});
			const splitAggregation = buildAgentSplitAggregation(data, [parent, worktree]);
			const splitRows = buildAgentComparisonData({
				data,
				splitAggregation,
				theme,
				colorBlindMode: false,
				sessions: [parent, worktree],
			});
			expect(splitRows.map((row) => row.key)).toEqual(['claude-code', 'claude-code__worktree']);
			expect(splitRows[0]).toMatchObject({
				label: 'Claude Code',
				count: 6,
				duration: 600,
				isWorktree: false,
			});
			expect(splitRows[1]).toMatchObject({
				label: 'Claude Code (Worktree)',
				count: 4,
				duration: 400,
				isWorktree: true,
			});
			const legacyRows = buildAgentComparisonData({
				data,
				splitAggregation: null,
				theme,
				colorBlindMode: false,
				sessions: [parent],
			});
			expect(legacyRows).toHaveLength(1);
			expect(legacyRows[0].durationPercentage).toBe(100);
		});
	});
});
// Source: src/__tests__/renderer/components/UsageDashboard/delegationTrendUtils.test.ts
describe('', () => {
	function day(
		date: string,
		interactiveMs: number,
		autoRunMs: number,
		cueMs = 0,
		counts: [number, number, number] = [1, 1, 1]
	): DelegationDay {
		return {
			date,
			interactive: { count: interactiveMs > 0 ? counts[0] : 0, durationMs: interactiveMs },
			autoRun: { count: autoRunMs > 0 ? counts[1] : 0, durationMs: autoRunMs },
			cue: { count: cueMs > 0 ? counts[2] : 0, durationMs: cueMs },
		};
	}
	describe('buildDelegationSeries', () => {
		it('returns nothing for an empty series', () => {
			expect(buildDelegationSeries([])).toEqual([]);
		});
		it('fills the calendar gap between sparse days with zero buckets', () => {
			const series = buildDelegationSeries([day('2026-01-01', 100, 0), day('2026-01-05', 0, 500)]);
			expect(series.map((b) => b.date)).toEqual([
				'2026-01-01',
				'2026-01-02',
				'2026-01-03',
				'2026-01-04',
				'2026-01-05',
			]);
			expect(series[1].interactive.durationMs).toBe(0);
			expect(series[4].autoRun.durationMs).toBe(500);
		});
		it('sorts an out-of-order series before densifying', () => {
			const series = buildDelegationSeries([day('2026-03-03', 10, 0), day('2026-03-01', 20, 0)]);
			expect(series.map((b) => b.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
		});
		it('extends through `throughDate` so a quiet tail still shows as quiet', () => {
			const series = buildDelegationSeries([day('2026-01-01', 100, 0)], {
				throughDate: '2026-01-04',
			});
			expect(series).toHaveLength(4);
			expect(series[3].date).toBe('2026-01-04');
			expect(series[3].interactive.durationMs).toBe(0);
		});
		it('groups long ranges into equal-width buckets under the cap', () => {
			const days: DelegationDay[] = [];
			const cursor = new Date(2026, 0, 1);
			for (let i = 0; i < 40; i++) {
				days.push(day(toYmd(cursor), 60, 40));
				cursor.setDate(cursor.getDate() + 1);
			}
			const series = buildDelegationSeries(days, { maxBars: 10 });
			expect(series.length).toBeLessThanOrEqual(10);
			// Nothing is dropped by grouping: the totals still add up.
			const totalInteractive = series.reduce((sum, b) => sum + b.interactive.durationMs, 0);
			expect(totalInteractive).toBe(40 * 60);
			expect(series[0].days).toBe(4);
			expect(series[0].endDate).toBe('2026-01-04');
		});
	});
	describe('bucket metric helpers', () => {
		const [bucket] = buildDelegationSeries([day('2026-02-02', 300, 500, 200, [3, 2, 1])]);
		it('reads the metric the chart is currently showing', () => {
			expect(bucketInteractiveValue(bucket, 'duration')).toBe(300);
			expect(bucketInteractiveValue(bucket, 'count')).toBe(3);
			// Delegated is Auto Run + Cue in both modes.
			expect(bucketDelegatedValue(bucket, 'duration')).toBe(700);
			expect(bucketDelegatedValue(bucket, 'count')).toBe(3);
		});
		it('scores an empty bucket at zero rather than NaN', () => {
			const [empty] = buildDelegationSeries([day('2026-02-02', 0, 0)]);
			expect(bucketDelegatedPercent(empty, 'duration')).toBe(0);
		});
		it('computes the delegated share per bucket', () => {
			expect(bucketDelegatedPercent(bucket, 'duration')).toBe(70);
		});
	});
});
// Source: src/__tests__/renderer/components/UsageDashboard/quotaLastRefreshed.test.ts
describe('', () => {
	const NOW = Date.parse('2026-05-15T12:00:00.000Z');
	describe('resolveLatestSampledAt', () => {
		it('returns null when nothing has been sampled', () => {
			expect(resolveLatestSampledAt({})).toBeNull();
		});
		it('returns the newest stamp across accounts', () => {
			const latest = resolveLatestSampledAt({
				a: { sampledAt: '2026-05-15T10:00:00.000Z' },
				b: { sampledAt: '2026-05-15T11:30:00.000Z' },
				c: { sampledAt: '2026-05-15T09:00:00.000Z' },
			});
			expect(latest).toBe(Date.parse('2026-05-15T11:30:00.000Z'));
		});
		it('skips missing and unparseable stamps', () => {
			const latest = resolveLatestSampledAt({
				a: { sampledAt: 'not-a-date' },
				b: {},
				c: undefined,
				d: { sampledAt: '2026-05-15T09:00:00.000Z' },
			});
			expect(latest).toBe(Date.parse('2026-05-15T09:00:00.000Z'));
		});
	});
	describe('isSampleBehindLatest', () => {
		const at = (ms: number) => new Date(ms).toISOString();
		it('flags a sample trailing the newest by more than the lag', () => {
			expect(isSampleBehindLatest(at(NOW - STALE_ROW_LAG_MS - 60000), NOW)).toBe(true);
		});
		it('does not flag a sample within the lag, or the newest sample itself', () => {
			expect(isSampleBehindLatest(at(NOW - STALE_ROW_LAG_MS), NOW)).toBe(false);
			expect(isSampleBehindLatest(at(NOW), NOW)).toBe(false);
		});
		it('does not flag a missing stamp, an unparseable one, or an empty panel', () => {
			expect(isSampleBehindLatest(undefined, NOW)).toBe(false);
			expect(isSampleBehindLatest('not-a-date', NOW)).toBe(false);
			expect(isSampleBehindLatest(at(NOW - 60 * 60000), null)).toBe(false);
		});
	});
});
// Source: src/__tests__/renderer/components/UsageDashboard/ActivityHeatmapUtils.test.ts
describe('', () => {
	const theme = S8_THEMES.dracula;
	describe('activityHeatmapUtils', () => {
		it('selects days and layout modes by range', () => {
			expect(getDaysForRange('day')).toBe(1);
			expect(getDaysForRange('week')).toBe(7);
			expect(getDaysForRange('month')).toBe(30);
			expect(getDaysForRange('quarter')).toBe(90);
			expect(getDaysForRange('year')).toBe(365);
			expect(getDaysForRange('all')).toBe(365);
			expect(shouldUseSingleDayMode('year')).toBe(true);
			expect(shouldUseSingleDayMode('all')).toBe(true);
			expect(shouldUseSingleDayMode('month')).toBe(false);
			expect(shouldUse4HourBlockMode('month')).toBe(true);
			expect(shouldUse4HourBlockMode('quarter')).toBe(true);
			expect(shouldUse4HourBlockMode('week')).toBe(false);
			expect(TIME_BLOCK_LABELS).toEqual(['12a-4a', '4a-8a', '8a-12p', '12p-4p', '4p-8p', '8p-12a']);
		});
		it('calculates heatmap intensity thresholds', () => {
			expect(calculateIntensity(0, 100)).toBe(0);
			expect(calculateIntensity(10, 100)).toBe(1);
			expect(calculateIntensity(50, 100)).toBe(2);
			expect(calculateIntensity(75, 100)).toBe(3);
			expect(calculateIntensity(76, 100)).toBe(4);
			expect(calculateIntensity(5, 0)).toBe(0);
		});
		it('returns theme, rgb, fallback, and colorblind colors', () => {
			expect(getIntensityColor(0, theme)).toBe(theme.colors.bgActivity);
			expect(getIntensityColor(2, theme)).toBe('rgba(189, 147, 249, 0.4)');
			expect(
				getIntensityColor(3, { ...theme, colors: { ...theme.colors, accent: 'rgb(1, 2, 3)' } })
			).toBe('rgba(1, 2, 3, 0.6)');
			expect(
				getIntensityColor(1, { ...theme, colors: { ...theme.colors, accent: 'var(--accent)' } })
			).toBe('var(--accent)4d');
			expect(getIntensityColor(99, theme, true)).toBe(COLORBLIND_HEATMAP_SCALE[4]);
		});
	});
});
