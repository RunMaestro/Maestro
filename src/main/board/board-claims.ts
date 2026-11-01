/** Durable claim primitive. No scheduler, process launcher, owner takeover or timer.
 * The owning runtime supplies fresh synchronous registry/liveness evidence; all
 * SQLite checks and writes share one IMMEDIATE transaction. A prepared claim is
 * capacity reserved, not evidence that a process started or work succeeded. */
import type Database from 'better-sqlite3';
import { hasUnresolvedMigrationBlockers } from './board-migration';
import { canonicalJson } from '../../shared/canonicalJson';
import { generateUUID } from '../../shared/uuid';
import {
	evaluateClaimWorker,
	persistedCaptureInput,
	type BoardWorkerWaitReason,
} from '../../shared/board/domain';
import { getBlockers, hasCycle } from '../../shared/board/graph';
import {
	validateBoard,
	type BoardCaptureCatalog,
	type BoardCapturePolicy,
} from '../../shared/board/types';
import {
	resolveProfileSpawnOverrides,
	type AgentProfile,
	type ProfileBaseAgentValues,
} from '../../shared/profiles/types';
import { DEFAULT_MAX_IN_PROGRESS } from './board-dispatcher';
import {
	BoardWorkspaceStorage,
	BoardWorkspaceStorageError,
	listBoardWorkers,
	type BoardCardKey,
} from './board-workspace-storage';

export interface BoardClaimReadRevision {
	workspace: number;
	collection: number;
	card: number;
	registry: number;
}
export interface BoardClaimCommand extends BoardCardKey {
	requestId: string;
	workerAgentId: string;
	readRevision: BoardClaimReadRevision;
}
export type { BoardRuntimeToken as BoardRunToken } from '../../shared/board/commands';
import type { BoardRuntimeToken as BoardRunToken } from '../../shared/board/commands';

/** Immutable preparation, also consumed by the fenced runtime. */
export interface BoardRunSpecification {
	key: BoardCardKey;
	card: Record<string, unknown>;
	readRevision: BoardClaimReadRevision;
	runToken: BoardRunToken;
	attempt: number;
	workerAgentId: string;
	owner: BoardClaimHostContext['owner'];
	repository: NonNullable<BoardClaimHostContext['repository']>;
	overrides: ProfileBaseAgentValues;
	profile?: AgentProfile;
}
type ExecutionLocation = { kind: 'local' } | { kind: 'ssh'; remoteId: string };

/** Trusted host evidence, never deserialized from a CLI/renderer command.
 * Repository IO is prepared outside the transaction using existing native Git /
 * real-path / SSH services. record is the exact observed repository row; cwd is
 * the card's explicit directory whose identity/containment was validated. The
 * runtime must invalidate preparation on registry/repository changes and recheck
 * after asynchronous preparation before calling this synchronous boundary. */
export interface BoardClaimHostContext {
	owner: { processIdentity: string; epoch: number };
	registryRevision: number;
	dispatchEnabled: boolean;
	/** Canonical handoff most recently verified against native Git by this host. */
	reviewArtifact?: string | null;
	agentStates: Readonly<
		Record<
			string,
			{
				live: boolean;
				busy: boolean;
				location: ExecutionLocation;
				baseValues?: ProfileBaseAgentValues;
			}
		>
	>;
	repository: {
		id: string;
		workingDirectory: string;
		record: Record<string, unknown>;
		location: ExecutionLocation;
		identity: string;
	} | null;
}
export type BoardClaimWaitReason =
	| BoardWorkerWaitReason
	| 'runtime-unavailable'
	| 'owner-conflict'
	| 'stale-revision'
	| 'not-found'
	| 'request-conflict'
	| 'card-claimed'
	| 'worker-busy'
	| 'worker-dormant'
	| 'worker-location-mismatch'
	| 'migration-blocked'
	| 'worker-held'
	| 'invalid-specification'
	| 'approval-required'
	| 'held'
	| 'dependency'
	| 'card-not-ready'
	| 'global-wip'
	| 'collection-wip'
	| 'storage-busy';
export type BoardClaimResult =
	| { ok: false; reason: BoardClaimWaitReason }
	| { ok: true; runToken: BoardRunToken; attempt: number; readRevision: BoardClaimReadRevision };

const waiting = (reason: BoardClaimWaitReason): BoardClaimResult => ({ ok: false, reason });

/** Invalid/missing policy fails closed. Old direct intent is accepted only with
 * the actual migration ledger and no unresolved blockers (checked by the caller). */
