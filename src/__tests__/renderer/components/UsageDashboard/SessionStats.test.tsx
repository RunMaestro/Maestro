/**
 * Tests for SessionStats component
 *
 * Verifies the worktree vs regular session breakdown introduced in
 * Doc 1 of the Dashboard Enhancements playbook (worktree differentiation).
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

describe('SessionStats — worktree breakdown', () => {
	it('renders the Regular | Worktree stat pair when sessions exist', () => {
		const sessions = [
			makeSession(),
			makeSession({ parentSessionId: 'parent-1' }),
			makeSession({ parentSessionId: 'parent-1' }),
		];

		render(<SessionStats sessions={sessions} theme={theme} />);

		const breakdown = screen.getByTestId('worktree-breakdown');
		expect(breakdown).toBeInTheDocument();
		expect(breakdown.textContent).toContain('Regular:');
		expect(breakdown.textContent).toContain('1');
		expect(breakdown.textContent).toContain('Worktree:');
		expect(breakdown.textContent).toContain('2');
	});

	it('counts parent agents (worktreeConfig set) as Regular, not Worktree', () => {
		const sessions = [
			makeSession({ worktreeConfig: { basePath: '/tmp/wt', watchEnabled: true } }),
			makeSession({ parentSessionId: 'parent-1' }),
		];

		render(<SessionStats sessions={sessions} theme={theme} />);

		const breakdown = screen.getByTestId('worktree-breakdown');
		expect(breakdown).toHaveAttribute('aria-label', 'Regular: 1 | Worktree: 1');
	});

	it('shows zero counts when there are no worktree children', () => {
		const sessions = [makeSession(), makeSession()];

		render(<SessionStats sessions={sessions} theme={theme} />);

		const breakdown = screen.getByTestId('worktree-breakdown');
		expect(breakdown).toHaveAttribute('aria-label', 'Regular: 2 | Worktree: 0');
	});

	it('excludes terminal sessions from the worktree breakdown', () => {
		const sessions = [
			makeSession({ toolType: 'terminal' }),
			makeSession({ toolType: 'terminal', parentSessionId: 'p1' }),
			makeSession(),
			makeSession({ parentSessionId: 'p2' }),
		];

		render(<SessionStats sessions={sessions} theme={theme} />);

		const breakdown = screen.getByTestId('worktree-breakdown');
		expect(breakdown).toHaveAttribute('aria-label', 'Regular: 1 | Worktree: 1');
	});

	it('does not render the breakdown row when no agent sessions exist', () => {
		render(<SessionStats sessions={[]} theme={theme} />);

		expect(screen.queryByTestId('worktree-breakdown')).not.toBeInTheDocument();
	});
});

describe('SessionStats — agent type display names', () => {
	it('shows the user-assigned name when only one session of that type exists', () => {
		const sessions = [makeSession({ name: 'Backend API', toolType: 'claude-code' })];

		render(<SessionStats sessions={sessions} theme={theme} />);

		expect(screen.getByText('Backend API')).toBeInTheDocument();
		expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
	});

	it('shows the prettified type when multiple sessions share the type', () => {
		const sessions = [
			makeSession({ name: 'Frontend', toolType: 'claude-code' }),
			makeSession({ name: 'Backend', toolType: 'claude-code' }),
		];

		render(<SessionStats sessions={sessions} theme={theme} />);

		expect(screen.getByText('Claude Code')).toBeInTheDocument();
		expect(screen.queryByText('Frontend')).not.toBeInTheDocument();
		expect(screen.queryByText('Backend')).not.toBeInTheDocument();
	});

	it('uses canonical display names for known agent types via shared resolver', () => {
		const sessions = [
			makeSession({ name: 'A', toolType: 'opencode' }),
			makeSession({ name: 'B', toolType: 'opencode' }),
			makeSession({ name: 'C', toolType: 'factory-droid' }),
			makeSession({ name: 'D', toolType: 'factory-droid' }),
		];

		render(<SessionStats sessions={sessions} theme={theme} />);

		expect(screen.getByText('OpenCode')).toBeInTheDocument();
		expect(screen.getByText('Factory Droid')).toBeInTheDocument();
	});
});
