import { executeBoardCommand } from '../../../main/board/board-command-host';
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openBoardDb } from '../../../main/board/board-db';
import {
	BoardStorageFacade,
	configureBoardCaptureHost,
	configureBoardStorage,
	resolveLocalBoardSourceKeys,
} from '../../../main/board/board-storage';
import {
	discoverBoardSources,
	configureBoardSourceHost,
	executeBoardSourceCommand,
} from '../../../main/board/board-source-host';
import { boardMigrationSourceKey } from '../../../main/board/board-migration';
import {
	probeBoardRemoteRepository,
	readBoardRemoteInput,
	type BoardRemoteTransport,
} from '../../../main/board/board-remote-source';
import { listBoardWorkers } from '../../../main/board/board-workspace-storage';
import { BOARD_SOURCE_PROJECT_PREFIX } from '../../../shared/board/types';
import type { SshRemoteConfig } from '../../../shared/types';
import { readBinaryFileRemoteAsBase64 } from '../../../main/utils/remote-fs';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { execGitReadOnly } from '../../../main/utils/remote-git';

vi.mock('node:fs', { spy: true });

let dir = '';
afterEach(() => {
	vi.restoreAllMocks();
	configureBoardCaptureHost(() => ({ agents: [], groups: [] }));
	configureBoardSourceHost(() => []);
	configureBoardStorage(null);
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
const config: SshRemoteConfig = {
	id: 'one',
	name: 'Fixture',
	host: 'fixture.invalid',
	username: 'fixture',
	privateKeyPath: '',
	port: 22,
	enabled: true,
};
function transport(root: string): BoardRemoteTransport {
	return {
		config: (id) => (id ? { ...config, id } : undefined),
		shell: vi.fn(async () => ({ stdout: `${root}\n`, stderr: '', exitCode: 0 })),
		git: vi.fn(async () => ({ stdout: `${root}\n${root}/.git\n`, stderr: '', exitCode: 0 })),
		read: vi.fn(async (file) => ({
			success: true,
			data: Buffer.from(
				file.endsWith('board.yaml')
					? JSON.stringify({ boards: [{ id: 'b', name: 'Remote input', cards: [] }] })
					: JSON.stringify({
							profiles: [{ id: 'role', name: 'Remote role', customModel: 'saved' }],
						})
			).toString('base64'),
		})),
	};
}
function fixture() {
	dir = fs.mkdtempSync(
		path.resolve('.maestro/board-global-workers-20261031/recovery-09-remote-fixture-')
	);
	const db = openBoardDb(path.join(dir, 'board.sqlite'));
	return { db, storage: new BoardStorageFacade(db) };
}

it('imports two remote hosts with the same path separately, retains immutable snapshots and exact worker grants without local reads', async () => {
	const { db, storage } = fixture();
	configureBoardStorage(storage);
	try {
		const root = '/remote-only/Repo';
		const remote = transport(root);
		const read = vi.mocked(fs.readFileSync);
		const real = vi.mocked(fs.realpathSync);
		const workers = ['one', 'two'].map((remoteId) => ({
			id: `worker-${remoteId}`,
			dir: root,
			boardWorker: true,
			sessionSshRemoteConfig: { enabled: true, remoteId },
		}));
		await discoverBoardSources(
			storage,
			[...workers, { id: 'local', dir: '/missing-local', boardWorker: true }],
			remote
		);
		expect(storage.query().sources).toHaveLength(2);
		expect(storage.query().collections.map((c) => c.board.name)).toEqual([
			'Remote input',
			'Remote input',
		]);
		for (const worker of workers) {
			const sourceKey = boardMigrationSourceKey({
				location: { kind: 'ssh', remoteId: worker.sessionSshRemoteConfig.remoteId },
				path: root,
			});
			expect(
				listBoardWorkers(db).find((w) => w.agentId === worker.id)?.payload.allowedRepositoryIds
			).toEqual([`source:${sourceKey}`]);
			expect(
				storage.query({ projectRoot: `${BOARD_SOURCE_PROJECT_PREFIX}${sourceKey}` }).collections
			).toHaveLength(1);
		}
		expect(read.mock.calls.some((args) => String(args[0]).startsWith(root))).toBe(false);
		expect(real.mock.calls.some((args) => String(args[0]).startsWith(root))).toBe(false);
		const before = db.prepare('SELECT * FROM migrations ORDER BY source_key').all();
		vi.mocked(remote.read).mockRejectedValue(new Error('No reimport allowed'));
		await discoverBoardSources(storage, workers.reverse(), remote);
		expect(db.prepare('SELECT * FROM migrations ORDER BY source_key').all()).toEqual(before);
		expect(storage.captureCatalog().repositories.every((r) => r.location?.kind === 'ssh')).toBe(
			true
		);
		configureBoardCaptureHost(() => ({ agents: workers.map((w) => ({ id: w.id })), groups: [] }));
		const source = storage
			.query()
			.sources.find(
				(source) =>
					source.location?.location.kind === 'ssh' && source.location.location.remoteId === 'one'
			)!;
		const projectRoot = `${BOARD_SOURCE_PROJECT_PREFIX}${source.sourceKey}`;
		const board = storage.read(projectRoot, 'b');
		const captured = storage.capture(
			{
				projectRoot,
				boardId: 'b',
				expectedRevision: board.storage!.expectedRevision!,
				card: {
					id: 'remote-card',
					title: 'Remote card',
					body: '',
					parents: [],
					status: 'todo',
					createdAt: '2026-10-31',
					updatedAt: '2026-10-31',
					executionScope: { kind: 'agent', agentId: 'worker-one' },
					role: { namespace: `legacy:${source.sourceKey}`, profileId: 'role' },
					repositoryId: `source:${source.sourceKey}`,
					workingDirectory: root,
					startModeOverride: 'direct',
				},
			},
			true
		);
		expect((await storage.captureReadinessAsync(captured))['remote-card']).not.toContain(
			'repository-unresolved'
		);
		expect(read.mock.calls.some((args) => String(args[0]).startsWith(root))).toBe(false);
		expect(real.mock.calls.some((args) => String(args[0]).startsWith(root))).toBe(false);
		expect(storage.query({ projectRoot }).collections).toHaveLength(1);
		db.prepare('INSERT INTO runtime_owner VALUES (1, ?, 7, 0)').run('remote-owner');
		const key = storage.workspace.resolveLegacyCollection([source.sourceKey], 'b');
		expect(
			await executeBoardCommand({
				action: 'rename',
				target: {
					projectRoot,
					sourceKey: source.sourceKey,
					collectionKey: key.collectionKey,
					expectedRevision: captured.storage!.expectedRevision!,
				},
				name: 'Renamed remote source through native host',
			})
		).toMatchObject({ ok: true, value: { name: 'Renamed remote source through native host' } });
		expect(
			await executeBoardCommand({
				action: 'query',
				query: { projectRoot: `${BOARD_SOURCE_PROJECT_PREFIX}${'f'.repeat(64)}` },
			})
		).toMatchObject({ ok: false, error: { code: 'legacy-mapping-missing' } });

		const collection = storage.workspace.readCollection(key)!;
		const row = collection.cards.find((card) => card.cardId === 'remote-card')!;
		const repository = storage
			.captureCatalog()
			.repositories.find((repo) => repo.id === `source:${source.sourceKey}`)!;
		const identity = await probeBoardRemoteRepository('one', root, root, remote);
		const host = {
			owner: { processIdentity: 'remote-owner', epoch: 7 },
			registryRevision: 1,
			dispatchEnabled: true,
			agentStates: {
				'worker-one': {
					live: true,
					busy: false,
					location: { kind: 'ssh' as const, remoteId: 'other' },
				},
			},
			repository: {
				id: repository.id,
				workingDirectory: root,
				record: repository,
				location: { kind: 'ssh' as const, remoteId: 'one' },
				identity,
			},
		};
		const command = {
			...key,
			cardId: 'remote-card',
			workerAgentId: 'worker-one',
			requestId: 'remote-claim',
			readRevision: {
				workspace: storage.workspace.readWorkspace().revision,
				collection: collection.revision,
				card: row.revision,
				registry: 1,
			},
		};
		expect(storage.claim(command, () => host)).toMatchObject({
			ok: false,
			reason: 'worker-location-mismatch',
		});
		host.agentStates['worker-one'].location.remoteId = 'one';
		expect(storage.claim(command, () => host)).toMatchObject({ ok: true });
		expect(read.mock.calls.some((args) => String(args[0]).startsWith(root))).toBe(false);
		expect(real.mock.calls.some((args) => String(args[0]).startsWith(root))).toBe(false);
	} finally {
		db.close();
	}
});

it('exposes missing config/input as unresolved and explicitly repairs only the selected source; later invalidation preserves snapshots and fences', async () => {
	const { db, storage } = fixture();
	try {
		const root = '/remote-only/repo';
		const remote = transport(root);
		const worker = {
			id: 'worker',
			dir: root,
			boardWorker: true,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'one' },
		};
		configureBoardSourceHost(() => [worker]);
		remote.config = () => undefined;
		await discoverBoardSources(storage, [worker], remote);
		const sourceKey = storage.query().sources[0].sourceKey;
		const revision = storage.query().revision;
		await discoverBoardSources(storage, [worker], remote);
		expect(storage.query().revision).toBe(revision);
		expect(storage.captureCatalog().repositories[0]).toMatchObject({
			validated: false,
			diagnostic: expect.any(String),
		});
		expect(db.prepare('SELECT * FROM migrations').all()).toEqual([]);
		expect(
			await executeBoardSourceCommand({ action: 'revalidate', sourceKey }, storage, remote)
		).toMatchObject({ ok: false, error: { code: 'legacy-mapping-missing' } });
		remote.config = () => config;
		vi.mocked(remote.read).mockResolvedValueOnce({
			success: false,
			error: 'Permission denied: input',
		});
		expect(
			await executeBoardSourceCommand({ action: 'revalidate', sourceKey }, storage, remote)
		).toMatchObject({ ok: false });
		expect(storage.captureCatalog().repositories[0].validated).toBe(false);
		vi.mocked(remote.read).mockImplementation(async (file) => ({
			success: true,
			data: Buffer.from(
				JSON.stringify(
					file.endsWith('board.yaml')
						? {
								boards: [
									{
										id: 'b',
										name: 'Remote input',
										cards: [
											{
												id: 'uncertain',
												title: 'Uncertain remote run',
												body: '',
												parents: [],
												status: 'running',
												runs: [{ attempt: 1, workerAgentId: 'worker', startedAt: '2026-10-31' }],
											},
										],
									},
								],
							}
						: { profiles: [{ id: 'role', name: 'Remote role' }] }
				)
			).toString('base64'),
		}));
		expect(
			await executeBoardSourceCommand({ action: 'revalidate', sourceKey }, storage, remote)
		).toEqual({ ok: true });
		expect(storage.query().collections).toHaveLength(1);
		const run = db.prepare('SELECT run_id, collection_key, card_id FROM runs').get() as {
			run_id: string;
			collection_key: string;
			card_id: string;
		};
		expect(run).toBeDefined();
		db.prepare('INSERT INTO runtime_owner VALUES (1, ?, 31, 100)').run('uncertain-owner');
		db.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?, ?, ?)').run(
			'worker',
			run.collection_key,
			run.card_id,
			run.run_id,
			31,
			12,
			'uncertain'
		);
		expect(db.prepare('SELECT * FROM migration_worker_holds').all()).not.toEqual([]);
		const frozen = () =>
			[
				'migrations',
				'migration_blockers',
				'migration_worker_holds',
				'runs',
				'runtime_owner',
				'reservations',
			].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
		const before = frozen();
		vi.mocked(remote.shell).mockResolvedValueOnce({
			stdout: '/somewhere-else\n',
			stderr: '',
			exitCode: 0,
		});
		expect(
			await executeBoardSourceCommand({ action: 'revalidate', sourceKey }, storage, remote)
		).toMatchObject({ ok: false, error: { code: 'identity-mismatch' } });
		expect(storage.captureCatalog().repositories[0].validated).toBe(false);
		expect(frozen()).toEqual(before);
		expect(
			await executeBoardSourceCommand({ action: 'revalidate', sourceKey }, storage, remote)
		).toEqual({ ok: true });
		expect(frozen()).toEqual(before);
	} finally {
		db.close();
	}
});

