import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileNoThrow, type ExecResult } from '../../../main/utils/execFile';
import { buildSshCommand } from '../../../main/utils/ssh-command-builder';
import { getSshRemoteById } from '../../../main/stores';
import type { GitHandlerDependencies } from '../../../main/ipc/handlers/git/shared';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('../../../main/stores', () => ({ getSshRemoteById: vi.fn() }));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: vi.fn().mockResolvedValue({ command: 'ssh', args: ['remote-git'] }),
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const target = path.resolve('branch-cleanup-target');
const cwd = path.resolve('branch-sibling');
const ok: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
const operations = ['commitAll', 'checkoutBranch'] as const;
type Operation = (typeof operations)[number];
type Handler = (event: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>;
let handlers: Map<string, Handler>;
let gate: typeof import('../../../main/git/worktreeActivity');
let git: typeof import('../../../main/utils/remote-git');
let deps: GitHandlerDependencies;

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.mocked(buildSshCommand).mockResolvedValue({ command: 'ssh', args: ['remote-git'] });
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	vi.mocked(execFileNoThrow).mockImplementation(async (_command, args = []) => {
		if (args[0] === 'status') return { ...ok, stdout: 'M  changed.ts' };
		if (args[0] === 'rev-parse')
			return { ...ok, stdout: args.includes('--short') ? 'abc123' : cwd };
		return ok;
	});
	deps = {
		settingsStore: { get: vi.fn() },
		getMainWindow: () => null,
		getProcessManager: vi.fn(() => ({ getAll: () => [] })),
	};
	handlers = new Map();
	vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
		handlers.set(channel, handler as Handler);
	});
	gate = await import('../../../main/git/worktreeActivity');
	git = await import('../../../main/utils/remote-git');
	const { registerBranchHandlers } = await import('../../../main/ipc/handlers/git/branch');
	registerBranchHandlers(deps);
});

function run(operation: Operation, sshRemoteId?: string, tracking = false) {
	return handlers.get(`git:${operation}`)!(
		{},
		cwd,
		operation === 'commitAll' ? 'checkpoint' : 'topic',
		...(operation === 'commitAll'
			? [sshRemoteId, '/remote/repo']
			: [tracking, sshRemoteId, '/remote/repo'])
	);
}

async function reserve() {
	const hold = await gate.reserveWorktreeCleanup(target);
	expect(hold.status).toBe('reserved-partially');
	if (hold.status !== 'reserved-partially') throw new Error('Reservation failed');
	expect(hold.blockers.length).toBeGreaterThan(0);
	return hold;
}

async function blocked() {
	expect(await gate.reserveWorktreeCleanup(target)).toMatchObject({ status: 'blocked' });
}

