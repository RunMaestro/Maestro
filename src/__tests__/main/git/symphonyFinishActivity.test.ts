import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileNoThrow, type ExecResult } from '../../../main/utils/execFile';
import { resolveGhPath } from '../../../main/utils/cliDetection';
import { getExpandedEnv } from '../../../main/agents/path-prober';
import { DEFAULT_CONTRIBUTOR_STATS } from '../../../shared/symphony-constants';
import type { SymphonyHandlerDependencies } from '../../../main/ipc/handlers/symphony/shared';
import type { SymphonyState } from '../../../shared/symphony-types';

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
vi.mock('../../../main/utils/safe-send', () => ({ createSafeSend: () => send }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const root = path.resolve('finish-cleanup-target');
const localPath = path.resolve('finish-sibling');
const ok: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
const failed: ExecResult = { stdout: '', stderr: 'cancelled', exitCode: 'SIGTERM' };
const operations = ['createDraftPR', 'complete', 'cancel'] as const;
type Operation = (typeof operations)[number];
type Handler = (event: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>;
let handlers: Map<string, Handler>;
let gate: typeof import('../../../main/git/worktreeActivity');
let shared: typeof import('../../../main/ipc/handlers/symphony/shared');
let files: Map<string, string>;
let statePath: string;
let metadataPath: string;

beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	vi.mocked(fs.mkdir).mockResolvedValue(undefined);
	vi.mocked(fs.rm).mockResolvedValue(undefined);
	vi.mocked(fs.access).mockResolvedValue(undefined);
	const contribution = {
		id: 'contrib_test',
		sessionId: 'session',
		repoSlug: 'owner/r',
		repoName: 'r',
		issueNumber: 42,
		issueTitle: 'Title',
		localPath,
		branchName: 'topic',
		startedAt: '2026-11-04T00:00:00Z',
		status: 'running',
		draftPrNumber: 42,
		draftPrUrl: 'https://github.com/owner/r/pull/42',
		tokenUsage: { inputTokens: 1, outputTokens: 2, estimatedCost: 0.1 },
		progress: { completedDocuments: 1, completedTasks: 2 },
		timeSpent: 100,
	};
	const userData = path.resolve('finish-user-data');
	statePath = path.join(userData, 'symphony', 'symphony-state.json');
	metadataPath = path.join(userData, 'symphony', 'contributions', 'contrib_test', 'metadata.json');
	files = new Map([
		[
			statePath,
			JSON.stringify({ active: [contribution], history: [], stats: DEFAULT_CONTRIBUTOR_STATS }),
		],
		[
			metadataPath,
			JSON.stringify({ ...contribution, contributionId: contribution.id, prCreated: false }),
		],
	]);
	vi.mocked(fs.readFile).mockImplementation(async (file) => files.get(String(file))!);
	vi.mocked(fs.writeFile).mockImplementation(async (file, data) => {
		files.set(String(file), String(data));
	});
	vi.mocked(resolveGhPath).mockResolvedValue('gh');
	vi.mocked(getExpandedEnv).mockReturnValue({ PATH: '/usr/bin' });
	vi.mocked(execFileNoThrow).mockImplementation(async (_command, args = []) => {
		if (args[0] === 'symbolic-ref') return { ...ok, stdout: 'refs/remotes/origin/main' };
		if (args[0] === 'rev-list') return { ...ok, stdout: '1' };
		if (args[0] === 'rev-parse') return { ...ok, stdout: 'topic' };
		if (args[0] === 'remote') return { ...ok, stdout: 'https://github.com/owner/r.git' };
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
	const { registerContributionFinishHandlers } =
		await import('../../../main/ipc/handlers/symphony/contributionFinish');
	const { registerLifecycleHandlers } =
		await import('../../../main/ipc/handlers/symphony/lifecycle');
	const deps = {
		app: { getPath: () => userData },
		getMainWindow: () => null,
	} as unknown as SymphonyHandlerDependencies;
	registerContributionFinishHandlers(deps);
	registerLifecycleHandlers(deps);
});

function run(operation: Operation, id = 'contrib_test', cleanup = true) {
	const handler = handlers.get(`symphony:${operation}`)!;
	return operation === 'cancel'
		? handler(null, id, cleanup)
		: handler(null, { contributionId: id });
}

async function reserve() {
	const hold = await gate.reserveWorktreeCleanup(root);
	expect(hold.status).toBe('reserved-partially');
	if (hold.status !== 'reserved-partially') throw new Error('Reservation failed');
	expect(hold.blockers).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				message: expect.stringContaining('native Git, process, client and registration'),
			}),
			expect.objectContaining({ message: expect.stringContaining('OS users, external processes') }),
		])
	);
	return hold;
}

