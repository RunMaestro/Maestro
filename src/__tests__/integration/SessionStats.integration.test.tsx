import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SessionStats } from '../../renderer/components/UsageDashboard/SessionStats';
import { COLORBLIND_AGENT_PALETTE } from '../../renderer/constants/colorblindPalettes';
import type { Session, ToolType } from '../../renderer/types';
import { THEMES } from '../../shared/themes';

const theme = THEMES['dracula'];

function makeSession(overrides: Partial<Session> & { id: string; toolType: ToolType }): Session {
	return {
		name: overrides.id,
		cwd: '/repo/project',
		projectRoot: '/repo/project',
		fullPath: '/repo/project',
		state: 'idle',
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		aiTabs: [],
		activeTabId: null,
		closedTabHistory: [],
		shellLogs: [],
		executionQueue: [],
		contextUsage: 0,
		workLog: [],
		isGitRepo: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		isLive: false,
		...overrides,
	} as Session;
}

describe('SessionStats', () => {
	it('shows the empty state when only terminal sessions are registered', () => {
		render(
			<SessionStats
				theme={theme}
				sessions={[makeSession({ id: 'terminal-session', toolType: 'terminal' })]}
			/>
		);

		expect(screen.getByText('Agent Statistics')).toBeInTheDocument();
		expect(screen.getByText('No agent sessions registered')).toBeInTheDocument();
		expect(screen.queryByText('Terminal')).not.toBeInTheDocument();
	});

	it('summarizes agent, repository, folder, local, remote, bookmark, and worktree counts', () => {
		const expectStatCard = (label: string, value: string, subValue?: string) => {
			const details = screen.getByText(label).parentElement!;
			expect(within(details).getByText(value)).toBeInTheDocument();
			if (subValue) {
				expect(within(details).getByText(subValue)).toBeInTheDocument();
			}
		};

		render(
			<SessionStats
				theme={theme}
				sessions={[
					makeSession({ id: 'terminal-session', toolType: 'terminal' }),
					makeSession({
						id: 'claude-local',
						toolType: 'claude-code',
						isGitRepo: true,
						bookmarked: true,
					}),
					makeSession({
						id: 'claude-remote-cwd',
						toolType: 'claude-code',
						cwd: 'ssh://prod.example.com/repo',
					}),
					makeSession({
						id: 'codex-remote-config',
						toolType: 'codex',
						isGitRepo: true,
						parentSessionId: 'claude-local',
						sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					}),
					makeSession({ id: 'factory-local', toolType: 'factory-droid' }),
				]}
			/>
		);

		expectStatCard('Total Agents', '4', '1 bookmarked');
		expectStatCard('Git Repositories', '2', '1 with worktrees');
		expectStatCard('Plain Folders', '2');
		expectStatCard('Local Agents', '2', '2 remote');

		expect(screen.getByText('Claude Code')).toBeInTheDocument();
		expect(screen.getByText('codex-remote-config')).toBeInTheDocument();
		expect(screen.getByText('factory-local')).toBeInTheDocument();
		expect(screen.queryByText('Terminal')).not.toBeInTheDocument();
	});

	it('uses colorblind-safe colors for agent type markers', () => {
		render(
			<SessionStats
				theme={theme}
				colorBlindMode
				sessions={[
					makeSession({ id: 'claude', toolType: 'claude-code' }),
					makeSession({ id: 'opencode', toolType: 'opencode' }),
				]}
			/>
		);

		const claudeMarker = screen.getByText('claude').querySelector('div');
		const openCodeMarker = screen.getByText('opencode').querySelector('div');

		expect(claudeMarker).toHaveStyle({ backgroundColor: COLORBLIND_AGENT_PALETTE[0] });
		expect(openCodeMarker).toHaveStyle({ backgroundColor: COLORBLIND_AGENT_PALETTE[1] });
	});

	it('falls back to the raw tool type for unknown agent types', () => {
		render(
			<SessionStats
				theme={theme}
				sessions={[makeSession({ id: 'custom-agent', toolType: 'custom-agent' as ToolType })]}
			/>
		);

		expect(screen.getByText('custom-agent')).toBeInTheDocument();
	});
});
