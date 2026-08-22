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
import { useGitCommandRunStore } from '../../../renderer/stores/gitCommandRunStore';
import { mockTheme } from '../../helpers/mockTheme';
import type { GitCommandOutputChunk, GitRunCommandResult } from '../../../shared/gitUtils';

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		runCommand: vi.fn(),
		cancelCommand: vi.fn(),
		onCommandOutput: vi.fn(),
	},
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
): { onClose: ReturnType<typeof vi.fn>; unmount: () => void } {
	const { unmount } = render(
		<GitCommandRunnerModal
			theme={mockTheme}
			data={{ sessionId: 'session-1', operation, cwd: '/test/repo', branch: 'main' }}
			onClose={onClose}
		/>,
		{ wrapper: TestWrapper }
	);
	return { onClose, unmount };
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
		// The run outlives the modal, so it also outlives a test.
		useGitCommandRunStore.setState({ runs: {} });

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
	});

	it('starts the requested operation exactly once', async () => {
		renderModal('push');

		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalledTimes(1));
		expect(gitService.runCommand).toHaveBeenCalledWith(
			expect.objectContaining({ operation: 'push', cwd: '/test/repo', setUpstream: false })
		);
		expect(screen.getByText('git push')).toBeInTheDocument();
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

	it('reports success when the command finishes', async () => {
		renderModal();
		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalled());

		await act(async () => {
			finishRun({ success: true, exitCode: 0, cancelled: false });
		});

		expect(await screen.findByText('Done')).toBeInTheDocument();
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

	it('leaves the command running when the console is closed', async () => {
		const { onClose, unmount } = renderModal('push');
		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalled());

		// Close is not Cancel: a push mid-transfer should finish.
		fireEvent.click(screen.getByTestId('git-command-close'));
		expect(onClose).toHaveBeenCalled();
		expect(gitService.cancelCommand).not.toHaveBeenCalled();

		unmount();
		expect(useGitCommandRunStore.getState().runs['push:local:/test/repo']?.status).toBe('running');
	});

	it('re-attaches to a running command instead of starting a second one', async () => {
		const first = renderModal('push');
		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalledTimes(1));
		stream('Enumerating objects: 42\n', 'stderr');
		first.unmount();

		// Output kept arriving while nothing was on screen.
		stream('Writing objects: 100%\n', 'stderr');

		renderModal('push');
		const console = screen.getByTestId('git-command-output');
		expect(console).toHaveTextContent('Enumerating objects: 42');
		expect(console).toHaveTextContent('Writing objects: 100%');
		expect(gitService.runCommand).toHaveBeenCalledTimes(1);
	});

	it('starts a fresh run after a finished one is closed', async () => {
		const first = renderModal('push');
		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalledTimes(1));
		await act(async () => {
			finishRun({ success: true, exitCode: 0, cancelled: false });
		});

		fireEvent.click(screen.getByTestId('git-command-close'));
		first.unmount();
		expect(useGitCommandRunStore.getState().runs['push:local:/test/repo']).toBeUndefined();

		renderModal('push');
		await waitFor(() => expect(gitService.runCommand).toHaveBeenCalledTimes(2));
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
