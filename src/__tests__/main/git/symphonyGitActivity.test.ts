import fs from 'fs/promises';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../../main/utils/execFile';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { resolveGhPath } from '../../../main/utils/cliDetection';
import { getExpandedEnv } from '../../../main/agents/path-prober';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn(), mkdir: vi.fn(), rm: vi.fn() } }));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/cliDetection', () => ({ resolveGhPath: vi.fn() }));
vi.mock('../../../main/agents/path-prober', () => ({ getExpandedEnv: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

const root = path.resolve('symphony-activity-target');
const sibling = path.resolve('symphony-activity-sibling');
const ok: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
const failed: ExecResult = { stdout: '', stderr: 'cancelled', exitCode: 'SIGTERM' };
let gate: typeof import('../../../main/git/worktreeActivity');
let fork: typeof import('../../../main/utils/symphony-fork');
let shared: typeof import('../../../main/ipc/handlers/symphony/shared');
let runner: typeof import('../../../main/services/symphony-runner');

beforeEach(async () => {
	vi.resetModules();
	vi.mocked(fs.realpath)
		.mockReset()
		.mockImplementation(async (p) => String(p));
	vi.mocked(fs.mkdir).mockReset().mockResolvedValue(undefined);
	vi.mocked(fs.rm).mockReset().mockResolvedValue(undefined);
	vi.mocked(resolveGhPath).mockReset().mockResolvedValue('gh');
	vi.mocked(getExpandedEnv).mockReset().mockReturnValue({ PATH: '/usr/bin' });
	vi.mocked(execFileNoThrow)
		.mockReset()
		.mockImplementation(async (_command, args = []) => {
			if (args[0] === 'api' && args[1] === 'user') return { ...ok, stdout: 'contributor' };
			if (args.includes('.clone_url')) return { ...ok, stdout: 'https://github.com/contributor/r' };
			if (args[0] === 'rev-parse') return { ...ok, stdout: 'topic' };
			if (args[0] === 'pr') return { ...ok, stdout: 'https://github.com/owner/r/pull/42' };
			return ok;
		});
	gate = await import('../../../main/git/worktreeActivity');
	fork = await import('../../../main/utils/symphony-fork');
	shared = await import('../../../main/ipc/handlers/symphony/shared');
	runner = await import('../../../main/services/symphony-runner');
});

async function reserve() {
	const hold = await gate.reserveWorktreeCleanup(root);
	expect(hold.status).toBe('reserved-partially');
	if (hold.status !== 'reserved-partially') throw new Error('Reservation failed');
	expect(hold.blockers.length).toBeGreaterThan(0);
	return hold;
}

function run(helper: 'fork' | 'draft', cwd = sibling) {
	return helper === 'fork'
		? fork.ensureForkSetup(cwd, 'owner/r')
		: shared.createDraftPR(cwd, 'main', 'Title', 'Body', 'owner/r', 'contributor');
}

describe.each(['fork', 'draft'] as const)('standalone Symphony %s admission', (helper) => {
	it('refuses before environment/gh/auth setup or recovery under any reservation', async () => {
		const hold = await reserve();
		try {
			for (const cwd of [root, path.join(root, 'child'), sibling, 'unknown'])
				await expect(run(helper, cwd)).rejects.toThrow('reserved');
			expect(getExpandedEnv).not.toHaveBeenCalled();
			expect(resolveGhPath).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
		} finally {
			hold.release();
		}
		(await reserve()).release();
	});

	it('registers synchronously and holds across pending gh setup and all child calls', async () => {
		let resolve!: (value: string) => void;
		vi.mocked(resolveGhPath).mockImplementationOnce(() => new Promise((done) => (resolve = done)));
		const execute = vi.mocked(execFileNoThrow).getMockImplementation()!;
		vi.mocked(execFileNoThrow).mockImplementation(async (...args) => {
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			const result = await execute(...args);
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			return result;
		});
		const pending = run(helper);
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
		await vi.waitFor(() => expect(resolveGhPath).toHaveBeenCalledOnce());
		expect(execFileNoThrow).not.toHaveBeenCalled();
		resolve('gh');
		await expect(pending).resolves.toMatchObject(
			helper === 'fork' ? { isFork: true } : { success: true }
		);
		expect(execFileNoThrow).toHaveBeenCalledTimes(helper === 'fork' ? 7 : 4);
		(await reserve()).release();
	});

	it.each(['env', 'gh', 'child'] as const)('releases after a thrown %s error', async (stage) => {
		if (stage === 'env')
			vi.mocked(getExpandedEnv).mockImplementationOnce(() => {
				throw new Error('setup');
			});
		if (stage === 'gh') vi.mocked(resolveGhPath).mockRejectedValueOnce(new Error('setup'));
		if (stage === 'child') vi.mocked(execFileNoThrow).mockRejectedValueOnce(new Error('setup'));
		await expect(run(helper)).rejects.toThrow('setup');
		(await reserve()).release();
	});

	it('releases after an unsuccessful child result', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValueOnce(failed);
		await expect(run(helper)).resolves.toHaveProperty('error');
		expect(execFileNoThrow).toHaveBeenCalledOnce();
		(await reserve()).release();
	});
});

it.each(['rename', 'set-url', 'add', 'set-head'])(
	'holds fork activity through remote %s',
	async (step) => {
		const execute = vi.mocked(execFileNoThrow).getMockImplementation()!;
		let finish!: (value: ExecResult) => void;
		vi.mocked(execFileNoThrow).mockImplementation((command, args = [], ...rest) => {
			if (step === 'set-url' && args[1] === 'rename') return Promise.resolve(failed);
			if (args[0] === 'remote' && args[1] === step) return new Promise((done) => (finish = done));
			return execute(command, args, ...rest);
		});
		const pending = run('fork');
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
		finish(ok);
		await expect(pending).resolves.toMatchObject({ isFork: true });
		if (step === 'set-url')
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['remote', 'set-url', 'origin', 'https://github.com/contributor/r'],
				sibling
			);
		(await reserve()).release();
	}
);

it.each(['push', 'gh-between-commands', 'rollback', 'rollback-throw'])(
	'holds draft activity through %s and releases after failure',
	async (step) => {
		const execute = vi.mocked(execFileNoThrow).getMockImplementation()!;
		let finish!: (value: ExecResult) => void;
		let reject!: (error: Error) => void;
		if (step === 'gh-between-commands') {
			let calls = 0;
			vi.mocked(resolveGhPath).mockImplementation(async () => {
				if (++calls === 2) {
					expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
					throw new Error('gh disappeared after push');
				}
				return 'gh';
			});
		}
		vi.mocked(execFileNoThrow).mockImplementation((command, args = [], ...rest) => {
			if ((step === 'push' && args[0] === 'push') || args.includes('--delete'))
				return new Promise((done, fail) => {
					finish = done;
					reject = fail;
				});
			if (args[0] === 'pr') return Promise.resolve(failed);
			return execute(command, args, ...rest);
		});
		const pending = run('draft');
		const outcome =
			step === 'gh-between-commands' || step === 'rollback-throw'
				? expect(pending).rejects.toThrow()
				: expect(pending).resolves.toMatchObject({ success: false });
		if (step !== 'gh-between-commands') {
			await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			if (step === 'rollback-throw') reject(new Error('rollback failed'));
			else finish(failed);
		}
		await outcome;
		if (step.startsWith('rollback'))
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['push', 'origin', '--delete', 'topic'],
				sibling
			);
		else
			expect(
				vi.mocked(execFileNoThrow).mock.calls.some(([, args = []]) => args.includes('--delete'))
			).toBe(false);
		(await reserve()).release();
	}
);

