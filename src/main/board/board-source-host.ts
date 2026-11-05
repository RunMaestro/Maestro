/** Discover only registered roots through explicit local or SSH adapters. Legacy files are immutable import input;
 * central data owns subsequent edits. No recursive scan or remote/local fallback. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BOARD_CONFIG_PATH, PROFILES_CONFIG_PATH } from '../../shared/maestro-paths';
import { canonicalJson } from '../../shared/canonicalJson';
import { resolveBoardLocation } from './board-location';
import { boardRemoteTransport, type BoardRemoteTransport } from './board-remote-source';
import {
	discoverRemoteBoardSources,
	executeBoardSourceOperation,
	type BoardSourceSession,
} from './board-source-core';
import { execGitReadOnly } from '../utils/remote-git';
import {
	applyBoardMigration,
	boardMigrationSourceKey,
	planBoardMigration,
} from './board-migration';
import { BoardStorageError, getBoardStorage, type BoardStorageFacade } from './board-storage';
import {
	assertBoardIsolationPath,
	assertBoardIsolationRegistrations,
	isBoardIsolationRequested,
	readBoardIsolationRegistries,
	requireBoardIsolation,
	type BoardIsolation,
} from './board-isolation';

let sessions: () => BoardSourceSession[] = () => [];
let isolatedHost:
	| { provider: typeof sessions; remote: BoardRemoteTransport; snapshot: string }
	| undefined;

/** Native bootstrap calls this after admission, before importing index or opening stores. */
export function configureIsolatedBoardSourceHost(
	contract: BoardIsolation,
	creation?: { identity: string; name: string; toolType: string; cwd: string }
): ((agent: BoardSourceSession, persist: () => void) => void) | undefined {
	requireBoardIsolation({ expected: contract });
	const provider = () => readBoardIsolationRegistries(contract).sessions as BoardSourceSession[];
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
	if (!creation) return;
	// A capability held only by the admitting parent/fixture host, never by IPC.
	// Normal isolated hosts remain sealed. This permits one exact append at an
	// already admitted source, without resetting admission or changing providers.
	const request = Object.freeze({ ...creation });
	const before = canonicalJson(readBoardIsolationRegistries(contract));
	if (
		request.identity !== contract.identity ||
		!request.name ||
		!request.toolType ||
		!admittedSources(provider(), remote)?.has(request.cwd)
	)
		throw new Error('Board isolation creation request was not admitted');
	let consumed = false;
	return (agent, persist) => {
		requireBoardIsolation({ expected: contract });
		admittedSources(provider(), remote);
		const current = readBoardIsolationRegistries(contract);
		const record = agent as BoardSourceSession & Record<string, unknown>;
		if (
			consumed ||
			canonicalJson(current) !== before ||
			!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(agent.id) ||
			(current.sessions as BoardSourceSession[]).some((item) => item.id === agent.id) ||
			record.name !== request.name ||
			record.toolType !== request.toolType ||
			record.cwd !== request.cwd ||
			record.projectRoot !== request.cwd ||
			record.fullPath !== request.cwd
		)
			throw new Error('Board isolation creation differs from the parent request');
		const after = {
			sessions: [...(current.sessions as BoardSourceSession[]), agent],
			sources: current.sources,
		};
		assertBoardIsolationRegistrations(contract, after);
		const expected = canonicalJson(after);
		consumed = true;
		persist(); // Synchronous owned-store write. A failure leaves admission sealed.
		if (canonicalJson(readBoardIsolationRegistries(contract)) !== expected)
			throw new Error('Board isolation creation changed unrelated registrations');
		isolatedHost!.snapshot = expected;
		admittedSources(provider(), remote);
	};
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
	registered: BoardSourceSession[],
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
	registered: BoardSourceSession[],
	remote: BoardRemoteTransport = boardRemoteTransport
): Promise<void> {
	const admitted = admittedSources(registered, remote);
	if (admitted) {
		registered = [
			...registered,
			...[...admitted].map((root) => ({ id: `source:${root}`, dir: root })),
		];
	}
	await discoverRemoteBoardSources(storage, registered, remote);
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

/** Admit the retained process, registries and persisted source identity before running the algorithm. */
export async function executeBoardSourceCommand(
	command: import('../../shared/board/types').BoardSourceCommand,
	storage?: BoardStorageFacade,
	remote: BoardRemoteTransport = isolatedHost?.remote ?? boardRemoteTransport
): Promise<import('../../shared/board/types').BoardSourceResponse> {
	const registered = sessions();
	const roots = admittedSources(registered, remote);
	storage ??= getBoardStorage();
	try {
		if (roots && command?.action === 'revalidate') {
			const source = storage
				.query({ sourceKey: command.sourceKey })
				.sources.find((entry) => entry.sourceKey === command.sourceKey)?.location;
			if (source && (source.location.kind !== 'local' || !roots.has(source.path)))
				throw new Error('Board isolation source identity is not registered');
		}
	} catch (error) {
		if (!(error instanceof BoardStorageError)) throw error;
		return { ok: false, error: { code: error.code, message: error.message } };
	}
	return executeBoardSourceOperation(command, storage, registered, remote);
}
