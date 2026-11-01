/**
 * Differential persistence for an explicitly opened machine-local Board DB.
 * This is a trusted storage boundary, not capture validation or dispatch authority.
 * Callers validate commands before writing; legacy transport wiring lives separately.
 */
import type Database from 'better-sqlite3';
import { canonicalJson } from '../../shared/canonicalJson';

/** A Board-owned worker and its preserved migration metadata. */
export interface StoredBoardWorker {
	agentId: string;
	enabled: boolean;
	paused: boolean;
	payload: Record<string, unknown>;
}

/** Read the machine-wide registry, including disabled and paused workers. */
export function listBoardWorkers(db: Database.Database): StoredBoardWorker[] {
	const rows = db
		.prepare('SELECT agent_id, enabled, paused, payload_json FROM workers ORDER BY agent_id')
		.all() as {
		agent_id: string;
		enabled: number;
		paused: number;
		payload_json: string;
	}[];
	return rows.map((row) => {
		const payload: unknown = JSON.parse(row.payload_json);
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
			throw new Error(`Invalid Board worker payload: ${row.agent_id}`);
		}
		return {
			agentId: row.agent_id,
			enabled: row.enabled === 1,
			paused: row.paused === 1,
			payload: payload as Record<string, unknown>,
		};
	});
}

/** Available namespaced roles and validated repository bindings for worker access. */
export function listBoardWorkerAccessOptions(db: Database.Database) {
	const roles = db
		.prepare(
			'SELECT profile_namespace, id, payload_json FROM profiles ORDER BY profile_namespace, id'
		)
		.all() as { profile_namespace: string; id: string; payload_json: string }[];
	const repositories = db
		.prepare('SELECT id, payload_json FROM repositories ORDER BY id')
		.all() as { id: string; payload_json: string }[];
	return {
		roles: roles.map((row) => ({
			namespace: row.profile_namespace,
			profileId: row.id,
			name: String(JSON.parse(row.payload_json).name || row.id),
		})),
		repositories: repositories.map((row) => ({
			id: row.id,
			name: String(JSON.parse(row.payload_json).workingDirectory || row.id),
		})),
	};
}

/** Register once; repeated registration cannot reset a migrated pause or restrictions. */
export function registerBoardWorker(db: Database.Database, agentId: string): boolean {
	if (typeof agentId !== 'string' || !agentId.trim() || agentId.includes('\0'))
		throw new Error('Board worker agent ID is required');
	return db
		.transaction(() => {
			const result = db
				.prepare(
					'INSERT INTO workers (agent_id, enabled, paused, payload_json) VALUES (?, 1, 0, ?) ON CONFLICT (agent_id) DO NOTHING'
				)
				.run(agentId, canonicalJson({ roleRefs: [], allowedRepositoryIds: [] }));
			if (result.changes)
				db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
			return result.changes === 1;
		})
		.immediate();
}

/** Change intake without deleting reservations, provenance or authorization. */
export function setBoardWorkerPaused(
	db: Database.Database,
	agentId: string,
	paused: boolean
): void {
	if (typeof paused !== 'boolean') throw new Error('Invalid Board worker pause');
	db.transaction(() => {
		const worker = db.prepare('SELECT paused FROM workers WHERE agent_id = ?').get(agentId) as
			| { paused: number }
			| undefined;
		if (!worker) throw new Error('Board worker not found');
		if (worker.paused === Number(paused)) return;
		db.prepare('UPDATE workers SET paused = ? WHERE agent_id = ?').run(Number(paused), agentId);
		db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
	}).immediate();
}

/** Enable or disable future Board participation without changing intake or metadata. */
export function setBoardWorkerEnabled(
	db: Database.Database,
	agentId: string,
	enabled: boolean
): void {
	if (typeof enabled !== 'boolean') throw new Error('Invalid Board worker enabled state');
	db.transaction(() => {
		const worker = db.prepare('SELECT enabled FROM workers WHERE agent_id = ?').get(agentId) as
			| { enabled: number }
			| undefined;
		if (!worker) throw new Error('Board worker not found');
		if (worker.enabled === Number(enabled)) return;
		db.prepare('UPDATE workers SET enabled = ? WHERE agent_id = ?').run(Number(enabled), agentId);
		db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
	}).immediate();
}

