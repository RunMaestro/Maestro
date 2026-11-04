import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../../main/utils/execFile';
import type { SshRemoteConfig } from '../../../shared/types';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/remote-git', () => ({ execShellRemote: vi.fn() }));
vi.mock('../../../main/runtime/getShellPath', () => ({ getShellPath: vi.fn() }));
vi.mock('../../../main/utils/spawnPath', () => ({ buildSpawnPath: vi.fn() }));
vi.mock('../../../shared/platformDetection', () => ({ isWindows: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
}));

import { execFileNoThrow } from '../../../main/utils/execFile';
import { execShellRemote } from '../../../main/utils/remote-git';
import { getShellPath } from '../../../main/runtime/getShellPath';
import { buildSpawnPath } from '../../../main/utils/spawnPath';
import { isWindows } from '../../../shared/platformDetection';
import { logger } from '../../../main/utils/logger';

const target = path.resolve('setup-cleanup-target');
const context = {
	worktreePath: path.resolve('setup-sibling'),
	mainRepoPath: path.resolve('setup-main'),
	branchName: 'topic',
};
const ok: ExecResult = { stdout: 'ready', stderr: '', exitCode: 0 };
let gate: typeof import('../../../main/git/worktreeActivity');
let runner: typeof import('../../../main/utils/worktree-setup-script');

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	vi.mocked(execFileNoThrow).mockResolvedValue(ok);
	vi.mocked(execShellRemote).mockResolvedValue(ok);
	vi.mocked(getShellPath).mockResolvedValue('shell-path');
	vi.mocked(buildSpawnPath).mockReturnValue('fallback-path');
	vi.mocked(isWindows).mockReturnValue(false);
	gate = await import('../../../main/git/worktreeActivity');
	runner = await import('../../../main/utils/worktree-setup-script');
});

afterEach(() => vi.restoreAllMocks());

async function reserve(root = target) {
	const hold = await gate.reserveWorktreeCleanup(root);
	expect(hold.status).toBe('reserved-partially');
	if (hold.status !== 'reserved-partially') throw new Error('Reservation failed');
	expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
	return hold;
}

async function blocked() {
	expect(await gate.reserveWorktreeCleanup(target)).toMatchObject({
		status: 'blocked',
		blockers: [{ code: 'mutation-busy' }],
	});
}