function approvedPolicy(
	payload: Record<string, unknown>,
	cardRevision: number,
	migrated: boolean
): BoardCapturePolicy | null {
	const policy = payload.capturePolicy as BoardCapturePolicy | undefined;
	if (policy) {
		if (
			!Number.isSafeInteger(policy.specificationRevision) ||
			policy.specificationRevision < 0 ||
			policy.specificationRevision > cardRevision
		)
			return null;
		if (policy.effectiveStartMode === 'direct' && policy.dispatchApproval === 'not-required')
			return policy;
		if (policy.effectiveStartMode === 'approval' && policy.dispatchApproval === 'granted') {
			const grant = policy.grant;
			if (
				grant?.specificationRevision === policy.specificationRevision &&
				grant.principal &&
				grant.grantedAt
			)
				return policy;
		}
		return null;
	}
	const migration = payload.migration as { intent?: string } | undefined;
	return migrated && migration?.intent === 'legacy-direct'
		? {
				effectiveStartMode: 'direct',
				dispatchApproval: 'not-required',
				specificationRevision: cardRevision,
			}
		: null;
}

/** Used by the facade for both desktop and CLI's later runtime adapter. Owner
 * registration/death proof belongs to that adapter; this function never creates
 * or steals the singleton owner. Replayed success is a receipt, not spawn authority. */
