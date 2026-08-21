/**
 * @file worktreeSetupScript.test.ts
 * @description Unit tests for the renderer-side post-create setup script runner.
 *
 * Covers script resolution (explicit parent session vs lookup by repo path),
 * the no-op path, and the toast surfaces for success and failure.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Session } from '../../../renderer/types';

const notifyToast = vi.fn();
vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => notifyToast(...args),
}));

const sessions: Session[] = [];
vi.mock('../../../renderer/stores/sessionStore', () => ({
	useSessionStore: { getState: () => ({ sessions }) },
}));

import { runWorktreeSetupScript } from '../../../renderer/utils/worktreeSetupScript';

const worktreeRunSetup = vi.fn();

function makeSession(overrides: Partial<Session>): Session {
	return {
		id: 'parent-1',
		cwd: '/repos/app',
		worktreeConfig: { basePath: '/repos/worktrees', watchEnabled: true },
		...overrides,
	} as Session;
}

const ARGS = {
	mainRepoPath: '/repos/app',
	worktreePath: '/repos/worktrees/feature-x',
	branchName: 'feature-x',
};

beforeEach(() => {
	vi.clearAllMocks();
	sessions.length = 0;
	worktreeRunSetup.mockResolvedValue({ success: true, ran: true, stdout: '', stderr: '' });
	(globalThis as any).window = { maestro: { git: { worktreeRunSetup } } };
});

describe('runWorktreeSetupScript', () => {
	it('does nothing when the parent agent has no setup script', async () => {
		const parentSession = makeSession({});

		const ran = await runWorktreeSetupScript({ ...ARGS, parentSession });

		expect(ran).toBe(false);
		expect(worktreeRunSetup).not.toHaveBeenCalled();
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('does nothing when the configured script is only whitespace', async () => {
		const parentSession = makeSession({
			worktreeConfig: { basePath: '/repos/worktrees', watchEnabled: true, setupScript: '  ' },
		});

		expect(await runWorktreeSetupScript({ ...ARGS, parentSession })).toBe(false);
		expect(worktreeRunSetup).not.toHaveBeenCalled();
	});

	it('runs the configured script with the worktree context', async () => {
		const parentSession = makeSession({
			worktreeConfig: {
				basePath: '/repos/worktrees',
				watchEnabled: true,
				setupScript: './setup.sh',
			},
		});

		const ran = await runWorktreeSetupScript({
			...ARGS,
			parentSession,
			baseBranch: 'main',
			sshRemoteId: 'remote-1',
		});

		expect(ran).toBe(true);
		expect(worktreeRunSetup).toHaveBeenCalledWith(
			'./setup.sh',
			{
				worktreePath: '/repos/worktrees/feature-x',
				branchName: 'feature-x',
				mainRepoPath: '/repos/app',
				baseBranch: 'main',
			},
			'remote-1'
		);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'success', title: 'Worktree Setup Complete' })
		);
	});

	it('resolves the owning agent from the repo path when no session is passed', async () => {
		sessions.push(
			makeSession({
				worktreeConfig: {
					basePath: '/repos/worktrees',
					watchEnabled: true,
					setupScript: 'npm ci',
				},
			})
		);

		expect(await runWorktreeSetupScript(ARGS)).toBe(true);
		expect(worktreeRunSetup).toHaveBeenCalledWith('npm ci', expect.anything(), undefined);
	});

	it('ignores worktree child agents when resolving by repo path', async () => {
		sessions.push(
			makeSession({
				id: 'child-1',
				parentSessionId: 'parent-1',
				worktreeConfig: {
					basePath: '/repos/worktrees',
					watchEnabled: true,
					setupScript: 'npm ci',
				},
			})
		);

		expect(await runWorktreeSetupScript(ARGS)).toBe(false);
		expect(worktreeRunSetup).not.toHaveBeenCalled();
	});

	it('reports a failing script as an error toast without throwing', async () => {
		worktreeRunSetup.mockResolvedValue({
			success: false,
			ran: true,
			stdout: '',
			stderr: 'boom',
			error: 'setup.sh: not found',
		});
		const parentSession = makeSession({
			worktreeConfig: {
				basePath: '/repos/worktrees',
				watchEnabled: true,
				setupScript: './setup.sh',
			},
		});

		expect(await runWorktreeSetupScript({ ...ARGS, parentSession })).toBe(false);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				title: 'Worktree Setup Script Failed',
				message: 'setup.sh: not found',
			})
		);
	});

	it('swallows IPC rejections so worktree creation still completes', async () => {
		worktreeRunSetup.mockRejectedValue(new Error('ipc exploded'));
		const parentSession = makeSession({
			worktreeConfig: {
				basePath: '/repos/worktrees',
				watchEnabled: true,
				setupScript: './setup.sh',
			},
		});

		expect(await runWorktreeSetupScript({ ...ARGS, parentSession })).toBe(false);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'error', message: 'ipc exploded' })
		);
	});
});
