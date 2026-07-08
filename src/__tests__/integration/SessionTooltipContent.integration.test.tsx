import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SessionTooltipContent } from '../../renderer/components/SessionList/SessionTooltipContent';
import type { Session, Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#222222',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		accent: '#7c3aed',
		border: '#444444',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#6d28d9',
	},
};

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Session One',
		state: 'idle',
		toolType: 'claude-code',
		cwd: '/repo/project',
		fullPath: '/repo/project',
		projectRoot: '/repo/project',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 42,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3000,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: null,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

describe('SessionTooltipContent', () => {
	it('renders local session metadata with group, batch, cost, active time, and clamped context', () => {
		const session = makeSession({
			contextUsage: 140,
			usageStats: { totalCostUsd: 1.234 },
			activeTimeMs: 65_000,
		});

		render(<SessionTooltipContent session={session} theme={theme} groupName="Group A" isInBatch />);

		expect(screen.getByText('Group A')).toBeInTheDocument();
		expect(screen.getByText('LOCAL')).toBeInTheDocument();
		expect(screen.getByText('AUTO')).toBeInTheDocument();
		expect(screen.getByText('100%')).toBeInTheDocument();
		expect(screen.getByText('$1.23')).toBeInTheDocument();
		expect(screen.getByText('1M')).toBeInTheDocument();
		expect(screen.getByText('/repo/project')).toBeInTheDocument();
	});

	it('renders a successful non-git SSH session as remote', () => {
		const session = makeSession({
			sessionSshRemoteConfig: { id: 'remote-1', enabled: true, name: 'Remote' },
		});

		render(<SessionTooltipContent session={session} theme={theme} />);

		expect(screen.getByText('REMOTE')).toBeInTheDocument();
		expect(screen.getByText('idle • claude-code (SSH)')).toBeInTheDocument();
	});

	it('renders a failed non-git SSH session with a failed remote badge', () => {
		const session = makeSession({
			sessionSshRemoteConfig: { id: 'remote-1', enabled: true, name: 'Remote' },
			sshConnectionFailed: true,
		});

		render(<SessionTooltipContent session={session} theme={theme} />);

		expect(screen.getByTitle('SSH connection failed')).toBeInTheDocument();
		expect(screen.getByText('REMOTE')).toBeInTheDocument();
	});

	it('renders git and remote indicators for successful remote git sessions', () => {
		const session = makeSession({
			isGitRepo: true,
			sessionSshRemoteConfig: { id: 'remote-1', enabled: true, name: 'Remote' },
		});

		render(<SessionTooltipContent session={session} theme={theme} gitFileCount={3} />);

		expect(screen.getByTitle('Remote SSH')).toBeInTheDocument();
		expect(screen.getByText('GIT')).toBeInTheDocument();
		expect(screen.getByText('3 files')).toBeInTheDocument();
	});

	it('omits failed remote text inside the failure badge when git metadata is already shown', () => {
		const session = makeSession({
			isGitRepo: true,
			sessionSshRemoteConfig: { id: 'remote-1', enabled: true, name: 'Remote' },
			sshConnectionFailed: true,
		});

		render(<SessionTooltipContent session={session} theme={theme} />);

		expect(screen.getByTitle('SSH connection failed')).toBeInTheDocument();
		expect(screen.getByText('GIT')).toBeInTheDocument();
		expect(screen.queryByText('REMOTE')).not.toBeInTheDocument();
	});
});
