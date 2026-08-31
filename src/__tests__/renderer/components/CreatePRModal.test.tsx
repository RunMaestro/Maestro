/**
 * Tests for CreatePRModal's header.
 *
 * Create Pull Request is reachable by right-clicking any Left Bar row, so the
 * agent whose branch the PR opens from is frequently not the highlighted one.
 * Only `cwd` and the branch reach this component, so the agent name has to be
 * threaded in from the host (`AppWorktreeModals`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CreatePRModal } from '../../../renderer/components/CreatePRModal';
import { mockTheme } from '../../helpers/mockTheme';

vi.mock('../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
}));

function renderModal(agentName?: string) {
	render(
		<CreatePRModal
			isOpen
			onClose={vi.fn()}
			theme={mockTheme}
			worktreePath="/repo"
			worktreeBranch="fix/crash"
			availableBranches={['main', 'rc']}
			agentName={agentName}
		/>
	);
}

describe('CreatePRModal header', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.maestro.git.checkGhCli = vi
			.fn()
			.mockResolvedValue({ installed: true, authenticated: true });
	});

	it('names the agent the PR is opened from', () => {
		renderModal('Sonoma-Fix');

		expect(screen.getByTestId('modal-subtitle')).toHaveTextContent('Sonoma-Fix');
	});

	it('keeps the heading the bare action', () => {
		// The name must not fold into the heading: that is what an aria-label and
		// a title-derived persisted size would pick up.
		renderModal('Sonoma-Fix');

		const heading = screen.getByRole('heading');
		expect(heading).toHaveTextContent('Create Pull Request');
		expect(heading).not.toHaveTextContent('Sonoma-Fix');
	});

	it('renders no subtitle when no agent name was threaded through', () => {
		renderModal(undefined);

		expect(screen.queryByTestId('modal-subtitle')).not.toBeInTheDocument();
	});
});
