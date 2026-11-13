import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { listBoardWorkers } from './board-workspace-storage';
import { BOARD_SOURCE_PROJECT_PREFIX } from '../../shared/board/types';
import type { BoardCommand, BoardCommandTarget } from '../../shared/board/commands';
import { boardMigrationSourceKey } from './board-migration';
import { resolveBoardLocation } from './board-location';
import { probeBoardRemoteRepository } from './board-remote-source';
import { requireBoardEnabled } from './board-feature';
/** Discover only registered roots through explicit local or SSH adapters. Legacy files are immutable import input;
 * central data owns subsequent edits. No recursive scan or remote/local fallback. */
import { canonicalJson } from '../../shared/canonicalJson';
import { boardRemoteTransport, type BoardRemoteTransport } from './board-remote-source';
import {
	discoverLocalBoardSources,
	discoverRemoteBoardSources,
	executeBoardSourceOperation,
	type BoardSourceSession,
} from './board-source-core';
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
	requireBoardEnabled();
	const registered = sessions();
	const remote = isolatedHost?.remote ?? boardRemoteTransport;
	const roots = admittedSources(registered, remote);
	if (!registered.length && !roots?.size) return Promise.resolve();
	if (!pending)
		pending = discoverBoardSources(
			getBoardStorage(),
			registered,
			remote,
			requireBoardEnabled
		).finally(() => {
			pending = null;
		});
	return pending;
}

/** Fresh exact-target admission, independent of the global discovery single-flight.
 * No imports or grants: persisted central identity is distinct from mutation authority,
 * which remains in the facade's current actor/specification/reservation checks.
 */
