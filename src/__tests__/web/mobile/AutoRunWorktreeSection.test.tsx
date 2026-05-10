/**
 * Tests for AutoRunWorktreeSection — the mobile counterpart to desktop's
 * WorktreeRunSection. Verifies the toggle gating (isGitRepo + basePath),
 * branch loading, and the shape of the LaunchWorktreeConfig emitted via
 * the onChange callback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AutoRunWorktreeSection } from '../../../web/mobile/AutoRunWorktreeSection';

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgMain: '#0b0b0d',
		bgSidebar: '#111113',
		bgActivity: '#1c1c1f',
		border: '#27272a',
		textMain: '#e4e4e7',
		textDim: '#a1a1aa',
		accent: '#6366f1',
		accentDim: 'rgba(99, 102, 241, 0.2)',
		accentText: '#a5b4fc',
		success: '#22c55e',
		warning: '#eab308',
		error: '#ef4444',
	}),
}));

vi.mock('../../../web/mobile/constants', () => ({
	HAPTIC_PATTERNS: { tap: [10], success: [10, 30, 60] },
	triggerHaptic: vi.fn(),
}));

vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

describe('AutoRunWorktreeSection', () => {
	const loadBranches = vi
		.fn()
		.mockResolvedValue({ branches: ['main', 'feature/x'], currentBranch: 'main' });
	const loadWorktrees = vi.fn().mockResolvedValue([]);

	beforeEach(() => {
		loadBranches.mockClear();
		loadWorktrees.mockClear();
	});

	it('returns null for non-git sessions', () => {
		const onChange = vi.fn();
		const { container } = render(
			<AutoRunWorktreeSection
				isGitRepo={false}
				worktreeBasePath={null}
				loadBranches={loadBranches}
				loadWorktrees={loadWorktrees}
				onChange={onChange}
			/>
		);
		expect(container.firstChild).toBeNull();
	});

	it('disables toggle when basePath is missing', () => {
		const onChange = vi.fn();
		render(
			<AutoRunWorktreeSection
				isGitRepo={true}
				worktreeBasePath={null}
				loadBranches={loadBranches}
				loadWorktrees={loadWorktrees}
				onChange={onChange}
			/>
		);
		const toggle = screen.getByRole('switch', {
			name: /Dispatch to a separate worktree/i,
		});
		expect(toggle).toBeDisabled();
		expect(screen.getByText(/Configure a Worktree base path on the desktop/i)).toBeInTheDocument();
	});

	it('emits disabled while off and enabled-valid once toggled on', async () => {
		const onChange = vi.fn();
		render(
			<AutoRunWorktreeSection
				isGitRepo={true}
				worktreeBasePath="/repo/worktrees"
				loadBranches={loadBranches}
				loadWorktrees={loadWorktrees}
				onChange={onChange}
			/>
		);

		// Initial render: disabled state
		expect(onChange).toHaveBeenLastCalledWith({ status: 'disabled' });

		// Enable toggle
		const toggle = screen.getByRole('switch', {
			name: /Dispatch to a separate worktree/i,
		});
		fireEvent.click(toggle);

		await waitFor(() => expect(loadBranches).toHaveBeenCalled());

		// Wait until the section emits enabled-valid with a populated config
		await waitFor(() => {
			const last = onChange.mock.calls.at(-1)?.[0];
			expect(last?.status).toBe('enabled-valid');
			expect(last?.config).toMatchObject({
				enabled: true,
				path: expect.stringMatching(/^\/repo\/worktrees\/auto-run-main-/),
				branchName: expect.stringMatching(/^auto-run-main-/),
				createPROnCompletion: false,
				prTargetBranch: 'main',
			});
		});
	});

	it('flips createPROnCompletion when the PR checkbox is toggled', async () => {
		const onChange = vi.fn();
		render(
			<AutoRunWorktreeSection
				isGitRepo={true}
				worktreeBasePath="/repo/worktrees"
				loadBranches={loadBranches}
				loadWorktrees={loadWorktrees}
				onChange={onChange}
			/>
		);

		fireEvent.click(screen.getByRole('switch', { name: /Dispatch to a separate worktree/i }));
		await waitFor(() => expect(loadBranches).toHaveBeenCalled());
		await waitFor(() => {
			const last = onChange.mock.calls.at(-1)?.[0];
			expect(last?.status).toBe('enabled-valid');
		});

		fireEvent.click(
			screen.getByRole('checkbox', {
				name: /Automatically create PR when complete/i,
			})
		);

		await waitFor(() => {
			const last = onChange.mock.calls.at(-1)?.[0];
			expect(last?.config?.createPROnCompletion).toBe(true);
		});
	});

	it('emits enabled-invalid when branch name is cleared', async () => {
		const onChange = vi.fn();
		render(
			<AutoRunWorktreeSection
				isGitRepo={true}
				worktreeBasePath="/repo/worktrees"
				loadBranches={loadBranches}
				loadWorktrees={loadWorktrees}
				onChange={onChange}
			/>
		);

		fireEvent.click(screen.getByRole('switch', { name: /Dispatch to a separate worktree/i }));
		await waitFor(() => expect(loadBranches).toHaveBeenCalled());
		await waitFor(() => {
			const last = onChange.mock.calls.at(-1)?.[0];
			expect(last?.status).toBe('enabled-valid');
		});

		const branchInput = screen.getByLabelText(/Worktree branch name/i);
		fireEvent.change(branchInput, { target: { value: '' } });

		await waitFor(() => {
			const last = onChange.mock.calls.at(-1)?.[0];
			expect(last?.status).toBe('enabled-invalid');
			expect(last?.reason).toMatch(/Branch name is required/i);
		});
		expect(screen.getByText(/Branch name is required/i)).toBeInTheDocument();
	});

	it('stays in enabled-loading while branches load and never emits valid with empty prTargetBranch', async () => {
		const onChange = vi.fn();
		// Slow loadBranches: pending so baseBranch stays '' while the user toggles
		// createPR and types a branch name. Without the guard this race emitted
		// enabled-valid with prTargetBranch: '' and the desktop's PR creation
		// step received a blank target. (Greptile P1 on PR #946.) The fix routes
		// the loading window through `enabled-loading`, which the parent treats
		// as "block launch, suppress the invalid-config banner".
		let resolveBranches: (value: { branches: string[]; currentBranch?: string }) => void;
		const slowLoadBranches = vi.fn(
			() =>
				new Promise<{ branches: string[]; currentBranch?: string }>((resolve) => {
					resolveBranches = resolve;
				})
		);

		render(
			<AutoRunWorktreeSection
				isGitRepo={true}
				worktreeBasePath="/repo/worktrees"
				loadBranches={slowLoadBranches}
				loadWorktrees={loadWorktrees}
				onChange={onChange}
			/>
		);

		fireEvent.click(screen.getByRole('switch', { name: /Dispatch to a separate worktree/i }));
		await waitFor(() => expect(slowLoadBranches).toHaveBeenCalled());

		// Type a branch name while branches are still loading (baseBranch === '').
		const branchInput = screen.getByLabelText(/Worktree branch name/i);
		fireEvent.change(branchInput, { target: { value: 'my-feature' } });

		// Toggle createPR on while baseBranch is still empty.
		fireEvent.click(
			screen.getByRole('checkbox', { name: /Automatically create PR when complete/i })
		);

		await waitFor(() => {
			const last = onChange.mock.calls.at(-1)?.[0];
			expect(last?.status).toBe('enabled-loading');
		});

		// Sanity: nothing was emitted with an empty prTargetBranch and createPR=true.
		const validWithEmptyTarget = onChange.mock.calls.find(
			([call]) =>
				call?.status === 'enabled-valid' &&
				call?.config?.createPROnCompletion === true &&
				call?.config?.prTargetBranch === ''
		);
		expect(validWithEmptyTarget).toBeUndefined();

		// And no `enabled-invalid` banner fires during the loading window — that
		// would surface "Branch name is required" / "Base branch is required"
		// warnings the user can't act on yet.
		const invalidDuringLoading = onChange.mock.calls.find(
			([call]) => call?.status === 'enabled-invalid'
		);
		expect(invalidDuringLoading).toBeUndefined();

		// Resolve branches so the test's pending promise doesn't leak. Wrap in
		// act() because the resolution triggers state setters in the component
		// (setBranches, setBaseBranch, setNewBranchName, setBranchLoadStatus).
		await act(async () => {
			resolveBranches!({ branches: ['main'], currentBranch: 'main' });
		});
	});

	it('renders "Failed to load" placeholder when branch fetch rejects', async () => {
		const onChange = vi.fn();
		const rejecting = vi.fn().mockRejectedValue(new Error('boom'));
		render(
			<AutoRunWorktreeSection
				isGitRepo={true}
				worktreeBasePath="/repo/worktrees"
				loadBranches={rejecting}
				loadWorktrees={loadWorktrees}
				onChange={onChange}
			/>
		);

		fireEvent.click(screen.getByRole('switch', { name: /Dispatch to a separate worktree/i }));

		await waitFor(() => {
			expect(screen.getByText(/Failed to load/i)).toBeInTheDocument();
		});
		await waitFor(() => {
			const last = onChange.mock.calls.at(-1)?.[0];
			expect(last?.status).toBe('enabled-invalid');
		});
	});
});