describe('branch operation Git activity', () => {
	it.each(operations)('%s refuses before guard, child or recovery setup', async (operation) => {
		const hold = await reserve();
		await expect(run(operation)).rejects.toThrow('reserved');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(deps.getProcessManager).not.toHaveBeenCalled();
		hold.release();
		(await reserve()).release();
	});

	it.each(operations)(
		'%s registers synchronously and holds pending child work',
		async (operation) => {
			let finish!: (result: ExecResult) => void;
			vi.mocked(execFileNoThrow).mockImplementationOnce(
				() => new Promise((resolve) => (finish = resolve))
			);
			const pending = run(operation);
			await blocked();
			await vi.waitFor(() => expect(execFileNoThrow).toHaveBeenCalledOnce());
			await blocked();
			finish(operation === 'checkoutBranch' ? { ...ok, stdout: cwd } : ok);
			expect(await pending).toMatchObject({ success: true });
			(await reserve()).release();
		}
	);

	it.each(operations)('%s holds after EVERY nested Git command releases', async (operation) => {
		const original = git.execGit;
		const commands: string[] = [];
		vi.spyOn(git, 'execGit').mockImplementation(async (...args) => {
			const result = await original(...args);
			commands.push(args[0].join(' '));
			// Observe after per-command finally, before the outer operation resumes.
			await blocked();
			return result;
		});
		expect(await run(operation, undefined, true)).toMatchObject({ success: true });
		expect(commands).toEqual(
			operation === 'commitAll'
				? ['add -A', 'status --porcelain', 'commit -m checkpoint', 'rev-parse --short HEAD']
				: ['rev-parse --show-toplevel', 'checkout -b topic --track origin/topic']
		);
		(await reserve()).release();
	});

	it('checkout holds across the async native guard after its Git query finishes', async () => {
		let finish!: (value: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() => new Promise<string>((resolve) => (finish = resolve))
		);
		const pending = run('checkoutBranch');
		await vi.waitFor(() => expect(fs.realpath).toHaveBeenCalledOnce());
		await blocked();
		expect(execFileNoThrow).toHaveBeenCalledTimes(1);
		finish(cwd);
		expect(await pending).toMatchObject({ success: true });
		(await reserve()).release();
	});

	it('checkout releases on a native busy-agent guard refusal', async () => {
		vi.mocked(deps.getProcessManager!).mockReturnValue({
			getAll: () => [{ sessionId: 'agent-ai-tab', cwd, isTerminal: false }],
		});
		expect(await run('checkoutBranch')).toMatchObject({
			success: false,
			error: expect.any(String),
		});
		expect(execFileNoThrow).toHaveBeenCalledTimes(1);
		(await reserve()).release();
	});

	it('checkout releases when native guard setup throws', async () => {
		vi.mocked(deps.getProcessManager!).mockImplementation(() => {
			throw new Error('inventory unavailable');
		});
		await expect(run('checkoutBranch')).rejects.toThrow('inventory unavailable');
		expect(execFileNoThrow).toHaveBeenCalledTimes(1);
		(await reserve()).release();
	});

	it('clean commitAll releases without committing', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue(ok);
		expect(await run('commitAll')).toEqual({ success: true, committed: false });
		expect(execFileNoThrow).toHaveBeenCalledTimes(2);
		(await reserve()).release();
	});

	it.each([
		['commitAll', 'add'],
		['commitAll', 'status'],
		['commitAll', 'commit'],
		['commitAll', 'rev-parse'],
		['checkoutBranch', 'rev-parse'],
		['checkoutBranch', 'checkout'],
	] as const)('%s releases after %s fails or throws', async (operation, command) => {
		const original = vi.mocked(execFileNoThrow).getMockImplementation()!;
		for (const throws of [false, true]) {
			vi.mocked(execFileNoThrow).mockImplementation(async (...args) => {
				if (args[1]?.[0] !== command) return original(...args);
				await blocked();
				if (throws) throw new Error('child failed');
				return { ...ok, stderr: 'cancelled', exitCode: 'SIGTERM' };
			});
			if (throws) await expect(run(operation)).rejects.toThrow('child failed');
			else
				expect(await run(operation)).toMatchObject({
					success: !['add', 'commit', 'checkout'].includes(command),
				});
			(await reserve()).release();
		}
	});

	it('finishing a concurrent operation does not release another outer lifetime', async () => {
		let finish!: (result: ExecResult) => void;
		vi.mocked(execFileNoThrow).mockImplementationOnce(
			() => new Promise((resolve) => (finish = resolve))
		);
		const first = run('commitAll');
		await vi.waitFor(() => expect(execFileNoThrow).toHaveBeenCalledOnce());
		expect(await run('checkoutBranch')).toMatchObject({ success: true });
		await blocked();
		finish(ok);
		await first;
		(await reserve()).release();
	});

	it.each(operations)('%s keeps SSH out of local admission/probes', async (operation) => {
		vi.mocked(getSshRemoteById).mockReturnValue({
			id: 'remote',
			name: 'Remote',
			host: 'host',
			port: 22,
			username: 'user',
			privateKeyPath: path.resolve('ssh-key'),
			enabled: true,
		});
		vi.mocked(execFileNoThrow).mockResolvedValue(ok);
		const hold = await reserve();
		vi.mocked(fs.realpath).mockClear();
		expect(await run(operation, 'remote')).toMatchObject({ success: true });
		expect(fs.realpath).not.toHaveBeenCalled();
		expect(execFileNoThrow).toHaveBeenCalledWith('ssh', ['remote-git']);
		hold.release();
	});

	it.each(operations)('%s refuses unresolved SSH without local fallback', async (operation) => {
		expect(await run(operation, 'missing')).toMatchObject({ success: false });
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(fs.realpath).not.toHaveBeenCalled();
		(await reserve()).release();
	});
});