export async function prepareBoardMutationTarget(
	target: BoardCommandTarget,
	action: BoardCommand['action']
): Promise<{ projectRoot: string; identity: string }> {
	requireBoardEnabled();
	const storage = getBoardStorage();
	const remote = isolatedHost?.remote ?? boardRemoteTransport;
	const registered = sessions();
	const admitted = admittedSources(registered, remote);
	if (
		!storage.sourceKeys(BOARD_SOURCE_PROJECT_PREFIX + target.sourceKey).includes(target.sourceKey)
	)
		throw new BoardStorageError('identity-mismatch', 'Unknown Board target source');
	if (
		storage.db
			.prepare('SELECT 1 FROM board_source_suppressions WHERE source_key=?')
			.get(target.sourceKey)
	)
		throw new BoardStorageError('protected-field', 'Board target source is suppressed');
	const query = { projectRoot: target.projectRoot, sourceKey: target.sourceKey };
	const prepared = await storage.prepareQuery(query);
	requireBoardEnabled();
	// Admit the freshly resolved source root, preserving supported caller aliases.
	if (
		admitted &&
		!prepared.projectRoot!.startsWith(BOARD_SOURCE_PROJECT_PREFIX) &&
		!admitted.has(prepared.projectRoot!)
	)
		throw new Error('Board isolation target root is not registered');
	const verifyCollection = () => {
		if (!storage.sourceKeys(prepared.projectRoot!).includes(target.sourceKey))
			throw new BoardStorageError(
				'identity-mismatch',
				'Board target source does not match project'
			);
		let row;
		try {
			row = storage.workspace.readCollection(target);
		} catch (error) {
			// Preserve the command host's non-disclosing not-found contract. The
			// storage-level source/collection identity guard remains authoritative.
			if (error instanceof BoardStorageError && error.code === 'identity-mismatch')
				throw new BoardStorageError(
					'not-found',
					'Board collection not found in the selected source/project'
				);
			throw error;
		}
		if (!row || row.archived)
			throw new BoardStorageError('not-found', 'Board target collection not found');
		if (row.revision !== target.expectedRevision)
			throw new BoardStorageError('stale-revision', 'Board changed since read');
	};
	verifyCollection();
	const before = storage.sourceIdentity(target.sourceKey);
	const source = storage.sourceLocation(target.sourceKey);
	if (source) {
		if (
			typeof source.path !== 'string' ||
			!source.path ||
			!['local', 'ssh'].includes(source.location?.kind) ||
			boardMigrationSourceKey(source) !== target.sourceKey
		)
			throw new BoardStorageError('identity-mismatch', 'Persisted Board source identity changed');
	}
	// Existing repository access is a probe-selection hint, never mutation authority.
	// It identifies registered aliases for an opaque target without scanning foreign roots.
	const relatedAgents = new Set(
		source?.location.kind === 'local'
			? listBoardWorkers(storage.db)
					.filter(
						(worker) =>
							Array.isArray(worker.payload.allowedRepositoryIds) &&
							worker.payload.allowedRepositoryIds.includes(`source:${target.sourceKey}`)
					)
					.map((worker) => worker.agentId)
			: []
	);
	const association = async (items: BoardSourceSession[]) => {
		const matched: unknown[] = [];
		const observed: BoardSourceSession[] = [];
		for (const item of JSON.parse(canonicalJson(items)) as BoardSourceSession[]) {
			if (!source) break;
			// A known source-bound current registration is present even when its
			// location/root is now invalid. The hint never grants a physical match.
			const related =
				relatedAgents.has(item.id) ||
				(source.location.kind === 'local' &&
					(item.dir === source.path || item.projectRoot === source.path));
			if (related) observed.push(item);
			const location = resolveBoardLocation(item);
			const raw = item.projectRoot || item.dir;
			if (location.kind !== source.location.kind || !raw) continue;
			if (location.kind === 'ssh') {
				if (
					source.location.kind === 'ssh' &&
					location.remoteId === source.location.remoteId &&
					raw === source.path
				) {
					matched.push(item);
					if (!related) observed.push(item);
				}
				continue;
			}
			if (raw !== source.path && raw !== target.projectRoot && !related) continue;
			if (!related) observed.push(item);
			try {
				const root = await fs.promises.realpath(raw);
				requireBoardEnabled();
				const entry = await fs.promises.lstat(raw);
				requireBoardEnabled();
				if (root === source.path)
					matched.push({ registration: item, root, entry: [entry.dev, entry.ino] });
			} catch (error) {
				if (
					!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(
						(error as NodeJS.ErrnoException).code ?? ''
					)
				)
					throw error;
			}
		}
		const latest = sessions();
		if (
			observed.some(
				(item) =>
					canonicalJson(latest.filter((current) => current.id === item.id)) !==
					canonicalJson([item])
			)
		)
			throw new BoardStorageError(
				'stale-revision',
				'Board source registration changed during alias validation'
			);
		return { matched: canonicalJson(matched), registered: canonicalJson(observed) };
	};
	const associated = await association(registered);
	// A completed SSH import is also a retained central namespace. Explicit central
	// edits do not use the repository/transport or mint execution authority. Never
	// infer this capability from a location row alone or an unresolved import.
	const retainedRemoteIdentity = () => {
		if (
			source?.location.kind !== 'ssh' ||
			target.projectRoot !== BOARD_SOURCE_PROJECT_PREFIX + target.sourceKey
		)
			return undefined;
		const ledger = storage.db
			.prepare(
				'SELECT m.snapshot FROM migrations m JOIN board_source_locations l USING(source_key) WHERE m.source_key=? AND NOT EXISTS (SELECT 1 FROM board_source_suppressions s WHERE s.source_key=m.source_key)'
			)
			.get(target.sourceKey) as { snapshot: Uint8Array } | undefined;
		if (!ledger) return undefined;
		const plan = JSON.parse(Buffer.from(ledger.snapshot).toString('utf8'));
		if (
			canonicalJson(plan.source ?? null) !== canonicalJson(source) ||
			plan.repository?.validated !== true ||
			plan.repository.workingDirectory !== source.path ||
			canonicalJson(plan.repository.location ?? null) !== canonicalJson(source.location)
		)
			return undefined;
		return createHash('sha256').update(ledger.snapshot).digest('hex');
	};
	const retained = associated.matched === '[]' ? retainedRemoteIdentity() : undefined;
	// Only bulk card archival may use a closed local namespace. No filesystem,
	// repository, run or human authority is inferred from the persisted location.
	// Observed-but-invalid registrations (including aliases) must never become orphans.
	const centralDeletion =
		action === 'delete-cards' &&
		source?.location.kind === 'local' &&
		target.projectRoot === BOARD_SOURCE_PROJECT_PREFIX + target.sourceKey &&
		associated.registered === '[]' &&
		!admitted?.has(source.path);

	let physical: unknown;
	if (source) {
		if (
			associated.matched === '[]' &&
			!retained &&
			!centralDeletion &&
			!(source.location.kind === 'local' && admitted?.has(source.path))
		)
			throw new BoardStorageError('legacy-mapping-missing', 'Board target is no longer registered');
		if (centralDeletion) {
			physical = ['central-card-archival', target.sourceKey];
		} else if (source.location.kind === 'local') {
			try {
				const root = await fs.promises.realpath(source.path);
				requireBoardEnabled();
				const stat = await fs.promises.stat(root);
				requireBoardEnabled();
				if (root !== source.path || !stat.isDirectory())
					throw new BoardStorageError(
						'identity-mismatch',
						'Board target physical identity changed'
					);
				physical = [root, stat.dev, stat.ino];
			} catch (error) {
				if (
					!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(
						(error as NodeJS.ErrnoException).code ?? ''
					)
				)
					throw error;
				throw new BoardStorageError(
					'legacy-mapping-missing',
					'Board target physical directory unavailable'
				);
			}
		} else if (retained) {
			physical = ['retained-central-ssh', retained];
		} else {
			physical = await probeBoardRemoteRepository(
				source.location.remoteId,
				source.path,
				source.path,
				remote,
				requireBoardEnabled
			);
		}
	} else {
		// An explicit central reference has no filesystem authority. Do not guess a root
		// from a worker/repository or a newly discovered association. Unmapped imports
		// need their explicit adapter; a registered rootless central source stays central.
		if (
			target.projectRoot !== BOARD_SOURCE_PROJECT_PREFIX + target.sourceKey ||
			storage.db.prepare('SELECT 1 FROM migrations WHERE source_key=?').get(target.sourceKey)
		)
			throw new BoardStorageError(
				'legacy-mapping-missing',
				'Board target source location is unresolved'
			);
		physical = ['central', target.sourceKey];
	}
	const after = await storage.prepareQuery(query);
	requireBoardEnabled();
	const current = sessions();
	admittedSources(current, remote);
	const currentAssociation = await association(current);
	requireBoardEnabled();
	if (
		after.projectRoot !== prepared.projectRoot ||
		storage.sourceIdentity(target.sourceKey) !== before ||
		canonicalJson(storage.sourceLocation(target.sourceKey) ?? null) !==
			canonicalJson(source ?? null) ||
		canonicalJson(currentAssociation) !== canonicalJson(associated) ||
		(retained !== undefined && retainedRemoteIdentity() !== retained)
	)
		throw new BoardStorageError('stale-revision', 'Board target source changed during admission');
	if (
		storage.db
			.prepare('SELECT 1 FROM board_source_suppressions WHERE source_key=?')
			.get(target.sourceKey)
	)
		throw new BoardStorageError('protected-field', 'Board target source is suppressed');
	verifyCollection();
	return {
		projectRoot: prepared.projectRoot!,
		identity: canonicalJson({ before, source: source ?? null, associated, physical }),
	};
}

