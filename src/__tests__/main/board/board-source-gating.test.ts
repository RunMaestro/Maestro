import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { openBoardDb } from '../../../main/board/board-db';
import { BoardStorageFacade, configureBoardStorage } from '../../../main/board/board-storage';
import {
	configureIsolatedBoardSourceHost,
	refreshBoardSources,
} from '../../../main/board/board-source-host';
import { configureBoardFeatures } from '../../../main/board/board-feature';
import {
	discoverLocalBoardSources,
	discoverRemoteBoardSources,
	executeBoardSourceOperation,
} from '../../../main/board/board-source-core';
import type { BoardRemoteTransport } from '../../../main/board/board-remote-source';
import * as remoteGit from '../../../main/utils/remote-git';
import { snapshotSqlite } from '../../helpers/sqliteSnapshot';

const fixture = createBoardIsolationFixture();
beforeAll(() => {
	fixture.install();
	configureIsolatedBoardSourceHost(fixture.contract);
});
afterAll(async () => fixture.cleanup());
afterEach(() => {
	vi.restoreAllMocks();
	configureBoardFeatures({ get: () => ({ board: true, maestroCue: true }) });
	for (const suffix of ['', '-wal', '-shm'])
		fs.rmSync(fixture.contract.db + suffix, { force: true });
	for (const root of Object.values(fixture.sources)) {
		for (const name of fs.readdirSync(root))
			fs.rmSync(path.join(root, name), { recursive: true, force: true });
	}
});
const stages = [
	'physical',
	'read',
	'git',
	'git-physical',
	'creator-git',
	'remote-shell',
	'remote-git',
	'remote-board',
	'remote-profile',
] as const;
it.each(stages.flatMap((stage) => ['board', 'maestroCue'].map((gate) => ({ stage, gate }))))(
	'pauses discovery after deferred $stage when $gate switches off, before writes or next IO',
	async ({ stage, gate }) => {
		const flags = { board: true, maestroCue: true };
		configureBoardFeatures({ get: () => flags });
		const db = openBoardDb(fixture.contract.db);
		const storage = new BoardStorageFacade(db);
		let reached!: () => void;
		let release!: () => void;
		const suspended = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const resume = new Promise<void>((resolve) => {
			release = resolve;
		});
		const offIO: string[] = [];
		let paused = false;
		const checkpoint = async (name: string) => {
			if (!flags.board || !flags.maestroCue) offIO.push(name);
			if (!paused && name === stage) {
				paused = true;
				reached();
				await resume;
			}
		};
		const before = snapshotSqlite(db);
		try {
			let discovery: Promise<void>;
			if (!stage.startsWith('remote-')) {
				const roots = [fixture.sources.one, fixture.sources.two];
				for (const root of roots) {
					execFileSync('git', ['init', '-q', root]);
					if (stage !== 'creator-git') {
						fs.mkdirSync(path.join(root, '.maestro'), { recursive: true });
						fs.writeFileSync(
							path.join(root, '.maestro', 'board.yaml'),
							'{"boards":[{"id":"b","name":"Import","cards":[]}]}'
						);
					}
				}
				const realpath = fs.promises.realpath.bind(fs.promises);
				const read = fs.promises.readFile.bind(fs.promises);
				const git = remoteGit.execGitReadOnly;
				let physicalCalls = 0;
				vi.spyOn(fs.promises, 'realpath').mockImplementation(async (...args) => {
					const name = ++physicalCalls > 2 ? 'git-physical' : 'physical';
					await checkpoint(name);
					return realpath(...args);
				});
				vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
					await checkpoint('read');
					return read(...args);
				});
				vi.spyOn(remoteGit, 'execGitReadOnly').mockImplementation(async (...args) => {
					await checkpoint(stage === 'creator-git' ? 'creator-git' : 'git');
					return git(...args);
				});
				discovery = discoverLocalBoardSources(
					storage,
					roots.map((dir, i) => ({ id: `worker${i}`, dir }))
				);
			} else {
				const remote: BoardRemoteTransport = {
					config: (id) => ({
						id,
						enabled: true,
						name: 'owned transport',
						host: 'fixture.invalid',
						username: 'fixture',
						port: 22,
						privateKeyPath: '',
					}),
					shell: async (_command, _config, options) => {
						await checkpoint('remote-shell');
						return { stdout: options!.cwd!, stderr: '', exitCode: 0 };
					},
					git: async (_args, _cwd, _config, root) => {
						await checkpoint('remote-git');
						return { stdout: `${root}\n${root}/.git`, stderr: '', exitCode: 0 };
					},
					read: async (file) => {
						await checkpoint(file.endsWith('board.yaml') ? 'remote-board' : 'remote-profile');
						return {
							success: true,
							data: Buffer.from(
								file.endsWith('board.yaml')
									? '{"boards":[{"id":"b","name":"Import","cards":[]}]}'
									: '{"profiles":[]}'
							).toString('base64'),
						};
					},
				};
				discovery = discoverRemoteBoardSources(
					storage,
					['one', 'two'].map((name) => ({
						id: name,
						dir: path.posix.join('/remote', name),
						sshRemoteId: 'fixture',
					})),
					remote
				);
			}
			const outcome = discovery.then(
				() => ({ error: undefined as unknown }),
				(error: unknown) => ({ error })
			);
			await suspended;
			flags[gate as keyof typeof flags] = false;
			release();
			const result = await outcome;
			expect(snapshotSqlite(db)).toEqual(before);
			expect(offIO).toEqual([]);
			expect(result.error).toBeInstanceOf(Error);
			expect((result.error as Error).message).toContain(
				gate === 'board' ? 'BoardDisabled' : 'CueDisabled'
			);
		} finally {
			release?.();
			db.close();
		}
	}
);