async function blocked() {
	expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({
		status: 'blocked',
		blockers: [{ code: 'mutation-busy' }],
	});
}

describe.each(operations)('Symphony %s finish admission', (operation) => {
	it('refuses before metadata/state, provenance probes, gh setup, writes or recovery', async () => {
		const before = [...files];
		const hold = await reserve();
		try {
			await expect(run(operation)).resolves.toMatchObject({
				success: false,
				error: expect.stringContaining('reserved'),
			});
			for (const fn of [
				fs.readFile,
				fs.access,
				fs.mkdir,
				fs.rm,
				fs.writeFile,
				resolveGhPath,
				getExpandedEnv,
				execFileNoThrow,
				send,
			])
				expect(fn).not.toHaveBeenCalled();
			expect([...files]).toEqual(before);
		} finally {
			hold.release();
		}
		(await reserve()).release();
	});

	it('preserves Encore refusal before entering the operation', async () => {
		shared.setSymphonyEnabledCheck(() => false);
		await expect(run(operation)).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining('SymphonyDisabled'),
		});
		expect(fs.readFile).not.toHaveBeenCalled();
		expect(execFileNoThrow).not.toHaveBeenCalled();
		(await reserve()).release();
	});

	it('admits synchronously and holds across the pending first metadata/state read', async () => {
		let finish!: (content: string) => void;
		vi.mocked(fs.readFile).mockImplementationOnce(
			() =>
				new Promise((done) => {
					finish = done;
				})
		);
		const pending = run(operation);
		await blocked();
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		expect(execFileNoThrow).not.toHaveBeenCalled();
		finish(files.get(operation === 'createDraftPR' ? metadataPath : statePath)!);
		await expect(pending).resolves.toMatchObject({ success: true });
		(await reserve()).release();
	});

	it('holds across all child calls and persistence after nested helpers return', async () => {
		const read = vi.mocked(fs.readFile).getMockImplementation()!;
		vi.mocked(fs.readFile).mockImplementation(async (...args) => {
			await blocked();
			const result = await read(...args);
			await blocked();
			return result;
		});
		const write = vi.mocked(fs.writeFile).getMockImplementation()!;
		vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
			await blocked();
			await write(...args);
			await blocked();
		});
		const execute = vi.mocked(execFileNoThrow).getMockImplementation()!;
		vi.mocked(execFileNoThrow).mockImplementation(async (...args) => {
			await blocked();
			const result = await execute(...args);
			await blocked();
			return result;
		});
		await expect(run(operation)).resolves.toMatchObject({ success: true });
		expect(send).toHaveBeenCalled();
		const commands = vi.mocked(execFileNoThrow).mock.calls.map(([, args]) => args?.join(' '));
		const state = JSON.parse(files.get(statePath)!) as SymphonyState;
		if (operation === 'createDraftPR') {
			expect(commands).toContain('push -u origin topic');
			expect(commands.some((args) => args?.startsWith('pr create'))).toBe(true);
			expect(JSON.parse(files.get(metadataPath)!).prCreated).toBe(true);
		} else if (operation === 'complete') {
			expect(commands).toContain('pr ready 42');
			expect(commands.some((args) => args?.startsWith('pr comment'))).toBe(true);
			expect(state.history).toHaveLength(1);
		} else {
			expect(commands).toContain('remote get-url origin');
			expect(fs.rm).toHaveBeenCalledWith(localPath, { recursive: true, force: true });
		}
		expect(fs.writeFile).toHaveBeenCalledWith(statePath, expect.any(String), 'utf-8');
		(await reserve()).release();
	});

	it.each(['resolve', 'reject'])('holds final state persistence through %s', async (outcome) => {
		let finish!: () => void;
		const write = vi.mocked(fs.writeFile).getMockImplementation()!;
		vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
			const state = JSON.parse(String(args[1]));
			if (String(args[0]) === statePath && (operation !== 'complete' || state.history.length))
				await new Promise<void>((done, fail) => {
					finish = () => (outcome === 'resolve' ? done() : fail(new Error('persistence')));
				});
			return write(...args);
		});
		const pending = run(operation);
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		await blocked();
		finish();
		await expect(pending).resolves.toMatchObject(
			outcome === 'resolve'
				? { success: true }
				: { success: false, error: expect.stringContaining('persistence') }
		);
		(await reserve()).release();
	});

	it('releases after a missing contribution without children or cleanup', async () => {
		if (operation === 'createDraftPR')
			vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('missing'));
		await run(operation, 'missing');
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(fs.rm).not.toHaveBeenCalled();
		(await reserve()).release();
	});
});

