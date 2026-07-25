import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeMergeModal } from '../../../renderer/components/WorktreeMergeModal';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';
import { gitService } from '../../../renderer/services/git';

vi.mock('../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
}));

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getBranches: vi.fn(),
		getStatus: vi.fn(),
		commitAll: vi.fn(),
		mergeBranch: vi.fn(),
		rebaseBranch: vi.fn(),
	},
}));

const worktreeSession = () =>
	createMockSession({
		cwd: '/repo-wt/feature',
		parentSessionId: 'parent-1',
		worktreeBranch: 'feature',
	});

describe('WorktreeMergeModal', () => {
	beforeEach(() => {
		// The gitService mock is module-level, so call history survives between
		// tests unless cleared - which would make "not.toHaveBeenCalled" lie.
		vi.clearAllMocks();
		vi.mocked(gitService.getBranches).mockResolvedValue(['feature', 'main', 'release']);
		vi.mocked(gitService.getStatus).mockResolvedValue({ files: [], branch: 'feature' });
		vi.mocked(gitService.commitAll).mockResolvedValue({ success: true, committed: true });
		vi.mocked(gitService.mergeBranch).mockResolvedValue({ success: true, mergedIn: '/repo' });
		vi.mocked(gitService.rebaseBranch).mockResolvedValue({ success: true });
		window.maestro.git.getDefaultBranch = vi
			.fn()
			.mockResolvedValue({ success: true, branch: 'main' });
	});

	const renderModal = (mode: 'merge' | 'rebase' = 'merge') =>
		render(
			<WorktreeMergeModal
				isOpen
				mode={mode}
				onClose={vi.fn()}
				theme={mockTheme}
				session={worktreeSession()}
			/>
		);

	it('preselects the default branch and never offers the worktree branch itself', async () => {
		renderModal();

		const select = (await screen.findByLabelText('Merge Into')) as HTMLSelectElement;
		await waitFor(() => expect(select.value).toBe('main'));

		const options = Array.from(select.options).map((o) => o.value);
		expect(options).toEqual(['main', 'release']);
	});

	it('merges the worktree branch into the selected branch', async () => {
		renderModal();

		await screen.findByLabelText('Merge Into');
		fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

		await waitFor(() =>
			expect(gitService.mergeBranch).toHaveBeenCalledWith(
				'/repo-wt/feature',
				'feature',
				'main',
				undefined
			)
		);
		expect(await screen.findByText('Merged feature into main.')).toBeInTheDocument();
	});

	it('rebases onto the selected branch', async () => {
		renderModal('rebase');

		await screen.findByLabelText('Rebase Onto');
		fireEvent.click(screen.getByRole('button', { name: 'Rebase' }));

		await waitFor(() =>
			expect(gitService.rebaseBranch).toHaveBeenCalledWith('/repo-wt/feature', 'main', undefined)
		);
	});

	it('commits uncommitted changes first, using the message the user confirms', async () => {
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [{ path: 'src/a.ts', status: 'M' }],
			branch: 'feature',
		});
		renderModal();

		const messageBox = await screen.findByPlaceholderText('Commit message');
		fireEvent.change(messageBox, { target: { value: 'feat: add the thing' } });
		fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

		await waitFor(() =>
			expect(gitService.commitAll).toHaveBeenCalledWith(
				'/repo-wt/feature',
				'feat: add the thing',
				undefined
			)
		);
		expect(gitService.mergeBranch).toHaveBeenCalled();
	});

	it('does not merge when the pre-merge commit fails', async () => {
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [{ path: 'src/a.ts', status: 'M' }],
			branch: 'feature',
		});
		vi.mocked(gitService.commitAll).mockResolvedValue({
			success: false,
			committed: false,
			error: 'no git identity configured',
		});
		renderModal();

		await screen.findByPlaceholderText('Commit message');
		fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

		expect(await screen.findByText('no git identity configured')).toBeInTheDocument();
		expect(gitService.mergeBranch).not.toHaveBeenCalled();
	});

	it('lists conflicting files when the merge is aborted', async () => {
		vi.mocked(gitService.mergeBranch).mockResolvedValue({
			success: false,
			conflicts: ['src/a.ts', 'src/b.ts'],
		});
		renderModal();

		await screen.findByLabelText('Merge Into');
		fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

		expect(await screen.findByText(/conflicts in 2 files/)).toBeInTheDocument();
		expect(screen.getByText('src/a.ts')).toBeInTheDocument();
		expect(screen.getByText('src/b.ts')).toBeInTheDocument();
	});

	it('surfaces a merge error verbatim', async () => {
		vi.mocked(gitService.mergeBranch).mockResolvedValue({
			success: false,
			error: '"main" has uncommitted changes in /repo.',
		});
		renderModal();

		await screen.findByLabelText('Merge Into');
		fireEvent.click(screen.getByRole('button', { name: 'Merge' }));

		expect(await screen.findByText('"main" has uncommitted changes in /repo.')).toBeInTheDocument();
	});
});
