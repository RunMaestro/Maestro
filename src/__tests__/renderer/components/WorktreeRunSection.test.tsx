import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { WorktreeRunSection } from '../../../renderer/components/WorktreeRunSection';
import type { Theme, Session } from '../../../renderer/types';

// Mock gitService
vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getBranches: vi.fn().mockResolvedValue(['main', 'develop']),
	},
}));

function createMockTheme(): Theme {
	return {
		id: 'dark',
		name: 'Dark',
		mode: 'dark',
		colors: {
			bgMain: '#1a1a1a',
			bgSidebar: '#111111',
			bgActivity: '#222222',
			textMain: '#ffffff',
			textDim: '#888888',
			accent: '#0066ff',
			border: '#333333',
			success: '#00cc00',
			warning: '#ffcc00',
			error: '#ff0000',
			info: '#0099ff',
			link: '#66aaff',
			userBubble: '#0044cc',
		},
	};
}

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'parent-1',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/project',
		fullPath: '/project',
		projectRoot: '/project',
		state: 'idle',
		tabs: [],
		activeTabIndex: 0,
		isGitRepo: true,
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		worktreeConfig: {
			basePath: '/project/worktrees',
			watchEnabled: false,
		},
		...overrides,
	} as Session;
}

function createWorktreeChild(overrides: Partial<Session> = {}): Session {
	return createMockSession({
		id: 'child-1',
		name: 'Worktree Child',
		parentSessionId: 'parent-1',
		worktreeBranch: 'feature-branch',
		cwd: '/project/worktrees/feature-branch',
		state: 'idle',
		...overrides,
	});
}

describe('WorktreeRunSection', () => {
	const theme = createMockTheme();
	let mockOnWorktreeTargetChange: ReturnType<typeof vi.fn>;
	let mockOnOpenWorktreeConfig: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockOnWorktreeTargetChange = vi.fn();
		mockOnOpenWorktreeConfig = vi.fn();
	});

	it('shows configure link when worktreeConfig is not set', () => {
		const session = createMockSession({ worktreeConfig: undefined });
		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				sessions={[session]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);
		expect(screen.getByText(/Configure Worktrees/)).toBeTruthy();
	});

	it('shows toggle button when worktreeConfig is set', () => {
		const session = createMockSession();
		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				sessions={[session]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);
		expect(screen.getByText('Run in Worktree')).toBeTruthy();
	});

	it('scans for available worktrees when toggle is enabled', async () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({
			gitSubdirs: [
				{ path: '/project/worktrees/old-feature', name: 'old-feature', isWorktree: true, branch: 'old-feature', repoRoot: '/project' },
				{ path: '/project/worktrees/experiment', name: 'experiment', isWorktree: true, branch: 'experiment', repoRoot: '/project' },
			],
		});
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				sessions={[session]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		await waitFor(() => {
			expect(scanMock).toHaveBeenCalledWith('/project/worktrees', undefined);
		});

		await waitFor(() => {
			expect(screen.getByText('old-feature')).toBeTruthy();
			expect(screen.getByText('experiment')).toBeTruthy();
		});
	});

	it('filters out worktrees already open in Maestro', async () => {
		const session = createMockSession();
		const openChild = createWorktreeChild({
			cwd: '/project/worktrees/feature-branch',
		});
		const scanMock = vi.fn().mockResolvedValue({
			gitSubdirs: [
				{ path: '/project/worktrees/feature-branch', name: 'feature-branch', isWorktree: true, branch: 'feature-branch', repoRoot: '/project' },
				{ path: '/project/worktrees/closed-wt', name: 'closed-wt', isWorktree: true, branch: 'closed-wt', repoRoot: '/project' },
			],
		});
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				sessions={[session, openChild]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		await waitFor(() => {
			// closed-wt should appear in Available Worktrees
			expect(screen.getByText('closed-wt')).toBeTruthy();
		});

		// feature-branch is already open, should NOT appear in Available Worktrees optgroup
		// (it appears in "Open in Maestro" instead)
		const availableOptions = screen.getAllByRole('option');
		const closedOptions = availableOptions.filter(
			(opt) => (opt as HTMLOptionElement).value.startsWith('__closed__:')
		);
		expect(closedOptions).toHaveLength(1);
		expect((closedOptions[0] as HTMLOptionElement).value).toBe('__closed__:/project/worktrees/closed-wt');
	});

	it('emits existing-closed mode when selecting an available worktree', async () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({
			gitSubdirs: [
				{ path: '/project/worktrees/closed-wt', name: 'closed-wt', isWorktree: true, branch: 'closed-wt', repoRoot: '/project' },
			],
		});
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				sessions={[session]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		await waitFor(() => {
			expect(screen.getByText('closed-wt')).toBeTruthy();
		});

		// Select the available worktree
		const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
		await act(async () => {
			fireEvent.change(select, { target: { value: '__closed__:/project/worktrees/closed-wt' } });
		});

		expect(mockOnWorktreeTargetChange).toHaveBeenCalledWith({
			mode: 'existing-closed',
			worktreePath: '/project/worktrees/closed-wt',
			createPROnCompletion: false,
		});
	});

	it('does not scan when toggle is disabled', () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				sessions={[session]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		expect(scanMock).not.toHaveBeenCalled();
	});

	it('uses worktree name when branch is null', async () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({
			gitSubdirs: [
				{ path: '/project/worktrees/my-wt', name: 'my-wt', isWorktree: true, branch: null, repoRoot: '/project' },
			],
		});
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				sessions={[session]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		await waitFor(() => {
			// Should display the name since branch is null
			expect(screen.getByText('my-wt')).toBeTruthy();
		});
	});

	it('shows Scanning indicator while worktrees are loading', async () => {
		const session = createMockSession();
		// Create a scan mock that doesn't resolve immediately
		let resolveScan: (value: { gitSubdirs: Array<{ path: string; name: string; branch: string | null }> }) => void;
		const scanPromise = new Promise<{ gitSubdirs: Array<{ path: string; name: string; branch: string | null }> }>((resolve) => {
			resolveScan = resolve;
		});
		const scanMock = vi.fn().mockReturnValue(scanPromise);
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				sessions={[session]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Should show "Scanning..." while loading
		await waitFor(() => {
			expect(screen.getByText('Scanning...')).toBeTruthy();
		});

		// Resolve the scan
		await act(async () => {
			resolveScan!({ gitSubdirs: [{ path: '/project/worktrees/wt1', name: 'wt1', branch: 'wt1' }] });
		});

		// "Scanning..." should disappear
		await waitFor(() => {
			expect(screen.queryByText('Scanning...')).toBeNull();
		});

		// The worktree should appear
		expect(screen.getByText('wt1')).toBeTruthy();
	});

	it('passes sshRemoteId when scanning', async () => {
		const session = createMockSession({
			sshRemoteId: 'ssh-remote-1',
		});
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				sessions={[session]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		await waitFor(() => {
			expect(scanMock).toHaveBeenCalledWith('/project/worktrees', 'ssh-remote-1');
		});
	});
});