it('rejects source reference forgery, remote identity mismatch, traversal, sibling roots and input errors without local fallback', async () => {
	const remote = transport('/repo');
	expect(() => resolveLocalBoardSourceKeys(`${BOARD_SOURCE_PROJECT_PREFIX}wrong`)).toThrow();
	remote.config = () => ({ ...config, id: 'other' });
	await expect(probeBoardRemoteRepository('one', '/repo', '/repo', remote)).rejects.toMatchObject({
		code: 'legacy-mapping-missing',
	});
	remote.config = () => config;
	for (const cwd of ['/repo-two', 'relative', '/repo/../outside']) {
		await expect(probeBoardRemoteRepository('one', '/repo', cwd, remote)).rejects.toMatchObject({
			code: 'identity-mismatch',
		});
	}
	vi.mocked(remote.read).mockResolvedValue({ success: false, error: 'Permission denied' });
	await expect(
		readBoardRemoteInput('one', '/repo', '.maestro/board.yaml', remote)
	).rejects.toMatchObject({ code: 'legacy-mapping-missing' });
	vi.mocked(remote.read).mockResolvedValue({
		success: false,
		error: 'File not found: /repo/.maestro/board.yaml',
	});
	expect(await readBoardRemoteInput('one', '/repo', '.maestro/board.yaml', remote)).toBeNull();
});