it('retains a completed source transaction when a later remote source pauses', async () => {
	const flags = { board: true, maestroCue: true };
	configureBoardFeatures({ get: () => flags });
	const db = openBoardDb(fixture.contract.db);
	const storage = new BoardStorageFacade(db);
	let reached!: () => void;
	let release!: () => void;
	const suspended = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const resume = new Promise<void>((resolve) => {
		release = resolve;
	});
	const remote: BoardRemoteTransport = {
		config: (id) => ({
			id,
			enabled: true,
			name: 'owned',
			host: 'fixture.invalid',
			username: 'fixture',
			port: 22,
			privateKeyPath: '',
		}),
		shell: async (_command, _config, options) => {
			if (options!.cwd!.endsWith('two')) {
				reached();
				await resume;
			}
			return { stdout: options!.cwd!, stderr: '', exitCode: 0 };
		},
		git: async (_args, _cwd, _config, root) => ({
			stdout: `${root}\n${root}/.git`,
			stderr: '',
			exitCode: 0,
		}),
		read: async (file) => ({
			success: true,
			data: Buffer.from(
				file.endsWith('board.yaml')
					? '{"boards":[{"id":"b","name":"Saved","cards":[]}]}'
					: '{"profiles":[]}'
			).toString('base64'),
		}),
	};
	try {
		const pending = discoverRemoteBoardSources(
			storage,
			['one', 'two'].map((name) => ({
				id: name,
				dir: path.posix.join('/remote', name),
				sshRemoteId: 'fixture',
			})),
			remote
		);
		const outcome = pending.catch((error: unknown) => error);
		await suspended;
		expect(db.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: 1 });
		const committed = snapshotSqlite(db);
		flags.maestroCue = false;
		release();
		expect(await outcome).toMatchObject({ message: 'CueDisabled' });
		expect(snapshotSqlite(db)).toEqual(committed);
	} finally {
		release?.();
		db.close();
	}
});