describe('worktree setup script activity', () => {
	it.each([target, path.join(context.worktreePath, 'child'), context.mainRepoPath])(
		'refuses under a reservation for %s before environment, shell or PATH setup',
		async (root) => {
			const hold = await reserve(root);
			const envRead = vi.fn(() => context.worktreePath);
			await expect(
				runner.runWorktreeSetupScript('setup', {
					...context,
					get worktreePath() {
						return envRead();
					},
				})
			).rejects.toThrow('reserved');
			expect(envRead).not.toHaveBeenCalled();
			for (const mock of [
				getShellPath,
				buildSpawnPath,
				isWindows,
				execFileNoThrow,
				execShellRemote,
				logger.info,
			])
				expect(mock).not.toHaveBeenCalled();
			hold.release();
			expect(await runner.runWorktreeSetupScript('setup', context)).toMatchObject({
				success: true,
			});
			(await reserve()).release();
		}
	);

	it('registers synchronously and holds a pending PATH probe and the child', async () => {
		let pathReady!: (value: string) => void;
		let childReady!: (value: ExecResult) => void;
		vi.mocked(getShellPath).mockImplementationOnce(
			() => new Promise((resolve) => (pathReady = resolve))
		);
		vi.mocked(execFileNoThrow).mockImplementationOnce(
			() => new Promise((resolve) => (childReady = resolve))
		);
		const pending = runner.runWorktreeSetupScript('setup', context);
		await blocked();
		await vi.waitFor(() => expect(getShellPath).toHaveBeenCalledOnce());
		await blocked();
		expect(execFileNoThrow).not.toHaveBeenCalled();
		pathReady('resolved-path');
		await vi.waitFor(() => expect(execFileNoThrow).toHaveBeenCalledOnce());
		await blocked();
		childReady(ok);
		expect(await pending).toMatchObject({ success: true, ran: true });
		(await reserve()).release();
	});

	it('a new script prevents an in-flight reservation from being installed', async () => {
		let canonicalReady!: (value: string) => void;
		let childReady!: (value: ExecResult) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() => new Promise<string>((resolve) => (canonicalReady = resolve))
		);
		const reservation = gate.reserveWorktreeCleanup(target);
		vi.mocked(execFileNoThrow).mockImplementationOnce(
			() => new Promise((resolve) => (childReady = resolve))
		);
		const pending = runner.runWorktreeSetupScript('setup', context);
		canonicalReady(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		await vi.waitFor(() => expect(execFileNoThrow).toHaveBeenCalledOnce());
		childReady(ok);
		await pending;
		(await reserve()).release();
	});

	it.each([0, 1, 'ETIMEDOUT', 'SIGTERM', 'ENOENT'])(
		'holds through child result %s and releases',
		async (exitCode) => {
			vi.mocked(execFileNoThrow).mockImplementationOnce(async () => {
				await blocked();
				return { ...ok, exitCode };
			});
			expect(await runner.runWorktreeSetupScript('setup', context)).toMatchObject({
				success: exitCode === 0,
				ran: true,
				exitCode,
			});
			(await reserve()).release();
		}
	);

	it('holds through failed PATH probing and fallback setup', async () => {
		vi.mocked(getShellPath).mockImplementationOnce(async () => {
			await blocked();
			throw new Error('PATH probe failed');
		});
		expect(await runner.runWorktreeSetupScript('setup', context)).toMatchObject({ success: true });
		expect(execFileNoThrow).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Array),
			context.worktreePath,
			expect.objectContaining({ env: expect.objectContaining({ PATH: 'fallback-path' }) })
		);
		(await reserve()).release();
	});

	it.each(['environment', 'shell', 'fallback', 'child', 'reporting'] as const)(
		'releases after %s setup throws',
		async (stage) => {
			const fail = () => {
				throw new Error('setup failed');
			};
			if (stage === 'shell') vi.mocked(isWindows).mockImplementationOnce(fail);
			if (stage === 'fallback') {
				vi.mocked(getShellPath).mockResolvedValueOnce('');
				vi.mocked(buildSpawnPath).mockImplementationOnce(fail);
			}
			if (stage === 'reporting') {
				vi.mocked(execFileNoThrow).mockResolvedValueOnce({ ...ok, exitCode: 1 });
				vi.mocked(logger.warn).mockImplementationOnce(fail);
			}
			if (stage === 'child')
				vi.mocked(execFileNoThrow).mockImplementationOnce(async () => {
					await blocked();
					return fail();
				});
			const input =
				stage === 'environment'
					? {
							...context,
							get worktreePath(): string {
								return fail();
							},
						}
					: context;
			await expect(runner.runWorktreeSetupScript('setup', input)).rejects.toThrow('setup failed');
			(await reserve()).release();
		}
	);

	it('finishing another script does not release an existing operation', async () => {
		let finish!: (value: ExecResult) => void;
		vi.mocked(execFileNoThrow).mockImplementationOnce(
			() => new Promise((resolve) => (finish = resolve))
		);
		const first = runner.runWorktreeSetupScript('first', context);
		await vi.waitFor(() => expect(execFileNoThrow).toHaveBeenCalledOnce());
		await runner.runWorktreeSetupScript('second', context);
		await blocked();
		finish(ok);
		await first;
		(await reserve()).release();
	});

	it.each([undefined, '', ' \n '])(
		'keeps an unconfigured script %s a no-op under a reservation',
		async (script) => {
			const hold = await reserve();
			expect(await runner.runWorktreeSetupScript(script, context)).toMatchObject({
				success: true,
				ran: false,
			});
			expect(getShellPath).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
			hold.release();
		}
	);

	it('preserves SSH execution without local inspection or exclusion claims', async () => {
		const remote: SshRemoteConfig = {
			id: 'remote',
			name: 'Remote',
			host: 'host',
			port: 22,
			username: 'dev',
			privateKeyPath: '',
			enabled: true,
		};
		const hold = await reserve();
		vi.mocked(fs.realpath).mockClear();
		expect(await runner.runWorktreeSetupScript('setup', context, remote)).toMatchObject({
			success: true,
		});
		expect(execShellRemote).toHaveBeenCalledWith(
			'setup',
			remote,
			expect.objectContaining({ cwd: context.worktreePath })
		);
		expect(fs.realpath).not.toHaveBeenCalled();
		expect(getShellPath).not.toHaveBeenCalled();
		expect(execFileNoThrow).not.toHaveBeenCalled();
		hold.release();
	});
});