it('refuses to relabel another remote repository and fences concurrent source changes during revalidation', async () => {
	const { db, storage } = fixture();
	try {
		const root = '/remote-only/repo';
		const remote = transport(root);
		await discoverBoardSources(
			storage,
			[{ id: 'worker', dir: root, sessionSshRemoteConfig: { enabled: true, remoteId: 'one' } }],
			remote
		);
		const source = storage.query().sources[0];
		const row = db.prepare('SELECT payload_json FROM repositories').get() as {
			payload_json: string;
		};
		const repository = JSON.parse(row.payload_json);
		db.prepare('UPDATE repositories SET payload_json=?').run(
			JSON.stringify({ ...repository, location: { kind: 'ssh', remoteId: 'other' } })
		);
		expect(
			await executeBoardSourceCommand(
				{ action: 'revalidate', sourceKey: source.sourceKey },
				storage,
				remote
			)
		).toMatchObject({ ok: false, error: { code: 'identity-mismatch' } });
		db.prepare('UPDATE repositories SET payload_json=?').run(row.payload_json);
		vi.mocked(remote.shell).mockImplementationOnce(async () => {
			db.prepare('UPDATE board_source_locations SET payload_json=?').run(
				JSON.stringify({ location: { kind: 'ssh', remoteId: 'one' }, path: '/changed' })
			);
			return { stdout: root, stderr: '', exitCode: 0 };
		});
		expect(
			await executeBoardSourceCommand(
				{ action: 'revalidate', sourceKey: source.sourceKey },
				storage,
				remote
			)
		).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
		expect(db.prepare('SELECT payload_json FROM repositories').get()).toEqual(row);
	} finally {
		db.close();
	}
});

