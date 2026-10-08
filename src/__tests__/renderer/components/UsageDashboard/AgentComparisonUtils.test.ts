import { describe, expect, it } from 'vitest';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';
import {
	buildAgentComparisonData,
	buildAgentSplitAggregation,
	getAgentColor,
} from '../../../../renderer/components/UsageDashboard/agentComparisonUtils';
import { COLORBLIND_AGENT_PALETTE } from '../../../../renderer/constants/colorblindPalettes';

const theme = THEMES.dracula;

function makeSession(overrides: Partial<Session>): Session {
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
	} as Session;
}

const data: StatsAggregation = {
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
			COLORBLIND_AGENT_PALETTE[2 % COLORBLIND_AGENT_PALETTE.length]
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