/** Replace explicitly granted roles and repositories without losing provenance. */
export function setBoardWorkerAccess(
	db: Database.Database,
	agentId: string,
	roleRefs: { namespace: string; profileId: string }[],
	allowedRepositoryIds: string[]
): void {
	if (
		!Array.isArray(roleRefs) ||
		!roleRefs.every(
			(role) =>
				role &&
				typeof role.namespace === 'string' &&
				role.namespace.trim() &&
				typeof role.profileId === 'string' &&
				role.profileId.trim()
		) ||
		!Array.isArray(allowedRepositoryIds) ||
		!allowedRepositoryIds.every((id) => typeof id === 'string' && id.trim())
	)
		throw new Error('Invalid Board worker access');
	db.transaction(() => {
		const row = db.prepare('SELECT payload_json FROM workers WHERE agent_id = ?').get(agentId) as
			| { payload_json: string }
			| undefined;
		if (!row) throw new Error('Board worker not found');
		const payload: unknown = JSON.parse(row.payload_json);
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
			throw new Error(`Invalid Board worker payload: ${agentId}`);
		}
		const existing = payload as Record<string, unknown>;
		const oldRoles = Array.isArray(existing.roleRefs) ? existing.roleRefs : [];
		const oldRepositories = Array.isArray(existing.allowedRepositoryIds)
			? existing.allowedRepositoryIds
			: [];
		for (const role of roleRefs) {
			const preserved = oldRoles.some(
				(old) => old && old.namespace === role.namespace && old.profileId === role.profileId
			);
			if (
				!preserved &&
				!db
					.prepare('SELECT 1 FROM profiles WHERE profile_namespace = ? AND id = ?')
					.get(role.namespace, role.profileId)
			)
				throw new Error('Board worker role not found');
		}
		for (const repository of allowedRepositoryIds) {
			if (
				!oldRepositories.includes(repository) &&
				!db.prepare('SELECT 1 FROM repositories WHERE id = ?').get(repository)
			)
				throw new Error('Board worker repository not found');
		}
		const next = canonicalJson({ ...payload, roleRefs, allowedRepositoryIds, accessManaged: true });
		if (canonicalJson(payload) === next) return;
		db.prepare('UPDATE workers SET payload_json = ? WHERE agent_id = ?').run(next, agentId);
		db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
	}).immediate();
}

export interface BoardCollectionKey {
	sourceKey: string;
	collectionKey: string;
}

export interface BoardCardKey extends BoardCollectionKey {
	cardId: string;
}

/** Raw JSON is retained instead of passing stored data through legacy whitelists. */
export interface StoredBoardCard extends BoardCardKey {
	archived: boolean;
	revision: number;
	payload: Record<string, unknown>;
}

export interface StoredBoardCollection extends BoardCollectionKey {
	archived: boolean;
	legacyBoardId: string;
	revision: number;
	payload: Record<string, unknown>;
}

/** Collection and cards are read in one SQLite snapshot. */
export interface BoardCollectionSnapshot extends StoredBoardCollection {
	cards: StoredBoardCard[];
}

export interface BoardWorkspacePatch {
	/** Object members merge recursively; arrays/scalars replace only the named field. */
	set?: Record<string, unknown>;
	/** Explicit field/path removals; e.g. ['executionScope', 'agentId'] when changing scope kind. */
	unset?: readonly (string | readonly string[])[];
}

export interface BoardCardWrite extends BoardWorkspacePatch {
	delete?: boolean;
	cardId: string;
	/** null asserts absence (create); a number must match the stored revision. */
	expectedRevision: number | null;
}

export interface BoardCollectionWrite extends BoardCollectionKey, BoardWorkspacePatch {
	/** Soft deletion preserves cards, DAG and historical run references. */
	delete?: boolean;
	/** Includes changes to any card in this collection. null asserts a new collection. */
	expectedRevision: number | null;
	/** Required only on creation; source identity and original ID cannot be changed. */
	legacyBoardId?: string;
	/** Only named cards change. Unmentioned cards and all run/claim rows stay intact. */
	cards?: readonly BoardCardWrite[];
}

export type BoardWorkspaceErrorCode =
	| 'runtime-unavailable'
	| 'invalid-input'
	| 'invalid-payload'
	| 'protected-field'
	| 'identity-mismatch'
	| 'already-exists'
	| 'not-found'
	| 'stale-revision'
	| 'legacy-mapping-missing'
	| 'legacy-mapping-ambiguous';

