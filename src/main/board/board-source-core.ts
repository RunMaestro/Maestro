/** Source algorithms over explicit storage, a per-call worker snapshot and an injected SSH transport.
 * Host entry points must admit registries and source identities before calling these operations.
 * This module never opens storage or selects a transport on the caller's behalf. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BOARD_CONFIG_PATH, PROFILES_CONFIG_PATH } from '../../shared/maestro-paths';
import { canonicalJson } from '../../shared/canonicalJson';
import { resolveBoardLocation } from './board-location';
import {
	probeBoardRemoteRepository,
	readBoardRemoteInput,
	type BoardRemoteTransport,
} from './board-remote-source';
import { execGitReadOnly } from '../utils/remote-git';
import {
	applyBoardMigration,
	boardMigrationSourceKey,
	planBoardMigration,
} from './board-migration';
import { BoardStorageError, type BoardStorageFacade } from './board-storage';

export interface BoardSourceSession {
	id: string;
	dir?: string;
	projectRoot?: string;
	boardWorker?: boolean;
	sshRemoteId?: string;
	sessionSshRemoteConfig?: { enabled?: boolean; remoteId?: string };
}

/** Local import uses recorded workers and host-owned admission checks before reading any input. */
export async function discoverLocalBoardSources(
	storage: BoardStorageFacade,
	workers: readonly BoardSourceSession[],
	admission?: { roots: ReadonlySet<string>; assertInputPath: (file: string) => void }
): Promise<void> {
	const registered: BoardSourceSession[] = JSON.parse(canonicalJson(workers));
	const roots = new Set(
		registered
			.filter((s) => resolveBoardLocation(s).kind === 'local')
			.map((s) => s.projectRoot || s.dir)
			.filter((root): root is string => !!root)
	);
	for (const root of roots) {
		let physical: string;
		try {
			physical = await fs.promises.realpath(root);
		} catch (error) {
			if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
			throw error;
		}
		if (admission && (physical !== root || !admission.roots.has(physical)))
			throw new Error('Board isolation source physical identity changed');
		const source = { location: { kind: 'local' as const }, path: physical };
		const sourceKey = boardMigrationSourceKey(source);
		if (
			storage.db
				.prepare('SELECT 1 FROM board_source_suppressions WHERE source_key=?')
				.get(sourceKey)
		)
			continue;
		// An import is a point-in-time transfer, never a YAML synchronization loop.
		const existing = storage.db
			.prepare('SELECT snapshot FROM migrations WHERE source_key=?')
			.get(sourceKey) as { snapshot: Uint8Array } | undefined;
		if (existing) {
			applyBoardMigration(storage.db, JSON.parse(Buffer.from(existing.snapshot).toString('utf8')));
			continue;
		}
		if (
			storage.db.prepare('SELECT 1 FROM board_sources WHERE source_key=?').get(sourceKey) &&
			storage.db.prepare('SELECT 1 FROM repositories WHERE id=?').get(`source:${sourceKey}`)
		)
			continue;
		const read = async (relative: string): Promise<Buffer | null> => {
			try {
				const file = path.join(physical, relative);
				admission?.assertInputPath(file);
				return await fs.promises.readFile(file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
				throw error;
			}
		};
		const boardBytes = await read(BOARD_CONFIG_PATH);
		const profileBytes = await read(PROFILES_CONFIG_PATH);
		const git = await execGitReadOnly(['rev-parse', '--show-toplevel'], physical);
		const repository =
			git.exitCode === 0 && (await fs.promises.realpath(git.stdout.trim())) === physical
				? { id: `source:${sourceKey}`, workingDirectory: physical, validated: true }
				: null;
		if (
			boardBytes ||
			profileBytes ||
			registered.some(
				(s) =>
					s.boardWorker &&
					resolveBoardLocation(s).kind === 'local' &&
					(s.projectRoot || s.dir) === root
			)
		) {
			applyBoardMigration(
				storage.db,
				planBoardMigration({ source, repository, boardBytes, profileBytes, workers: registered })
			);
		} else {
			storage.db
				.transaction(() => {
					if (
						storage.db
							.prepare('SELECT 1 FROM board_source_suppressions WHERE source_key=?')
							.get(sourceKey)
					)
						return;
					const inserted = storage.db
						.prepare('INSERT OR IGNORE INTO board_sources VALUES (?)')
						.run(sourceKey);
					storage.db
						.prepare('INSERT OR IGNORE INTO board_source_locations VALUES (?, ?)')
						.run(sourceKey, canonicalJson(source));
					const repositoryAdded = repository
						? storage.db
								.prepare('INSERT OR IGNORE INTO repositories VALUES (?, ?)')
								.run(repository.id, canonicalJson(repository)).changes
						: 0;
					if (inserted.changes || repositoryAdded)
						storage.db.prepare('UPDATE workspace SET revision=revision+1 WHERE id=1').run();
				})
				.immediate();
		}
	}
}

/** Copy before the first await so transport callbacks cannot change source identities or worker grants. */
export async function discoverRemoteBoardSources(
	storage: BoardStorageFacade,
	workers: readonly BoardSourceSession[],
	remote: BoardRemoteTransport
): Promise<void> {
	// Remote identity is never inferred from a matching local directory.
	const remoteSources = new Map<
		string,
		{ location: { kind: 'ssh'; remoteId: string }; path: string }
	>();
	for (const session of workers) {
		let location = resolveBoardLocation(session);
		// Retain the unresolved source diagnostic for an enabled configuration
		// with no selected host, without guessing between conflicting identities.
		if (
			location.kind === 'invalid' &&
			session.sessionSshRemoteConfig?.enabled &&
			!session.sessionSshRemoteConfig.remoteId &&
			!session.sshRemoteId
		)
			location = { kind: 'ssh', remoteId: '' };
		if (location.kind !== 'ssh') continue;
		const root = session.projectRoot || session.dir;
		if (!root) continue;
		// Missing remote ID remains visible but cannot be executed or mapped locally.
		const source = { location, path: root };
		remoteSources.set(boardMigrationSourceKey(source), source);
	}
	if (!remoteSources.size) return;
	const registered: BoardSourceSession[] = JSON.parse(canonicalJson(workers));
	for (const [sourceKey, source] of remoteSources) {
		if (
			storage.db
				.prepare('SELECT 1 FROM board_source_suppressions WHERE source_key=?')
				.get(sourceKey)
		)
			continue;
		const existing = storage.db
			.prepare('SELECT snapshot FROM migrations WHERE source_key=?')
			.get(sourceKey) as { snapshot: Uint8Array } | undefined;
		if (existing) {
			applyBoardMigration(storage.db, JSON.parse(Buffer.from(existing.snapshot).toString('utf8')));
			continue;
		}
		let diagnostic: string | undefined;
		try {
			await importRemoteBoardSource(storage, source, registered, remote);
			continue;
		} catch (error) {
			if (!(error instanceof BoardStorageError)) throw error;
			diagnostic = error.message;
		}
		storage.db
			.transaction(() => {
				if (
					storage.db
						.prepare('SELECT 1 FROM board_source_suppressions WHERE source_key=?')
						.get(sourceKey)
				)
					return;
				const inserted = storage.db
					.prepare('INSERT OR IGNORE INTO board_sources VALUES (?)')
					.run(sourceKey);
				storage.db
					.prepare('INSERT OR IGNORE INTO board_source_locations VALUES (?, ?)')
					.run(sourceKey, canonicalJson(source));
				const updated = storage.db
					.prepare(
						'INSERT INTO repositories VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json WHERE payload_json <> excluded.payload_json'
					)
					.run(
						`source:${sourceKey}`,
						canonicalJson({
							id: `source:${sourceKey}`,
							workingDirectory: source.path,
							location: source.location,
							validated: false,
							diagnostic,
							sourceStatus: 'unresolved',
						})
					);
				if (inserted.changes || updated.changes)
					storage.db.prepare('UPDATE workspace SET revision=revision+1 WHERE id=1').run();
			})
			.immediate();
	}
}

/** One immutable import through the selected SSH identity, also used by explicit repair. */
async function importRemoteBoardSource(
	storage: BoardStorageFacade,
	source: { location: { kind: 'ssh'; remoteId: string }; path: string },
	registered: BoardSourceSession[],
	remote: BoardRemoteTransport
): Promise<void> {
	const sourceKey = boardMigrationSourceKey(source);
	await probeBoardRemoteRepository(source.location.remoteId, source.path, source.path, remote);
	const boardBytes = await readBoardRemoteInput(
		source.location.remoteId,
		source.path,
		BOARD_CONFIG_PATH,
		remote
	);
	const profileBytes = await readBoardRemoteInput(
		source.location.remoteId,
		source.path,
		PROFILES_CONFIG_PATH,
		remote
	);
	const repository = {
		id: `source:${sourceKey}`,
		workingDirectory: source.path,
		validated: true,
		location: source.location,
	};
	const plan = planBoardMigration({
		source,
		repository,
		boardBytes,
		profileBytes,
		workers: registered,
	});
	applyBoardMigration(storage.db, plan);
}

/** Revalidate only the persisted identity. Never reimport changed YAML or clear provenance/fences. */
export async function executeBoardSourceOperation(
	command: import('../../shared/board/types').BoardSourceCommand,
	storage: BoardStorageFacade,
	workers: readonly BoardSourceSession[],
	remote: BoardRemoteTransport
): Promise<import('../../shared/board/types').BoardSourceResponse> {
	try {
		if (!command || typeof command.sourceKey !== 'string' || !command.sourceKey.trim())
			throw new BoardStorageError('invalid-input', 'Explicit source identity required');
		command = { ...command };
		if (command.action === 'save-role' || command.action === 'delete-role') {
			storage.editSourceRole(command);
			return { ok: true };
		}
		if (command.action !== 'revalidate')
			throw new BoardStorageError('invalid-input', 'Unknown source operation');
		if (
			storage.db
				.prepare('SELECT 1 FROM board_source_suppressions WHERE source_key=?')
				.get(command.sourceKey)
		)
			throw new BoardStorageError('invalid-input', 'Board source is suppressed');
		const entry = storage
			.query({ sourceKey: command.sourceKey })
			.sources.find((s) => s.sourceKey === command.sourceKey);
		if (!entry?.location)
			throw new BoardStorageError(
				'legacy-mapping-missing',
				'Source location requires an explicit supported adapter'
			);
		const source = entry.location;
		if (boardMigrationSourceKey(source) !== command.sourceKey)
			throw new BoardStorageError('identity-mismatch', 'Persisted source identity changed');
		const migration = storage.db
			.prepare('SELECT snapshot FROM migrations WHERE source_key=?')
			.get(command.sourceKey) as { snapshot: Uint8Array } | undefined;
		const importedRepository = migration
			? (
					JSON.parse(Buffer.from(migration.snapshot).toString('utf8')) as {
						repository?: { id: string; workingDirectory: string };
					}
				).repository
			: undefined;
		if (importedRepository && importedRepository.workingDirectory !== source.path)
			throw new BoardStorageError(
				'identity-mismatch',
				'Imported repository does not match selected source'
			);

		const repositoryId = importedRepository?.id ?? `source:${command.sourceKey}`;
		const registeredRepository = storage.db
			.prepare('SELECT payload_json FROM repositories WHERE id=?')
			.get(repositoryId) as { payload_json: string } | undefined;
		const retainedRepository = registeredRepository
			? JSON.parse(registeredRepository.payload_json)
			: {};
		if (
			registeredRepository &&
			(retainedRepository.workingDirectory !== source.path ||
				((retainedRepository.location || source.location.kind === 'ssh') &&
					canonicalJson({ location: retainedRepository.location }) !==
						canonicalJson({ location: source.location })))
		)
			throw new BoardStorageError(
				'identity-mismatch',
				'Repository identity belongs to another location'
			);
		if (source.location.kind === 'ssh' && !migration) {
			const registered: BoardSourceSession[] = JSON.parse(canonicalJson(workers));
			await importRemoteBoardSource(
				storage,
				{ ...source, location: source.location },
				registered,
				remote
			);
			return { ok: true };
		}
		let validated = false;
		let identityError: BoardStorageError | undefined;
		try {
			if (source.location.kind === 'ssh') {
				await probeBoardRemoteRepository(
					source.location.remoteId,
					source.path,
					source.path,
					remote
				);
				validated = true;
			} else {
				const physical = fs.realpathSync(source.path);
				if (
					physical !== source.path ||
					boardMigrationSourceKey({ ...source, path: physical }) !== command.sourceKey
				)
					throw new BoardStorageError('identity-mismatch', 'Source physical identity changed');
				const git = await execGitReadOnly(['rev-parse', '--show-toplevel'], physical);
				validated =
					git.exitCode === 0 &&
					fs.realpathSync(git.stdout.trim()) === physical &&
					fs.realpathSync(source.path) === physical;
			}
		} catch (error) {
			if (error instanceof BoardStorageError) identityError = error;
			else if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
				throw error;
		}
		// Persist the host observation, including invalidation, without touching migration state.
		storage.db
			.transaction(() => {
				if (
					storage.db
						.prepare('SELECT 1 FROM board_source_suppressions WHERE source_key=?')
						.get(command.sourceKey)
				)
					throw new BoardStorageError('invalid-input', 'Board source is suppressed');
				const current = storage.db
					.prepare('SELECT payload_json FROM repositories WHERE id=?')
					.get(repositoryId) as { payload_json: string } | undefined;
				const currentSource = storage.db
					.prepare('SELECT payload_json FROM board_source_locations WHERE source_key=?')
					.get(command.sourceKey) as { payload_json: string } | undefined;
				if (
					current?.payload_json !== registeredRepository?.payload_json ||
					(currentSource &&
						canonicalJson(JSON.parse(currentSource.payload_json)) !== canonicalJson(source))
				)
					throw new BoardStorageError(
						'stale-revision',
						'Source or repository changed during revalidation'
					);
				storage.db
					.prepare(
						'INSERT INTO repositories VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET payload_json=excluded.payload_json'
					)
					.run(
						repositoryId,
						canonicalJson({
							...retainedRepository,
							diagnostic: identityError?.message,
							id: repositoryId,
							workingDirectory: source.path,
							...(source.location.kind === 'ssh' ? { location: source.location } : {}),
							validated,
						})
					);
				storage.db.prepare('UPDATE workspace SET revision=revision+1 WHERE id=1').run();
			})
			.immediate();
		if (identityError) throw identityError;
		if (!validated)
			throw new BoardStorageError(
				'invalid-input',
				'Repository remains unresolved: selected source must be an existing Git root'
			);
		return { ok: true };
	} catch (error) {
		if (!(error instanceof BoardStorageError)) throw error;
		return { ok: false, error: { code: error.code, message: error.message } };
	}
}
