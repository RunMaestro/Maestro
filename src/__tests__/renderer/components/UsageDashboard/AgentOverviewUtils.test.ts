import { describe, expect, it } from 'vitest';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';
import {
	DEFAULT_AGENT_SORT,
	buildCalendarSparkline,
	buildRangeActivity,
	getSessionAutoPercent,
	getSessionLastQueryAt,
	getSessionQueryCount,
	getStatusColor,
	sortAgentOverviewSessions,
} from '../../../../renderer/components/UsageDashboard/agentOverviewUtils';

const theme = THEMES.dracula;

function makeSession(overrides: Partial<Session>): Session {
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
	} as Session;
}

const data: StatsAggregation = {
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
	window: { startYmd: '2025-12-01', endYmd: '2026-01-02' },
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
		codexSession: 1_700_000_000_000,
		claude: 1_700_000_500_000,
	},
	worktreeQueries: 0,
	parentQueries: 12,
	imageAnnotations: 0,
} as unknown as StatsAggregation;

describe('agentOverviewUtils', () => {
	it('maps status colors', () => {
		expect(getStatusColor('idle', theme)).toBe(theme.colors.success);
		expect(getStatusColor('busy', theme)).toBe(theme.colors.warning);
		expect(getStatusColor('error', theme)).toBe(theme.colors.error);
		expect(getStatusColor('connecting', theme)).toBe(theme.colors.textDim);
	});

	describe('buildCalendarSparkline', () => {
		const window = { startYmd: '2025-12-01', endYmd: '2026-01-02' };

		it('is all zeros over 7 calendar days when the entity has no rows', () => {
			expect(buildCalendarSparkline(undefined, window, 7)).toEqual([0, 0, 0, 0, 0, 0, 0]);
		});

		it('places counts on their calendar day and zero-fills the gaps', () => {
			expect(
				buildCalendarSparkline(
					[
						{ date: '2025-12-29', count: 4 },
						{ date: '2026-01-02', count: 3 },
					],
					window,
					7
				)
			).toEqual([0, 0, 4, 0, 0, 0, 3]);
		});

		it('drops active days older than the window instead of pulling them forward', () => {
			// The old "last 7 rows" sparkline drew these two days side by side.
			expect(
				buildCalendarSparkline(
					[
						{ date: '2025-12-02', count: 9 },
						{ date: '2026-01-02', count: 3 },
					],
					window,
					7
				)
			).toEqual([0, 0, 0, 0, 0, 0, 3]);
		});

		it('clips to a range shorter than the sparkline', () => {
			const today = { startYmd: '2026-01-02', endYmd: '2026-01-02' };
			expect(buildCalendarSparkline([{ date: '2026-01-02', count: 5 }], today, 7)).toEqual([5]);
		});

		it('crosses a month boundary by calendar day', () => {
			expect(buildCalendarSparkline([], window, 14)).toHaveLength(14);
		});
	});

	it('fills the whole range for a detail chart', () => {
		const series = buildRangeActivity([{ date: '2026-01-01', count: 2 }], {
			startYmd: '2025-12-30',
			endYmd: '2026-01-02',
		});
		expect(series).toEqual([
			{ date: '2025-12-30', count: 0 },
			{ date: '2025-12-31', count: 0 },
			{ date: '2026-01-01', count: 2 },
			{ date: '2026-01-02', count: 0 },
		]);
	});

	it("counts only the agent's own rows, never its provider's total", () => {
		const codex = makeSession({ id: 'codexSession', toolType: 'codex' });
		const claude = makeSession({ id: 'claude', toolType: 'claude-code' });

		expect(getSessionQueryCount(codex, data)).toBe(5);
		// The only claude-code agent, with no rows of its own: 0, not the
		// provider's 2.
		expect(getSessionQueryCount(claude, data)).toBe(0);
	});

	it('computes auto percent', () => {
		const parent = makeSession({ id: 'codexSession', toolType: 'codex' });
		const empty = makeSession({ id: 'emptySession', toolType: 'codex' });

		expect(getSessionAutoPercent(parent, data)).toBe(75);
		expect(getSessionAutoPercent(empty, data)).toBeNull();
	});

	it('defaults the grid to the Queries sort', () => {
		expect(DEFAULT_AGENT_SORT).toBe('queries');
	});

	it('reads the last-query timestamp, and reports null when the agent has none', () => {
		const codex = makeSession({ id: 'codexSession' });
		const quiet = makeSession({ id: 'emptySession' });

		expect(getSessionLastQueryAt(codex, data)).toBe(1_700_000_000_000);
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
			sortAgentOverviewSessions([quiet, alpha, beta], data, 'recent').map((session) => session.name)
		).toEqual(['Beta', 'Alpha', 'Aardvark']);
	});
});
