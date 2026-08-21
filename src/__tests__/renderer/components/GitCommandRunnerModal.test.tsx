/**
 * Tests for GitCommandRunnerModal - the streaming pull/push console opened
 * from the header git pill menu.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { GitCommandRunnerModal } from '../../../renderer/components/GitCommandRunnerModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { gitService } from '../../../renderer/services/git';
import { mockTheme } from '../../helpers/mockTheme';
import { createMockSession } from '../../helpers/mockSession';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { GitCommandOutputChunk, GitRunCommandResult } from '../../../shared/gitUtils';

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		runCommand: vi.fn(),
		cancelCommand: vi.fn(),
		onCommandOutput: vi.fn(),
	},
}));

const mockRefreshGitStatus = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../renderer/contexts/GitStatusContext', () => ({
	useGitDetail: () => ({ refreshGitStatus: mockRefreshGitStatus }),
}));

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

/** Captures the streamed-output subscriber so tests can push chunks. */
let emitChunk: (chunk: GitCommandOutputChunk) => void = () => {};
/** Resolves the in-flight runCommand promise. */
let finishRun: (result: GitRunCommandResult) => void = () => {};

function renderModal(
	operation: 'pull' | 'push' = 'pull',
	onClose = vi.fn()
): { onClose: () => void } {
	render(
		<GitCommandRunnerModal
			theme={mockTheme}
			data={{ sessionId: 'session-1', operation, cwd: '/test/repo', branch: 'main' }}
			onClose={onClose}
		/>,
		{ wrapper: TestWrapper }
	);
	return { onClose };
}

/** Push a chunk through the subscriber the modal registered. */
function stream(chunk: string, streamName: 'stdout' | 'stderr' = 'stdout') {
	act(() => {
		emitChunk({ runId: currentRunId, stream: streamName, chunk });
	});
}

let currentRunId = '';

describe('GitCommandRunnerModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		currentRunId = '';

		vi.mocked(gitService.onCommandOutput).mockImplementation((callback) => {
			emitChunk = callback;
			return vi.fn();
		});
		vi.mocked(gitService.runCommand).mockImplementation((options) => {
			currentRunId = options.runId;
			return new Promise<GitRunCommandResult>((resolve) => {
				finishRun = resolve;
			});
		});

		// The modal names the agent it is transferring for, so the store has to
		// hold the agent the payload points at.
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'session-1', name: 'Sonoma-Fix' })],
		} as never);
	});

	it('starts the requested operation exactly once', async () => {
		renderModal('push');

		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalledTimes(1));
		expect(gitService.runCommand).toHaveBeenCalledWith(
			expect.objectContaining({ operation: 'push', cwd: '/test/repo', setUpstream: false })
		);
		expect(screen.getByText('git push')).toBeInTheDocument();
	});

	// Pull/Push are reachable by right-clicking any Left Bar row, so the target
	// is frequently not the highlighted agent. "git push" alone names nothing.
	it('names the agent the command targets', async () => {
		renderModal('push');

		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalled());
		expect(screen.getByTestId('modal-subtitle')).toHaveTextContent('Sonoma-Fix');
	});

	it('keeps the command line as the title rather than folding the name into it', async () => {
		// The title is the aria-label and seeds the fallback resize key, so a
		// per-agent title would mint a per-agent persisted window size.
		renderModal('push');

		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalled());
		expect(screen.getByText('git push')).toBeInTheDocument();
		expect(screen.queryByText(/git push . Sonoma-Fix/)).not.toBeInTheDocument();
		// The concrete consequence of folding the name into the title: the
		// persisted-size key is title-derived when no explicit key is passed, so
		// a per-agent title would give every agent its own remembered size.
		expect(document.querySelector('[data-modal-resize-key]')).toHaveAttribute(
			'data-modal-resize-key',
			'modal-git-command-runner'
		);
	});

	// `subtitle={agent && agent.name}` yields `false` when the agent is missing,
	// which must not paint a bare separator with nothing after it.
	it('renders no separator for a falsy subtitle', async () => {
		useSessionStore.setState({ sessions: [] } as never);
		renderModal('pull');

		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalled());
		expect(screen.queryByText(/·/)).not.toBeInTheDocument();
	});

	it('renders no subtitle when the agent is gone', async () => {
		useSessionStore.setState({ sessions: [] } as never);
		renderModal('pull');

		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalled());
		expect(screen.queryByTestId('modal-subtitle')).not.toBeInTheDocument();
		expect(screen.getByText('git pull')).toBeInTheDocument();
	});

	it('renders streamed output as it arrives', async () => {
		renderModal();
		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalled());

		stream('remote: Enumerating objects\n', 'stderr');
		stream('Fast-forward\n');

		const console = screen.getByTestId('git-command-output');
		expect(console).toHaveTextContent('remote: Enumerating objects');
		expect(console).toHaveTextContent('Fast-forward');
	});

	it('collapses carriage-return progress lines like a terminal does', async () => {
		renderModal();
		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalled());

		stream('Receiving objects:  10%\rReceiving objects: 100%', 'stderr');

		const console = screen.getByTestId('git-command-output');
		expect(console.textContent).toBe('Receiving objects: 100%');
	});

	it('reports success and refreshes git status when the command finishes', async () => {
		renderModal();
		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalled());

		await act(async () => {
			finishRun({ success: true, exitCode: 0, cancelled: false });
		});

		expect(await screen.findByText('Done')).toBeInTheDocument();
		expect(mockRefreshGitStatus).toHaveBeenCalled();
	});

	it('shows the error text when the command fails', async () => {
		renderModal();
		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalled());

		await act(async () => {
			finishRun({
				success: false,
				exitCode: 1,
				cancelled: false,
				error: 'fatal: could not read from remote repository',
			});
		});

		expect(
			await screen.findByText('fatal: could not read from remote repository')
		).toBeInTheDocument();
	});

	it('cancels the run through the Cancel button', async () => {
		renderModal();
		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalled());

		fireEvent.click(screen.getByText('Cancel'));

		expect(gitService.cancelCommand).toHaveBeenCalledWith(currentRunId);
	});

	it('offers a set-upstream retry when a push has no upstream branch', async () => {
		renderModal('push');
		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalled());

		await act(async () => {
			finishRun({
				success: false,
				exitCode: 128,
				cancelled: false,
				error: 'fatal: The current branch main has no upstream branch.',
			});
		});

		fireEvent.click(await screen.findByText('Push and Set Upstream'));

		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalledTimes(2));
		expect(gitService.runCommand).toHaveBeenLastCalledWith(
			expect.objectContaining({ operation: 'push', setUpstream: true })
		);
	});

	it('does not offer the upstream retry for an unrelated push failure', async () => {
		renderModal('push');
		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalled());

		await act(async () => {
			finishRun({
				success: false,
				exitCode: 1,
				cancelled: false,
				error: 'error: failed to push some refs',
			});
		});

		expect(screen.queryByText('Push and Set Upstream')).not.toBeInTheDocument();
	});
});
