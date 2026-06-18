/**
 * Tests for useAutoRun (web mobile).
 *
 * Covers:
 * - launchAutoRun forwards the optional `worktree` payload through
 *   `configure_auto_run` and returns a Promise<LaunchAutoRunResult>.
 * - launchAutoRun resolves with success=false (and an error message) when the
 *   server reports failure or the request rejects — used by the mobile App
 *   to revert the optimistic "connecting" indicator (Gap 1).
 * - loadGitBranches dispatches `get_git_branches` and unwraps the response.
 * - listWorktrees dispatches `list_worktrees` and unwraps the response.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useAutoRun,
	type LaunchWorktreeConfig,
	type Playbook,
	type PlaybookDraft,
} from '../../../web/hooks/useAutoRun';

const playbook: Playbook = {
	id: 'playbook-1',
	name: 'Daily',
	createdAt: 1,
	updatedAt: 2,
	documents: [{ filename: 'plan.md', resetOnCompletion: true }],
	loopEnabled: false,
	maxLoops: null,
	prompt: 'Run it',
};

const playbookDraft: PlaybookDraft = {
	name: 'Daily',
	documents: [{ filename: 'plan.md', resetOnCompletion: true }],
	loopEnabled: false,
	maxLoops: null,
	prompt: 'Run it',
};

describe('useAutoRun (mobile/web)', () => {
	const send = vi.fn().mockReturnValue(true);
	const sendRequest = vi.fn();

	beforeEach(() => {
		send.mockClear();
		sendRequest.mockReset();
		sendRequest.mockResolvedValue({ success: true });
	});

	describe('launchAutoRun', () => {
		it('omits worktree when none is supplied and resolves with the server result', async () => {
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			let response: { success: boolean; error?: string } | undefined;
			await act(async () => {
				response = await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
					prompt: 'p',
				});
			});

			expect(sendRequest).toHaveBeenCalledTimes(1);
			expect(sendRequest).toHaveBeenCalledWith(
				'configure_auto_run',
				{
					sessionId: 's-1',
					documents: [{ filename: 'doc.md' }],
					prompt: 'p',
					loopEnabled: undefined,
					maxLoops: undefined,
					launch: true,
				},
				10_000
			);
			expect(response).toEqual({ success: true, error: undefined });
		});

		it('uses an extended timeout when worktree dispatch is enabled', async () => {
			const worktree: LaunchWorktreeConfig = {
				enabled: true,
				path: '/repo/worktrees/auto-run-main-0503',
				branchName: 'auto-run-main-0503',
				createPROnCompletion: false,
				prTargetBranch: 'main',
			};
			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			await act(async () => {
				await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
					worktree,
				});
			});

			expect(sendRequest.mock.calls[0][2]).toBe(60_000);
		});

		it('uses the default timeout when worktree dispatch is disabled', async () => {
			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			await act(async () => {
				await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
					worktree: {
						enabled: false,
						path: '/x',
						branchName: 'b',
						createPROnCompletion: false,
						prTargetBranch: 'main',
					},
				});
			});

			expect(sendRequest.mock.calls[0][2]).toBe(10_000);
		});

		it('forwards worktree config when enabled', async () => {
			const worktree: LaunchWorktreeConfig = {
				enabled: true,
				path: '/repo/worktrees/auto-run-main-0503',
				branchName: 'auto-run-main-0503',
				createPROnCompletion: true,
				prTargetBranch: 'main',
			};

			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			await act(async () => {
				await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
					worktree,
				});
			});

			const payload = sendRequest.mock.calls[0][1];
			expect(payload.worktree).toEqual(worktree);
		});

		it('strips a disabled worktree config', async () => {
			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			await act(async () => {
				await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
					worktree: {
						enabled: false,
						path: '/x',
						branchName: 'b',
						createPROnCompletion: false,
						prTargetBranch: 'main',
					},
				});
			});
			expect(sendRequest.mock.calls[0][1].worktree).toBeUndefined();
		});

		it('returns success=false when the server reports an error', async () => {
			sendRequest.mockResolvedValueOnce({ success: false, error: 'Bad request' });
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			let response: { success: boolean; error?: string } | undefined;
			await act(async () => {
				response = await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
				});
			});

			expect(response).toEqual({ success: false, error: 'Bad request' });
		});

		it('returns success=false when sendRequest rejects with a known transport error', async () => {
			sendRequest.mockRejectedValueOnce(new Error('Request timed out'));
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			let response: { success: boolean; error?: string } | undefined;
			await act(async () => {
				response = await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
				});
			});

			expect(response).toEqual({ success: false, error: 'Request timed out' });
		});

		it('also handles WebSocket-not-connected as a known transport failure', async () => {
			sendRequest.mockRejectedValueOnce(new Error('WebSocket not connected'));
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			let response: { success: boolean; error?: string } | undefined;
			await act(async () => {
				response = await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
				});
			});

			expect(response).toEqual({ success: false, error: 'WebSocket not connected' });
		});

		it('re-throws unexpected errors so they bubble to global handlers / Sentry', async () => {
			const unexpected = new Error('Some non-transport bug');
			sendRequest.mockRejectedValueOnce(unexpected);
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			await expect(
				result.current.launchAutoRun('s-1', { documents: [{ filename: 'doc.md' }] })
			).rejects.toBe(unexpected);
		});

		it('treats a missing success field as failure', async () => {
			sendRequest.mockResolvedValueOnce({});
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			let response: { success: boolean; error?: string } | undefined;
			await act(async () => {
				response = await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
				});
			});

			expect(response).toEqual({ success: false, error: undefined });
		});
	});

	describe('loadGitBranches', () => {
		it('sends get_git_branches and returns branches list', async () => {
			sendRequest.mockResolvedValueOnce({
				branches: ['main', 'feature/x'],
				currentBranch: 'main',
			});

			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			const out = await result.current.loadGitBranches('s-1');

			expect(sendRequest).toHaveBeenCalledWith('get_git_branches', { sessionId: 's-1' });
			expect(out).toEqual({ branches: ['main', 'feature/x'], currentBranch: 'main' });
		});

		it('propagates transport errors to the caller', async () => {
			sendRequest.mockRejectedValueOnce(new Error('boom'));
			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			await expect(result.current.loadGitBranches('s-1')).rejects.toThrow('boom');
		});
	});

	describe('listWorktrees', () => {
		it('sends list_worktrees and unwraps response', async () => {
			sendRequest.mockResolvedValueOnce({
				worktrees: [{ path: '/repo/wt-1', branch: 'feat/x', isBare: false }],
			});

			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			const out = await result.current.listWorktrees('s-1');

			expect(sendRequest).toHaveBeenCalledWith('list_worktrees', { sessionId: 's-1' });
			expect(out).toEqual([{ path: '/repo/wt-1', branch: 'feat/x', isBare: false }]);
		});

		it('propagates transport errors to the caller', async () => {
			sendRequest.mockRejectedValueOnce(new Error('boom'));
			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			await expect(result.current.listWorktrees('s-1')).rejects.toThrow('boom');
		});
	});

	describe('documents and controls', () => {
		it('loads documents, reads content, and exposes provided Auto Run state', async () => {
			sendRequest.mockImplementation(async (type: string) => {
				if (type === 'get_auto_run_docs') {
					return {
						documents: [
							{
								filename: 'plan.md',
								path: '/repo/.maestro/plan.md',
								taskCount: 2,
								completedCount: 1,
							},
						],
					};
				}
				if (type === 'get_auto_run_document') return { content: '# Plan' };
				return { success: true };
			});

			const autoRunState = {
				isRunning: true,
				currentDocument: 'plan.md',
				currentTask: 'Task',
				completedTasks: 1,
				totalTasks: 2,
			} as any;
			const { result } = renderHook(() => useAutoRun(sendRequest, send, autoRunState));

			await act(async () => {
				await result.current.loadDocuments('s-1');
				await result.current.loadDocumentContent('s-1', 'plan.md');
			});

			expect(result.current.autoRunState).toBe(autoRunState);
			expect(result.current.documents).toEqual([
				{
					filename: 'plan.md',
					path: '/repo/.maestro/plan.md',
					taskCount: 2,
					completedCount: 1,
				},
			]);
			expect(result.current.selectedDoc).toEqual({ filename: 'plan.md', content: '# Plan' });
			expect(result.current.isLoadingDocs).toBe(false);
			expect(sendRequest).toHaveBeenCalledWith('get_auto_run_docs', { sessionId: 's-1' });
			expect(sendRequest).toHaveBeenCalledWith('get_auto_run_document', {
				sessionId: 's-1',
				filename: 'plan.md',
			});
		});

		it('saves, resets, stops, and recovers Auto Run actions', async () => {
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			await act(async () => {
				await expect(
					result.current.saveDocumentContent('s-1', 'plan.md', '# Updated')
				).resolves.toBe(true);
				await expect(result.current.resetDocumentTasks('s-1', 'plan.md')).resolves.toBe(true);
				await expect(result.current.stopAutoRun('s-1')).resolves.toBe(true);
				await expect(result.current.resumeAutoRunError('s-1')).resolves.toBe(true);
				await expect(result.current.skipAutoRunDocument('s-1')).resolves.toBe(true);
				await expect(result.current.abortAutoRunError('s-1')).resolves.toBe(true);
			});

			expect(sendRequest).toHaveBeenCalledWith('save_auto_run_document', {
				sessionId: 's-1',
				filename: 'plan.md',
				content: '# Updated',
			});
			expect(sendRequest).toHaveBeenCalledWith('reset_auto_run_doc_tasks', {
				sessionId: 's-1',
				filename: 'plan.md',
			});
			expect(sendRequest).toHaveBeenCalledWith('stop_auto_run', { sessionId: 's-1' });
			expect(sendRequest).toHaveBeenCalledWith('resume_auto_run_error', { sessionId: 's-1' });
			expect(sendRequest).toHaveBeenCalledWith('skip_auto_run_document', { sessionId: 's-1' });
			expect(sendRequest).toHaveBeenCalledWith('abort_auto_run_error', { sessionId: 's-1' });
		});

		it('uses safe document and control fallbacks on failures', async () => {
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			sendRequest.mockRejectedValueOnce(new Error('offline'));
			await act(async () => {
				await result.current.loadDocuments('s-1');
			});
			expect(result.current.documents).toEqual([]);

			sendRequest.mockRejectedValueOnce(new Error('offline'));
			await act(async () => {
				await result.current.loadDocumentContent('s-1', 'plan.md');
			});
			expect(result.current.selectedDoc).toEqual({ filename: 'plan.md', content: '' });

			sendRequest.mockRejectedValue(new Error('offline'));
			await act(async () => {
				await expect(
					result.current.saveDocumentContent('s-1', 'plan.md', '# Updated')
				).resolves.toBe(false);
				await expect(result.current.resetDocumentTasks('s-1', 'plan.md')).resolves.toBe(false);
				await expect(result.current.stopAutoRun('s-1')).resolves.toBe(false);
				await expect(result.current.resumeAutoRunError('s-1')).resolves.toBe(false);
				await expect(result.current.skipAutoRunDocument('s-1')).resolves.toBe(false);
				await expect(result.current.abortAutoRunError('s-1')).resolves.toBe(false);
			});
		});
	});

	describe('playbooks', () => {
		it('loads, creates, updates, and deletes playbooks', async () => {
			const updatedPlaybook = { ...playbook, name: 'Updated' };
			sendRequest.mockImplementation(async (type: string) => {
				if (type === 'list_playbooks') return { playbooks: [playbook] };
				if (type === 'create_playbook') return { success: true, playbook };
				if (type === 'update_playbook') return { success: true, playbook: updatedPlaybook };
				if (type === 'delete_playbook') return { success: true };
				return { success: true };
			});
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			await act(async () => {
				await result.current.loadPlaybooks('s-1');
			});
			expect(result.current.playbooks).toEqual([playbook]);
			expect(result.current.isLoadingPlaybooks).toBe(false);

			await act(async () => {
				await expect(result.current.createPlaybook('s-1', playbookDraft)).resolves.toEqual(
					playbook
				);
				await expect(
					result.current.updatePlaybook('s-1', 'playbook-1', { name: 'Updated' })
				).resolves.toEqual(updatedPlaybook);
				await expect(result.current.deletePlaybook('s-1', 'playbook-1')).resolves.toBe(true);
			});

			expect(result.current.playbooks).toEqual([]);
			expect(sendRequest).toHaveBeenCalledWith('list_playbooks', { sessionId: 's-1' });
			expect(sendRequest).toHaveBeenCalledWith('create_playbook', {
				sessionId: 's-1',
				playbook: playbookDraft,
			});
			expect(sendRequest).toHaveBeenCalledWith('update_playbook', {
				sessionId: 's-1',
				playbookId: 'playbook-1',
				updates: { name: 'Updated' },
			});
			expect(sendRequest).toHaveBeenCalledWith('delete_playbook', {
				sessionId: 's-1',
				playbookId: 'playbook-1',
			});
		});

		it('uses safe playbook fallbacks on malformed responses and failures', async () => {
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			sendRequest.mockResolvedValueOnce({ playbooks: null });
			await act(async () => {
				await result.current.loadPlaybooks('s-1');
			});
			expect(result.current.playbooks).toEqual([]);

			sendRequest.mockResolvedValueOnce({ success: true, playbook: null });
			sendRequest.mockResolvedValueOnce({ success: true, playbook: null });
			sendRequest.mockResolvedValueOnce({ success: false });
			await act(async () => {
				await expect(result.current.createPlaybook('s-1', playbookDraft)).resolves.toBeNull();
				await expect(
					result.current.updatePlaybook('s-1', 'playbook-1', { name: 'Updated' })
				).resolves.toBeNull();
				await expect(result.current.deletePlaybook('s-1', 'playbook-1')).resolves.toBe(false);
			});

			sendRequest.mockRejectedValue(new Error('offline'));
			await act(async () => {
				await result.current.loadPlaybooks('s-1');
				await expect(result.current.createPlaybook('s-1', playbookDraft)).resolves.toBeNull();
				await expect(
					result.current.updatePlaybook('s-1', 'playbook-1', { name: 'Updated' })
				).resolves.toBeNull();
				await expect(result.current.deletePlaybook('s-1', 'playbook-1')).resolves.toBe(false);
			});
			expect(result.current.playbooks).toEqual([]);
			expect(result.current.isLoadingPlaybooks).toBe(false);
		});
	});
});
