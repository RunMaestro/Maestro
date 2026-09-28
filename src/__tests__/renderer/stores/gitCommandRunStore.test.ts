/**
 * Tests for gitCommandRunStore - the git pull/push/fetch runs that outlive
 * their console modal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gitService } from '../../../renderer/services/git';
import { useGitCommandRunStore, gitRunKey } from '../../../renderer/stores/gitCommandRunStore';
import type { GitCommandOutputChunk, GitRunCommandResult } from '../../../shared/gitUtils';

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		runCommand: vi.fn(),
		cancelCommand: vi.fn(),
		onCommandOutput: vi.fn(),
	},
}));

const TARGET = {
	sessionId: 'session-1',
	operation: 'push' as const,
	cwd: '/test/repo',
	branch: 'main',
};
const KEY = gitRunKey(TARGET);

/** The store's chunk handler, captured on its one-time subscribe. */
let emitChunk: (chunk: GitCommandOutputChunk) => void = () => {};
let settleRun: (result: GitRunCommandResult) => void = () => {};
let lastRunId = '';

const runOf = (key = KEY) => useGitCommandRunStore.getState().runs[key];

describe('gitCommandRunStore', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useGitCommandRunStore.setState({ runs: {} });

		vi.mocked(gitService.onCommandOutput).mockImplementation((callback) => {
			emitChunk = callback;
			return vi.fn();
		});
		vi.mocked(gitService.runCommand).mockImplementation((options) => {
			lastRunId = options.runId;
			return new Promise<GitRunCommandResult>((resolve) => {
				settleRun = resolve;
			});
		});
	});

	it('starts one run per operation and repo', () => {
		useGitCommandRunStore.getState().startRun(TARGET);
		useGitCommandRunStore.getState().startRun(TARGET);

		expect(gitService.runCommand).toHaveBeenCalledTimes(1);
		expect(runOf().status).toBe('running');
	});

	it('runs the same operation on a different repo concurrently', () => {
		useGitCommandRunStore.getState().startRun(TARGET);
		useGitCommandRunStore.getState().startRun({ ...TARGET, cwd: '/other/repo' });

		expect(gitService.runCommand).toHaveBeenCalledTimes(2);
		expect(runOf().status).toBe('running');
		expect(runOf(gitRunKey({ ...TARGET, cwd: '/other/repo' })).status).toBe('running');
	});

	it('accumulates streamed output for its own attempt only', () => {
		useGitCommandRunStore.getState().startRun(TARGET);

		emitChunk({ runId: lastRunId, stream: 'stderr', chunk: 'Enumerating objects\n' });
		emitChunk({ runId: 'some-other-run', stream: 'stdout', chunk: 'not mine\n' });

		expect(runOf().output).toBe('Enumerating objects\n');
	});

	it('records the outcome when the command settles', async () => {
		useGitCommandRunStore.getState().startRun(TARGET);
		settleRun({ success: false, exitCode: 1, cancelled: false, error: 'rejected' });
		await vi.waitFor(() => expect(runOf().status).toBe('failed'));

		expect(runOf().error).toBe('rejected');
		expect(runOf().announced).toBe(false);
	});

	it('cancels through the service and reports the cancelled outcome', async () => {
		useGitCommandRunStore.getState().startRun(TARGET);
		useGitCommandRunStore.getState().cancelRun(KEY);

		expect(gitService.cancelCommand).toHaveBeenCalledWith(lastRunId);

		settleRun({ success: false, exitCode: 'SIGTERM', cancelled: true });
		await vi.waitFor(() => expect(runOf().status).toBe('cancelled'));
	});

	it('ignores a cancel for a run that already settled', async () => {
		useGitCommandRunStore.getState().startRun(TARGET);
		settleRun({ success: true, exitCode: 0, cancelled: false });
		await vi.waitFor(() => expect(runOf().status).toBe('success'));

		useGitCommandRunStore.getState().cancelRun(KEY);
		expect(gitService.cancelCommand).not.toHaveBeenCalled();
	});

	it('retries with a fresh transcript when setting upstream', async () => {
		useGitCommandRunStore.getState().startRun(TARGET);
		emitChunk({ runId: lastRunId, stream: 'stderr', chunk: 'no upstream branch\n' });
		const firstRunId = lastRunId;
		settleRun({ success: false, exitCode: 128, cancelled: false, error: 'no upstream branch' });
		await vi.waitFor(() => expect(runOf().status).toBe('failed'));

		useGitCommandRunStore.getState().retryWithUpstream(KEY);

		expect(gitService.runCommand).toHaveBeenLastCalledWith(
			expect.objectContaining({ setUpstream: true })
		);
		expect(runOf().output).toBe('');
		expect(runOf().status).toBe('running');

		// A late chunk from the abandoned attempt must not bleed into the retry.
		emitChunk({ runId: firstRunId, stream: 'stderr', chunk: 'stale\n' });
		expect(runOf().output).toBe('');
	});

	it('drops a settled result whose run was already cleared', async () => {
		useGitCommandRunStore.getState().startRun(TARGET);
		useGitCommandRunStore.getState().clearRun(KEY);

		settleRun({ success: true, exitCode: 0, cancelled: false });
		await Promise.resolve();

		expect(runOf()).toBeUndefined();
	});
});
