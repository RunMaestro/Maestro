import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileNoThrow, type ExecResult } from '../../../main/utils/execFile';
import { resolveGhPath } from '../../../main/utils/cliDetection';
import { getExpandedEnv } from '../../../main/agents/path-prober';
import { fetchWithTimeout } from '../../../main/utils/fetchWithTimeout';
import type { SymphonyHandlerDependencies } from '../../../main/ipc/handlers/symphony/shared';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('fs/promises', () => ({
	default: {
		realpath: vi.fn(),
		mkdir: vi.fn(),
		rm: vi.fn(),
		readFile: vi.fn(),
		writeFile: vi.fn(),
		access: vi.fn(),
	},
}));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/cliDetection', () => ({ resolveGhPath: vi.fn() }));
vi.mock('../../../main/agents/path-prober', () => ({ getExpandedEnv: vi.fn() }));
vi.mock('../../../main/utils/fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('../../../main/utils/safe-send', () => ({ createSafeSend: () => send }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const root = path.resolve('kickoff-cleanup-target');
const localPath = path.resolve('kickoff-sibling');
const ok: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
const failed: ExecResult = { stdout: '', stderr: 'cancelled', exitCode: 'SIGTERM' };
const operations = ['start', 'cloneRepo', 'startContribution'] as const;
type Operation = (typeof operations)[number];
type Handler = (event: unknown, params: unknown) => Promise<Record<string, unknown>>;
let handlers: Map<string, Handler>;
let gate: typeof import('../../../main/git/worktreeActivity');
let shared: typeof import('../../../main/ipc/handlers/symphony/shared');

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	vi.mocked(fs.mkdir).mockResolvedValue(undefined);
	vi.mocked(fs.rm).mockResolvedValue(undefined);
	vi.mocked(fs.access).mockResolvedValue(undefined);
	const files = new Map<string, string>();
	vi.mocked(fs.readFile).mockImplementation(
		async (file) =>
			files.get(String(file)) ?? JSON.stringify({ active: [], history: [], stats: {} })
	);
	vi.mocked(fs.writeFile).mockImplementation(async (file, data) => {
		files.set(String(file), String(data));
	});
	vi.mocked(resolveGhPath).mockResolvedValue('gh');
	vi.mocked(getExpandedEnv).mockReturnValue({ PATH: '/usr/bin' });
	vi.mocked(execFileNoThrow).mockImplementation(async (_command, args = []) => {
		if (args[0] === 'api' && args[1] === 'user') return { ...ok, stdout: 'contributor' };
		if (args.includes('.permissions.push')) return { ...ok, stdout: 'true' };
		if (args[0] === 'symbolic-ref') return { ...ok, stdout: 'refs/remotes/origin/main' };
		if (args[0] === 'rev-parse') return { ...ok, stdout: 'topic' };
		if (args[0] === 'pr') return { ...ok, stdout: 'https://github.com/owner/r/pull/42' };
		return ok;
	});
	handlers = new Map();
	vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
		handlers.set(channel, handler as Handler);
	});
	gate = await import('../../../main/git/worktreeActivity');
	shared = await import('../../../main/ipc/handlers/symphony/shared');
	shared.setSymphonyEnabledCheck(() => true);
	const { registerContributionStartHandlers } =
		await import('../../../main/ipc/handlers/symphony/contributionStart');
	registerContributionStartHandlers({
		app: { getPath: () => path.resolve('kickoff-user-data') },
		getMainWindow: () => null,
	} as unknown as SymphonyHandlerDependencies);
});

function run(operation: Operation, overrides: Record<string, unknown> = {}) {
	return handlers.get(`symphony:${operation}`)!(null, {
		repoSlug: 'owner/r',
		repoUrl: 'https://github.com/owner/r',
		repoName: 'r',
		issueNumber: 42,
		issueTitle: 'Title',
		documentPaths: [],
		agentType: 'codex',
		sessionId: 'session',
		contributionId: 'contrib_test',
		localPath,
		...overrides,
	});
}

async function reserve() {
	const hold = await gate.reserveWorktreeCleanup(root);
	expect(hold.status).toBe('reserved-partially');
	if (hold.status !== 'reserved-partially') throw new Error('Reservation failed');
	expect(hold.blockers.length).toBeGreaterThan(0);
	return hold;
}