export class BoardWorkspaceStorageError extends Error {
	constructor(
		readonly code: BoardWorkspaceErrorCode,
		message: string,
		readonly details: {
			key?: BoardCollectionKey | BoardCardKey;
			expectedRevision?: number | null;
			actualRevision?: number | null;
			candidates?: BoardCollectionKey[];
			captureErrors?: import('../../shared/board/domain').BoardCaptureError[];
		} = {}
	) {
		super(message);
		this.name = 'BoardWorkspaceStorageError';
	}
}

interface CollectionRow {
	collection_key: string;
	source_key: string;
	legacy_board_id: string;
	payload_json: string;
	revision: number;
}

interface CardRow {
	id: string;
	payload_json: string;
	revision: number;
}

// No general document replacement: migration/raw, approvals, runs and identity are
// host-owned. Future lifecycle commands must have their own fenced transactions.
export const BOARD_COLLECTION_EDITABLE_FIELDS: ReadonlySet<string> = new Set([
	'name',
	'maxInProgress',
	'autoDecompose',
]);
export const BOARD_CARD_EDITABLE_FIELDS: ReadonlySet<string> = new Set([
	'title',
	'body',
	'parents',
	'status',
	'heldByUser',
	'priority',
	'worktree',
	'prOnDone',
	'createdAt',
	'updatedAt',
	'kind',
	'executionScope',
	'assigneeAgentId',
	'assigneeProfileId',
	'profileNamespace',
	'role',
	'repositoryId',
	'workingDirectory',
	'startModeOverride',
]);

