/**
 * Tests for SessionContextMenu - the Left Bar right-click menu.
 *
 * Focus is on the git action section, which mirrors the header branch pill's
 * dropdown but acts on the right-clicked agent rather than the active one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SessionContextMenu } from '../../../../renderer/components/SessionList/SessionContextMenu';
import type { Session } from '../../../../renderer/types';
import { mockTheme } from '../../../helpers/mockTheme';

const DEFAULT_BRANCH_INFO = { branch: 'feature/login', remote: '', ahead: 2, behind: 3 };
const mockGetBranchInfo = vi.fn(() => DEFAULT_BRANCH_INFO);
const mockRefreshGitStatus = vi.fn().mockResolvedValue(undefined);
const mockGetFileDetails = vi.fn(() => ({
	totalAdditions: 206,
	totalDeletions: 37,
	modifiedCount: 5,
}));
const mockGetFileCount = vi.fn(() => 5);
vi.mock('../../../../renderer/contexts/GitStatusContext', () => ({
	useGitBranch: () => ({ getBranchInfo: mockGetBranchInfo }),
	useGitDetail: () => ({
		getFileDetails: mockGetFileDetails,
		refreshGitStatus: mockRefreshGitStatus,
	}),
	useGitFileStatus: () => ({ getFileCount: mockGetFileCount }),
}));

vi.mock('../../../../renderer/services/git', () => ({
	gitService: { getDiff: vi.fn().mockResolvedValue({ diff: 'diff --git a/x b/x' }) },
}));

vi.mock('../../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));

const mockOpenModal = vi.fn();
vi.mock('../../../../renderer/stores/modalStore', () => ({
	useModalStore: Object.assign(
		vi.fn((selector) => selector({ openModal: mockOpenModal })),
		{ getState: () => ({ openModal: mockOpenModal }) }
	),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Agent',
		cwd: '/test/repo',
		fullPath: '/test/repo',
		toolType: 'claude-code',
		inputMode: 'ai',
		aiTabs: [],
		terminalTabs: [],
		isGitRepo: true,
		bookmarked: false,
		...overrides,
	} as Session;
}

function renderMenu(overrides: Partial<React.ComponentProps<typeof SessionContextMenu>> = {}) {
	const props = {
		x: 10,
		y: 10,
		theme: mockTheme,
		session: makeSession(),
		groups: [],
		hasWorktreeChildren: false,
		onRename: vi.fn(),
		onEdit: vi.fn(),
		onDuplicate: vi.fn(),
		onToggleBookmark: vi.fn(),
		onMoveToGroup: vi.fn(),
		onDelete: vi.fn(),
		onDismiss: vi.fn(),
		...overrides,
	};
	render(<SessionContextMenu {...props} />);
	return props;
}

describe('SessionContextMenu', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetBranchInfo.mockReturnValue(DEFAULT_BRANCH_INFO);
		mockGetFileDetails.mockReturnValue({
			totalAdditions: 206,
			totalDeletions: 37,
			modifiedCount: 5,
		});
		mockGetFileCount.mockReturnValue(5);
	});

	it('renders the git actions for a git agent', () => {
		renderMenu();
		expect(screen.getByTestId('session-context-git-log')).toBeInTheDocument();
		expect(screen.getByTestId('session-context-git-diff')).toBeInTheDocument();
		expect(screen.getByTestId('session-context-git-pull')).toBeInTheDocument();
		expect(screen.getByTestId('session-context-git-push')).toBeInTheDocument();
		expect(screen.getByTestId('session-context-change-branch')).toBeInTheDocument();
		expect(screen.getByTestId('session-context-create-pr')).toBeInTheDocument();
	});

	it('hides the git actions for a non-git agent', () => {
		renderMenu({ session: makeSession({ isGitRepo: false }) });
		expect(screen.queryByTestId('session-context-git-log')).not.toBeInTheDocument();
		expect(screen.queryByTestId('session-context-git-diff')).not.toBeInTheDocument();
		expect(screen.queryByTestId('session-context-git-pull')).not.toBeInTheDocument();
		expect(screen.queryByTestId('session-context-create-pr')).not.toBeInTheDocument();
		// Non-git entries still render.
		expect(screen.getByText('Rename')).toBeInTheDocument();
	});

	it('badges pull and push with the behind/ahead counts', () => {
		renderMenu();
		expect(screen.getByTestId('session-context-git-pull')).toHaveTextContent('3');
		expect(screen.getByTestId('session-context-git-push')).toHaveTextContent('2');
	});

	// Without this the row offered a diff without saying whether there was one.
	it('badges the diff row with the working-tree change counts', () => {
		renderMenu();
		const row = screen.getByTestId('session-context-git-diff');
		expect(row).toHaveTextContent('206');
		expect(row).toHaveTextContent('37');
		expect(row).toHaveAttribute('title', '+206 −37 ~5 in 5 files');
	});

	it('falls back to a file count when only basic status was polled', () => {
		// Non-active agents are polled without numstat, so they have no line counts.
		mockGetFileDetails.mockReturnValue({
			totalAdditions: 0,
			totalDeletions: 0,
			modifiedCount: 0,
		});
		mockGetFileCount.mockReturnValue(4);
		renderMenu();

		const row = screen.getByTestId('session-context-git-diff');
		expect(row).toHaveTextContent('4');
		expect(row).toHaveAttribute('title', '4 files changed');
	});

	it('leaves the diff row unbadged on a clean tree', () => {
		mockGetFileCount.mockReturnValue(0);
		renderMenu();

		const row = screen.getByTestId('session-context-git-diff');
		expect(row).toHaveTextContent(/^View Git Diff$/);
		expect(row).toHaveAttribute('title', 'No uncommitted changes');
	});

	it('opens the git log for the right-clicked agent, not the active one', () => {
		const props = renderMenu({
			session: makeSession({ id: 'other-agent', cwd: '/other/repo' }),
		});

		fireEvent.click(screen.getByTestId('session-context-git-log'));

		expect(mockOpenModal).toHaveBeenCalledWith(
			'gitLog',
			expect.objectContaining({ cwd: '/other/repo' })
		);
		expect(props.onDismiss).toHaveBeenCalled();
	});

	it('opens the streaming runner for pull and push against this agent', () => {
		renderMenu({ session: makeSession({ id: 'other-agent', cwd: '/other/repo' }) });

		fireEvent.click(screen.getByTestId('session-context-git-pull'));
		expect(mockOpenModal).toHaveBeenCalledWith(
			'gitCommandRunner',
			expect.objectContaining({
				operation: 'pull',
				cwd: '/other/repo',
				sessionId: 'other-agent',
				branch: 'feature/login',
			})
		);
	});

	it('uses the live shell cwd for a terminal-mode agent', () => {
		renderMenu({
			session: makeSession({ inputMode: 'terminal', shellCwd: '/test/repo/packages/app' }),
		});

		fireEvent.click(screen.getByTestId('session-context-git-push'));

		expect(mockOpenModal).toHaveBeenCalledWith(
			'gitCommandRunner',
			expect.objectContaining({ cwd: '/test/repo/packages/app', operation: 'push' })
		);
	});

	it('passes the SSH remote through to the git actions', () => {
		renderMenu({
			session: makeSession({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			} as Partial<Session>),
		});

		fireEvent.click(screen.getByTestId('session-context-change-branch'));

		expect(mockOpenModal).toHaveBeenCalledWith(
			'branchSwitcher',
			expect.objectContaining({ sshRemoteId: 'remote-1', currentBranch: 'feature/login' })
		);
	});

	it('opens the PR modal for this agent when no explicit handler is given', () => {
		const session = makeSession({ id: 'other-agent' });
		renderMenu({ session });

		fireEvent.click(screen.getByTestId('session-context-create-pr'));

		expect(mockOpenModal).toHaveBeenCalledWith(
			'createPR',
			expect.objectContaining({ session: expect.objectContaining({ id: 'other-agent' }) })
		);
	});

	it('prefers the supplied onCreatePR handler when present', () => {
		const onCreatePR = vi.fn();
		renderMenu({
			session: makeSession({ parentSessionId: 'parent-1', worktreeBranch: 'feature/x' }),
			onCreatePR,
		});

		fireEvent.click(screen.getByTestId('session-context-create-pr'));

		expect(onCreatePR).toHaveBeenCalled();
		expect(mockOpenModal).not.toHaveBeenCalledWith('createPR', expect.anything());
	});

	it('hides Create Pull Request when no branch is known', () => {
		mockGetBranchInfo.mockReturnValue({ branch: '', remote: '', ahead: 0, behind: 0 });
		renderMenu();

		expect(screen.queryByTestId('session-context-create-pr')).not.toBeInTheDocument();
		// The other git actions remain available.
		expect(screen.getByTestId('session-context-git-log')).toBeInTheDocument();
	});

	it('still renders Remove Worktree for a worktree child', () => {
		const onDeleteWorktree = vi.fn();
		renderMenu({
			session: makeSession({ parentSessionId: 'parent-1', worktreeBranch: 'feature/x' }),
			onDeleteWorktree,
		});

		fireEvent.click(screen.getByText('Remove Worktree'));
		expect(onDeleteWorktree).toHaveBeenCalled();
	});

	it('opens the diff for the right-clicked agent and dismisses the menu', async () => {
		const props = renderMenu({
			session: makeSession({ id: 'other-agent', cwd: '/other/repo' }),
		});

		fireEvent.click(screen.getByTestId('session-context-git-diff'));

		// The diff is fetched asynchronously, but the menu closes immediately.
		expect(props.onDismiss).toHaveBeenCalled();
		await waitFor(() =>
			expect(mockOpenModal).toHaveBeenCalledWith(
				'gitDiff',
				expect.objectContaining({ cwd: '/other/repo' })
			)
		);
	});

	it('lists Move to Group targets in the Left Bar order, ignoring leading emojis', () => {
		// Stored order is arbitrary; the submenu must read in the order the user
		// already scans the sidebar in, and an emoji in the name must not sort a
		// group to the top of the list.
		renderMenu({
			groups: [
				{ id: 'g1', name: 'Zebra', emoji: '🦓', collapsed: false },
				{ id: 'g2', name: '🚀 Apollo', emoji: '🚀', collapsed: false },
				{ id: 'g3', name: 'Mercury', emoji: '☿', collapsed: false },
			],
		});

		fireEvent.mouseEnter(screen.getByText('Move to Group').closest('div') as HTMLElement);

		const names = screen
			.getAllByRole('button')
			.map((button) => button.textContent ?? '')
			.filter((text) => ['Zebra', '🚀 Apollo', 'Mercury'].some((name) => text.includes(name)));

		expect(names.map((text) => text.replace(/[^A-Za-z]/g, ''))).toEqual([
			'Apollo',
			'Mercury',
			'Zebra',
		]);
	});
});
