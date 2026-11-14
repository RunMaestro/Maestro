/**
 * Tests for SessionStats component
 *
 * Agent Statistics: the four cards (via the widget StatCard), provider rows
 * labeled by provider, and the range-scoped "active" footnote.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionStats } from '../../../../renderer/components/UsageDashboard/SessionStats';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

let idCounter = 0;
function makeSession(overrides: Partial<Session> = {}): Session {
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
	} as Session;
}

describe('SessionStats - cards', () => {
	it('labels the git card as agents in Git repos and counts worktree parents', () => {
		const parent = makeSession({ id: 'p1', isGitRepo: true });
		const child = makeSession({ parentSessionId: 'p1', isGitRepo: true });
		const configuredOnly = makeSession({
			isGitRepo: true,
			worktreeConfig: { basePath: '/tmp/wt', watchEnabled: true },
		});

		render(<SessionStats sessions={[parent, child, configuredOnly]} theme={theme} />);

		expect(screen.getByText('Agents in Git Repos')).toBeInTheDocument();
		// Only the agent a worktree was actually spawned from is a parent.
		expect(screen.getByText('1 with worktrees')).toBeInTheDocument();
	});

	it('no longer renders the duplicated Regular | Worktree line', () => {
		render(
			<SessionStats
				sessions={[makeSession({ id: 'p9' }), makeSession({ parentSessionId: 'p9' })]}
				theme={theme}
			/>
		);
		expect(screen.queryByTestId('worktree-breakdown')).not.toBeInTheDocument();
	});

	it('counts an agent as remote from its typed SSH fields', () => {
		const sessions = [
			makeSession({ sshRemoteId: 'remote-1' }),
			makeSession({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			}),
			makeSession(),
		];

		render(<SessionStats sessions={sessions} theme={theme} />);

		expect(screen.getByText('2 remote')).toBeInTheDocument();
	});

	it('excludes terminal sessions from every count', () => {
		render(
			<SessionStats
				sessions={[makeSession({ toolType: 'terminal' }), makeSession()]}
				theme={theme}
			/>
		);
		const cards = screen.getByTestId('session-stats-cards');
		expect(cards.textContent).toContain('Total Agents');
		expect(cards.textContent).toContain('1');
		expect(cards.textContent).not.toContain('2');
	});

	it('says "No agents registered" when there are none', () => {
		render(<SessionStats sessions={[]} theme={theme} />);
		expect(screen.getByText('No agents registered')).toBeInTheDocument();
	});
});

describe('SessionStats - provider rows', () => {
	it('labels a provider row with the provider name even when one agent uses it', () => {
		const sessions = [makeSession({ name: 'Backend API', toolType: 'claude-code' })];

		render(<SessionStats sessions={sessions} theme={theme} />);

		expect(screen.getByText('Claude Code')).toBeInTheDocument();
		expect(screen.queryByText('Backend API')).not.toBeInTheDocument();
	});

	it('uses canonical display names for known providers', () => {
		const sessions = [
			makeSession({ name: 'A', toolType: 'opencode' }),
			makeSession({ name: 'B', toolType: 'opencode' }),
			makeSession({ name: 'C', toolType: 'factory-droid' }),
		];

		render(<SessionStats sessions={sessions} theme={theme} />);

		expect(screen.getByText('OpenCode')).toBeInTheDocument();
		expect(screen.getByText('Factory Droid')).toBeInTheDocument();
		expect(screen.getByText('Agents by Provider')).toBeInTheDocument();
	});
});

describe('SessionStats - active agents in range', () => {
	const buildData = (
		bySessionByDay: Record<string, Array<{ date: string; count: number; duration: number }>>
	) =>
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
			byAgentByDay: {},
			bySessionByDay,
			bySessionSource: {},
		}) as never;

	it('reports how many agents ran a query in the range', () => {
		const active = makeSession();
		const idle = makeSession();

		render(
			<SessionStats
				sessions={[active, idle]}
				theme={theme}
				data={buildData({ [active.id]: [{ date: '2026-09-01', count: 3, duration: 500 }] })}
			/>
		);

		expect(screen.getByText('1 active in range')).toBeInTheDocument();
	});

	it('shares the footnote line with the bookmarked count', () => {
		const active = makeSession({ bookmarked: true });
		const idle = makeSession();

		render(
			<SessionStats
				sessions={[active, idle]}
				theme={theme}
				data={buildData({ [active.id]: [{ date: '2026-09-01', count: 3, duration: 500 }] })}
			/>
		);

		expect(screen.getByText('1 active in range \u00b7 1 bookmarked')).toBeInTheDocument();
	});

	it('omits the active line entirely when no stats are supplied', () => {
		render(<SessionStats sessions={[makeSession()]} theme={theme} />);

		expect(screen.queryByText(/active/)).not.toBeInTheDocument();
	});
});
