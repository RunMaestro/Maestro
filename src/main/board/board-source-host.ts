/** Discover only registered roots through explicit local or SSH adapters. Legacy files are immutable import input;
 * central data owns subsequent edits. No recursive scan or remote/local fallback. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BOARD_CONFIG_PATH, PROFILES_CONFIG_PATH } from '../../shared/maestro-paths';
import { canonicalJson } from '../../shared/canonicalJson';
import { resolveBoardLocation } from './board-location';
import {
	boardRemoteTransport,
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
import { BoardStorageError, getBoardStorage, type BoardStorageFacade } from './board-storage';
import {
	assertBoardIsolationPath,
	isBoardIsolationRequested,
	readBoardIsolationRegistries,
	requireBoardIsolation,
	type BoardIsolation,
} from './board-isolation';

interface SourceSession {
	id: string;
	dir?: string;
	projectRoot?: string;
	boardWorker?: boolean;
	sshRemoteId?: string;
	sessionSshRemoteConfig?: { enabled?: boolean; remoteId?: string };
}
let sessions: () => SourceSession[] = () => [];
let isolatedHost:
	| { provider: typeof sessions; remote: BoardRemoteTransport; snapshot: string }
	| undefined;

/** Native bootstrap calls this after admission, before importing index or opening stores. */
export function configureIsolatedBoardSourceHost(contract: BoardIsolation): void {
	requireBoardIsolation({ expected: contract });
	const provider = () => readBoardIsolationRegistries(contract).sessions as SourceSession[];
	const refuseRemote = (): never => {
		throw new Error('Board isolation refuses SSH and network discovery transport');
	};
	const remote: BoardRemoteTransport = Object.freeze({
		config: refuseRemote,
		read: refuseRemote,
		git: refuseRemote,
		shell: refuseRemote,
	});
	configureBoardSourceHost(provider, remote);
	// Reject agent roots outside the source registry before the first native store opens.
	admittedSources(provider(), remote);
}

export function configureBoardSourceHost(
	provider: typeof sessions,
	remote?: BoardRemoteTransport
): void {
	if (isBoardIsolationRequested()) {
		const contract = requireBoardIsolation();
		const registries = readBoardIsolationRegistries(contract);
		if (
			isolatedHost ||
			typeof provider !== 'function' ||
			!remote ||
			remote === boardRemoteTransport
		)
			throw new Error('Board isolation requires one fixture source provider and transport');
		if (canonicalJson(provider()) !== canonicalJson(registries.sessions))
			throw new Error('Board isolation source provider differs from the agent registry');
		isolatedHost = { provider, remote, snapshot: canonicalJson(registries) };
	} else if (isolatedHost) {
		throw new Error('Board isolation source provider cannot be reset');
	}
	sessions = provider;
}

/** Re-read both admitted registries before any storage or source operation. */
function admittedSources(
	registered: SourceSession[],
	remote?: BoardRemoteTransport
): Set<string> | undefined {
	if (!isBoardIsolationRequested()) return undefined;
	const contract = requireBoardIsolation();
	const registries = readBoardIsolationRegistries(contract);
	if (
		!isolatedHost ||
		sessions !== isolatedHost.provider ||
		canonicalJson(registries) !== isolatedHost.snapshot ||
		canonicalJson(isolatedHost.provider()) !== canonicalJson(registries.sessions) ||
		canonicalJson(registered) !== canonicalJson(registries.sessions) ||
		remote !== isolatedHost.remote ||
		remote === boardRemoteTransport
	)
		throw new Error('Board isolation source provider or transport was not admitted');
	const roots = new Set((registries.sources as { root: string }[]).map((source) => source.root));
	for (const session of registered) {
		const root = session.projectRoot || session.dir;
		if (root && !roots.has(root)) throw new Error('Board isolation source root is not registered');
	}
	return roots;
}
let pending: Promise<void> | null = null;
export function refreshBoardSources(): Promise<void> {
	const registered = sessions();
	const remote = isolatedHost?.remote ?? boardRemoteTransport;
	const roots = admittedSources(registered, remote);
	if (!registered.length && !roots?.size) return Promise.resolve();
	if (!pending)
		pending = discoverBoardSources(getBoardStorage(), registered, remote).finally(() => {
			pending = null;
		});
	return pending;
}

/** Injectable storage and recorded sessions keep fixture discovery away from live data. */
export async function discoverBoardSources(
	storage: BoardStorageFacade,
	registered: SourceSession[],
	remote: BoardRemoteTransport = boardRemoteTransport
): Promise<void> {
	const admitted = admittedSources(registered, remote);
	if (admitted) {
		registered = [
			...registered,
			...[...admitted].map((root) => ({ id: `source:${root}`, dir: root })),
		];
	}
	// Remote identity is never inferred from a matching local directory.
	const remoteSources = new Map<
		string,
		{ location: { kind: 'ssh'; remoteId: string }; path: string }
	>();
	for (const session of registered) {
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
		if (admitted && (physical !== root || !admitted.has(physical)))
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
				if (admitted) assertBoardIsolationPath(requireBoardIsolation(), file);
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

/** One immutable import through the selected SSH identity, also used by explicit repair. */
async function importRemoteBoardSource(
	storage: BoardStorageFacade,
	source: { location: { kind: 'ssh'; remoteId: string }; path: string },
	registered: SourceSession[],
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
export async function executeBoardSourceCommand(
	command: import('../../shared/board/types').BoardSourceCommand,
	storage?: BoardStorageFacade,
	remote: BoardRemoteTransport = isolatedHost?.remote ?? boardRemoteTransport
): Promise<import('../../shared/board/types').BoardSourceResponse> {
	const roots = admittedSources(sessions(), remote);
	storage ??= getBoardStorage();
	try {
		if (!command || typeof command.sourceKey !== 'string' || !command.sourceKey.trim())
			throw new BoardStorageError('invalid-input', 'Explicit source identity required');
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
		if (roots && (source.location.kind !== 'local' || !roots.has(source.path)))
			throw new Error('Board isolation source identity is not registered');
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
			await importRemoteBoardSource(
				storage,
				{ ...source, location: source.location },
				sessions(),
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
