import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { WorktreeRunSection } from '../../../renderer/components/WorktreeRunSection';
import type { Theme, Session } from '../../../renderer/types';
import { gitService } from '../../../renderer/services/git';

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
		// Restore git.branch to default mock (previous tests may override it)
		(window.maestro.git as Record<string, unknown>).branch = vi.fn().mockResolvedValue({ stdout: 'main' });
		mockOnWorktreeTargetChange = vi.fn();
		mockOnOpenWorktreeConfig = vi.fn();
	});

	it('shows disabled toggle and configure link when worktreeConfig is not set', () => {
		const session = createMockSession({ worktreeConfig: undefined });
		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);
		// Toggle should render but be disabled
		const toggle = screen.getByText('Dispatch to a separate worktree');
		expect(toggle).toBeTruthy();
		const toggleButton = toggle.closest('button')!;
		expect(toggleButton.disabled).toBe(true);
		expect(toggleButton.className).toContain('opacity-40');
		expect(toggleButton.className).toContain('cursor-not-allowed');
		// Configure link should also render
		expect(screen.getByText(/Configure →/)).toBeTruthy();
	});

	it('treats session as configured when legacy worktreeParentPath is set', () => {
		const session = createMockSession({
			worktreeConfig: undefined,
			worktreeParentPath: '/project/worktrees',
		});
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);
		// Toggle should be enabled (not disabled)
		const toggle = screen.getByText('Dispatch to a separate worktree');
		const toggleButton = toggle.closest('button')!;
		expect(toggleButton.disabled).toBe(false);
		// Configure link should NOT appear
		expect(screen.queryByText(/Configure →/)).toBeNull();
	});

	it('treats session as configured when child worktree sessions exist', () => {
		const session = createMockSession({ worktreeConfig: undefined });
		const child = createWorktreeChild();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[child]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);
		// Toggle should be enabled because children exist
		const toggle = screen.getByText('Dispatch to a separate worktree');
		const toggleButton = toggle.closest('button')!;
		expect(toggleButton.disabled).toBe(false);
		expect(screen.queryByText(/Configure →/)).toBeNull();
	});

	it('shows section header and toggle in off state with no selector when worktreeTarget is null', () => {
		const session = createMockSession();
		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);
		// Section header should be present
		expect(screen.getByText('Run in Worktree')).toBeTruthy();
		// Toggle button text
		expect(screen.getByText('Dispatch to a separate worktree')).toBeTruthy();
		// Selector dropdown should NOT be visible when toggle is off
		expect(screen.queryByRole('combobox')).toBeNull();
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
				worktreeChildren={[]}
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
				worktreeChildren={[openChild]}
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
				worktreeChildren={[]}
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
				worktreeChildren={[]}
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
				worktreeChildren={[]}
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
				worktreeChildren={[]}
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
				worktreeChildren={[]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		await waitFor(() => {
			expect(scanMock).toHaveBeenCalledWith('/project/worktrees', 'ssh-remote-1');
		});
	});

	it('shows selector dropdown when worktreeTarget is non-null (toggle on)', () => {
		const session = createMockSession();
		const child = createWorktreeChild();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[child]}
				worktreeTarget={{ mode: 'existing-open', sessionId: child.id, createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Selector should be visible
		expect(screen.getAllByRole('combobox').length).toBeGreaterThanOrEqual(1);
	});

	it('lists open worktree agents as options', () => {
		const session = createMockSession();
		const child1 = createWorktreeChild({ id: 'child-1', name: 'Agent Alpha', worktreeBranch: 'branch-a' });
		const child2 = createWorktreeChild({ id: 'child-2', name: 'Agent Beta', worktreeBranch: 'branch-b' });
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[child1, child2]}
				worktreeTarget={{ mode: 'existing-open', sessionId: 'child-1', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Both children should be listed as options
		const options = screen.getAllByRole('option');
		const optionTexts = options.map((o) => o.textContent);
		expect(optionTexts.some((t) => t?.includes('Agent Alpha') && t?.includes('branch-a'))).toBe(true);
		expect(optionTexts.some((t) => t?.includes('Agent Beta') && t?.includes('branch-b'))).toBe(true);
	});

	it('disables busy agents and shows busy suffix', () => {
		const session = createMockSession();
		const idleChild = createWorktreeChild({ id: 'child-idle', name: 'Idle Agent', state: 'idle', worktreeBranch: 'idle-branch' });
		const busyChild = createWorktreeChild({ id: 'child-busy', name: 'Busy Agent', state: 'busy', worktreeBranch: 'busy-branch' });
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[idleChild, busyChild]}
				worktreeTarget={{ mode: 'existing-open', sessionId: 'child-idle', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		const options = screen.getAllByRole('option');
		const busyOption = options.find((o) => (o as HTMLOptionElement).value === 'child-busy') as HTMLOptionElement;
		expect(busyOption).toBeTruthy();
		expect(busyOption.disabled).toBe(true);
		expect(busyOption.textContent).toContain('— busy');

		const idleOption = options.find((o) => (o as HTMLOptionElement).value === 'child-idle') as HTMLOptionElement;
		expect(idleOption).toBeTruthy();
		expect(idleOption.disabled).toBe(false);
		expect(idleOption.textContent).not.toContain('— busy');
	});

	it('shows base branch dropdown and branch name input when Create New Worktree is selected', async () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		const { rerender } = render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Select "Create New Worktree" from the dropdown
		const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
		await act(async () => {
			fireEvent.change(select, { target: { value: '__create_new__' } });
		});

		// Wait for branches to load
		await waitFor(() => {
			// Base branch dropdown should appear (second combobox)
			const comboboxes = screen.getAllByRole('combobox');
			expect(comboboxes.length).toBe(2); // main selector + base branch selector
		});

		// Branch name input should appear
		expect(screen.getByDisplayValue(/auto-run-/)).toBeTruthy();
		expect(screen.getByText('Base Branch')).toBeTruthy();
		expect(screen.getByText('Worktree Branch Name')).toBeTruthy();
	});

	it('defaults to current branch as base branch', async () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;
		// Current branch is 'develop', not main
		(window.maestro.git as Record<string, unknown>).branch = vi.fn().mockResolvedValue({ stdout: 'develop' });
		vi.mocked(gitService.getBranches).mockResolvedValue(['main', 'develop', 'feature/xyz']);

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
		await act(async () => {
			fireEvent.change(select, { target: { value: '__create_new__' } });
		});

		await waitFor(() => {
			expect(screen.getAllByRole('combobox').length).toBe(2);
		});

		// Should default to current branch 'develop', not 'main'
		const mmdd = `${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}`;
		expect(screen.getByDisplayValue(`auto-run-develop-${mmdd}`)).toBeTruthy();
	});

	it('auto-generates branch name from selected base branch', async () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;
		vi.mocked(gitService.getBranches).mockResolvedValue(['main', 'develop', 'feature/xyz']);

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Select "Create New Worktree"
		const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
		await act(async () => {
			fireEvent.change(select, { target: { value: '__create_new__' } });
		});

		// Wait for branch data to load
		await waitFor(() => {
			expect(screen.getAllByRole('combobox').length).toBe(2);
		});

		// Should auto-populate with a name derived from the first (default) branch
		const mmdd = `${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}`;
		expect(screen.getByDisplayValue(`auto-run-main-${mmdd}`)).toBeTruthy();

		// Change base branch to 'develop' and verify name updates
		const baseBranchSelect = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
		await act(async () => {
			fireEvent.change(baseBranchSelect, { target: { value: 'develop' } });
		});

		expect(screen.getByDisplayValue(`auto-run-develop-${mmdd}`)).toBeTruthy();
	});

	it('updates createPROnCompletion when PR checkbox is toggled', async () => {
		const session = createMockSession();
		const child = createWorktreeChild();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		// Start with toggle off, then toggle on to set internal selectedValue
		const { rerender } = render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[child]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Click toggle to turn on — this sets internal selectedValue
		const toggle = screen.getByText('Dispatch to a separate worktree');
		await act(async () => {
			fireEvent.click(toggle);
		});

		// Rerender with the worktreeTarget that would have been set by the parent
		const lastCall = mockOnWorktreeTargetChange.mock.calls[mockOnWorktreeTargetChange.mock.calls.length - 1][0];
		mockOnWorktreeTargetChange.mockClear();

		rerender(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[child]}
				worktreeTarget={lastCall}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Now click the PR checkbox label text
		const prLabel = screen.getByText('Automatically create PR when complete');
		await act(async () => {
			fireEvent.click(prLabel);
		});

		// Should have called onWorktreeTargetChange with createPROnCompletion: true
		expect(mockOnWorktreeTargetChange).toHaveBeenCalledWith(
			expect.objectContaining({ createPROnCompletion: true })
		);
	});

	it('emits correct WorktreeRunTarget for existing-open mode', () => {
		const session = createMockSession();
		const child = createWorktreeChild({ id: 'child-1' });
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[child]}
				worktreeTarget={{ mode: 'existing-open', sessionId: 'child-1', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Select the existing-open child via dropdown
		const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
		fireEvent.change(select, { target: { value: 'child-1' } });

		expect(mockOnWorktreeTargetChange).toHaveBeenCalledWith({
			mode: 'existing-open',
			sessionId: 'child-1',
			createPROnCompletion: false,
		});
	});

	it('calls onWorktreeTargetChange(null) when toggle is turned off', () => {
		const session = createMockSession();
		const child = createWorktreeChild();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[child]}
				worktreeTarget={{ mode: 'existing-open', sessionId: child.id, createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Click the toggle to turn off
		const toggle = screen.getByText('Dispatch to a separate worktree');
		fireEvent.click(toggle);

		expect(mockOnWorktreeTargetChange).toHaveBeenCalledWith(null);
	});

	it('clicking toggle on always defaults to create-new mode', () => {
		const session = createMockSession();
		const idleChild = createWorktreeChild({ id: 'child-idle', state: 'idle', name: 'Idle' });
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[idleChild]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Click the toggle to turn on
		const toggle = screen.getByText('Dispatch to a separate worktree');
		fireEvent.click(toggle);

		// Should always default to create-new, even when idle children exist
		expect(mockOnWorktreeTargetChange).toHaveBeenCalledWith({
			mode: 'create-new',
			createPROnCompletion: false,
		});
	});

	it('clicking toggle on with no children also selects create-new', () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Click the toggle to turn on — no children exist
		const toggle = screen.getByText('Dispatch to a separate worktree');
		fireEvent.click(toggle);

		expect(mockOnWorktreeTargetChange).toHaveBeenCalledWith({
			mode: 'create-new',
			createPROnCompletion: false,
		});
	});

	it('calls onOpenWorktreeConfig when configure link is clicked', () => {
		const session = createMockSession({ worktreeConfig: undefined });
		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		fireEvent.click(screen.getByText(/Configure →/));
		expect(mockOnOpenWorktreeConfig).toHaveBeenCalledOnce();
	});

	it('disabled toggle does not fire toggle handler when clicked', () => {
		const session = createMockSession({ worktreeConfig: undefined });
		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		const toggle = screen.getByText('Dispatch to a separate worktree');
		fireEvent.click(toggle);
		// Should not have been called because button is disabled
		expect(mockOnWorktreeTargetChange).not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// Edge case: No worktrees found
	// -----------------------------------------------------------------------

	it('shows "No worktrees found" message and auto-selects create-new when no agents or worktrees exist', async () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Wait for scanning to finish
		await waitFor(() => {
			expect(scanMock).toHaveBeenCalled();
		});

		// Should show "No worktrees found" message
		await waitFor(() => {
			const options = screen.getAllByRole('option');
			const noWorktreesOption = options.find((o) => o.textContent?.includes('No worktrees found'));
			expect(noWorktreesOption).toBeTruthy();
			expect((noWorktreesOption as HTMLOptionElement).disabled).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// Edge case: getBranches failure
	// -----------------------------------------------------------------------

	it('shows error message when getBranches fails', async () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;
		vi.mocked(gitService.getBranches).mockRejectedValue(new Error('git not found'));

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Select "Create New Worktree" to trigger branch loading
		const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
		await act(async () => {
			fireEvent.change(select, { target: { value: '__create_new__' } });
		});

		// Wait for error to appear
		await waitFor(() => {
			expect(screen.getByText('Could not load branches')).toBeTruthy();
		});

		// Base branch dropdown should be disabled
		const comboboxes = screen.getAllByRole('combobox');
		if (comboboxes.length > 1) {
			expect((comboboxes[1] as HTMLSelectElement).disabled).toBe(true);
		}
	});

	// -----------------------------------------------------------------------
	// Edge case: Empty branch name
	// -----------------------------------------------------------------------

	it('shows validation message when branch name is empty', async () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;
		vi.mocked(gitService.getBranches).mockResolvedValue(['main']);

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Select "Create New Worktree"
		const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
		await act(async () => {
			fireEvent.change(select, { target: { value: '__create_new__' } });
		});

		// Wait for branch inputs to appear
		await waitFor(() => {
			expect(screen.getByText('Worktree Branch Name')).toBeTruthy();
		});

		// Clear the branch name input
		const branchInput = screen.getByDisplayValue(/auto-run-/) as HTMLInputElement;
		await act(async () => {
			fireEvent.change(branchInput, { target: { value: '' } });
		});

		// Should show validation message
		expect(screen.getByText('Branch name is required')).toBeTruthy();
	});

	// -----------------------------------------------------------------------
	// UX Polish: Info icon, state indicator, path preview, keyboard nav
	// -----------------------------------------------------------------------

	it('shows "Off" badge in off state and "Enabled" badge in on state', () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		const { rerender } = render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Off state should show "Off" badge
		expect(screen.getByText('Off')).toBeTruthy();
		expect(screen.queryByText('Enabled')).toBeNull();

		// On state should show "Enabled"
		rerender(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);
		expect(screen.getByText('Enabled')).toBeTruthy();
		expect(screen.queryByText('Off')).toBeNull();
	});

	it('renders info icon next to the toggle button', () => {
		const session = createMockSession();
		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={null}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Info icon (Lucide SVG) should be present inside the toggle button
		const toggleButton = screen.getByText('Dispatch to a separate worktree').closest('button');
		const svgIcon = toggleButton?.querySelector('svg');
		expect(svgIcon).toBeTruthy();
	});

	it('shows agent state color indicator when an open agent is selected', () => {
		const session = createMockSession();
		const idleChild = createWorktreeChild({ id: 'child-idle', name: 'Idle Agent', state: 'idle' });
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[idleChild]}
				worktreeTarget={{ mode: 'existing-open', sessionId: 'child-idle', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Select the idle child to set internal selectedValue
		const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
		fireEvent.change(select, { target: { value: 'child-idle' } });

		// State indicator should be visible
		const indicator = screen.getByTestId('agent-state-indicator');
		expect(indicator).toBeTruthy();
		expect(indicator.textContent).toContain('Idle Agent');
		expect(indicator.textContent).toContain('ready');
	});

	it('shows worktree path preview when creating a new worktree with a branch name', async () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;
		vi.mocked(gitService.getBranches).mockResolvedValue(['main']);

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Select "Create New Worktree"
		const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
		await act(async () => {
			fireEvent.change(select, { target: { value: '__create_new__' } });
		});

		// Wait for branch inputs to load
		await waitFor(() => {
			expect(screen.getByText('Worktree Branch Name')).toBeTruthy();
		});

		// Path preview should show basePath/branchName
		const mmdd = `${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}`;
		await waitFor(() => {
			expect(screen.getByText(`/project/worktrees/auto-run-main-${mmdd}`)).toBeTruthy();
		});
	});

	it('hides path preview when branch name is cleared', async () => {
		const session = createMockSession();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;
		vi.mocked(gitService.getBranches).mockResolvedValue(['main']);

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[]}
				worktreeTarget={{ mode: 'create-new', createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Select "Create New Worktree"
		const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
		await act(async () => {
			fireEvent.change(select, { target: { value: '__create_new__' } });
		});

		await waitFor(() => {
			expect(screen.getByText('Worktree Branch Name')).toBeTruthy();
		});

		// Clear branch name
		const branchInput = screen.getByDisplayValue(/auto-run-/) as HTMLInputElement;
		await act(async () => {
			fireEvent.change(branchInput, { target: { value: '' } });
		});

		// Path preview should not be visible (no text matching the basePath pattern)
		expect(screen.queryByText(/\/project\/worktrees\//)).toBeNull();
	});

	it('PR checkbox is keyboard accessible with Enter and Space', () => {
		const session = createMockSession();
		const child = createWorktreeChild();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[child]}
				worktreeTarget={{ mode: 'existing-open', sessionId: child.id, createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// Select the child to set internal state
		const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
		fireEvent.change(select, { target: { value: child.id } });

		const checkbox = screen.getByRole('checkbox');
		expect(checkbox).toBeTruthy();
		expect(checkbox.getAttribute('tabindex')).toBe('0');

		// Press Enter to toggle
		fireEvent.keyDown(checkbox, { key: 'Enter' });
		expect(mockOnWorktreeTargetChange).toHaveBeenCalledWith(
			expect.objectContaining({ createPROnCompletion: true })
		);

		mockOnWorktreeTargetChange.mockClear();

		// Press Space to toggle back
		fireEvent.keyDown(checkbox, { key: ' ' });
		expect(mockOnWorktreeTargetChange).toHaveBeenCalledWith(
			expect.objectContaining({ createPROnCompletion: false })
		);
	});

	it('expanded section has animation class', () => {
		const session = createMockSession();
		const child = createWorktreeChild();
		const scanMock = vi.fn().mockResolvedValue({ gitSubdirs: [] });
		(window.maestro.git as Record<string, unknown>).scanWorktreeDirectory = scanMock;

		const { container } = render(
			<WorktreeRunSection
				theme={theme}
				activeSession={session}
				worktreeChildren={[child]}
				worktreeTarget={{ mode: 'existing-open', sessionId: child.id, createPROnCompletion: false }}
				onWorktreeTargetChange={mockOnWorktreeTargetChange}
				onOpenWorktreeConfig={mockOnOpenWorktreeConfig}
			/>
		);

		// The expanded content wrapper should have the animation class
		const animatedDiv = container.querySelector('.animate-slide-down');
		expect(animatedDiv).toBeTruthy();
	});
});
