/**
 * Tests for GitPillMenu - the header git pill dropdown.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GitPillMenu } from '../../../renderer/components/GitPillMenu';
import { mockTheme } from '../../helpers/mockTheme';

const mockOpenUrl = vi.fn();
vi.mock('../../../renderer/utils/openUrl', () => ({
	openUrl: (url: string) => mockOpenUrl(url),
}));

// Mock the LayerStackContext (Escape handling is covered by its own tests)
vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn().mockReturnValue('mock-layer-id'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

function renderMenu(overrides: Partial<React.ComponentProps<typeof GitPillMenu>> = {}) {
	const props = {
		theme: mockTheme,
		anchorRef: { current: null },
		ahead: 0,
		behind: 0,
		changes: { fileCount: 0, additions: 0, deletions: 0, modified: 0 },
		onViewLog: vi.fn(),
		onViewDiff: vi.fn(),
		onPull: vi.fn(),
		onPush: vi.fn(),
		onSwitchBranch: vi.fn(),
		onCreatePR: vi.fn(),
		onConfigureWorktrees: vi.fn(),
		branch: 'feature/login',
		remote: 'https://github.com/user/repo.git',
		onClose: vi.fn(),
		...overrides,
	};
	render(<GitPillMenu {...props} />);
	return props;
}

describe('GitPillMenu', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders all seven actions', () => {
		renderMenu();
		expect(screen.getByText('View Git Log')).toBeInTheDocument();
		expect(screen.getByText('View Git Diff')).toBeInTheDocument();
		expect(screen.getByText('Git Pull')).toBeInTheDocument();
		expect(screen.getByText('Git Push')).toBeInTheDocument();
		expect(screen.getByText('Change Branch')).toBeInTheDocument();
		expect(screen.getByText('Create Pull Request')).toBeInTheDocument();
		expect(screen.getByText('Configure Worktrees')).toBeInTheDocument();
	});

	// The branch/origin rows below came from the pill's retired hover card.
	describe('branch / origin detail', () => {
		it('shows the branch and origin inherited from the hover card', () => {
			renderMenu();
			expect(screen.getByTestId('git-pill-menu-detail')).toBeInTheDocument();
			expect(screen.getByText('feature/login')).toBeInTheDocument();
			// Scheme and .git suffix are trimmed for display.
			expect(screen.getByText('github.com/user/repo')).toBeInTheDocument();
		});

		it('omits the detail block entirely when neither is known', () => {
			renderMenu({ branch: undefined, remote: undefined });
			expect(screen.queryByTestId('git-pill-menu-detail')).not.toBeInTheDocument();
			// Actions still render.
			expect(screen.getByText('View Git Log')).toBeInTheDocument();
		});

		it('shows the branch alone when the repo has no origin', () => {
			renderMenu({ remote: undefined });
			expect(screen.getByText('feature/login')).toBeInTheDocument();
			expect(screen.queryByText('Origin')).not.toBeInTheDocument();
		});

		it('copies the branch name', async () => {
			const writeText = vi.fn().mockResolvedValue(undefined);
			Object.assign(navigator, { clipboard: { writeText } });
			renderMenu();

			fireEvent.click(screen.getByTitle('Copy branch name'));

			await waitFor(() => expect(writeText).toHaveBeenCalledWith('feature/login'));
		});

		it('copies the full remote URL, not the trimmed display text', async () => {
			const writeText = vi.fn().mockResolvedValue(undefined);
			Object.assign(navigator, { clipboard: { writeText } });
			renderMenu();

			fireEvent.click(screen.getByTitle('Copy remote URL'));

			await waitFor(() =>
				expect(writeText).toHaveBeenCalledWith('https://github.com/user/repo.git')
			);
		});

		it('opens the repository in a browser', () => {
			renderMenu();
			fireEvent.click(screen.getByTestId('git-pill-menu-open-remote'));
			expect(mockOpenUrl).toHaveBeenCalledWith('https://github.com/user/repo');
		});

		it('disables the origin link for a remote with no browsable URL', () => {
			renderMenu({ remote: 'not-a-url' });
			fireEvent.click(screen.getByTestId('git-pill-menu-open-remote'));
			expect(mockOpenUrl).not.toHaveBeenCalled();
		});
	});

	it('omits Configure Worktrees when no handler is supplied', () => {
		renderMenu({ onConfigureWorktrees: undefined });
		expect(screen.queryByTestId('git-pill-menu-configure-worktrees')).not.toBeInTheDocument();
	});

	it('omits Create Pull Request when no handler is supplied', () => {
		renderMenu({ onCreatePR: undefined });
		expect(screen.queryByTestId('git-pill-menu-create-pr')).not.toBeInTheDocument();
		// The rest of the menu is unaffected.
		expect(screen.getByText('Change Branch')).toBeInTheDocument();
	});

	it('calls the matching handler for each action', () => {
		const props = renderMenu();

		fireEvent.click(screen.getByTestId('git-pill-menu-log'));
		expect(props.onViewLog).toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('git-pill-menu-diff'));
		expect(props.onViewDiff).toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('git-pill-menu-pull'));
		expect(props.onPull).toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('git-pill-menu-push'));
		expect(props.onPush).toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('git-pill-menu-switch-branch'));
		expect(props.onSwitchBranch).toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('git-pill-menu-create-pr'));
		expect(props.onCreatePR).toHaveBeenCalled();
	});

	it('badges pull and push with behind/ahead counts', () => {
		renderMenu({ ahead: 3, behind: 2 });
		expect(screen.getByTestId('git-pill-menu-pull')).toHaveTextContent('2');
		expect(screen.getByTestId('git-pill-menu-push')).toHaveTextContent('3');
	});

	it('omits the counts when in sync with upstream', () => {
		renderMenu();
		expect(screen.getByTestId('git-pill-menu-pull')).toHaveTextContent(/^Git Pull$/);
		expect(screen.getByTestId('git-pill-menu-push')).toHaveTextContent(/^Git Push$/);
	});

	// The diff row has to say whether opening it will show anything - a clean
	// tree and a 200-line diff used to look identical here.
	describe('diff badge', () => {
		it('badges the diff row with the working-tree line counts', () => {
			renderMenu({ changes: { fileCount: 5, additions: 206, deletions: 37, modified: 5 } });
			const row = screen.getByTestId('git-pill-menu-diff');
			expect(row).toHaveTextContent('206');
			expect(row).toHaveTextContent('37');
		});

		it('falls back to a file count when line detail is missing', () => {
			// Non-active agents get file counts only - no numstat is run for them.
			renderMenu({ changes: { fileCount: 4, additions: 0, deletions: 0, modified: 0 } });
			expect(screen.getByTestId('git-pill-menu-diff')).toHaveTextContent('4');
		});

		it('shows no badge on a clean tree', () => {
			renderMenu();
			expect(screen.getByTestId('git-pill-menu-diff')).toHaveTextContent(/^View Git Diff$/);
		});
	});
});
