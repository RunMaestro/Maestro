import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteWorktreeModal } from '../../renderer/components/DeleteWorktreeModal';
import type { Session, Theme } from '../../renderer/types';

vi.mock('../../renderer/components/ui/Modal', () => ({
	Modal: ({
		title,
		onClose,
		headerIcon,
		children,
		footer,
	}: {
		title: string;
		onClose: () => void;
		headerIcon?: React.ReactNode;
		children: React.ReactNode;
		footer?: React.ReactNode;
	}) => (
		<div role="dialog" aria-label={title}>
			<div>
				{headerIcon}
				<h2>{title}</h2>
				<button type="button" aria-label="Close modal" onClick={onClose}>
					Close
				</button>
			</div>
			<div>{children}</div>
			<div>{footer}</div>
		</div>
	),
}));

const theme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#222222',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		accent: '#00aaff',
		accentForeground: '#ffffff',
		border: '#444444',
		error: '#ff5555',
		warning: '#ffaa00',
	},
};

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'worktree-session',
		parentSessionId: 'parent-session',
		name: 'Feature Auth',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo-worktrees/feature-auth',
		fullPath: '/repo-worktrees/feature-auth',
		projectRoot: '/repo',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

function renderModal(overrides: Partial<React.ComponentProps<typeof DeleteWorktreeModal>> = {}) {
	const props: React.ComponentProps<typeof DeleteWorktreeModal> = {
		theme,
		session: createSession(),
		onClose: vi.fn(),
		onConfirm: vi.fn(),
		onConfirmAndDelete: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};

	return {
		...render(<DeleteWorktreeModal {...props} />),
		props,
	};
}

describe('DeleteWorktreeModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders the confirmation copy, session name, worktree path, and close control', () => {
		const { props } = renderModal();

		expect(screen.getByRole('dialog', { name: 'Delete Worktree' })).toBeInTheDocument();
		expect(screen.getByText('Delete Worktree')).toBeInTheDocument();
		expect(screen.getByText('Feature Auth')).toBeInTheDocument();
		expect(screen.getByText('/repo-worktrees/feature-auth')).toHaveAttribute(
			'title',
			'/repo-worktrees/feature-auth'
		);
		expect(screen.getByText(/keeps the git worktree directory on disk/i)).toBeInTheDocument();
		expect(screen.getByText(/permanently deletes the worktree directory/i)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it('omits the path block when the session has no cwd', () => {
		renderModal({ session: createSession({ cwd: '' }) });

		expect(screen.queryByText('/repo-worktrees/feature-auth')).not.toBeInTheDocument();
	});

	it('cancels from click and Enter key without confirming deletion', () => {
		const { props, unmount } = renderModal();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(props.onClose).toHaveBeenCalledTimes(1);
		expect(props.onConfirm).not.toHaveBeenCalled();
		unmount();

		const second = renderModal();
		fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
		expect(second.props.onClose).not.toHaveBeenCalled();
		fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' });
		expect(second.props.onClose).toHaveBeenCalledTimes(1);
		expect(second.props.onConfirm).not.toHaveBeenCalled();
	});

	it('removes the session without deleting from disk from click and Enter key', () => {
		const { props, unmount } = renderModal();

		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		expect(props.onConfirm).toHaveBeenCalledTimes(1);
		expect(props.onClose).toHaveBeenCalledTimes(1);
		unmount();

		const second = renderModal();
		fireEvent.keyDown(screen.getByRole('button', { name: 'Remove' }), { key: 'Escape' });
		expect(second.props.onConfirm).not.toHaveBeenCalled();
		fireEvent.keyDown(screen.getByRole('button', { name: 'Remove' }), { key: 'Enter' });
		expect(second.props.onConfirm).toHaveBeenCalledTimes(1);
		expect(second.props.onClose).toHaveBeenCalledTimes(1);
	});

	it('deletes the worktree from disk, shows pending state, and closes on success', async () => {
		let resolveDelete: () => void = () => {};
		const onConfirmAndDelete = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveDelete = resolve;
				})
		);
		const { props } = renderModal({ onConfirmAndDelete });

		fireEvent.click(screen.getByRole('button', { name: 'Remove and Delete' }));

		await waitFor(() => {
			expect(onConfirmAndDelete).toHaveBeenCalledTimes(1);
			expect(screen.getByRole('button', { name: /Deleting\.\.\./ })).toBeDisabled();
		});
		expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();

		resolveDelete();
		await waitFor(() => {
			expect(props.onClose).toHaveBeenCalledTimes(1);
		});
	});

	it('deletes from disk on Enter and ignores other keys', async () => {
		const { props } = renderModal();

		fireEvent.keyDown(screen.getByRole('button', { name: 'Remove and Delete' }), {
			key: 'Escape',
		});
		expect(props.onConfirmAndDelete).not.toHaveBeenCalled();

		fireEvent.keyDown(screen.getByRole('button', { name: 'Remove and Delete' }), {
			key: 'Enter',
		});

		await waitFor(() => {
			expect(props.onConfirmAndDelete).toHaveBeenCalledTimes(1);
			expect(props.onClose).toHaveBeenCalledTimes(1);
		});
	});

	it('shows explicit and fallback errors and restores the action buttons', async () => {
		const onConfirmAndDelete = vi
			.fn()
			.mockRejectedValueOnce(new Error('permission denied'))
			.mockRejectedValueOnce('boom');
		const { props } = renderModal({ onConfirmAndDelete });

		fireEvent.click(screen.getByRole('button', { name: 'Remove and Delete' }));
		await waitFor(() => {
			expect(screen.getByText('permission denied')).toBeInTheDocument();
		});
		expect(screen.getByRole('button', { name: 'Remove and Delete' })).toBeInTheDocument();
		expect(props.onClose).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Remove and Delete' }));
		await waitFor(() => {
			expect(screen.getByText('Failed to delete worktree')).toBeInTheDocument();
		});
		expect(props.onClose).not.toHaveBeenCalled();
	});
});
