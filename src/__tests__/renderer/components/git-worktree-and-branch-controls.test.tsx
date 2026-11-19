// Source: src/__tests__/renderer/components/CreateWorktreeModal.test.tsx
// Source: src/__tests__/renderer/components/MainPanel/BranchSwitcherDropdown.test.tsx
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { CreateWorktreeModal } from '../../../renderer/components/CreateWorktreeModal';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';
import * as layers from '../../../renderer/hooks/ui/useModalLayer';
import { gitService } from '../../../renderer/services/git';
import { waitFor } from '@testing-library/react';
import { BranchSwitcherDropdown } from '../../../renderer/components/MainPanel/BranchSwitcherDropdown';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getBranches: vi.fn(),
		switchBranch: vi.fn(),
	},
}));
describe('CreateWorktreeModal', () => {
	describe('CreateWorktreeModal', () => {
		beforeEach(() => {
			vi.spyOn(layers, 'useModalLayer').mockImplementation(() => {});
			vi.mocked(gitService.getBranches).mockResolvedValue(['rc']);
		});
		// These tests reassign window.maestro.git methods directly (not via vi.spyOn),
		// so vi.restoreAllMocks() cannot revert them. Capture the originals and restore
		// them in afterEach so the mocks do not leak into other tests in this file.
		const originalCheckGhCli = window.maestro.git.checkGhCli;
		const originalBranch = window.maestro.git.branch;

		afterEach(() => {
			vi.restoreAllMocks();
			window.maestro.git.checkGhCli = originalCheckGhCli;
			window.maestro.git.branch = originalBranch;
		});

		// Bespoke header (own <h2>, not <Modal>), so this goes through the shared
		// <ModalSubtitle> rather than <Modal subtitle>.
		it('names the agent the worktree is branched from', () => {
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
					session={createMockSession({ cwd: '/repo', name: 'Sonoma-Fix' })}
					onCreateWorktree={vi.fn()}
				/>
			);

			expect(screen.getByTestId('modal-subtitle')).toHaveTextContent('Sonoma-Fix');
			// The heading stays the bare action, so the name cannot leak into an
			// aria-label or a title-derived persisted size.
			expect(screen.getByRole('heading')).toHaveTextContent('Create New Worktree');
			expect(screen.getByRole('heading')).not.toHaveTextContent('Sonoma-Fix');
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
});
describe('BranchSwitcherDropdown', () => {
	async function setup() {
		const anchor = document.createElement('button');
		document.body.appendChild(anchor);
		render(
			<LayerStackProvider>
				<BranchSwitcherDropdown
					cwd="/repo"
					currentBranch="main"
					theme={mockTheme}
					anchorEl={anchor}
					onClose={vi.fn()}
					onSwitched={vi.fn()}
				/>
			</LayerStackProvider>
		);
		const input = await screen.findByPlaceholderText('Filter branches…');
		await screen.findByText('feature/ime');
		fireEvent.change(input, { target: { value: 'feature' } });
		return input;
	}

	describe('BranchSwitcherDropdown filter Enter', () => {
		beforeEach(() => {
			vi.mocked(gitService.getBranches).mockResolvedValue(['main', 'feature/ime']);
			vi.mocked(gitService.switchBranch).mockResolvedValue({ success: true } as never);
		});

		it('leaves Enter to the input method during an IME composition', async () => {
			const input = await setup();

			for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
				expect(fireEvent.keyDown(input, { key: 'Enter', ...ime })).toBe(true);
			}

			expect(gitService.switchBranch).not.toHaveBeenCalled();
		});

		it('switches to the highlighted branch on a normal Enter', async () => {
			const input = await setup();

			expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);

			await waitFor(() => {
				expect(gitService.switchBranch).toHaveBeenCalledWith('/repo', 'feature/ime', undefined);
			});
		});
	});
});
