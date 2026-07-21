import { describe, expect, it } from 'vitest';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';
import {
	getSessionAutoPercent,
	getSessionQueryCount,
	getStatusColor,
	isSessionHighlighted,
	sortAgentOverviewSessions,
} from '../../../../renderer/components/UsageDashboard/agentOverviewUtils';
import { buildSessionSparkline } from '../../../../renderer/components/UsageDashboard/usageDashboardUtils';

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
});