it('propagates an actual unexpected SQLite error even if a gate flips off at the failing statement', async () => {
	const flags = { board: true, maestroCue: true };
	configureBoardFeatures({ get: () => flags });
	const root = fixture.sources.one;
	execFileSync('git', ['init', '-q', root]);
	const db = openBoardDb(fixture.contract.db);
	const before = snapshotSqlite(db);
	const prepare = db.prepare.bind(db);
	let failure: unknown;
	vi.spyOn(db, 'prepare').mockImplementation((sql) => {
		if (sql.startsWith('INSERT OR IGNORE INTO board_sources')) {
			flags.board = false;
			try {
				return prepare('SELECT * FROM nonexistent_capacity_fixture_table');
			} catch (error) {
				failure = error;
				throw error;
			}
		}
		return prepare(sql);
	});
	try {
		const result = await discoverLocalBoardSources(new BoardStorageFacade(db), [
			{ id: 'creator', dir: root },
		]).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(result).toBe(failure);
		expect(snapshotSqlite(db)).toEqual(before);
	} finally {
		db.close();
	}
});

it.each(['board', 'maestroCue'] as const)(
	'retains source state if %s switches off during explicit source Git revalidation',
	async (gate) => {
		const flags = { board: true, maestroCue: true };
		configureBoardFeatures({ get: () => flags });
		const root = fixture.sources.one;
		execFileSync('git', ['init', '-q', root]);
		const db = openBoardDb(fixture.contract.db);
		const storage = new BoardStorageFacade(db);
		let release!: () => void;
		let reached!: () => void;
		const suspended = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const resume = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await discoverLocalBoardSources(storage, [{ id: 'creator', dir: root }]);
			const before = snapshotSqlite(db);
			const sourceKey = storage.query().sources[0].sourceKey;
			const git = remoteGit.execGitReadOnly;
			vi.spyOn(remoteGit, 'execGitReadOnly').mockImplementation(async (...args) => {
				reached();
				await resume;
				return git(...args);
			});
			const noRemote = (): never => {
				throw new Error('Unexpected remote IO');
			};
			const remote: BoardRemoteTransport = {
				config: noRemote,
				shell: noRemote,
				git: noRemote,
				read: noRemote,
			};
			const result = executeBoardSourceOperation(
				{ action: 'revalidate', sourceKey },
				storage,
				[],
				remote
			).catch((error: unknown) => error);
			await suspended;
			flags[gate] = false;
			release();
			expect(await result).toMatchObject({
				message: gate === 'board' ? 'BoardDisabled' : 'CueDisabled',
			});
			expect(snapshotSqlite(db)).toEqual(before);
		} finally {
			release?.();
			db.close();
		}
	}
);

it.each(['board', 'maestroCue'] as const)(
	'propagates a %s pause through the actual admitted refresh host before creator registration',
	async (gate) => {
		const flags = { board: true, maestroCue: true };
		configureBoardFeatures({ get: () => flags });
		for (const root of Object.values(fixture.sources)) execFileSync('git', ['init', '-q', root]);
		const db = openBoardDb(fixture.contract.db);
		configureBoardStorage(new BoardStorageFacade(db));
		const before = snapshotSqlite(db);
		let reached!: () => void;
		let release!: () => void;
		const suspended = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const resume = new Promise<void>((resolve) => {
			release = resolve;
		});
		const git = remoteGit.execGitReadOnly;
		vi.spyOn(remoteGit, 'execGitReadOnly').mockImplementation(async (...args) => {
			reached();
			await resume;
			return git(...args);
		});
		try {
			const result = refreshBoardSources().catch((error: unknown) => error);
			await suspended;
			flags[gate] = false;
			release();
			expect(await result).toMatchObject({
				message: gate === 'board' ? 'BoardDisabled' : 'CueDisabled',
			});
			expect(snapshotSqlite(db)).toEqual(before);
		} finally {
			release?.();
			db.close();
		}
	}
);
