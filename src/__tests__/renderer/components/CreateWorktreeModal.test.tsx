import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateWorktreeModal } from '../../../renderer/components/CreateWorktreeModal';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';

vi.mock('../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
}));

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getBranches: vi.fn().mockResolvedValue(['rc']),
	},
}));

describe('CreateWorktreeModal', () => {
	// These tests reassign window.maestro.git methods directly (not via vi.spyOn),
	// so vi.restoreAllMocks() cannot revert them. Capture the originals and restore
	// them in afterEach so the mocks do not leak into other tests in this file.
	const originalCheckGhCli = window.maestro.git.checkGhCli;
	const originalBranch = window.maestro.git.branch;

	afterEach(() => {
		window.maestro.git.checkGhCli = originalCheckGhCli;
		window.maestro.git.branch = originalBranch;
	});

	it('wraps a long spaceless creation error without overflowing the modal', async () => {
		const longError = 'failedtoaddworktreeoversshaborting'.repeat(20);
		window.maestro.git.checkGhCli = vi
			.fn()
			.mockResolvedValue({ installed: true, authenticated: true });
		window.maestro.git.branch = vi
			.fn()
			.mockResolvedValue({ stdout: 'rc', stderr: '', exitCode: 0 });

		render(
			<CreateWorktreeModal
				isOpen
				onClose={vi.fn()}
				theme={mockTheme}
				session={createMockSession({ cwd: '/repo' })}
				onCreateWorktree={vi.fn().mockRejectedValue(new Error(longError))}
			/>
		);

		fireEvent.change(screen.getByPlaceholderText('feature-xyz'), {
			target: { value: 'fix/overflow' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		const errorParagraph = await screen.findByText(longError);
		expect(errorParagraph).toHaveClass('break-all', 'min-w-0');
		expect(errorParagraph.parentElement).toHaveClass('overflow-hidden');
	});
});
