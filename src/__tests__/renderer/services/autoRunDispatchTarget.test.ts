/**
 * @file autoRunDispatchTarget.test.ts
 * @description Which agent an Auto Run executes in.
 *
 * One resolver serves the Auto Run window's Go button, `maestro-cli auto-run
 * --worktree`, and a scheduled run fired by Cue. The failures are reported
 * rather than handled here because the callers want different things from
 * them: the Go button falls back or asks for a retry, a scheduled run fails
 * and is kept.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BatchRunConfig, Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { useSessionStore } from '../../../renderer/stores/sessionStore';

vi.mock('../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

import { resolveAutoRunDispatchTarget } from '../../../renderer/services/autoRunDispatchTarget';
import { spawnWorktreeAgentAndDispatch } from '../../../renderer/utils/worktreeSpawn';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { captureException } from '../../../renderer/utils/sentry';

const parent = () =>
	createMockSession({ id: 'parent', name: 'Parent', cwd: '/repo', state: 'idle' }) as Session;

const child = (over: Partial<Session> = {}) =>
	createMockSession({
		id: 'child',
		name: 'nightly',
		cwd: '/repo-wt/nightly',
		parentSessionId: 'parent',
		worktreeBranch: 'nightly',
		state: 'idle',
		...over,
	}) as Session;

const runConfig = (over: Partial<BatchRunConfig> = {}): BatchRunConfig => ({
	documents: [{ id: 'd1', filename: 'plan', resetOnCompletion: false, isDuplicate: false }],
	prompt: 'work the list',
	loopEnabled: false,
	...over,
});

describe('resolveAutoRunDispatchTarget', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSessionStore.setState({ sessions: [parent(), child()] });
	});

	it('runs in the launching agent when there is no worktree target', async () => {
		const result = await resolveAutoRunDispatchTarget(parent(), runConfig());

		expect(result).toEqual({ ok: true, sessionId: 'parent' });
		expect(spawnWorktreeAgentAndDispatch).not.toHaveBeenCalled();
	});

	describe('an already-open worktree agent', () => {
		const target = (over = {}) => ({
			mode: 'existing-open' as const,
			sessionId: 'child',
			createPROnCompletion: false,
			...over,
		});

		it('runs in that agent', async () => {
			const result = await resolveAutoRunDispatchTarget(
				parent(),
				runConfig({ worktreeTarget: target() })
			);

			expect(result).toEqual({ ok: true, sessionId: 'child' });
			expect(spawnWorktreeAgentAndDispatch).not.toHaveBeenCalled();
		});

		it('reports an agent that is gone, without announcing it', async () => {
			useSessionStore.setState({ sessions: [parent()] });

			const result = await resolveAutoRunDispatchTarget(
				parent(),
				runConfig({ worktreeTarget: target() })
			);

			expect(result).toMatchObject({ ok: false, reason: 'target-missing' });
			// The wording is the caller's: the Go button falls back, a scheduled
			// run fails and is kept.
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('reports an agent that is mid-turn', async () => {
			for (const state of ['busy', 'connecting'] as const) {
				useSessionStore.setState({ sessions: [parent(), child({ state })] });

				const result = await resolveAutoRunDispatchTarget(
					parent(),
					runConfig({ worktreeTarget: target() })
				);

				expect(result).toMatchObject({ ok: false, reason: 'target-busy' });
			}
		});

		it('fills in what a pull request needs, from the open worktree', async () => {
			const config = runConfig({
				worktreeTarget: target({ createPROnCompletion: true, baseBranch: 'rc' }),
			});

			await resolveAutoRunDispatchTarget(parent(), config);

			expect(config.worktree).toEqual({
				enabled: true,
				path: '/repo-wt/nightly',
				branchName: 'nightly',
				createPROnCompletion: true,
				prTargetBranch: 'rc',
			});
		});

		it('leaves the pull-request block alone when none was asked for', async () => {
			const config = runConfig({ worktreeTarget: target() });

			await resolveAutoRunDispatchTarget(parent(), config);

			expect(config.worktree).toBeUndefined();
		});
	});

	describe('a worktree that has to be opened or created', () => {
		const target = {
			mode: 'create-new' as const,
			newBranchName: 'nightly',
			createPROnCompletion: false,
		};

		it('runs in the agent the spawn returns', async () => {
			vi.mocked(spawnWorktreeAgentAndDispatch).mockResolvedValue('new-child');
			const config = runConfig({ worktreeTarget: target });

			const result = await resolveAutoRunDispatchTarget(parent(), config);

			expect(result).toEqual({ ok: true, sessionId: 'new-child' });
			expect(spawnWorktreeAgentAndDispatch).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'parent' }),
				config
			);
		});

		// A worktree child cannot parent another worktree: the base path and cwd
		// have to come from the main repository.
		it('spawns from the parent when launched from a worktree child', async () => {
			vi.mocked(spawnWorktreeAgentAndDispatch).mockResolvedValue('new-child');

			await resolveAutoRunDispatchTarget(child(), runConfig({ worktreeTarget: target }));

			expect(vi.mocked(spawnWorktreeAgentAndDispatch).mock.calls[0][0]).toMatchObject({
				id: 'parent',
			});
		});

		it('reports a spawn that already explained itself', async () => {
			vi.mocked(spawnWorktreeAgentAndDispatch).mockResolvedValue(null);

			const result = await resolveAutoRunDispatchTarget(
				parent(),
				runConfig({ worktreeTarget: target })
			);

			expect(result).toEqual({
				ok: false,
				reason: 'spawn-failed',
				message: 'Failed to spawn worktree agent',
			});
			// A null return has raised its own toast inside the spawn helper.
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('reports and announces a spawn that threw', async () => {
			vi.mocked(spawnWorktreeAgentAndDispatch).mockRejectedValue(new Error('git exploded'));

			const result = await resolveAutoRunDispatchTarget(
				parent(),
				runConfig({ worktreeTarget: target })
			);

			expect(result).toEqual({ ok: false, reason: 'spawn-failed', message: 'git exploded' });
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ title: 'Worktree Error', message: 'git exploded' })
			);
			expect(captureException).toHaveBeenCalled();
		});
	});
});