it.each(['createDraftPR', 'complete', 'cancel'] as const)(
	'%s holds pending gh/provenance setup',
	async (operation) => {
		let finish!: () => void;
		if (operation === 'cancel')
			vi.mocked(fs.access).mockImplementationOnce(
				() =>
					new Promise<void>((done) => {
						finish = done;
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
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		await blocked();
		expect(execFileNoThrow).not.toHaveBeenCalled();
		finish();
		await expect(pending).resolves.toMatchObject({ success: true });
		(await reserve()).release();
	}
);

it.each(operations)(
	'%s releases after a failed/cancelled child without destructive recovery',
	async (operation) => {
		vi.mocked(execFileNoThrow).mockResolvedValueOnce(failed);
		await run(operation);
		expect(fs.rm).not.toHaveBeenCalled();
		if (operation === 'complete')
			expect(JSON.parse(files.get(statePath)!).active[0].status).toBe('failed');
		(await reserve()).release();
	}
);

describe.each(['createDraftPR', 'complete'] as const)('%s exception release', (operation) => {
	it.each(['gh', 'env', 'child'])('releases after %s throws', async (stage) => {
		if (stage === 'gh') vi.mocked(resolveGhPath).mockRejectedValueOnce(new Error('setup'));
		if (stage === 'env')
			vi.mocked(getExpandedEnv).mockImplementationOnce(() => {
				throw new Error('setup');
			});
		if (stage === 'child') vi.mocked(execFileNoThrow).mockRejectedValueOnce(new Error('setup'));
		await expect(run(operation)).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining('setup'),
		});
		expect(fs.rm).not.toHaveBeenCalled();
		(await reserve()).release();
	});
});

it('cancel without cleanup never enters provenance or deletion', async () => {
	await expect(run('cancel', 'contrib_test', false)).resolves.toMatchObject({ cancelled: true });
	expect(fs.access).not.toHaveBeenCalled();
	expect(execFileNoThrow).not.toHaveBeenCalled();
	expect(fs.rm).not.toHaveBeenCalled();
	(await reserve()).release();
});

it.each(['resolve', 'reject'])(
	'cancel holds pending legacy clone cleanup through %s and later persistence',
	async (outcome) => {
		let finish!: () => void;
		vi.mocked(fs.rm).mockImplementationOnce(
			() =>
				new Promise<void>((done, fail) => {
					finish = () => (outcome === 'resolve' ? done() : fail(new Error('cleanup')));
				})
		);
		const pending = run('cancel');
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		await blocked();
		expect(fs.writeFile).not.toHaveBeenCalled();
		finish();
		await expect(pending).resolves.toMatchObject({ success: true, cancelled: true });
		expect(JSON.parse(files.get(statePath)!).active).toEqual([]);
		(await reserve()).release();
	}
);

it('draft failure holds nested remote-branch rollback until it settles', async () => {
	let finish!: (result: ExecResult) => void;
	const execute = vi.mocked(execFileNoThrow).getMockImplementation()!;
	vi.mocked(execFileNoThrow).mockImplementation((command, args = [], ...rest) => {
		if (args.includes('--delete'))
			return new Promise((done) => {
				finish = done;
			});
		if (args[0] === 'pr') return Promise.resolve(failed);
		return execute(command, args, ...rest);
	});
	const pending = run('createDraftPR');
	await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
	await blocked();
	expect(fs.writeFile).not.toHaveBeenCalled();
	finish(failed);
	await expect(pending).resolves.toMatchObject({
		success: false,
		error: expect.stringContaining('Failed to create PR'),
	});
	(await reserve()).release();
});

it('complete holds initial completing-state persistence before gh setup', async () => {
	let finish!: () => void;
	vi.mocked(fs.writeFile).mockImplementationOnce(
		() =>
			new Promise<void>((done) => {
				finish = done;
			})
	);
	const pending = run('complete');
	await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
	await blocked();
	expect(resolveGhPath).not.toHaveBeenCalled();
	finish();
	await expect(pending).resolves.toMatchObject({ success: true });
	(await reserve()).release();
});

it('a failed concurrent operation does not release another pending finish', async () => {
	let finish!: (content: string) => void;
	vi.mocked(fs.readFile).mockImplementationOnce(
		() =>
			new Promise((done) => {
				finish = done;
			})
	);
	const pending = run('complete');
	await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
	vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('metadata'));
	await expect(run('createDraftPR')).resolves.toMatchObject({ success: false });
	await blocked();
	finish(files.get(statePath)!);
	await expect(pending).resolves.toMatchObject({ success: true });
	(await reserve()).release();
});