async function blocked() {
	expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({
		status: 'blocked',
		blockers: [{ code: 'mutation-busy' }],
	});
}

describe.each(operations)('Symphony %s kickoff admission', (operation) => {
	it('refuses before any setup, child, persistence or destructive recovery', async () => {
		const hold = await reserve();
		try {
			for (const cwd of [root, path.join(root, 'child'), localPath, 'unknown'])
				await expect(run(operation, { localPath: cwd })).resolves.toMatchObject({
					success: false,
					error: expect.stringContaining('reserved'),
				});
			expect(resolveGhPath).not.toHaveBeenCalled();
			expect(getExpandedEnv).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
			for (const fn of [fs.mkdir, fs.readFile, fs.writeFile, fs.rm, fetchWithTimeout, send])
				expect(fn).not.toHaveBeenCalled();
		} finally {
			hold.release();
		}
		(await reserve()).release();
	});

	it('preserves the Encore precondition without entering the operation', async () => {
		shared.setSymphonyEnabledCheck(() => false);
		await expect(run(operation)).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining('SymphonyDisabled'),
		});
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(fs.mkdir).not.toHaveBeenCalled();
		(await reserve()).release();
	});

	it('registers synchronously and holds pending first setup before any Git helper', async () => {
		let finish!: () => void;
		if (operation === 'cloneRepo')
			vi.mocked(fs.mkdir).mockImplementationOnce(
				() =>
					new Promise<string | undefined>((done) => {
						finish = () => done(undefined);
					})
			);
		else
			vi.mocked(resolveGhPath).mockImplementationOnce(
				() =>
					new Promise((done) => {
						finish = () => done('gh');
					})
			);
		const pending = run(operation);
		await blocked();
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		expect(execFileNoThrow).not.toHaveBeenCalled();
		finish();
		await expect(pending).resolves.toMatchObject({ success: true });
		(await reserve()).release();
	});

	it('holds across every child, filesystem setup and write including nested helper returns', async () => {
		const mkdirImpl = vi.mocked(fs.mkdir).getMockImplementation()!;
		vi.mocked(fs.mkdir).mockImplementation(async (...args) => {
			await blocked();
			const result = await mkdirImpl(...args);
			await blocked();
			return result;
		});
		const readFileImpl = vi.mocked(fs.readFile).getMockImplementation()!;
		vi.mocked(fs.readFile).mockImplementation(async (...args) => {
			await blocked();
			const result = await readFileImpl(...args);
			await blocked();
			return result;
		});
		const writeFileImpl = vi.mocked(fs.writeFile).getMockImplementation()!;
		vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
			await blocked();
			const result = await writeFileImpl(...args);
			await blocked();
			return result;
		});
		const execFileNoThrowImpl = vi.mocked(execFileNoThrow).getMockImplementation()!;
		vi.mocked(execFileNoThrow).mockImplementation(async (...args) => {
			await blocked();
			const result = await execFileNoThrowImpl(...args);
			await blocked();
			return result;
		});
		await expect(run(operation)).resolves.toMatchObject({ success: true });
		const commands = vi.mocked(execFileNoThrow).mock.calls.map(([, args]) => args?.[0]);
		expect(commands).toContain(operation === 'startContribution' ? 'checkout' : 'clone');
		if (operation !== 'cloneRepo') {
			expect(commands).toContain('push');
			expect(commands).toContain('pr');
			expect(fs.writeFile).toHaveBeenCalled();
		}
		(await reserve()).release();
	});

	it('releases after invalid input without setup', async () => {
		await run(operation, { repoUrl: 'file:///bad', issueNumber: 0 });
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(fs.rm).not.toHaveBeenCalled();
		(await reserve()).release();
	});

	it('releases after first setup throws without destructive recovery', async () => {
		if (operation === 'cloneRepo') vi.mocked(fs.mkdir).mockRejectedValueOnce(new Error('setup'));
		else vi.mocked(resolveGhPath).mockRejectedValueOnce(new Error('setup'));
		await expect(run(operation)).resolves.toMatchObject({
			success: false,
			error: expect.any(String),
		});
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(fs.rm).not.toHaveBeenCalled();
		(await reserve()).release();
	});

	it('releases after a failed or cancelled first child', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValueOnce(failed);
		await expect(run(operation)).resolves.toHaveProperty('error');
		expect(fs.rm).not.toHaveBeenCalled();
		(await reserve()).release();
	});
});

