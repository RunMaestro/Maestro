/** Pure planning of explicitly supplied legacy Board sources. No discovery or writes. */
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { isPathAtOrUnderRoot } from '../../shared/worktreePaths';
import { canonicalJson } from '../../shared/canonicalJson';
import { validateBoard, validateBoardCard } from '../../shared/board/types';
import { validateAgentProfile } from '../../shared/profiles/types';
import type Database from 'better-sqlite3';
import { selectPoolAgentIds } from '../../shared/board/pool';

export interface BoardMigrationInput {
	/** Canonical location and source path supplied by the caller, never inferred from a worker. */
	source: { location: { kind: 'local' } | { kind: 'ssh'; remoteId: string }; path: string };
	repository: {
		id: string;
		workingDirectory: string;
		validated: boolean;
		location?: BoardMigrationInput['source']['location'];
	} | null;
	boardBytes: Uint8Array | null;
	profileBytes: Uint8Array | null;
	workers: unknown[];
}

export interface MigrationEntry {
	index: number;
	legacyId: string | null;
	raw: unknown;
	conflicts: string[];
}

export interface MigrationCard extends MigrationEntry {
	executionScope: { kind: 'agent'; agentId: string } | null;
	profileNamespace: string | null;
	intent:
		| 'approval-required'
		| 'legacy-direct'
		| 'human-review'
		| 'reconciliation-required'
		| 'inactive'
		| 'unknown';
	blockers: string[];
}

export interface BoardMigrationPlan {
	source?: BoardMigrationInput['source'];
	sourceKey: string;
	profileNamespace: string;
	snapshot: { boardBase64: string | null; profileBase64: string | null; workers: unknown[] };
	hashes: { board: string | null; profiles: string | null; workers: string };
	repository: BoardMigrationInput['repository'];
	boards: (MigrationEntry & { collectionKey: string | null; cards: MigrationCard[] })[];
	profiles: MigrationEntry[];
	conflicts: string[];
}

