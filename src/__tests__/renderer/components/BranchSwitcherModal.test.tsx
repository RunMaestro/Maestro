/**
 * Tests for BranchSwitcherModal - the fuzzy branch picker opened from the
 * header git pill menu.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BranchSwitcherModal } from '../../../renderer/components/BranchSwitcherModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { gitService } from '../../../renderer/services/git';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';
import { mockTheme } from '../../helpers/mockTheme';

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getBranches: vi.fn(),
		checkoutBranch: vi.fn(),
	},
}));

const mockRefreshGitStatus = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../renderer/contexts/GitStatusContext', () => ({
	useGitDetail: () => ({ refreshGitStatus: mockRefreshGitStatus }),
}));

vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

const defaultData = {
	sessionId: 'session-1',
	cwd: '/test/repo',
	currentBranch: 'main',
};

function renderModal(onClose = vi.fn()) {
	render(<BranchSwitcherModal theme={mockTheme} data={defaultData} onClose={onClose} />, {
		wrapper: TestWrapper,
	});
	return onClose;
}

describe('BranchSwitcherModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(gitService.getBranches).mockResolvedValue([
			'main',
			'feature/login',
			'fix/crash-on-boot',
		]);
		vi.mocked(gitService.checkoutBranch).mockResolvedValue({ success: true });
	});

	it('lists branches with the current one marked', async () => {
		renderModal();

		expect(await screen.findByText('feature/login')).toBeInTheDocument();
		expect(screen.getByText('main')).toBeInTheDocument();
		expect(screen.getByText('Current')).toBeInTheDocument();
		expect(gitService.getBranches).toHaveBeenCalledWith('/test/repo', undefined);
	});

	it('fuzzy-filters branches as you type', async () => {
		renderModal();
		await screen.findByText('feature/login');

		fireEvent.change(screen.getByTestId('branch-switcher-input'), { target: { value: 'flog' } });

		expect(screen.getByText('feature/login')).toBeInTheDocument();
		expect(screen.queryByText('fix/crash-on-boot')).not.toBeInTheDocument();
	});

	it('checks out the clicked branch, flashes, and closes', async () => {
		const onClose = renderModal();
		fireEvent.click(await screen.findByText('feature/login'));

		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(gitService.checkoutBranch).toHaveBeenCalledWith(
			'/test/repo',
			'feature/login',
			false,
			undefined
		);
		expect(mockRefreshGitStatus).toHaveBeenCalled();
		expect(notifyCenterFlash).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Switched to feature/login' })
		);
	});

	it('retries with a tracking branch when the name is unknown locally', async () => {
		vi.mocked(gitService.checkoutBranch)
			.mockResolvedValueOnce({
				success: false,
				error: "error: pathspec 'feature/login' did not match any file(s) known to git",
			})
			.mockResolvedValueOnce({ success: true });

		const onClose = renderModal();
		fireEvent.click(await screen.findByText('feature/login'));

		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(gitService.checkoutBranch).toHaveBeenNthCalledWith(
			2,
			'/test/repo',
			'feature/login',
			true,
			undefined
		);
	});

	it('shows the git error inline and stays open when checkout fails', async () => {
		vi.mocked(gitService.checkoutBranch).mockResolvedValue({
			success: false,
			error: 'error: Your local changes would be overwritten',
		});

		const onClose = renderModal();
		fireEvent.click(await screen.findByText('feature/login'));

		expect(await screen.findByTestId('branch-switcher-error')).toHaveTextContent(
			'Your local changes would be overwritten'
		);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('closes without checking out when the current branch is picked', async () => {
		const onClose = renderModal();
		fireEvent.click(await screen.findByText('main'));

		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(gitService.checkoutBranch).not.toHaveBeenCalled();
	});
});