it.each(['start', 'startContribution'] as const)(
	'%s holds after nested draft helper returns until final persistence settles',
	async (operation) => {
		let finish!: () => void;
		const write = vi.mocked(fs.writeFile).getMockImplementation()!;
		vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
			if (vi.mocked(execFileNoThrow).mock.calls.some(([, argv]) => argv?.[0] === 'pr'))
				await new Promise<void>((done) => {
					finish = done;
				});
			return write(...args);
		});
		const pending = run(operation);
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		await blocked();
		finish();
		await expect(pending).resolves.toMatchObject({ success: true, draftPrNumber: 42 });
		(await reserve()).release();
	}
);

it.each(['resolve', 'reject'])(
	'start holds failed-PR rollback and legacy clone cleanup through %s',
	async (outcome) => {
		const execute = vi.mocked(execFileNoThrow).getMockImplementation()!;
		let rollback!: (value: ExecResult) => void;
		vi.mocked(execFileNoThrow).mockImplementation((command, args = [], ...rest) => {
			if (args.includes('--delete'))
				return new Promise((done) => {
					rollback = done;
				});
			if (args[0] === 'pr') return Promise.resolve(failed);
			return execute(command, args, ...rest);
		});
		let finish!: () => void;
		vi.mocked(fs.rm).mockImplementationOnce(
			() =>
				new Promise<void>((done, fail) => {
					finish = () => (outcome === 'resolve' ? done() : fail(new Error('cleanup')));
				})
		);
		const pending = run('start');
		await vi.waitFor(() => expect(rollback).toBeTypeOf('function'));
		await blocked();
		expect(fs.rm).not.toHaveBeenCalled();
		rollback(failed);
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		await blocked();
		finish();
		await expect(pending).resolves.toMatchObject({
			error: expect.stringContaining('PR creation failed'),
		});
		(await reserve()).release();
	}
);

it('a failed concurrent kickoff does not release a different pending operation', async () => {
	let finish!: (value: ExecResult) => void;
	vi.mocked(execFileNoThrow).mockImplementationOnce(
		() =>
			new Promise((done) => {
				finish = done;
			})
	);
	const pending = run('cloneRepo');
	await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
	vi.mocked(resolveGhPath).mockRejectedValueOnce(new Error('setup'));
	await expect(run('start')).resolves.toMatchObject({ success: false });
	await blocked();
	finish(ok);
	await pending;
	(await reserve()).release();
});

it('holds startContribution while downloading a document after fork setup has returned', async () => {
	let finish!: (response: Response) => void;
	vi.mocked(fetchWithTimeout).mockImplementationOnce(
		() =>
			new Promise((done) => {
				finish = done;
			})
	);
	const pending = run('startContribution', {
		documentPaths: [
			{ name: 'plan.md', path: 'https://github.com/owner/r/plan.md', isExternal: true },
		],
	});
	await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
	await blocked();
	expect(execFileNoThrow).not.toHaveBeenCalledWith(
		'git',
		expect.arrayContaining(['push']),
		expect.anything()
	);
	finish(new Response('Plan'));
	await expect(pending).resolves.toMatchObject({ success: true });
	expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('plan.md'), expect.any(Buffer));
	(await reserve()).release();
});

it.each(['start', 'startContribution'] as const)(
	'%s releases after final persistence fails after nested draft success',
	async (operation) => {
		const write = vi.mocked(fs.writeFile).getMockImplementation()!;
		vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
			if (vi.mocked(execFileNoThrow).mock.calls.some(([, argv]) => argv?.[0] === 'pr')) {
				await blocked();
				throw new Error('persistence');
			}
			return write(...args);
		});
		await expect(run(operation)).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining('persistence'),
		});
		expect(fs.rm).not.toHaveBeenCalled();
		(await reserve()).release();
	}
);