it('types transport exceptions and rejects mid-probe remote config changes', async () => {
	const remote = transport('/repo');
	vi.mocked(remote.shell).mockRejectedValueOnce(new Error('transport failure'));
	await expect(probeBoardRemoteRepository('one', '/repo', '/repo', remote)).rejects.toMatchObject({
		code: 'legacy-mapping-missing',
	});
	let changed = false;
	remote.config = () => ({ ...config, host: changed ? 'changed.invalid' : config.host });
	vi.mocked(remote.git).mockImplementationOnce(async () => {
		changed = true;
		return { stdout: '/repo\n/repo/.git\n', stderr: '', exitCode: 0 };
	});
	await expect(probeBoardRemoteRepository('one', '/repo', '/repo', remote)).rejects.toMatchObject({
		code: 'identity-mismatch',
	});
});

it('uses existing SSH file adapter and real local child/Git processes with quoted paths, preserving original bytes', async () => {
	const { db } = fixture();
	try {
		const root = path.join(dir, "repo 'quoted' $literal");
		fs.mkdirSync(path.join(root, '.maestro'), { recursive: true });
		execFileSync('git', ['init', '--quiet', root]);
		const original = Buffer.concat([Buffer.from('boards: []\n'), Buffer.from([255])]);
		fs.writeFileSync(path.join(root, '.maestro/board.yaml'), original);
		const remote: BoardRemoteTransport = {
			config: () => config,
			read: (file, cfg) =>
				readBinaryFileRemoteAsBase64(file, cfg, {
					buildSshArgs: () => [],
					execSsh: (_binary, args) => execFileNoThrow('/bin/sh', ['-c', args[0]]),
				}),
			shell: (_command, cfg, options) => {
				expect(cfg.id).toBe('one');
				return execFileNoThrow('/bin/sh', ['-c', 'pwd -P'], options?.cwd);
			},
			git: (args, localCwd, cfg, cwd) => {
				expect(localCwd).toBe('');
				expect(cfg?.id).toBe('one');
				return execGitReadOnly(args, cwd!);
			},
		};
		expect(await readBoardRemoteInput('one', root, '.maestro/board.yaml', remote)).toEqual(
			original
		);
		expect(await probeBoardRemoteRepository('one', root, root, remote)).toContain('one');
		expect(fs.readFileSync(path.join(root, '.maestro/board.yaml'))).toEqual(original);
	} finally {
		db.close();
	}
});