/** Injectable storage and recorded sessions keep fixture discovery away from live data. */
export async function discoverBoardSources(
	storage: BoardStorageFacade,
	registered: BoardSourceSession[],
	remote: BoardRemoteTransport = boardRemoteTransport,
	checkpoint: () => void = requireBoardEnabled
): Promise<void> {
	checkpoint();
	const admitted = admittedSources(registered, remote);
	if (admitted) {
		registered = [
			...registered,
			...[...admitted].map((root) => ({ id: `source:${root}`, dir: root })),
		];
	}
	await discoverRemoteBoardSources(storage, registered, remote, checkpoint);
	checkpoint();
	await discoverLocalBoardSources(
		storage,
		registered,
		admitted
			? {
					roots: admitted,
					assertInputPath: (file) => {
						assertBoardIsolationPath(requireBoardIsolation(), file);
					},
				}
			: undefined,
		checkpoint
	);
	checkpoint();
}

/** Admit the retained process, registries and persisted source identity before running the algorithm. */
export async function executeBoardSourceCommand(
	command: import('../../shared/board/types').BoardSourceCommand,
	storage?: BoardStorageFacade,
	remote: BoardRemoteTransport = isolatedHost?.remote ?? boardRemoteTransport
): Promise<import('../../shared/board/types').BoardSourceResponse> {
	requireBoardEnabled();
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
	return executeBoardSourceOperation(command, storage, registered, remote, requireBoardEnabled);
}