function hash(value: Uint8Array | string): string {
	return createHash('sha256').update(value).digest('hex');
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function id(value: unknown): string | null {
	const candidate = record(value)?.id;
	return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function entries(bytes: Uint8Array | null, field: string): unknown[] {
	if (bytes === null) return [];
	const parsed: unknown = yaml.load(Buffer.from(bytes).toString('utf8'), {
		schema: yaml.JSON_SCHEMA,
	});
	if (parsed == null) return [];
	const root = record(parsed);
	if (!root || (root[field] != null && !Array.isArray(root[field]))) {
		throw new Error(`Invalid legacy ${field} document`);
	}
	return (root[field] as unknown[] | null | undefined) ?? [];
}

function duplicates(values: unknown[]): Set<string> {
	const seen = new Set<string>();
	const repeated = new Set<string>();
	for (const value of values) {
		const key = id(value);
		if (key && seen.has(key)) repeated.add(key);
		if (key) seen.add(key);
	}
	return repeated;
}

/** Retains raw entries and bytes even when legacy validators reject or normalize them. */
export function boardMigrationSourceKey(source: BoardMigrationInput['source']): string {
	return hash(canonicalJson(source));
}

export function planBoardMigration(input: BoardMigrationInput): BoardMigrationPlan {
	if (
		!input.source.path ||
		(input.source.location.kind === 'ssh' && !input.source.location.remoteId)
	) {
		throw new Error('Canonical source identity is required');
	}
	const sourceKey = boardMigrationSourceKey(input.source);
	const profileNamespace = `legacy:${sourceKey}`;
	const rawBoards = entries(input.boardBytes, 'boards');
	const rawProfiles = entries(input.profileBytes, 'profiles');
	const duplicateBoards = duplicates(rawBoards);
	const duplicateProfiles = duplicates(rawProfiles);
	const profiles = rawProfiles.map((raw, index): MigrationEntry => {
		const legacyId = id(raw);
		return {
			index,
			legacyId,
			raw,
			conflicts: [
				...(!validateAgentProfile(raw) ? ['invalid-profile'] : []),
				...(legacyId && duplicateProfiles.has(legacyId) ? ['duplicate-profile-id'] : []),
			],
		};
	});
	const boards = rawBoards.map((raw, index) => {
		const legacyId = id(raw);
		const board = record(raw);
		const rawCards = Array.isArray(board?.cards) ? board.cards : [];
		const duplicateCards = duplicates(rawCards);
		const conflicts = [
			...(!validateBoard(raw) ? ['invalid-board'] : []),
			...(legacyId && duplicateBoards.has(legacyId) ? ['duplicate-board-id'] : []),
			...(duplicateCards.size ? ['duplicate-card-id'] : []),
		];
		const cards = rawCards.map((cardRaw, cardIndex): MigrationCard => {
			const card = record(cardRaw);
			const cardId = id(cardRaw);
			const role = typeof card?.assigneeProfileId === 'string' ? card.assigneeProfileId : null;
			const matchingProfiles = profiles.filter((p) => p.legacyId === role);
			const base =
				matchingProfiles.length === 1 && matchingProfiles[0].conflicts.length === 0
					? record(matchingProfiles[0].raw)?.baseAgentId
					: undefined;
			const pin =
				typeof card?.assigneeAgentId === 'string' && card.assigneeAgentId
					? card.assigneeAgentId
					: null;
			const basePin = typeof base === 'string' && base ? base : null;
			const blockers = [...conflicts];
			if (!validateBoardCard(cardRaw, '1970-01-01T00:00:00.000Z')) blockers.push('invalid-card');
			if (cardId && duplicateCards.has(cardId)) blockers.push('duplicate-card-id');
			if (role && (matchingProfiles.length !== 1 || matchingProfiles[0].conflicts.length))
				blockers.push('profile-unresolved');
			if (pin && basePin && pin !== basePin) blockers.push('pin-role-conflict');
			const agentId = pin || basePin;
			if (!agentId) blockers.push('missing-scope');
			if (!input.repository?.validated) blockers.push('repository-unresolved');
			const status = card?.status;
			const intent =
				status === 'triage'
					? 'approval-required'
					: status === 'todo' || status === 'ready'
						? 'legacy-direct'
						: status === 'review'
							? 'human-review'
							: status === 'running'
								? 'reconciliation-required'
								: status === 'blocked' || status === 'done'
									? 'inactive'
									: 'unknown';
			if (intent !== 'legacy-direct') blockers.push(intent);
			if (card?.heldByUser === true) blockers.push('held');
			return {
				index: cardIndex,
				legacyId: cardId,
				raw: cardRaw,
				conflicts: blockers,
				blockers,
				executionScope: agentId ? { kind: 'agent', agentId } : null,
				profileNamespace: role ? profileNamespace : null,
				intent,
			};
		});
		return {
			index,
			legacyId,
			raw,
			conflicts,
			collectionKey: legacyId ? `legacy:${hash(canonicalJson([sourceKey, legacyId]))}` : null,
			cards,
		};
	});
	// A worker named by multiple unfinished runs is a conflict, not a winner selection.
	const runningWorkers = new Map<string, MigrationCard[]>();
	for (const board of boards) {
		for (const card of board.cards) {
			if (card.intent !== 'reconciliation-required') continue;
			const runs = record(card.raw)?.runs;
			const unfinished = Array.isArray(runs) ? runs.filter((run) => !record(run)?.endedAt) : [];
			const workerIds = unfinished
				.map((run) => record(run)?.workerAgentId)
				.filter((worker): worker is string => typeof worker === 'string' && worker.length > 0);
			if (!workerIds.length) card.blockers.push('running-worker-unknown');
			for (const worker of workerIds) {
				const claims = runningWorkers.get(worker) ?? [];
				claims.push(card);
				runningWorkers.set(worker, claims);
			}
		}
	}
	for (const claims of runningWorkers.values()) {
		if (claims.length > 1) for (const card of claims) card.blockers.push('running-worker-conflict');
	}
	return {
		sourceKey,
		source: input.source,
		profileNamespace,
		snapshot: {
			boardBase64:
				input.boardBytes === null ? null : Buffer.from(input.boardBytes).toString('base64'),
			profileBase64:
				input.profileBytes === null ? null : Buffer.from(input.profileBytes).toString('base64'),
			workers: input.workers,
		},
		hashes: {
			board: input.boardBytes === null ? null : hash(input.boardBytes),
			profiles: input.profileBytes === null ? null : hash(input.profileBytes),
			workers: hash(canonicalJson(input.workers)),
		},
		repository: input.repository,
		boards,
		profiles,
		conflicts: [
			...(duplicateBoards.size ? ['duplicate-board-id'] : []),
			...(duplicateProfiles.size ? ['duplicate-profile-id'] : []),
		],
	};
}

/** Null keys identify archived conflicts, never silently renamed active entities. */
export interface BoardMigrationMapping {
	sourceKey: string;
	profileNamespace: string;
	boards: {
		index: number;
		legacyId: string | null;
		collectionKey: string | null;
		cards: { index: number; legacyId: string | null; id: string | null; runIds: string[] }[];
	}[];
	profiles: { index: number; legacyId: string | null; id: string | null }[];
}

export type BoardMigrationResult =
	| { status: 'imported' | 'already-imported'; mapping: BoardMigrationMapping }
	| { status: 'source-changed'; mapping: BoardMigrationMapping };

/**
 * Apply only to an explicitly opened workspace. No source/session writes or discovery.
 * The caller must honor migration blockers/worker holds before enabling dispatch;
 * these are reconciliation fences, not proof that a legacy process has stopped.
 */
export function applyBoardMigration(
	db: Database.Database,
	plan: BoardMigrationPlan,
	options: { now?: () => number; beforeCommit?: () => void } = {}
): BoardMigrationResult {
	// Hash the complete plan as well: changed repository validation or import semantics
	// must not masquerade as an identical import just because YAML bytes are unchanged.
	const serialized = canonicalJson(plan);
	const hashesJson = canonicalJson({ ...plan.hashes, plan: hash(serialized) });
	if (db.inTransaction) throw new Error('Board migration requires its own IMMEDIATE transaction');
	return db
		.transaction((): BoardMigrationResult => {
			const previous = db
				.prepare('SELECT hashes_json, mapping_json, snapshot FROM migrations WHERE source_key = ?')
				.get(plan.sourceKey) as
				| { hashes_json: string; mapping_json: string; snapshot: Buffer }
				| undefined;
			if (previous) {
				applyMigrationWorkerAccess(
					db,
					JSON.parse(previous.snapshot.toString()) as BoardMigrationPlan
				);
				return {
					status: previous.hashes_json === hashesJson ? 'already-imported' : 'source-changed',
					mapping: JSON.parse(previous.mapping_json) as BoardMigrationMapping,
				};
			}

			const mapping: BoardMigrationMapping = {
				sourceKey: plan.sourceKey,
				profileNamespace: plan.profileNamespace,
				boards: [],
				profiles: [],
			};
			const blockers: unknown[] = [...plan.conflicts];
			if (plan.source)
				db.prepare('INSERT OR IGNORE INTO board_source_locations VALUES (?, ?)').run(
					plan.sourceKey,
					canonicalJson(plan.source)
				);
			const insertCollection = db.prepare(
				'INSERT INTO collections (collection_key, source_key, legacy_board_id, payload_json) VALUES (?, ?, ?, ?)'
			);
			const insertCard = db.prepare(
				'INSERT INTO cards (collection_key, id, payload_json) VALUES (?, ?, ?)'
			);
			const insertRun = db.prepare(
				'INSERT INTO runs (run_id, collection_key, card_id, attempt, specification_json, outcome_json) VALUES (?, ?, ?, ?, ?, ?)'
			);
			const holdWorker = db.prepare(
				'INSERT INTO migration_worker_holds (worker_agent_id, claims_json) VALUES (?, ?) ON CONFLICT (worker_agent_id) DO UPDATE SET claims_json = excluded.claims_json'
			);
			const readHold = db.prepare(
				'SELECT claims_json FROM migration_worker_holds WHERE worker_agent_id = ?'
			);
			for (const board of plan.boards) {
				// A duplicate collection/card key cannot represent an unambiguous DAG.
				// Archive the entire collection in the ledger instead of selecting a winner.
				const collectionKey = board.conflicts.length ? null : board.collectionKey;
				const boardMapping: BoardMigrationMapping['boards'][number] = {
					index: board.index,
					legacyId: board.legacyId,
					collectionKey,
					cards: [],
				};
				mapping.boards.push(boardMapping);
				if (!collectionKey) blockers.push({ board: board.index, reasons: board.conflicts });
				if (collectionKey) {
					insertCollection.run(
						collectionKey,
						plan.sourceKey,
						board.legacyId,
						canonicalJson({ ...record(board.raw), cards: [], migration: { raw: board.raw } })
					);
				}
				for (const card of board.cards) {
					const raw = record(card.raw);
					const runs = Array.isArray(raw?.runs) ? raw.runs : [];
					const attempts = runs.map((run) => record(run)?.attempt);
					const validRuns =
						attempts.every(
							(attempt) =>
								typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt > 0
						) && new Set(attempts).size === attempts.length;
					const unfinished = runs.filter((run) => !record(run)?.endedAt);
					const cardBlockers = [
						...card.blockers,
						...(!validRuns ? ['invalid-run-history'] : []),
						...(unfinished.length ? ['reconciliation-required'] : []),
						...(unfinished.some(
							(run) => typeof record(run)?.workerAgentId !== 'string' || !record(run)?.workerAgentId
						)
							? ['running-worker-unknown']
							: []),
					];
					const cardId = collectionKey ? card.legacyId : null;
					const cardMapping = {
						index: card.index,
						legacyId: card.legacyId,
						id: cardId,
						runIds: [] as string[],
					};
					boardMapping.cards.push(cardMapping);
					if (cardBlockers.length)
						blockers.push({ board: board.index, card: card.index, reasons: cardBlockers });
					if (collectionKey && cardId) {
						insertCard.run(
							collectionKey,
							cardId,
							canonicalJson({
								...raw,
								executionScope: card.executionScope,
								profileNamespace: card.profileNamespace,
								repositoryId: plan.repository?.validated ? plan.repository.id : null,
								workingDirectory: plan.repository?.workingDirectory ?? null,
								migration: {
									raw: card.raw,
									intent: card.intent,
									blockers: cardBlockers,
									sourceKey: plan.sourceKey,
								},
							})
						);
						if (validRuns)
							for (const run of runs) {
								const runId = `legacy:${hash(canonicalJson([collectionKey, cardId, record(run)?.attempt]))}`;
								insertRun.run(
									runId,
									collectionKey,
									cardId,
									record(run)?.attempt,
									canonicalJson({
										raw: run,
										executionScope: card.executionScope,
										repository: plan.repository,
									}),
									record(run)?.endedAt ? canonicalJson(run) : null
								);
								cardMapping.runIds.push(runId);
							}
					}
					// Preserve every uncertain claim, including archived duplicate/invalid cards.
					for (const run of unfinished) {
						const worker = record(run)?.workerAgentId;
						if (typeof worker !== 'string' || !worker) continue;
						const existing = readHold.get(worker) as { claims_json: string } | undefined;
						const claims = existing ? (JSON.parse(existing.claims_json) as unknown[]) : [];
						claims.push({
							sourceKey: plan.sourceKey,
							board: board.index,
							card: card.index,
							raw: run,
						});
						holdWorker.run(worker, canonicalJson(claims));
					}
				}
			}
			for (const profile of plan.profiles) {
				const profileId = profile.conflicts.length ? null : profile.legacyId;
				mapping.profiles.push({ index: profile.index, legacyId: profile.legacyId, id: profileId });
				if (profileId)
					db.prepare(
						'INSERT INTO profiles (profile_namespace, id, payload_json, source_key) VALUES (?, ?, ?, ?)'
					).run(plan.profileNamespace, profileId, canonicalJson(profile.raw), plan.sourceKey);
				else blockers.push({ profile: profile.index, reasons: profile.conflicts });
			}
			if (plan.repository?.validated) {
				const existing = db
					.prepare('SELECT payload_json FROM repositories WHERE id = ?')
					.get(plan.repository.id) as { payload_json: string } | undefined;
				const payload = canonicalJson(plan.repository);
				if (existing && existing.payload_json !== payload) {
					const previous = JSON.parse(existing.payload_json);
					// Discovery's typed pending SSH record is not an imported repository.
					// Complete this exact identity atomically with the original import snapshot.
					if (
						plan.source?.location.kind !== 'ssh' ||
						plan.repository.id !== `source:${plan.sourceKey}` ||
						previous.sourceStatus !== 'unresolved' ||
						previous.validated !== false ||
						previous.workingDirectory !== plan.source.path ||
						canonicalJson({ location: previous.location }) !==
							canonicalJson({ location: plan.source.location })
					)
						throw new Error('Board migration repository conflict');
					db.prepare('UPDATE repositories SET payload_json=? WHERE id=?').run(
						payload,
						plan.repository.id
					);
				} else if (!existing)
					db.prepare('INSERT INTO repositories VALUES (?, ?)').run(plan.repository.id, payload);
			}
			applyMigrationWorkerAccess(db, plan);
			db.prepare('INSERT INTO migrations VALUES (?, ?, ?, ?, ?)').run(
				plan.sourceKey,
				hashesJson,
				Buffer.from(serialized),
				canonicalJson(mapping),
				(options.now ?? Date.now)()
			);
			db.prepare('INSERT INTO migration_blockers VALUES (?, ?)').run(
				plan.sourceKey,
				canonicalJson(blockers)
			);
			db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
			options.beforeCommit?.();
			return { status: 'imported', mapping };
		})
		.immediate();
}

/** Accumulate only migration-owned grants, without overwriting central or older unmarked restrictions. */
function applyMigrationWorkerAccess(db: Database.Database, plan: BoardMigrationPlan): void {
	const location = plan.source?.location ?? { kind: 'local' as const };
	const candidates = plan.snapshot.workers.flatMap((worker) => {
		const raw = record(worker);
		return raw && typeof raw.id === 'string'
			? [
					{
						id: raw.id,
						dir: typeof raw.dir === 'string' ? raw.dir : null,
						boardWorker:
							raw.boardWorker === true &&
							(location.kind === 'ssh'
								? (record(raw.sessionSshRemoteConfig)?.enabled === true
										? record(raw.sessionSshRemoteConfig)?.remoteId
										: raw.sshRemoteId) === location.remoteId
								: record(raw.sessionSshRemoteConfig)?.enabled !== true && !raw.sshRemoteId),
					},
				]
			: [];
	});
	const allowed = new Set(
		plan.repository?.validated
			? location.kind === 'ssh'
				? candidates
						.filter(
							(c) =>
								c.boardWorker &&
								c.dir &&
								isPathAtOrUnderRoot(c.dir, plan.repository!.workingDirectory)
						)
						.map((c) => c.id)
				: selectPoolAgentIds(plan.repository.workingDirectory, candidates)
			: []
	);
	for (const worker of plan.snapshot.workers) {
		const raw = record(worker);
		if (!raw || raw.boardWorker !== true || typeof raw.id !== 'string' || !raw.id) continue;
		const previous = db
			.prepare('SELECT payload_json FROM workers WHERE agent_id = ?')
			.get(raw.id) as { payload_json: string } | undefined;
		const existing = previous
			? (JSON.parse(previous.payload_json) as {
					roleRefs?: { namespace: string; profileId: string }[];
					allowedRepositoryIds?: string[];
					accessManaged?: boolean;
					migration?: { sourceKey: string; raw: unknown; sources?: Record<string, unknown> };
				})
			: null;
		// Only migration-owned access may accumulate. A central registration or an
		// explicit access edit (even empty) is authoritative; pause/enable are never reset.
		if (existing && (!existing.migration || existing.accessManaged !== false)) continue;
		const roleRefs = allowed.has(raw.id)
			? plan.profiles
					.filter(
						(p) =>
							!p.conflicts.length &&
							(!record(p.raw)?.baseAgentId || record(p.raw)?.baseAgentId === raw.id)
					)
					.map((p) => ({ namespace: plan.profileNamespace, profileId: p.legacyId! }))
			: [];
		const repositories = allowed.has(raw.id) ? [plan.repository!.id] : [];
		const roles = [...(existing?.roleRefs ?? []), ...roleRefs];
		const payload = canonicalJson({
			...existing,
			accessManaged: false,
			roleRefs: roles.filter(
				(role, index) =>
					roles.findIndex(
						(other) => other.namespace === role.namespace && other.profileId === role.profileId
					) === index
			),
			allowedRepositoryIds: [
				...new Set([...(existing?.allowedRepositoryIds ?? []), ...repositories]),
			],
			migration: {
				...(existing?.migration ?? {}),
				sourceKey: existing?.migration?.sourceKey ?? plan.sourceKey,
				raw: existing?.migration?.raw ?? worker,
				sources: { ...(existing?.migration?.sources ?? {}), [plan.sourceKey]: worker },
				blockers:
					existing?.allowedRepositoryIds?.length || repositories.length
						? []
						: ['repository-unresolved'],
			},
		});
		if (previous && canonicalJson(existing) === payload) continue;
		db.prepare(
			'INSERT INTO workers (agent_id, enabled, paused, payload_json) VALUES (?, 1, 0, ?) ON CONFLICT (agent_id) DO UPDATE SET payload_json = excluded.payload_json'
		).run(raw.id, payload);
		db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
	}
}

/** These provenance reasons are enforced from current state by the shared claim
 * gates. Structural/unknown-run blockers remain immutable safety fences. */
export function hasUnresolvedMigrationBlockers(blockers: unknown): boolean {
	if (!Array.isArray(blockers)) return true;
	const currentStateReasons = new Set([
		'approval-required',
		'human-review',
		'inactive',
		'held',
		'missing-scope',
		'repository-unresolved',
		'profile-unresolved',
		'pin-role-conflict',
	]);
	return blockers.some((entry) => {
		if (typeof entry === 'string') return !currentStateReasons.has(entry);
		if (!entry || typeof entry !== 'object' || !Array.isArray(entry.reasons)) return true;
		return hasUnresolvedMigrationBlockers(entry.reasons);
	});
}
