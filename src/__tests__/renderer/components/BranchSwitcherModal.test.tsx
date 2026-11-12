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
import { createMockSession } from '../../helpers/mockSession';
import { useSessionStore } from '../../../renderer/stores/sessionStore';

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
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'session-1', name: 'Sonoma-Fix' })],
		} as never);
	});

	// This modal's customHeader REPLACES the default header, so `<Modal subtitle>`
	// never renders here - the name has to live in the custom header itself.
	it('names the agent whose repo is switching branches', async () => {
		renderModal();

		await waitFor(() => expect(gitService.getBranches).toHaveBeenCalled());
		expect(screen.getByTestId('modal-subtitle')).toHaveTextContent('Sonoma-Fix');
		// Not folded into the title, which is the aria-label and would otherwise
		// collide with the explicit resizeKey contract.
		expect(screen.queryByText(/Switch Branch . Sonoma-Fix/)).not.toBeInTheDocument();
	});

	it('renders no name when the agent is gone', async () => {
		useSessionStore.setState({ sessions: [] } as never);
		renderModal();

		await waitFor(() => expect(gitService.getBranches).toHaveBeenCalled());
		expect(screen.queryByTestId('modal-subtitle')).not.toBeInTheDocument();
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