function requireKey(value: string): void {
	if (typeof value !== 'string' || !value.trim()) {
		throw new BoardWorkspaceStorageError('invalid-input', 'Explicit nonempty Board keys required');
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPayload(serialized: string): Record<string, unknown> {
	const value: unknown = JSON.parse(serialized);
	if (!isRecord(value)) {
		throw new BoardWorkspaceStorageError('invalid-payload', 'Board payload must be a JSON object');
	}
	return value;
}

/** Patches keep unmentioned nested fields, including future execution metadata. */
function mergePayload(
	stored: Record<string, unknown>,
	patch: Record<string, unknown>
): Record<string, unknown> {
	const result = { ...stored };
	for (const [field, value] of Object.entries(patch)) {
		// defineProperty also treats a JSON key named __proto__ as ordinary data.
		Object.defineProperty(result, field, {
			value:
				isRecord(value) &&
				Object.prototype.hasOwnProperty.call(stored, field) &&
				isRecord(stored[field])
					? mergePayload(stored[field], value)
					: value,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return result;
}

function patchPayload(
	stored: Record<string, unknown>,
	patch: BoardWorkspacePatch,
	allowed: ReadonlySet<string>
): string {
	// Round-trip through the canonical serializer to reject non-JSON data before
	// merging and to detach caller-owned values. Undefined members cannot clear data.
	const set = readPayload(canonicalJson(patch.set ?? {}));
	const removals = (patch.unset ?? []).map((field) =>
		typeof field === 'string' ? [field] : field
	);
	for (const removal of removals) {
		if (!removal.length || removal.some((field) => typeof field !== 'string' || !field)) {
			throw new BoardWorkspaceStorageError('invalid-input', 'Board removal requires a field path');
		}
		let written: unknown = set;
		for (const field of removal) {
			written =
				isRecord(written) && Object.prototype.hasOwnProperty.call(written, field)
					? written[field]
					: undefined;
		}
		if (written !== undefined) {
			throw new BoardWorkspaceStorageError('invalid-input', 'Cannot set and unset the same field');
		}
	}
	for (const field of [...Object.keys(set), ...removals.map((removal) => removal[0])]) {
		if (!allowed.has(field)) {
			throw new BoardWorkspaceStorageError(
				'protected-field',
				`Board field is not editable: ${field}`
			);
		}
	}
	// Detach nested objects before removals so the original remains a reliable
	// change-detection baseline, even for an unset-only patch.
	const next = readPayload(canonicalJson(mergePayload(stored, set)));
	for (const removal of removals) {
		let parent: unknown = next;
		for (const field of removal.slice(0, -1)) {
			parent =
				isRecord(parent) && Object.prototype.hasOwnProperty.call(parent, field)
					? parent[field]
					: undefined;
		}
		if (isRecord(parent)) delete parent[removal[removal.length - 1]];
	}
	return canonicalJson(next);
}

function checkRevision(
	key: BoardCollectionKey | BoardCardKey,
	expectedRevision: number | null,
	actualRevision: number | null
): void {
	if (
		expectedRevision !== null &&
		(!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
	) {
		throw new BoardWorkspaceStorageError('invalid-input', 'Invalid Board expectedRevision', {
			key,
		});
	}
	if (expectedRevision === actualRevision) return;
	const code =
		expectedRevision === null
			? 'already-exists'
			: actualRevision === null
				? 'not-found'
				: 'stale-revision';
	throw new BoardWorkspaceStorageError(code, `Board write rejected: ${code}`, {
		key,
		expectedRevision,
		actualRevision,
	});
}

/**
 * Owns no path, native loader or connection lifecycle. Use openBoardDb(path) and
 * close that injected handle when finished. No YAML discovery, writes or fallback.
 */
export class BoardWorkspaceStorage {
	constructor(private readonly db: Database.Database) {}

	private collectionRow(key: BoardCollectionKey): CollectionRow | undefined {
		requireKey(key.sourceKey);
		requireKey(key.collectionKey);
		const row = this.db
			.prepare('SELECT * FROM collections WHERE collection_key = ?')
			.get(key.collectionKey) as CollectionRow | undefined;
		if (row && row.source_key !== key.sourceKey) {
			throw new BoardWorkspaceStorageError(
				'identity-mismatch',
				'Collection belongs to another source',
				{
					key,
				}
			);
		}
		return row;
	}

	private storedCollection(row: CollectionRow): StoredBoardCollection {
		return {
			sourceKey: row.source_key,
			collectionKey: row.collection_key,
			archived: !!this.db
				.prepare('SELECT 1 FROM collection_archives WHERE collection_key = ?')
				.get(row.collection_key),
			legacyBoardId: row.legacy_board_id,
			revision: row.revision,
			payload: readPayload(row.payload_json),
		};
	}

	private storedCard(key: BoardCollectionKey, row: CardRow): StoredBoardCard {
		return {
			...key,
			cardId: row.id,
			archived: !!this.db
				.prepare('SELECT 1 FROM card_archives WHERE collection_key = ? AND card_id = ?')
				.get(key.collectionKey, row.id),
			revision: row.revision,
			payload: readPayload(row.payload_json),
		};
	}

	/** Host-owned policy snapshot; called inside the facade's capture transaction only.
	 * Deliberately absent from ordinary editable-field allowlists. */
	recordCapturePolicy(
		key: StoredBoardCollection,
		cardId: string,
		policy: { effectiveStartMode: unknown; specificationRevision: number; dispatchApproval: string }
	): void {
		if (!this.db.inTransaction)
			throw new BoardWorkspaceStorageError(
				'invalid-input',
				'Host capture policy requires the writer transaction'
			);
		this.collectionRow(key);
		const row = this.db
			.prepare('SELECT payload_json FROM cards WHERE collection_key = ? AND id = ?')
			.get(key.collectionKey, cardId) as { payload_json: string };
		this.db
			.prepare('UPDATE cards SET payload_json = ? WHERE collection_key = ? AND id = ?')
			.run(
				canonicalJson({ ...readPayload(row.payload_json), capturePolicy: policy }),
				key.collectionKey,
				cardId
			);
	}

	/** Catalog comes only from persisted source registrations and migration ledgers. */
	listSourceKeys(): string[] {
		return (
			this.db
				.prepare(
					'SELECT source_key FROM board_sources UNION SELECT source_key FROM migrations ORDER BY source_key'
				)
				.all() as { source_key: string }[]
		).map((row) => row.source_key);
	}

	/** All collections and card revisions share one read transaction. */
	readWorkspace(): {
		revision: number;
		sourceKeys: string[];
		collections: BoardCollectionSnapshot[];
	} {
		return this.db.transaction(() => ({
			revision: (
				this.db.prepare('SELECT revision FROM workspace WHERE id = 1').get() as { revision: number }
			).revision,
			sourceKeys: this.listSourceKeys(),
			collections: this.listSourceKeys().flatMap((sourceKey) =>
				this.listCollections(sourceKey)
					.filter((entry) => !entry.archived)
					.map((entry) => this.readCollection(entry)!)
			),
		}))();
	}

	listCollections(sourceKey: string): StoredBoardCollection[] {
		requireKey(sourceKey);
		const rows = this.db
			.prepare('SELECT * FROM collections WHERE source_key = ? ORDER BY collection_key')
			.all(sourceKey) as CollectionRow[];
		return rows.map((row) => this.storedCollection(row));
	}

	readCollection(key: BoardCollectionKey): BoardCollectionSnapshot | null {
		return this.db.transaction(() => {
			const row = this.collectionRow(key);
			if (!row) return null;
			const cards = this.db
				.prepare(
					'SELECT id, payload_json, revision FROM cards WHERE collection_key = ? ORDER BY rowid'
				)
				.all(key.collectionKey) as CardRow[];
			return {
				...this.storedCollection(row),
				cards: cards.map((card) => this.storedCard(key, card)),
			};
		})();
	}

	readCard(key: BoardCardKey): StoredBoardCard | null {
		requireKey(key.cardId);
		return this.db.transaction(() => {
			if (!this.collectionRow(key)) return null;
			const row = this.db
				.prepare('SELECT id, payload_json, revision FROM cards WHERE collection_key = ? AND id = ?')
				.get(key.collectionKey, key.cardId) as CardRow | undefined;
			return row ? this.storedCard(key, row) : null;
		})();
	}

	/** Canonical source candidates must be supplied by the legacy adapter, never guessed here. */
	resolveLegacyCollection(
		sourceKeys: readonly string[],
		legacyBoardId: string
	): BoardCollectionKey {
		requireKey(legacyBoardId);
		const candidates = this.db.transaction(() => {
			const query = this.db.prepare(
				'SELECT collection_key, source_key FROM collections WHERE source_key = ? AND legacy_board_id = ?'
			);
			return [...new Set(sourceKeys)].flatMap((sourceKey) => {
				requireKey(sourceKey);
				const row = query.get(sourceKey, legacyBoardId) as CollectionRow | undefined;
				return row ? [{ sourceKey: row.source_key, collectionKey: row.collection_key }] : [];
			});
		})();
		if (candidates.length !== 1) {
			const code = candidates.length ? 'legacy-mapping-ambiguous' : 'legacy-mapping-missing';
			throw new BoardWorkspaceStorageError(code, `Cannot resolve legacy Board: ${code}`, {
				candidates,
			});
		}
		return candidates[0];
	}

	/** Narrow result writer: existing completed run only; never replaces history or its FK row. */
	stampRunPr(
		input: BoardCardKey & {
			expectedRevision: number;
			expectedCardRevision: number;
			run: { attempt: number; startedAt: string };
			result: { prUrl: string } | { prError: string };
			updatedAt: string;
		}
	): BoardCollectionSnapshot {
		if (this.db.inTransaction)
			throw new BoardWorkspaceStorageError('invalid-input', 'Own transaction required');
		return this.db
			.transaction(() => {
				const collection = this.readCollection(input);
				checkRevision(input, input.expectedRevision, collection?.revision ?? null);
				const card = collection!.cards.find((entry) => entry.cardId === input.cardId);
				checkRevision(input, input.expectedCardRevision, card?.revision ?? null);
				const runs = card!.payload.runs;
				if (!Array.isArray(runs)) throw new BoardWorkspaceStorageError('not-found', 'Run missing');
				const matches = runs.filter(
					(run) =>
						isRecord(run) &&
						run.attempt === input.run.attempt &&
						run.startedAt === input.run.startedAt
				);
				if (matches.length !== 1 || !isRecord(matches[0]) || !matches[0].endedAt) {
					throw new BoardWorkspaceStorageError(
						'protected-field',
						'PR result requires an unambiguous completed run'
					);
				}
				const rows = this.db
					.prepare(
						'SELECT run_id, outcome_json FROM runs WHERE collection_key = ? AND card_id = ? AND attempt = ?'
					)
					.all(input.collectionKey, input.cardId, input.run.attempt) as {
					run_id: string;
					outcome_json: string | null;
				}[];
				if (rows.length !== 1 || rows[0].outcome_json === null)
					throw new BoardWorkspaceStorageError('protected-field', 'Completed central run missing');
				const outcome = readPayload(rows[0].outcome_json);
				// Fenced runtime outcomes wrap the card run; migrated outcomes retain
				// the original flat run. Validate and stamp the same identity in both.
				const cardOutcome = isRecord(outcome.cardOutcome) ? outcome.cardOutcome : null;
				const completedRun = cardOutcome ? cardOutcome.run : outcome;
				if (
					!isRecord(completedRun) ||
					completedRun.startedAt !== input.run.startedAt ||
					completedRun.attempt !== input.run.attempt
				)
					throw new BoardWorkspaceStorageError('identity-mismatch', 'PR run changed');
				const patch = (run: Record<string, unknown>) => {
					const next: Record<string, unknown> = { ...run, ...input.result };
					if ('prUrl' in input.result) delete next.prError;
					return next;
				};
				const next = {
					...card!.payload,
					updatedAt: input.updatedAt,
					runs: runs.map((run) => (run === matches[0] ? patch(run) : run)),
				};
				this.db
					.prepare(
						'UPDATE cards SET payload_json = ?, revision = revision + 1 WHERE collection_key = ? AND id = ?'
					)
					.run(canonicalJson(next), input.collectionKey, input.cardId);
				this.db
					.prepare('UPDATE runs SET outcome_json = ? WHERE run_id = ?')
					.run(
						canonicalJson(
							cardOutcome
								? { ...outcome, cardOutcome: { ...cardOutcome, run: patch(completedRun) } }
								: patch(outcome)
						),
						rows[0].run_id
					);
				this.db
					.prepare('UPDATE collections SET revision = revision + 1 WHERE collection_key = ?')
					.run(input.collectionKey);
				this.db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
				return this.readCollection(input)!;
			})
			.immediate();
	}

	/**
	 * One IMMEDIATE transaction checks collection/card revisions and patches only
	 * changed rows. Any failure rolls back the entire write, including revisions.
	 * Returned snapshot carries the new revisions; no-op patches keep their revision.
	 * Archival is a tombstone, never a physical delete. Run specifications,
	 * approvals and fences are never rebuilt or relaxed by this API.
	 */
	writeCollection(input: BoardCollectionWrite): BoardCollectionSnapshot {
		return this.writeCollections([input])[0];
	}

	/** Explicit empty collection bootstrap, without forging migration or repository evidence. */
	createCollection(input: BoardCollectionWrite): BoardCollectionSnapshot {
		if (
			this.db.inTransaction ||
			input.expectedRevision !== null ||
			input.delete ||
			input.cards?.length
		)
			throw new BoardWorkspaceStorageError(
				'invalid-input',
				'Bootstrap requires a new empty collection'
			);
		requireKey(input.sourceKey);
		return this.db
			.transaction(() => {
				this.db
					.prepare('INSERT OR IGNORE INTO board_sources (source_key) VALUES (?)')
					.run(input.sourceKey);
				return this.applyCollection(input);
			})
			.immediate();
	}

	writeCollections(
		inputs: readonly BoardCollectionWrite[],
		recordHostState?: (snapshots: BoardCollectionSnapshot[]) => void
	): BoardCollectionSnapshot[] {
		if (this.db.inTransaction) {
			throw new BoardWorkspaceStorageError(
				'invalid-input',
				'Board write requires its own transaction'
			);
		}
		return this.db
			.transaction(() => {
				const snapshots = inputs.map((input) => this.applyCollection(input));
				recordHostState?.(snapshots);
				return snapshots.map((snapshot) => this.readCollection(snapshot)!);
			})
			.immediate();
	}

	private applyCollection(input: BoardCollectionWrite): BoardCollectionSnapshot {
		const key: BoardCollectionKey = {
			sourceKey: input.sourceKey,
			collectionKey: input.collectionKey,
		};
		const stored = this.collectionRow(key);
		checkRevision(key, input.expectedRevision, stored?.revision ?? null);
		const legacyBoardId = stored?.legacy_board_id ?? input.legacyBoardId;
		if (!legacyBoardId) {
			throw new BoardWorkspaceStorageError(
				'invalid-input',
				'New collection requires legacyBoardId'
			);
		}
		requireKey(legacyBoardId);
		if (stored && input.legacyBoardId !== undefined && input.legacyBoardId !== legacyBoardId) {
			throw new BoardWorkspaceStorageError('identity-mismatch', 'Cannot change original Board ID', {
				key,
			});
		}
		if (
			!stored &&
			this.db
				.prepare('SELECT 1 FROM collections WHERE source_key = ? AND legacy_board_id = ?')
				.get(key.sourceKey, legacyBoardId)
		) {
			throw new BoardWorkspaceStorageError('already-exists', 'Source already has this Board ID', {
				key,
			});
		}
		if (
			input.delete &&
			this.db
				.prepare(
					"SELECT 1 FROM cards WHERE collection_key = ? AND json_extract(payload_json, '$.status') = 'running' UNION ALL SELECT 1 FROM reservations WHERE collection_key = ?"
				)
				.get(key.collectionKey, key.collectionKey)
		) {
			throw new BoardWorkspaceStorageError('protected-field', 'Cannot archive an active Board');
		}
		const payload = patchPayload(
			stored ? readPayload(stored.payload_json) : { id: legacyBoardId },
			input,
			BOARD_COLLECTION_EDITABLE_FIELDS
		);
		const seen = new Set<string>();
		const cards = (input.cards ?? []).map((card) => {
			requireKey(card.cardId);
			if (seen.has(card.cardId)) {
				throw new BoardWorkspaceStorageError('invalid-input', 'Duplicate card in Board write', {
					key,
				});
			}
			seen.add(card.cardId);
			const row = this.db
				.prepare('SELECT id, payload_json, revision FROM cards WHERE collection_key = ? AND id = ?')
				.get(key.collectionKey, card.cardId) as CardRow | undefined;
			checkRevision({ ...key, cardId: card.cardId }, card.expectedRevision, row?.revision ?? null);
			const original = row ? readPayload(row.payload_json) : { id: card.cardId };
			if (
				card.delete &&
				(original.status === 'running' ||
					this.db
						.prepare('SELECT 1 FROM reservations WHERE collection_key = ? AND card_id = ?')
						.get(key.collectionKey, card.cardId))
			) {
				throw new BoardWorkspaceStorageError('protected-field', 'Cannot archive an active card');
			}
			const next = patchPayload(original, card, BOARD_CARD_EDITABLE_FIELDS);
			const archive =
				!!card.delete &&
				!this.db
					.prepare('SELECT 1 FROM card_archives WHERE collection_key = ? AND card_id = ?')
					.get(key.collectionKey, card.cardId);
			if (
				row &&
				canonicalJson({ createdAt: original.createdAt }) !==
					canonicalJson({ createdAt: readPayload(next).createdAt })
			) {
				throw new BoardWorkspaceStorageError(
					'protected-field',
					'Cannot change card creation time',
					{ key }
				);
			}
			return {
				cardId: card.cardId,
				row,
				payload: next,
				archive,
				changed: !row || canonicalJson(original) !== next || archive,
			};
		});
		const archive =
			!!input.delete &&
			!this.db
				.prepare('SELECT 1 FROM collection_archives WHERE collection_key = ?')
				.get(key.collectionKey);
		const changed =
			archive ||
			!stored ||
			canonicalJson(readPayload(stored.payload_json)) !== payload ||
			cards.some((card) => card.changed);
		if (changed) {
			if (stored) {
				this.db
					.prepare(
						'UPDATE collections SET payload_json = ?, revision = revision + 1 WHERE collection_key = ?'
					)
					.run(payload, key.collectionKey);
			} else {
				this.db
					.prepare(
						'INSERT INTO collections (collection_key, source_key, legacy_board_id, payload_json) VALUES (?, ?, ?, ?)'
					)
					.run(key.collectionKey, key.sourceKey, legacyBoardId, payload);
			}
			for (const card of cards) {
				if (!card.changed) continue;
				if (card.row) {
					this.db
						.prepare(
							'UPDATE cards SET payload_json = ?, revision = revision + 1 WHERE collection_key = ? AND id = ?'
						)
						.run(card.payload, key.collectionKey, card.cardId);
				} else {
					this.db
						.prepare('INSERT INTO cards (collection_key, id, payload_json) VALUES (?, ?, ?)')
						.run(key.collectionKey, card.cardId, card.payload);
				}
				if (card.archive)
					this.db
						.prepare('INSERT INTO card_archives VALUES (?, ?)')
						.run(key.collectionKey, card.cardId);
			}
			if (archive)
				this.db.prepare('INSERT INTO collection_archives VALUES (?)').run(key.collectionKey);
			this.db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
		}
		return this.readCollection(key)!;
	}
}