export function claimBoardCard(
	db: Database.Database,
	command: BoardClaimCommand,
	currentHost: () => BoardClaimHostContext & { catalog: BoardCaptureCatalog },
	/** Internal revalidation only. Never allocates, replays a receipt or grants a spawn. */
	prepared?: BoardRunSpecification
): BoardClaimResult {
	if (db.inTransaction && !prepared)
		throw new BoardWorkspaceStorageError('invalid-input', 'Claim requires its own transaction');
	if (
		[
			command.requestId,
			command.sourceKey,
			command.collectionKey,
			command.cardId,
			command.workerAgentId,
		].some((key) => typeof key !== 'string' || !key.trim() || key.includes('\0')) ||
		!command.readRevision ||
		['workspace', 'collection', 'card', 'registry'].some((key) => {
			const value = command.readRevision[key as keyof BoardClaimReadRevision];
			return !Number.isSafeInteger(value) || value < 0;
		})
	)
		throw new BoardWorkspaceStorageError(
			'invalid-input',
			'Explicit claim identities and read revisions required'
		);
	try {
		return db
			.transaction((): BoardClaimResult => {
				const host = currentHost();
				if (host.dispatchEnabled !== true) return waiting('runtime-unavailable');
				const owner = db
					.prepare('SELECT process_identity, epoch FROM runtime_owner WHERE id = 1')
					.get() as { process_identity: string; epoch: number } | undefined;
				if (
					!owner ||
					owner.process_identity !== host.owner.processIdentity ||
					owner.epoch !== host.owner.epoch
				)
					return waiting('owner-conflict');
				const principal = `board-claim:${owner.process_identity}:${owner.epoch}`;
				const receipt = db
					.prepare('SELECT principal, result_json FROM commands WHERE request_id = ?')
					.get(command.requestId) as { principal: string; result_json: string } | undefined;
				if (receipt && !prepared) {
					const stored = JSON.parse(receipt.result_json) as {
						command: BoardClaimCommand;
						result: BoardClaimResult;
					};
					return receipt.principal === principal &&
						canonicalJson(stored.command) === canonicalJson(command)
						? stored.result
						: waiting('request-conflict');
				}
				const workspace = new BoardWorkspaceStorage(db);
				const collection = workspace.readCollection(command);
				const card = collection?.cards.find((entry) => entry.cardId === command.cardId);
				if (!collection || collection.archived || !card || card.archived)
					return waiting('not-found');
				if (
					db
						.prepare(
							'SELECT 1 FROM reservations WHERE collection_key = ? AND card_id = ? AND run_id != ?'
						)
						.get(command.collectionKey, command.cardId, prepared?.runToken.runId ?? '')
				)
					return waiting('card-claimed');
				if (
					db
						.prepare('SELECT 1 FROM reservations WHERE worker_agent_id = ? AND run_id != ?')
						.get(command.workerAgentId, prepared?.runToken.runId ?? '')
				)
					return waiting('worker-busy');
				const state = db
					.prepare('SELECT revision, global_wip_limit FROM workspace WHERE id = 1')
					.get() as { revision: number; global_wip_limit: number | null };
				const readRevision = {
					workspace: state.revision,
					collection: collection.revision,
					card: card.revision,
					registry: host.registryRevision,
				};
				if (prepared) {
					const reservation = db
						.prepare('SELECT * FROM reservations WHERE run_id = ?')
						.get(prepared.runToken.runId) as
						| { owner_epoch: number; generation: number; phase: string; worker_agent_id: string }
						| undefined;
					if (
						!reservation ||
						reservation.owner_epoch !== host.owner.epoch ||
						reservation.generation !== prepared.runToken.generation ||
						reservation.worker_agent_id !== command.workerAgentId ||
						!['prepared', 'starting'].includes(reservation.phase)
					)
						return waiting('card-claimed');
					if (
						card.revision !== prepared.readRevision.card + 1 ||
						host.registryRevision !== prepared.readRevision.registry ||
						canonicalJson(card.payload) !== canonicalJson(prepared.card)
					)
						return waiting('stale-revision');
				} else if (canonicalJson(readRevision) !== canonicalJson(command.readRevision))
					return waiting('stale-revision');
				const migration = card.payload.migration as
					| { blockers?: unknown[]; sourceKey?: string }
					| undefined;
				const ledger = db
					.prepare('SELECT payload_json FROM migration_blockers WHERE source_key = ?')
					.get(command.sourceKey) as { payload_json: string } | undefined;
				const blockers: unknown = ledger ? JSON.parse(ledger.payload_json) : [];
				if (
					hasUnresolvedMigrationBlockers(blockers) ||
					(migration?.blockers && hasUnresolvedMigrationBlockers(migration.blockers))
				)
					return waiting('migration-blocked');
				if (
					db
						.prepare('SELECT 1 FROM migration_worker_holds WHERE worker_agent_id = ?')
						.get(command.workerAgentId)
				)
					return waiting('worker-held');
				const activeCards = collection.cards.filter((entry) => !entry.archived);
				const board = validateBoard({
					...collection.payload,
					cards: activeCards.map((entry) => entry.payload),
				});
				if (!board || board.cards.length !== activeCards.length || hasCycle(board))
					return waiting('invalid-specification');
				const selected = board.cards.find((entry) => entry.id === command.cardId);
				if (!selected) return waiting('invalid-specification');
				if (
					selected.kind === 'review' &&
					(!selected.reviewHandoff || host.reviewArtifact !== canonicalJson(selected.reviewHandoff))
				)
					return waiting('review-artifact-unresolved');
				if (selected.heldByUser) return waiting('held');
				if (selected.status !== 'todo' && selected.status !== 'ready')
					return waiting('card-not-ready');
				if (getBlockers(selected, board).length) return waiting('dependency');
				const migrated =
					!!db.prepare('SELECT 1 FROM migrations WHERE source_key = ?').get(command.sourceKey) &&
					migration?.sourceKey === command.sourceKey;
				const policy = approvedPolicy(card.payload, card.revision, migrated);
				if (!policy) return waiting('approval-required');
				const workers = listBoardWorkers(db).map((worker) => ({
					...worker,
					roleRefs: Array.isArray(worker.payload.roleRefs) ? worker.payload.roleRefs : [],
					allowedRepositoryIds: Array.isArray(worker.payload.allowedRepositoryIds)
						? worker.payload.allowedRepositoryIds
						: [],
				}));
				const reason = evaluateClaimWorker(
					persistedCaptureInput(selected, card.payload),
					command.workerAgentId,
					{
						...host.catalog,
						canRelaxStartPolicy: true,
						workers,
						repositoryIds: host.catalog.repositories
							.filter((entry) => entry.validated)
							.map((entry) => entry.id),
					}
				);
				if (reason) return waiting(reason);
				const agent = host.agentStates[command.workerAgentId];
				if (agent?.live !== true) return waiting('worker-dormant');
				if (agent.busy !== false) return waiting('worker-busy');
				const repository = host.repository;
				const repositoryRow = db
					.prepare('SELECT payload_json FROM repositories WHERE id = ?')
					.get(selected.repositoryId) as { payload_json: string } | undefined;
				if (
					!repository ||
					!repository.identity ||
					repository.id !== selected.repositoryId ||
					repository.workingDirectory !== selected.workingDirectory ||
					!repositoryRow ||
					repository.record.validated !== true ||
					canonicalJson(JSON.parse(repositoryRow.payload_json)) !== canonicalJson(repository.record)
				)
					return waiting('repository-unresolved');
				if (canonicalJson(agent.location) !== canonicalJson(repository.location))
					return waiting('worker-location-mismatch');
				if (prepared && canonicalJson(repository) !== canonicalJson(prepared.repository))
					return waiting('stale-revision');
				// Every reserved phase counts, including preparation, stopping and uncertainty.
				// Legacy running cards without a reservation also occupy capacity.
				const capacity = db
					.prepare(
						`SELECT collection_key, card_id FROM reservations
				UNION SELECT collection_key, id AS card_id FROM cards WHERE json_extract(payload_json, '$.status') = 'running'`
					)
					.all() as { collection_key: string; card_id: string }[];
				if (prepared) {
					const own = capacity.findIndex(
						(entry) =>
							entry.collection_key === command.collectionKey && entry.card_id === command.cardId
					);
					if (own >= 0) capacity.splice(own, 1);
				}
				if (state.global_wip_limit !== null && capacity.length >= state.global_wip_limit)
					return waiting('global-wip');
				if (
					capacity.filter((entry) => entry.collection_key === command.collectionKey).length >=
					(board.maxInProgress ?? DEFAULT_MAX_IN_PROGRESS)
				)
					return waiting('collection-wip');
				const last = db
					.prepare(
						'SELECT max(attempt) AS attempt FROM runs WHERE collection_key = ? AND card_id = ?'
					)
					.get(command.collectionKey, command.cardId) as { attempt: number | null };
				const attempt = (last.attempt ?? 0) + 1;
				if (!Number.isSafeInteger(attempt)) return waiting('invalid-specification');
				const runToken = { runId: generateUUID(), ownerEpoch: owner.epoch, generation: attempt };
				const role =
					selected.role ??
					(typeof card.payload.profileNamespace === 'string' && selected.assigneeProfileId
						? { namespace: card.payload.profileNamespace, profileId: selected.assigneeProfileId }
						: undefined);
				const profile =
					role &&
					host.catalog.profiles.find(
						(entry) => entry.namespace === role.namespace && entry.profile.id === role.profileId
					)?.profile;
				const overrides = profile
					? resolveProfileSpawnOverrides(profile, agent.baseValues)
					: (agent.baseValues ?? {});
				if (prepared) {
					if (
						canonicalJson({ profile, overrides }) !==
						canonicalJson({ profile: prepared.profile, overrides: prepared.overrides })
					)
						return waiting('stale-revision');
					return { ok: true, runToken: prepared.runToken, attempt: prepared.attempt, readRevision };
				}
				const now = new Date().toISOString();
				const specification = {
					key: {
						sourceKey: command.sourceKey,
						collectionKey: command.collectionKey,
						cardId: command.cardId,
					},
					card: card.payload,
					policy,
					readRevision,
					runToken,
					attempt,
					preparedAt: now,
					workerAgentId: command.workerAgentId,
					owner: host.owner,
					membership: host.catalog.agents.find((entry) => entry.id === command.workerAgentId),
					repository,
					role,
					profile,
					overrides,
				};
				db.prepare(
					'INSERT INTO runs (run_id, collection_key, card_id, attempt, specification_json) VALUES (?, ?, ?, ?, ?)'
				).run(
					runToken.runId,
					command.collectionKey,
					command.cardId,
					attempt,
					canonicalJson(specification)
				);
				db.prepare(
					'INSERT INTO reservations (worker_agent_id, collection_key, card_id, run_id, owner_epoch, generation, phase) VALUES (?, ?, ?, ?, ?, ?, ?)'
				).run(
					command.workerAgentId,
					command.collectionKey,
					command.cardId,
					runToken.runId,
					owner.epoch,
					attempt,
					'prepared'
				);
				// Separate from public running/history: the process has not started yet.
				db.prepare(
					'UPDATE cards SET revision = revision + 1 WHERE collection_key = ? AND id = ?'
				).run(command.collectionKey, command.cardId);
				db.prepare('UPDATE collections SET revision = revision + 1 WHERE collection_key = ?').run(
					command.collectionKey
				);
				db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
				const result: BoardClaimResult = { ok: true, runToken, attempt, readRevision };
				db.prepare(
					'INSERT INTO commands (request_id, principal, result_json, revision) VALUES (?, ?, ?, ?)'
				).run(command.requestId, principal, canonicalJson({ command, result }), state.revision + 1);
				return result;
			})
			.immediate();
	} catch (error) {
		if ((error as { code?: string }).code === 'SQLITE_BUSY') return waiting('storage-busy');
		throw error; // Unexpected storage/corruption failures roll back, never become an empty success.
	}
}

/** Native non-Board intake observes the same durable capacity fences as claims.
 * Only the Board Cue service supplies its exact run id to enter its reservation. */
export function boardWorkerCanStart(
	db: Database.Database,
	agentId: string,
	runId?: string
): boolean {
	if (db.prepare('SELECT 1 FROM migration_worker_holds WHERE worker_agent_id=?').get(agentId))
		return false;
	const reservation = db
		.prepare('SELECT run_id FROM reservations WHERE worker_agent_id=?')
		.get(agentId) as { run_id: string } | undefined;
	return !reservation || (runId !== undefined && reservation.run_id === runId);
}
