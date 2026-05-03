/**
 * Tests for AutoRunWorktreeSection — the mobile counterpart to desktop's
 * WorktreeRunSection. Verifies the toggle gating (isGitRepo + basePath),
 * branch loading, and the shape of the LaunchWorktreeConfig emitted via
 * the onChange callback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

	it('emits null while disabled and full config once enabled', async () => {
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

		// Initial render: disabled → onChange(null)
		expect(onChange).toHaveBeenLastCalledWith(null);

		// Enable toggle
		const toggle = screen.getByRole('switch', {
			name: /Dispatch to a separate worktree/i,
		});
		fireEvent.click(toggle);

		await waitFor(() => expect(loadBranches).toHaveBeenCalled());

		// Wait until the section emits a populated config (path/branchName resolved)
		await waitFor(() => {
			const last = onChange.mock.calls.at(-1)?.[0];
			expect(last).toMatchObject({
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
			expect(last?.enabled).toBe(true);
		});

		fireEvent.click(
			screen.getByRole('checkbox', {
				name: /Automatically create PR when complete/i,
			})
		);

		await waitFor(() => {
			const last = onChange.mock.calls.at(-1)?.[0];
			expect(last?.createPROnCompletion).toBe(true);
		});
	});

	it('emits null when branch name is cleared', async () => {
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
			expect(last?.enabled).toBe(true);
		});

		const branchInput = screen.getByLabelText(/Worktree branch name/i);
		fireEvent.change(branchInput, { target: { value: '' } });

		await waitFor(() => {
			expect(onChange).toHaveBeenLastCalledWith(null);
		});
		expect(screen.getByText(/Branch name is required/i)).toBeInTheDocument();
	});
});