it('one failed helper cannot release another pending helper', async () => {
	let finish!: (value: string) => void;
	vi.mocked(resolveGhPath).mockImplementationOnce(() => new Promise((done) => (finish = done)));
	const pending = run('fork');
	await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
	vi.mocked(execFileNoThrow).mockResolvedValueOnce(failed);
	await expect(run('draft')).resolves.toMatchObject({ success: false });
	expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
	finish('gh');
	await pending;
	(await reserve()).release();
});

function runRunner(operation: 'start' | 'finalize' | 'cancel', onStatusChange = vi.fn()) {
	if (operation === 'finalize') return runner.finalizeContribution(sibling, 42, 1, 'Issue');
	if (operation === 'cancel') return runner.cancelContribution(sibling, 42);
	return runner.startContribution({
		contributionId: 'contrib_test',
		repoSlug: 'owner/r',
		repoUrl: 'https://github.com/owner/r',
		issueNumber: 1,
		issueTitle: 'Issue',
		documentPaths: [],
		localPath: sibling,
		branchName: 'topic',
		onStatusChange,
	});
}

describe.each(['start', 'finalize', 'cancel'] as const)(
	'Symphony runner %s admission',
	(operation) => {
		it('refuses before callbacks, setup, children or destructive recovery', async () => {
			const hold = await reserve();
			const status = vi.fn();
			try {
				await expect(runRunner(operation, status)).rejects.toThrow('reserved');
				expect(status).not.toHaveBeenCalled();
				expect(getExpandedEnv).not.toHaveBeenCalled();
				expect(resolveGhPath).not.toHaveBeenCalled();
				expect(execFileNoThrow).not.toHaveBeenCalled();
				expect(fs.mkdir).not.toHaveBeenCalled();
				expect(fs.rm).not.toHaveBeenCalled();
			} finally {
				hold.release();
			}
			(await reserve()).release();
		});

		it('holds one outer activity across callbacks, all children and filesystem completion', async () => {
			const execute = vi.mocked(execFileNoThrow).getMockImplementation()!;
			vi.mocked(execFileNoThrow).mockImplementation(async (...args) => {
				expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
				const result = await execute(...args);
				expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
				return result;
			});
			// These run after nested helper activity has released, or after gh close.
			vi.mocked(fs.mkdir).mockImplementation(async () => {
				expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
				return undefined;
			});
			vi.mocked(fs.rm).mockImplementation(async () => {
				expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			});
			const callbackChecks: Promise<unknown>[] = [];
			const pending = runRunner(
				operation,
				vi.fn((status: string) => {
					// The final running callback has no asynchronous work after it; a
					// reservation's realpath may finish after the whole operation returns.
					if (status !== 'running')
						callbackChecks.push(
							gate.reserveWorktreeCleanup(root).then((hold) => expect(hold.status).toBe('blocked'))
						);
				})
			);
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			await expect(pending).resolves.toMatchObject({ success: true });
			await Promise.all(callbackChecks);
			if (operation === 'start') {
				expect(fs.mkdir).toHaveBeenCalledOnce();
				for (const verb of ['clone', 'checkout', 'config', 'commit', 'push'])
					expect(
						vi.mocked(execFileNoThrow).mock.calls.some(([, args = []]) => args[0] === verb)
					).toBe(true);
			}
			if (operation === 'cancel') {
				expect(execFileNoThrow).toHaveBeenCalledWith(
					'gh',
					['pr', 'close', '42', '--delete-branch'],
					sibling
				);
				expect(fs.rm).toHaveBeenCalledOnce();
			}
			(await reserve()).release();
		});

		it('releases after a child throws, retaining existing error behavior', async () => {
			vi.mocked(execFileNoThrow).mockRejectedValueOnce(new Error('child failed'));
			const pending = runRunner(operation);
			if (operation === 'start') await expect(pending).resolves.toMatchObject({ success: false });
			else await expect(pending).rejects.toThrow('child failed');
			expect(fs.rm).toHaveBeenCalledTimes(operation === 'start' ? 1 : 0);
			(await reserve()).release();
		});
	}
);

it.each(['start', 'cancel'] as const)(
	'retains runner %s activity through failed cleanup',
	async (operation) => {
		if (operation === 'start')
			vi.mocked(execFileNoThrow).mockResolvedValueOnce(ok).mockResolvedValueOnce(failed);
		let reject!: (error: Error) => void;
		vi.mocked(fs.rm).mockImplementationOnce(() => new Promise((_done, fail) => (reject = fail)));
		const pending = runRunner(operation);
		await vi.waitFor(() => expect(fs.rm).toHaveBeenCalledOnce());
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
		reject(new Error('cleanup failed'));
		await expect(pending).resolves.toMatchObject({ success: operation === 'cancel' });
		(await reserve()).release();
	}
);
