import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
	ContextualMemory,
	MemoryConfig,
	MemoryEvidence,
	MemoryProgress,
	MemoryRecallIntent,
	MemorySource,
} from '../../shared/pianola/memory';
import { isUsableMemoryEvidence } from '../../shared/pianola/memory';
import {
	hasCorrectionEvidence,
	memoryDate,
	mergeMemoryDuplicate,
	sameMemorySlot,
	validateMemoryInterval,
	validateMemoryRecallIntent,
} from './memory-lifecycle';
import { sourceHash } from '../storage/historical-inventory';
import type { HistoricalScope, HistoryExclusions } from '../storage/historical-inventory';
import type { MemoryCandidate } from './memory-candidates';
import { compareMemoryCandidateSimilarity, shortlistMemoryCandidates } from './memory-ranking';
import { memoryQueryContentTerms } from './memory-query-terms';
import { memoryEvidenceDurability } from '../../shared/pianola/memory-attribution';
import { MemoryTransport } from './memory-transport';
export const MEMORY_SPACE =
	'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78:q8:mean:normalized:384:prefix-v1';
/** Bump when the evidence classification rules change, so stored verdicts are re-derived. */
const DERIVED_EVIDENCE_VERSION = 2;
export class MemoryDatabase {
	readonly db: Database.Database;
	readonly transport: MemoryTransport;
	private readonly sourceLookup: Database.Statement;
	constructor(file: string) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		this.db = new Database(file);
		this.db.pragma('journal_mode = WAL');
		this.db.pragma('synchronous = FULL');
		this.db.pragma('foreign_keys = ON');
		this.db.pragma('busy_timeout = 5000');
		this.db.loadExtension(
			sqliteVec.getLoadablePath().replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
		);
		this.db.exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,user_id TEXT,project_id TEXT NOT NULL,revision TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS episodes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,source_id TEXT NOT NULL,version TEXT NOT NULL,committed INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,source_id TEXT NOT NULL,message_id TEXT NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY,uuid TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL,project_id TEXT NOT NULL,project_path TEXT,kind TEXT NOT NULL,text TEXT NOT NULL,canonical TEXT NOT NULL,state TEXT NOT NULL,valid_from TEXT,valid_to TEXT,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS memory_scope ON memories(user_id,project_id,state);
   CREATE TABLE IF NOT EXISTS memory_evidence(memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,PRIMARY KEY(memory_id,evidence_id));
   CREATE TABLE IF NOT EXISTS ingestion_queue(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS processed_events(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,source_id TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS relationships(from_id TEXT NOT NULL,to_id TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(from_id,to_id,kind));
   CREATE TABLE IF NOT EXISTS suppression(user_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(user_id,fingerprint));
   CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,dollars REAL NOT NULL,reserved_tokens INTEGER NOT NULL,reserved_dollars REAL NOT NULL,state TEXT NOT NULL);
   CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text,scope,tokenize='unicode61');
   CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(embedding float[384],scope TEXT partition key,active INTEGER);`);
		this.db.exec(
			'CREATE TABLE IF NOT EXISTS quarantined_extractions(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,data TEXT NOT NULL)'
		);
		if (
			!(this.db.pragma('table_info(ingestion_queue)') as { name: string }[]).some(
				(column) => column.name === 'error'
			)
		)
			this.db.exec('ALTER TABLE ingestion_queue ADD COLUMN error TEXT');
		for (const table of ['sources', 'memories'])
			if (
				!(this.db.pragma('table_info(' + table + ')') as { name: string }[]).some(
					(c) => c.name === 'excluded'
				)
			)
				this.db.exec('ALTER TABLE ' + table + ' ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0');
		// The project path is queried on every policy rebuild. Reading it out of the
		// JSON payload meant a full table scan with a JSON parse per row.
		if (
			!(this.db.pragma('table_info(memories)') as { name: string }[]).some(
				(column) => column.name === 'project_path'
			)
		) {
			this.db.exec('ALTER TABLE memories ADD COLUMN project_path TEXT');
			this.db.exec(
				"UPDATE memories SET project_path=json_extract(data,'$.projectPath') WHERE json_extract(data,'$.projectPath') IS NOT NULL"
			);
		}
		this.db.exec(
			'CREATE INDEX IF NOT EXISTS memory_visibility ON memories(user_id,excluded,project_id,state)'
		);
		// Every stored memory runs a duplicate check against its own scope and
		// kind. Without this index that check scanned every memory in the
		// project, so building a bank cost O(n^2): measured throughput fell from
		// 778 rows/s to 77 rows/s between the first and last quarter of a 24k
		// build. The fingerprint column is what the check compares, so it is
		// indexed here.
		this.db.exec(
			'CREATE INDEX IF NOT EXISTS memory_duplicate ON memories(user_id,project_id,kind,canonical)'
		);
		// Eligibility is a pure function of the stored evidence, so it is derived once and
		// indexed. Calling the JS classifier per row made every candidate scan pay a
		// per-row callback; the derived columns answer the same question in SQL.
		if (
			!(this.db.pragma('table_info(evidence)') as { name: string }[]).some(
				(column) => column.name === 'derived_usable'
			)
		)
			this.db.exec(
				'ALTER TABLE evidence ADD COLUMN derived_usable INTEGER; ALTER TABLE evidence ADD COLUMN derived_session INTEGER; ALTER TABLE evidence ADD COLUMN derived_timebound INTEGER'
			);
		this.db.exec(
			'CREATE INDEX IF NOT EXISTS evidence_derived ON evidence(derived_usable, derived_session, derived_timebound)'
		);
		// A change to the classification rules must re-derive the stored verdicts, or old
		// evidence would keep the verdict it was given under the previous rules.
		if (this.get<number>('derivedEvidenceVersion') !== DERIVED_EVIDENCE_VERSION)
			this.db.transaction(() => {
				this.db.exec(
					'UPDATE evidence SET derived_usable=NULL, derived_session=NULL, derived_timebound=NULL'
				);
				this.set('derivedEvidenceVersion', DERIVED_EVIDENCE_VERSION);
			})();
		this.refreshDerivedEvidence();
		this.db
			.exec(`CREATE TABLE IF NOT EXISTS memory_quarantine(memory_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,reason TEXT NOT NULL,quarantined_at INTEGER NOT NULL,released_at INTEGER);
			CREATE TABLE IF NOT EXISTS extraction_quarantine(id TEXT PRIMARY KEY,reason TEXT NOT NULL,quarantined_at INTEGER NOT NULL);
			DROP VIEW IF EXISTS usable_memories;
			CREATE VIEW usable_memories AS SELECT m.* FROM memories m WHERE m.excluded=0
			AND NOT EXISTS (SELECT 1 FROM memory_quarantine q WHERE q.memory_id=m.uuid AND q.released_at IS NULL)
			AND EXISTS (SELECT 1 FROM memory_evidence me WHERE me.memory_id=m.id)
			AND NOT EXISTS (SELECT 1 FROM memory_evidence me JOIN evidence e ON e.id=me.evidence_id WHERE me.memory_id=m.id AND e.derived_usable=0)`);
		this.refreshVectorVisibility();
		const space = this.get<string>('embeddingSpace');
		if (space && space !== MEMORY_SPACE)
			throw new Error(
				'Embedding space changed; explicit reindex required before memory can be used'
			);
		this.set('embeddingSpace', MEMORY_SPACE);
		if (this.get<number>('lexicalFactsVersion') !== 1) {
			this.db
				.transaction(() => {
					if (this.get<number>('lexicalFactsVersion') === 1) return;
					// Rebuild only derived lexical text; retain assertion/evidence bytes and index row identities.
					this.db.exec(`UPDATE memory_fts SET text=(
					SELECT m.text || ' ' || COALESCE(json_extract(m.data,'$.rationale'),'') || ' ' ||
					COALESCE((SELECT group_concat(value,' ') FROM json_each(m.data,'$.alternatives')),'')
					FROM memories m WHERE m.id=memory_fts.rowid
				) WHERE rowid IN (SELECT id FROM memories)`);
					this.set('lexicalFactsVersion', 1);
				})
				.immediate();
		}
		this.sourceLookup = this.db.prepare(
			"SELECT CASE WHEN excluded=1 THEN json_set(data,'$.error',NULL) ELSE data END data,cursor,CASE WHEN excluded=1 THEN 'excluded' ELSE state END state FROM sources WHERE id=?"
		);

		this.db.exec(`CREATE TABLE IF NOT EXISTS ingestion_work(
			id TEXT PRIMARY KEY REFERENCES ingestion_queue(id), data TEXT NOT NULL,
			owner TEXT, claimed_at INTEGER);
			CREATE UNIQUE INDEX IF NOT EXISTS ingestion_owner ON ingestion_work(owner) WHERE owner IS NOT NULL;`);
		// Legacy state is retained verbatim. Never infer that a sent request is safe to retry.
		this.db
			.transaction(() => {
				// Preserve the serialized checkpoint inside SQLite without hydrating evidence.
				this.db
					.prepare(
						`INSERT OR IGNORE INTO ingestion_work(id,data)
				SELECT q.id,m.value FROM metadata m JOIN ingestion_queue q
				ON q.id=json_extract(m.value,'$.id') WHERE m.key='pendingExtraction'
				AND json_type(m.value)='object'`
					)
					.run();
				// Keep import and uncertainty ownership atomic with competing claims.
				// Accounting and checkpoint bytes remain untouched.
				this.db
					.prepare(
						`INSERT OR IGNORE INTO ingestion_work(id,data)
				SELECT id,data FROM ingestion_queue WHERE
				(json_extract(data,'$.sent')=1 AND json_extract(data,'$.extracted') IS NULL AND json_extract(data,'$.batchId') IS NULL) OR
				(json_extract(data,'$.verificationSent')=1 AND json_extract(data,'$.verified') IS NULL AND json_extract(data,'$.verificationBatchId') IS NULL) OR
				EXISTS(SELECT 1 FROM usage u WHERE u.state IN ('reserved','uncertain') AND
				(u.id=json_extract(data,'$.reservation') OR u.id=json_extract(data,'$.verificationReservation')))`
					)
					.run();
				this.db
					.prepare(
						`UPDATE ingestion_work SET owner='uncertain:' || id,claimed_at=0
				WHERE owner IS NULL AND (
					((json_extract(data,'$.sent')=1 OR EXISTS(SELECT 1 FROM usage u WHERE u.id=json_extract(data,'$.reservation') AND u.state='uncertain'))
					AND json_extract(data,'$.extracted') IS NULL AND json_extract(data,'$.batchId') IS NULL) OR
					((json_extract(data,'$.verificationSent')=1 OR EXISTS(SELECT 1 FROM usage u WHERE u.id=json_extract(data,'$.verificationReservation') AND u.state='uncertain'))
					AND json_extract(data,'$.verified') IS NULL AND json_extract(data,'$.verificationBatchId') IS NULL))`
					)
					.run();
			})
			.immediate();
		this.transport = new MemoryTransport(this.db);
		if (this.hasOrphanedCheckpoint()) {
			this.set('paused', true);
			this.set('lastError', 'Legacy checkpoint has no queue row; offline reconciliation required');
		}
	}
	hasOrphanedCheckpoint(): boolean {
		return !!this.db
			.prepare(
				`SELECT 1 FROM metadata m WHERE m.key='pendingExtraction'
			AND json_type(m.value)='object' AND NOT EXISTS
			(SELECT 1 FROM ingestion_queue q WHERE q.id=json_extract(m.value,'$.id'))`
			)
			.get();
	}
	get<T>(key: string): T | undefined {
		const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as
			| { value: string }
			| undefined;
		return row ? (JSON.parse(row.value) as T) : undefined;
	}
	set(key: string, value: unknown) {
		this.db
			.prepare(
				'INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
			)
			.run(key, JSON.stringify(value));
	}
	config(): MemoryConfig {
		return (
			this.get<MemoryConfig>('config') ?? {
				enabled: false,
				userId: crypto.randomUUID(),
				roots: [],
				exclusions: [],
				mode: 'local',
				hostedProvider: 'openai',
				endpoint: 'http://127.0.0.1:11434',
				model: 'qwen3:8b',
				hostedConsent: false,
				inputPrice: 0.75,
				outputPrice: 4.5,
				tokenBudget: 1000000,
				dollarBudget: 5,
				ongoing: true,
			}
		);
	}
	source(id: string): MemorySource | null {
		const row = this.sourceLookup.get(id) as
			| { data: string; cursor: number; state: MemorySource['state'] }
			| undefined;
		return row ? { ...JSON.parse(row.data), cursor: row.cursor, state: row.state } : null;
	}
	scopes(): Array<HistoricalScope & { memoryId?: number }> {
		// The exclusion policy only consumes the project identity, so the query reads
		// no other JSON field. Parsing the whole payload per row was the cost.
		return [
			...this.db
				.prepare(
					"SELECT project_id projectId,json_extract(data,'$.projectPath') projectPath FROM sources WHERE json_extract(data,'$.projectPath') IS NOT NULL"
				)
				.all(),
			...this.db
				.prepare(
					'SELECT id memoryId,project_id projectId,project_path projectPath FROM memories WHERE project_path IS NOT NULL'
				)
				.all(),
		] as Array<HistoricalScope & { memoryId?: number }>;
	}
	sourceAllowed(id: string): boolean {
		return !!this.db.prepare('SELECT 1 FROM sources WHERE id=? AND excluded=0').get(id);
	}
	private visibleJob(column: 'm.value' | 'q.data'): string {
		// Resolve cached neighbors from authorized rows before JSON hydration.
		return `json_set(${column},'$.nearby',json((SELECT json_group_array(json(n.data))
			FROM json_each(${column},'$.nearby') cached JOIN usable_memories n
			ON n.uuid=json_extract(cached.value,'$.id')
			WHERE n.excluded=0 AND n.user_id=json_extract(${column},'$.source.userId')
			AND n.project_id IN ('',json_extract(${column},'$.source.projectId')))))`;
	}
	workJob<T>(id: string): T | null {
		const row = this.db
			.prepare(
				`SELECT ${this.visibleJob('q.data')} data FROM ingestion_work q
			JOIN ingestion_queue original ON original.id=q.id JOIN sources s ON s.id=original.source_id
			WHERE q.id=? AND s.excluded=0 AND s.user_id=?
			AND NOT EXISTS (SELECT 1 FROM extraction_quarantine x WHERE x.id=q.id)`
			)
			.get(id, this.config().userId) as { data: string } | undefined;
		return row ? (JSON.parse(row.data) as T) : null;
	}

	// Durable claims deliberately have no TTL. A timed-out worker may still be sending.
	// Crash claims require offline reconciliation, never automatic lease stealing.
	claimQueued(owner: string, runtime: string): { id: string; data: string } | undefined {
		const row = this.transport.claim(runtime, owner);
		if (!row) return;
		return this.db
			.prepare(`SELECT id,${this.visibleJob('q.data')} data FROM ingestion_work q WHERE id=?`)
			.get(row.id) as { id: string; data: string };
	}
	enqueue(id: string, sourceId: string, payload: string): void {
		this.db
			.transaction(() => {
				const inserted = this.db
					.prepare('INSERT OR IGNORE INTO ingestion_queue(id,source_id,data) VALUES(?,?,?)')
					.run(id, sourceId, payload);
				if (inserted.changes) this.transport.recordEnqueue(id, payload);
			})
			.immediate();
	}
	workOwned(id: string, owner: string): boolean {
		return !!this.db.prepare('SELECT 1 FROM ingestion_work WHERE id=? AND owner=?').get(id, owner);
	}
	claimedJob<T>(id: string): T | null {
		const row = this.db
			.prepare(
				`SELECT ${this.visibleJob('q.data')} data FROM ingestion_work q
			JOIN ingestion_queue original ON original.id=q.id JOIN sources s ON s.id=original.source_id
			WHERE q.id=? AND q.owner IS NOT NULL AND s.excluded=0 AND s.user_id=?
			AND NOT EXISTS (SELECT 1 FROM extraction_quarantine x WHERE x.id=q.id)
			AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.id=q.id AND e.committed=1)`
			)
			.get(id, this.config().userId) as { data: string } | undefined;
		return row ? (JSON.parse(row.data) as T) : null;
	}
	queueProgress() {
		return this.db
			.prepare(
				`SELECT COUNT(*) total,
			COALESCE(SUM(CASE WHEN e.committed=1 THEN 1 ELSE 0 END),0) committed,
			COALESCE(SUM(CASE WHEN COALESCE(e.committed,0)=0 THEN 1 ELSE 0 END),0) remaining,
			COALESCE(SUM(CASE WHEN w.owner IS NOT NULL THEN 1 ELSE 0 END),0) claimed,
			COALESCE(SUM(CASE WHEN x.id IS NOT NULL AND COALESCE(e.committed,0)=0 THEN 1 ELSE 0 END),0) quarantined,
			COALESCE(SUM(CASE WHEN s.excluded=1 AND COALESCE(e.committed,0)=0 THEN 1 ELSE 0 END),0) excluded,
			COALESCE(SUM(CASE WHEN q.error IS NOT NULL AND COALESCE(e.committed,0)=0 THEN 1 ELSE 0 END),0) failed
			FROM ingestion_queue q JOIN sources s ON s.id=q.source_id
			LEFT JOIN ingestion_work w ON w.id=q.id LEFT JOIN episodes e ON e.id=q.id
			LEFT JOIN extraction_quarantine x ON x.id=q.id WHERE s.user_id=?`
			)
			.get(this.config().userId) as {
			total: number;
			committed: number;
			remaining: number;
			claimed: number;
			quarantined: number;
			excluded: number;
			failed: number;
		};
	}
	saveWork(job: { id: string }, owner: string) {
		if (
			!this.db
				.prepare('UPDATE ingestion_work SET data=? WHERE id=? AND owner=?')
				.run(JSON.stringify(job), job.id, owner).changes
		)
			throw new Error('Episode claim lost');
	}
	releaseWork(id: string, owner: string) {
		this.db
			.prepare('UPDATE ingestion_work SET owner=NULL,claimed_at=NULL WHERE id=? AND owner=?')
			.run(id, owner);
	}
	nextQueued(): { id: string; data: string } | undefined {
		return this.db
			.prepare(
				`SELECT q.id,${this.visibleJob('q.data')} data FROM
			(SELECT original.rowid ordinal,original.id,original.source_id,original.error,
			COALESCE(w.data,original.data) data,w.owner FROM ingestion_queue original
			LEFT JOIN ingestion_work w ON w.id=original.id) q JOIN sources s ON s.id=q.source_id
			WHERE s.excluded=0 AND s.user_id=? AND q.error IS NULL AND q.owner IS NULL
			AND NOT EXISTS (SELECT 1 FROM extraction_quarantine invalid WHERE invalid.id=q.id)
			AND NOT EXISTS (SELECT 1 FROM episodes completed WHERE completed.id=q.id AND completed.committed=1)
			ORDER BY q.ordinal LIMIT 1`
			)
			.get(this.config().userId) as { id: string; data: string } | undefined;
	}
	// Call inside the same immediate transaction as reservation + sent checkpoint.
	reserveNanRate(tokens: number, now = Date.now()): boolean {
		if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > 1_500_000)
			throw new Error('Invalid NaN token reservation');
		const recent = (this.get<{ at: number; tokens: number }[]>('nanRequests') ?? []).filter(
			(r) => r.at > now - 60_000
		);
		if (recent.length >= 60 || recent.reduce((n, r) => n + r.tokens, tokens) > 1_500_000)
			return false;
		recent.push({ at: now, tokens });
		this.set('nanRequests', recent);
		return true;
	}
	applyExclusions(
		policy: HistoryExclusions,
		config: MemoryConfig,
		scopes: Array<HistoricalScope & { memoryId?: number }>
	) {
		const sourceRows = this.db
			.prepare(
				"SELECT id,user_id,project_id,json_extract(data,'$.projectPath') projectPath,json_extract(data,'$.filePath') filePath,json_extract(data,'$.root') root,json_extract(data,'$.provider') provider FROM sources"
			)
			.all() as {
			id: string;
			user_id: string | null;
			project_id: string;
			projectPath: string;
			filePath: string;
			root: string;
			provider: string;
		}[];
		const update = this.db.prepare('UPDATE sources SET excluded=? WHERE id=?');
		this.db.transaction(() => {
			for (const s of sourceRows) {
				const owned = config.roots.some(
					(r) =>
						r.enabled &&
						r.userId === config.userId &&
						r.provider === s.provider &&
						path.resolve(r.path).toLowerCase() === path.resolve(s.root).toLowerCase()
				);
				update.run(
					!owned ||
						s.user_id !== config.userId ||
						policy.excludesPath(s.filePath) ||
						policy.excludesProjectMetadata(s.projectPath, s.project_id)
						? 1
						: 0,
					s.id
				);
			}
			const memoryIds = scopes
				.filter(
					(s) =>
						s.memoryId !== undefined && policy.excludesProjectMetadata(s.projectPath, s.projectId)
				)
				.map((s) => s.memoryId);
			this.db.prepare('UPDATE memories SET excluded=0 WHERE user_id=?').run(config.userId);
			this.db
				.prepare(
					"UPDATE memories SET excluded=1 WHERE user_id=? AND (id IN (SELECT value FROM json_each(?)) OR project_id IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM memory_evidence me JOIN evidence e ON e.id=me.evidence_id LEFT JOIN sources s ON s.id=e.source_id WHERE me.memory_id=memories.id AND (s.excluded=1 OR (?=1 AND e.source_id LIKE 'legacy:%') OR (s.id IS NULL AND e.source_id NOT LIKE 'legacy:%' AND e.source_id NOT LIKE 'explicit:%'))))"
				)
				.run(
					config.userId,
					JSON.stringify(memoryIds),
					JSON.stringify([...policy.projectIds]),
					config.exclusions.length ? 1 : 0
				);
			this.refreshVectorVisibility();
		})();
		this.db.transaction(() => {
			this.db.exec(`INSERT INTO quarantined_extractions
				SELECT w.id,q.source_id,w.data FROM ingestion_work w
				JOIN ingestion_queue q ON q.id=w.id JOIN sources s ON s.id=q.source_id
				WHERE s.excluded=1 ON CONFLICT(id) DO UPDATE SET data=excluded.data;
				INSERT INTO quarantined_extractions
				SELECT json_extract(m.value,'$.id'),s.id,m.value FROM metadata m
				JOIN sources s ON s.id=json_extract(m.value,'$.source.id')
				WHERE m.key='pendingExtraction' AND s.excluded=1 ON CONFLICT(id) DO NOTHING`);
		})();
	}
	/**
	 * Recompute the derived eligibility columns for evidence whose classification is stale.
	 * The stored evidence bytes are never rewritten; only the derived verdict is refreshed.
	 */
	private refreshDerivedEvidence() {
		const rows = this.db
			.prepare(
				'SELECT id,data FROM evidence WHERE derived_usable IS NULL OR derived_session IS NULL OR derived_timebound IS NULL'
			)
			.all() as { id: string; data: string }[];
		if (!rows.length) return;
		const update = this.db.prepare(
			'UPDATE evidence SET derived_usable=?, derived_session=?, derived_timebound=? WHERE id=?'
		);
		this.db.transaction(() => {
			for (const row of rows) {
				const evidence = JSON.parse(row.data) as MemoryEvidence & { durability?: string };
				const usable = isUsableMemoryEvidence(evidence) ? 1 : 0;
				const durability = evidence.durability ?? memoryEvidenceDurability(evidence.text);
				update.run(
					usable,
					durability === 'session' ? 1 : 0,
					durability === 'time-bound' ? 1 : 0,
					row.id
				);
			}
		})();
	}
	private refreshVectorVisibility() {
		// Quarantine retains the embedding; -1 keeps it out of current AND historical KNN.
		const visibility =
			"CASE WHEN m.excluded=1 THEN 2 WHEN NOT EXISTS (SELECT 1 FROM usable_memories safe WHERE safe.id=m.id) THEN -1 WHEN m.state='superseded' THEN 0 ELSE 1 END";
		const rows = this.db
			.prepare(
				'SELECT m.id,' +
					visibility +
					' active FROM memories m JOIN memory_vectors v ON v.rowid=m.id WHERE v.active<>' +
					visibility
			)
			.all() as { id: number; active: number }[];
		const update = this.db.prepare('UPDATE memory_vectors SET active=? WHERE rowid=?');
		for (const row of rows) update.run(BigInt(row.active), BigInt(row.id));
	}
	quarantine(uuid: string, userId: string, reason: string): boolean {
		return this.db.transaction(() => {
			if (!this.db.prepare('SELECT 1 FROM memories WHERE uuid=? AND user_id=?').get(uuid, userId))
				return false;
			this.db
				.prepare(
					'INSERT INTO memory_quarantine VALUES(?,?,?,?,NULL) ON CONFLICT(memory_id) DO UPDATE SET reason=excluded.reason,quarantined_at=excluded.quarantined_at,released_at=NULL'
				)
				.run(uuid, userId, reason, Date.now());
			this.refreshVectorVisibility();
			return true;
		})();
	}
	releaseQuarantine(uuid: string, userId: string): boolean {
		return this.db.transaction(() => {
			const changed = this.db
				.prepare(
					'UPDATE memory_quarantine SET released_at=? WHERE memory_id=? AND user_id=? AND released_at IS NULL'
				)
				.run(Date.now(), uuid, userId).changes;
			this.refreshVectorVisibility();
			return changed > 0;
		})();
	}
	quarantineExtraction(id: string, reason: string) {
		this.db.transaction(() => {
			this.db
				.prepare('INSERT INTO extraction_quarantine VALUES(?,?,?) ON CONFLICT(id) DO NOTHING')
				.run(id, reason, Date.now());
			this.set('paused', true);
			this.set('pauseReason', 'provenance-quarantine');
		})();
	}
	sourceList(userId?: string): MemorySource[] {
		const rows = (
			userId
				? this.db
						.prepare(
							"SELECT CASE WHEN excluded=1 THEN json_set(data,'$.error',NULL) ELSE data END data,cursor,CASE WHEN excluded=1 THEN 'excluded' ELSE state END state FROM sources WHERE user_id=?"
						)
						.all(userId)
				: this.db
						.prepare(
							"SELECT CASE WHEN excluded=1 THEN json_set(data,'$.error',NULL) ELSE data END data,cursor,CASE WHEN excluded=1 THEN 'excluded' ELSE state END state FROM sources"
						)
						.all()
		) as { data: string; cursor: number; state: MemorySource['state'] }[];
		return rows.map((r) => ({
			...(JSON.parse(r.data) as MemorySource),
			cursor: r.cursor,
			state: r.state,
		}));
	}
	upsertSource(source: MemorySource) {
		const old = this.db
			.prepare('SELECT revision,cursor,state FROM sources WHERE id=?')
			.get(source.id) as { revision: string; cursor: number; state: string } | undefined;
		const data = this.db.prepare('SELECT data FROM sources WHERE id=?').get(source.id) as
			| { data: string }
			| undefined;
		const previous = data ? (JSON.parse(data.data) as MemorySource) : null;
		if (
			old?.revision === source.revision &&
			previous?.userId === source.userId &&
			previous?.authorship === source.authorship &&
			previous?.projectId === source.projectId &&
			previous?.projectPath === source.projectPath &&
			old?.state !== 'excluded'
		)
			return;
		// Reconcile rewrites from the beginning; episode/evidence hashes prevent paid re-extraction of unchanged windows.
		this.db
			.prepare(
				'INSERT INTO sources(id,user_id,project_id,revision,cursor,state,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,project_id=excluded.project_id,revision=excluded.revision,cursor=0,state=excluded.state,data=excluded.data'
			)
			.run(
				source.id,
				source.userId,
				source.projectId,
				source.revision,
				0,
				source.state,
				JSON.stringify(source)
			);
	}
	sourceState(id: string, cursor: number, state: MemorySource['state'], error?: string) {
		const row = this.db.prepare('SELECT data FROM sources WHERE id=?').get(id) as { data: string };
		this.db
			.prepare('UPDATE sources SET cursor=?,state=?,data=? WHERE id=?')
			.run(cursor, state, JSON.stringify({ ...JSON.parse(row.data), error }), id);
	}
	hasEpisode(id: string): boolean {
		return !!this.db.prepare('SELECT 1 FROM episodes WHERE id=? AND committed=1').get(id);
	}
	hasEvent(id: string): boolean {
		return !!this.db.prepare('SELECT 1 FROM processed_events WHERE id=?').get(id);
	}
	suppressedEvidence(userId: string, e: MemoryEvidence): boolean {
		return !!this.db
			.prepare('SELECT 1 FROM suppression WHERE user_id=? AND fingerprint=?')
			.get(userId, sourceHash(e.text));
	}
	reserve(id: string, input: number, output: number, config: MemoryConfig) {
		if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0)
			throw new Error('Invalid token reservation');
		this.db
			.transaction(() => {
				const totals = this.totals();
				const cost =
					config.mode === 'local'
						? 0
						: ((input * config.inputPrice + output * config.outputPrice) / 1000000) *
							(config.mode === 'batch' ? 0.5 : 1);
				if (
					totals.inputTokens + totals.outputTokens + totals.reservedTokens + input + output >
						config.tokenBudget ||
					totals.dollars + totals.reservedDollars + cost > config.dollarBudget
				)
					throw new Error('Memory budget reached; increase the cap explicitly to continue');
				this.db
					.prepare('INSERT INTO usage VALUES(?,?,?,?,?,?,?)')
					.run(id, 0, 0, 0, input + output, cost, 'reserved');
			})
			.immediate();
	}
	settle(id: string, input: number, output: number, config: MemoryConfig) {
		if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0)
			throw new Error('Provider returned invalid token usage; reservation retained');
		const dollars =
			config.mode === 'local'
				? 0
				: ((input * config.inputPrice + output * config.outputPrice) / 1000000) *
					(config.mode === 'batch' ? 0.5 : 1);
		this.db
			.prepare(
				"UPDATE usage SET input_tokens=?,output_tokens=?,dollars=?,reserved_tokens=0,reserved_dollars=0,state='settled' WHERE id=? AND state IN ('reserved','uncertain')"
			)
			.run(input, output, dollars, id);
	}
	totals() {
		const row = this.db
			.prepare(
				'SELECT COALESCE(SUM(input_tokens),0) i,COALESCE(SUM(output_tokens),0) o,COALESCE(SUM(dollars),0) d,COALESCE(SUM(reserved_tokens),0) r,COALESCE(SUM(reserved_dollars),0) rd FROM usage'
			)
			.get() as { i: number; o: number; d: number; r: number; rd: number };
		return {
			inputTokens: row.i,
			outputTokens: row.o,
			dollars: row.d,
			reservedTokens: row.r,
			reservedDollars: row.rd,
		};
	}
	progress(running: boolean, phase: string, error: string | null): MemoryProgress {
		const config = this.config();
		const sources = this.sourceList(config.userId);
		const count = this.db
			.prepare('SELECT COUNT(*) n FROM usable_memories WHERE user_id=?')
			.get(config.userId) as { n: number };
		return {
			running,
			paused: this.get<boolean>('paused') ?? true,
			phase,
			sources: sources.length,
			completed: sources.filter((s) => s.state === 'complete').length,
			failed: sources.filter((s) => s.state === 'failed').length,
			excluded: sources.filter((s) => s.state === 'excluded').length,
			pending: sources.filter((s) => s.state === 'pending').length,
			memories: count.n,
			...this.totals(),
			error: error ?? this.get<string>('lastError') ?? null,
			embeddingSpace: MEMORY_SPACE,
		};
	}
	store(memory: ContextualMemory, vector: Float32Array): string | null {
		return this.db.transaction(() => this.storeRecord(memory, vector))();
	}
	/**
	 * Store several memories in one transaction.
	 *
	 * A transaction per row costs far more than the row itself: measured on a
	 * 20k build, a per-row transaction took 1238 ms per 2000 rows against 148 ms
	 * for the same rows in one transaction, an eight-fold difference that the
	 * per-row cost never amortizes. The batch is still atomic: either every
	 * memory in it is stored or none is, so a caller cannot observe a half
	 * written batch.
	 */
	storeMany(
		entries: readonly { memory: ContextualMemory; vector: Float32Array }[]
	): (string | null)[] {
		if (!entries.length) return [];
		return this.db.transaction(() =>
			entries.map((entry) => this.storeRecord(entry.memory, entry.vector))
		)();
	}
	private storeRecord(memory: ContextualMemory, vector: Float32Array): string | null {
		memory = {
			...memory,
			validFrom: memoryDate(memory.validFrom),
			validTo: memoryDate(memory.validTo),
		};
		validateMemoryInterval(memory.validFrom, memory.validTo);
		const incoming = memory;
		const fingerprint = sourceHash(memory.text.trim().toLowerCase());
		if (
			this.db
				.prepare('SELECT 1 FROM suppression WHERE user_id=? AND fingerprint=?')
				.get(memory.userId, fingerprint)
		)
			return null;
		if (
			memory.evidence.some((e) =>
				this.db
					.prepare('SELECT 1 FROM suppression WHERE user_id=? AND fingerprint=?')
					.get(memory.userId, sourceHash(e.text))
			)
		)
			return null;
		const project = memory.projectId ?? '';
		const evidenceUsability = new Map<MemoryEvidence, boolean>();
		const evidenceUsable = (evidence: MemoryEvidence) => {
			const cached = evidenceUsability.get(evidence);
			if (cached !== undefined) return cached;
			const usable = isUsableMemoryEvidence(evidence);
			evidenceUsability.set(evidence, usable);
			return usable;
		};
		const usable = memory.evidence.length > 0 && memory.evidence.every(evidenceUsable);
		const candidates = usable
			? (this.db
					.prepare(
						"SELECT id,uuid,data FROM usable_memories WHERE user_id=? AND project_id=? AND kind=? AND state<>'superseded' AND (uuid=? OR canonical=?) ORDER BY CASE WHEN uuid=? THEN 0 ELSE 1 END,id DESC"
					)
					.all(
						memory.userId,
						project,
						memory.kind,
						memory.duplicateOf ?? '',
						fingerprint,
						memory.duplicateOf ?? ''
					) as { id: number; uuid: string; data: string }[])
			: [];
		const existing = candidates.find((row) =>
			sameMemorySlot(JSON.parse(row.data) as ContextualMemory, memory)
		);
		let id: number;
		if (existing) {
			id = existing.id;
			memory = mergeMemoryDuplicate(this.hydrateMany([existing])[0], memory);
			this.db
				.prepare(
					'UPDATE memories SET state=?,valid_from=?,valid_to=?,project_path=COALESCE(?,project_path),data=? WHERE id=?'
				)
				.run(
					memory.status,
					memory.validFrom,
					memory.validTo,
					memory.projectPath ?? null,
					JSON.stringify({ ...memory, evidence: [] }),
					id
				);
			this.db
				.prepare('UPDATE memory_fts SET text=? WHERE rowid=?')
				.run(memory.text + ' ' + memory.rationale + ' ' + memory.alternatives.join(' '), id);
		} else {
			const info = this.db
				.prepare(
					'INSERT INTO memories(uuid,user_id,project_id,project_path,kind,text,canonical,state,valid_from,valid_to,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
				)
				.run(
					memory.id,
					memory.userId,
					project,
					memory.projectPath ?? null,
					memory.kind,
					memory.text,
					fingerprint,
					memory.status,
					memory.validFrom,
					memory.validTo,
					JSON.stringify({ ...memory, evidence: [] })
				);
			id = Number(info.lastInsertRowid);
			this.db
				.prepare('INSERT INTO memory_fts(rowid,text,scope) VALUES(?,?,?)')
				.run(
					id,
					memory.text + ' ' + memory.rationale + ' ' + memory.alternatives.join(' '),
					sourceHash(memory.userId + ':' + project)
				);
			this.db
				.prepare('INSERT INTO memory_vectors(rowid,embedding,scope,active) VALUES(?,?,?,?)')
				.run(
					BigInt(id),
					Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
					sourceHash(memory.userId + ':' + project),
					memory.status === 'superseded' ? 0n : 1n
				);
		}
		for (const e of memory.evidence) {
			const old = this.db
				.prepare('SELECT user_id,source_id,message_id,data FROM evidence WHERE id=?')
				.get(e.id) as
				| { user_id: string; source_id: string; message_id: string; data: string }
				| undefined;
			if (
				old &&
				(old.user_id !== memory.userId ||
					old.source_id !== e.sourceId ||
					old.message_id !== e.messageId ||
					(JSON.parse(old.data) as MemoryEvidence).text !== e.text)
			)
				throw new Error('Memory evidence identity collision');
			const durability = e.durability ?? memoryEvidenceDurability(e.text);
			this.db
				.prepare(
					'INSERT INTO evidence(id,user_id,source_id,message_id,data,derived_usable,derived_session,derived_timebound) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, derived_usable=excluded.derived_usable, derived_session=excluded.derived_session, derived_timebound=excluded.derived_timebound'
				)
				.run(
					e.id,
					memory.userId,
					e.sourceId,
					e.messageId,
					JSON.stringify(e),
					evidenceUsable(e) ? 1 : 0,
					durability === 'session' ? 1 : 0,
					durability === 'time-bound' ? 1 : 0
				);
			this.db.prepare('INSERT OR IGNORE INTO memory_evidence VALUES(?,?)').run(id, e.id);
		}
		if (!memory.evidence.length || !memory.evidence.every(evidenceUsable)) {
			this.quarantine(
				existing?.uuid ?? memory.id,
				memory.userId,
				'Evidence contains host context or lacks complete-turn provenance'
			);
			return existing?.uuid ?? memory.id;
		}
		if (incoming.supersedes && memory.supersedes === incoming.supersedes) {
			const previous = this.find(memory.supersedes);
			if (
				previous &&
				previous.id !== memory.id &&
				previous.userId === memory.userId &&
				previous.projectId === memory.projectId &&
				previous.kind === memory.kind
			) {
				const alreadyLinked = this.db
					.prepare("SELECT 1 FROM relationships WHERE from_id=? AND to_id=? AND kind='supersedes'")
					.get(memory.id, previous.id);
				const canCorrect =
					sameMemorySlot(previous, memory) &&
					hasCorrectionEvidence(incoming) &&
					(!previous.pinned || incoming.pinned) &&
					memory.validFrom !== null &&
					(previous.validFrom === null || memory.validFrom > previous.validFrom);
				if (!alreadyLinked && canCorrect) {
					this.link(memory.id, previous.id, 'supersedes');
					this.retire(previous.id, memory.validFrom);
				} else if (!alreadyLinked) {
					this.link(memory.id, previous.id, 'contradiction');
					memory.supersedes = null;
					if (memory.status === 'current') memory.status = 'contested';
					this.db
						.prepare('UPDATE memories SET state=?,data=? WHERE uuid=?')
						.run(memory.status, JSON.stringify({ ...memory, evidence: [] }), memory.id);
				}
			}
		}
		for (const related of incoming.related) {
			if (related === memory.supersedes) continue;
			const other = this.find(related);
			if (
				other &&
				other.id !== memory.id &&
				other.userId === memory.userId &&
				other.projectId === memory.projectId
			) {
				this.link(memory.id, related, 'contradiction');
				if (
					other.status !== 'superseded' &&
					other.status !== 'proposed' &&
					!other.pinned &&
					memory.status !== 'proposed' &&
					hasCorrectionEvidence(incoming) &&
					memory.validFrom !== null &&
					(other.validFrom === null || memory.validFrom >= other.validFrom) &&
					this.find(memory.id)?.status !== 'superseded'
				) {
					other.status = 'contested';
					this.db
						.prepare('UPDATE memories SET state=?,data=? WHERE uuid=?')
						.run('contested', JSON.stringify({ ...other, evidence: [] }), other.id);
				}
			}
		}
		return existing?.uuid ?? memory.id;
	}
	link(from: string, to: string, kind: string) {
		if (from === to) return;
		const a = this.find(from),
			b = this.find(to);
		if (!a || !b || a.userId !== b.userId || a.projectId !== b.projectId) return;
		if (kind !== 'supersedes' && kind !== 'contradiction')
			throw new Error('Invalid memory relationship');
		this.db.prepare('INSERT OR IGNORE INTO relationships VALUES(?,?,?)').run(from, to, kind);
	}
	retire(uuid: string, until: string | null) {
		const old = this.find(uuid);
		if (!old) return;
		until = memoryDate(until);
		validateMemoryInterval(old.validFrom, until);
		// A future correction closes the interval without prematurely hiding today's fact.
		// Preserve unresolved modality: as-of recall must not turn a retired proposal/conflict into approval.
		if (old.status === 'current' && (until === null || Date.parse(until) <= Date.now()))
			old.status = 'superseded';
		old.validTo = old.validTo && until ? (old.validTo < until ? old.validTo : until) : until;
		this.db
			.prepare('UPDATE memories SET state=?,valid_to=?,data=? WHERE uuid=?')
			.run(old.status, old.validTo, JSON.stringify({ ...old, evidence: [] }), uuid);
		this.db
			.prepare(
				'UPDATE memory_vectors SET active=? WHERE rowid=(SELECT id FROM memories WHERE uuid=?)'
			)
			.run(old.status === 'superseded' ? 0n : 1n, uuid);
	}
	private hydrateMany(rows: { data: string; id: number }[]): ContextualMemory[] {
		if (!rows.length) return [];
		const memories = rows.map((row) => JSON.parse(row.data) as ContextualMemory);
		const byRow = new Map(rows.map((row, index) => [row.id, memories[index]]));
		const byUuid = new Map(memories.map((memory) => [memory.id, memory]));
		for (const memory of memories) {
			memory.evidence = [];
			memory.related = [];
		}
		const ids = JSON.stringify(rows.map((row) => row.id));
		const evidence = this.db
			.prepare(
				'SELECT me.memory_id,e.data FROM json_each(?) selected JOIN memory_evidence me ON me.memory_id=selected.value JOIN evidence e ON e.id=me.evidence_id ORDER BY me.memory_id,e.id'
			)
			.all(ids) as { memory_id: number; data: string }[];
		for (const row of evidence)
			byRow.get(row.memory_id)!.evidence.push(JSON.parse(row.data) as MemoryEvidence);
		const uuids = JSON.stringify(memories.map((memory) => memory.id));
		const relationships = this.db
			.prepare(
				`SELECT r.from_id owner,r.to_id related FROM json_each(?) selected CROSS JOIN relationships r ON r.from_id=selected.value
			CROSS JOIN usable_memories m ON m.uuid=r.to_id CROSS JOIN usable_memories owner ON owner.uuid=r.from_id
			WHERE r.kind='contradiction' AND m.user_id=owner.user_id AND m.project_id=owner.project_id
			AND NOT EXISTS (SELECT 1 FROM relationships resolved WHERE resolved.from_id=r.from_id AND resolved.to_id=r.to_id AND resolved.kind='supersedes')
			AND NOT EXISTS (SELECT 1 FROM relationships resolved WHERE resolved.from_id=r.to_id AND resolved.to_id=r.from_id AND resolved.kind='supersedes')
			UNION SELECT r.to_id owner,r.from_id related FROM relationships r
			CROSS JOIN usable_memories m ON m.uuid=r.from_id CROSS JOIN usable_memories owner ON owner.uuid=r.to_id
			WHERE r.to_id IN (SELECT value FROM json_each(?)) AND r.kind='contradiction'
			AND m.user_id=owner.user_id AND m.project_id=owner.project_id
			AND NOT EXISTS (SELECT 1 FROM relationships resolved WHERE resolved.from_id=r.from_id AND resolved.to_id=r.to_id AND resolved.kind='supersedes')
			AND NOT EXISTS (SELECT 1 FROM relationships resolved WHERE resolved.from_id=r.to_id AND resolved.to_id=r.from_id AND resolved.kind='supersedes')`
			)
			.all(uuids, uuids) as { owner: string; related: string }[];
		for (const row of relationships) byUuid.get(row.owner)!.related.push(row.related);
		return memories;
	}
	find(uuid: string): ContextualMemory | null {
		return this.findMany([uuid])[0] ?? null;
	}
	/** Unique requested order; unauthorized/excluded/quarantined IDs cannot occupy slots. */
	findMany(uuids: readonly string[]): ContextualMemory[] {
		const unique = [...new Set(uuids)];
		if (!unique.length) return [];
		const rows = this.db
			.prepare(
				'SELECT m.id,m.data FROM json_each(?) selected JOIN usable_memories m ON m.uuid=selected.value ORDER BY CAST(selected.key AS INTEGER)'
			)
			.all(JSON.stringify(unique)) as { id: number; data: string }[];
		return this.hydrateMany(rows);
	}
	private temporalQuery(intent: MemoryRecallIntent): { sql: string; params: unknown[] } {
		intent = validateMemoryRecallIntent(intent);
		const instant = intent.mode === 'as-of' ? intent.at : new Date(Date.now()).toISOString();
		const interval =
			'(m.valid_from IS NULL OR julianday(m.valid_from) IS NOT NULL) AND (m.valid_to IS NULL OR julianday(m.valid_to) IS NOT NULL) AND (m.valid_from IS NULL OR m.valid_to IS NULL OR julianday(m.valid_from)<julianday(m.valid_to))';
		const begun = '(m.valid_from IS NULL OR julianday(m.valid_from)<=julianday(?))';
		if (intent.mode === 'history') return { sql: interval + ' AND ' + begun, params: [instant] };
		// Session evidence never becomes a current fact. Time-bound evidence needs a
		// supported finite end on the memory itself; durable evidence needs neither.
		const durability =
			' AND NOT EXISTS (SELECT 1 FROM memory_evidence me JOIN evidence e ON e.id=me.evidence_id WHERE me.memory_id=m.id' +
			' AND (e.derived_session=1 OR (e.derived_timebound=1 AND (m.valid_to IS NULL OR julianday(m.valid_to) IS NULL))))';
		if (intent.mode === 'previous')
			return {
				sql:
					interval +
					' AND ' +
					begun +
					" AND (m.state='superseded' OR (m.state='current' AND m.valid_to IS NOT NULL AND julianday(m.valid_to)<=julianday(?)))" +
					durability,
				params: [instant, instant],
			};
		const state =
			intent.mode === 'as-of'
				? "(m.state='current' OR (m.state='superseded' AND m.valid_to IS NOT NULL))"
				: 'm.state=?';
		return {
			sql:
				interval +
				' AND ' +
				begun +
				' AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday(?)) AND ' +
				state +
				durability,
			params: [instant, instant, ...(intent.mode === 'as-of' ? [] : [intent.mode])],
		};
	}
	list(user: string, project?: string, history = false, limit = 500): ContextualMemory[] {
		// Listing deliberately browses all history; recall's lifecycle/time intent is separate.
		const temporal = history ? { sql: '1=1', params: [] } : this.temporalQuery({ mode: 'current' });
		const rows = this.db
			.prepare(
				`SELECT m.id,m.data FROM usable_memories m WHERE m.user_id=? AND (? IS NULL OR m.project_id IN (?,'')) AND ${temporal.sql} ORDER BY m.id DESC LIMIT ?`
			)
			.all(user, project ?? null, project ?? '', ...temporal.params, limit) as {
			id: number;
			data: string;
		}[];
		return this.hydrateMany(rows);
	}
	retrieveCandidates(
		user: string,
		project: string | null,
		query: string,
		vector: Float32Array,
		intent: MemoryRecallIntent = { mode: 'current' },
		candidateLimit = 80
	): MemoryCandidate[] {
		const bound = Math.max(1, Math.min(160, Math.trunc(candidateLimit)));
		if (!Number.isFinite(bound)) throw new Error('Invalid memory candidate limit');
		if (vector.length !== 384 || vector.some((value) => !Number.isFinite(value)))
			throw new Error('Invalid memory query vector');
		intent = validateMemoryRecallIntent(intent);
		const temporal = this.temporalQuery(intent);
		const scopes = project ? [project, ''] : [''];
		const groups: { channels: MemoryCandidate[][]; offsets: number[]; turn: number }[] = [];
		const terms = memoryQueryContentTerms(query)
			.map((term) => '"' + term + '"')
			.join(' OR ');
		const bytes = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
		for (const scope of scopes) {
			const scopeKey = sourceHash(user + ':' + scope);
			const params: unknown[] = [user, scope, ...temporal.params];
			const lexical = terms
				? 'SELECT f.rowid id,f.rank score FROM memory_fts f CROSS JOIN eligible e ON e.id=f.rowid WHERE memory_fts MATCH ? ORDER BY f.rank,f.rowid LIMIT ?'
				: 'SELECT NULL id,NULL score WHERE 0';
			if (terms) params.push('scope:' + scopeKey + ' AND text:(' + terms + ')', bound);
			const activeStates = ['previous', 'history', 'as-of'].includes(intent.mode) ? [0, 1] : [1];
			const vectors = activeStates.map((active, index) => {
				params.push(bytes, scopeKey, BigInt(active), bound);
				return (
					'vector_' +
					index +
					' AS MATERIALIZED (SELECT rowid id,distance FROM memory_vectors WHERE embedding MATCH ? AND scope=? AND active=? AND rowid IN (SELECT id FROM eligible) AND k=? ORDER BY distance)'
				);
			});
			// Native channel limits see only eligible IDs; neither pins nor channel scores widen scope.
			const rows = this.db
				.prepare(
					'WITH eligible AS MATERIALIZED (SELECT m.id FROM usable_memories m WHERE m.user_id=? AND m.project_id=? AND ' +
						temporal.sql +
						'), ' +
						'lexical_raw AS MATERIALIZED (' +
						lexical +
						'), lexical AS (SELECT id,score,ROW_NUMBER() OVER (ORDER BY score,id)-1 lexicalRank FROM lexical_raw), ' +
						vectors.join(',') +
						', ' +
						'vector_raw AS (SELECT id,MIN(distance) distance FROM (' +
						activeStates.map((_, index) => 'SELECT * FROM vector_' + index).join(' UNION ALL ') +
						') GROUP BY id), ' +
						'vectors AS (SELECT id,distance,ROW_NUMBER() OVER (ORDER BY distance,id)-1 vectorRank FROM vector_raw ORDER BY distance,id LIMIT ' +
						bound +
						'), ' +
						'selected AS (SELECT id FROM lexical UNION SELECT id FROM vectors) ' +
						"SELECT m.uuid id,m.user_id userId,NULLIF(m.project_id,'') projectId,m.kind,m.text,m.state status,m.valid_from validFrom,m.valid_to validTo,json_extract(m.data,'$.support') support,json_extract(m.data,'$.pinned') pinned,json_extract(m.data,'$.learnedAt') learnedAt,json_extract(m.data,'$.supersedes') supersedes,COALESCE(json_extract(m.data,'$.rationale'),'') rationale,COALESCE(json_extract(m.data,'$.alternatives'),'[]') alternatives," +
						'l.lexicalRank,l.score lexicalScore,v.vectorRank,v.distance vectorDistance FROM selected CROSS JOIN memories m ON m.id=selected.id LEFT JOIN lexical l ON l.id=m.id LEFT JOIN vectors v ON v.id=m.id'
				)
				.all(...params) as (Omit<MemoryCandidate['memory'], 'alternatives'> & {
				alternatives: string;
				lexicalRank: number | null;
				lexicalScore: number | null;
				vectorRank: number | null;
				vectorDistance: number | null;
			})[];
			const candidates: MemoryCandidate[] = rows.map(
				({ lexicalRank, lexicalScore, vectorRank, vectorDistance, alternatives, ...memory }) => ({
					memory: {
						...memory,
						alternatives: JSON.parse(alternatives) as string[],
						pinned: !!memory.pinned,
					},
					...(lexicalRank === null ? {} : { lexicalRank }),
					...(lexicalScore === null ? {} : { lexicalScore }),
					...(vectorRank === null || vectorDistance === null
						? {}
						: {
								vectorRank,
								vectorDistance,
								cosineDistance: (vectorDistance * vectorDistance) / 2,
							}),
				})
			);
			candidates.sort(
				(a, b) => compareMemoryCandidateSimilarity(a, b) || a.memory.id.localeCompare(b.memory.id)
			);
			groups.push({
				channels: [
					candidates.filter((c) => c.lexicalRank !== undefined),
					candidates.filter((c) => c.vectorRank !== undefined),
				],
				offsets: [0, 0],
				turn: 0,
			});
		}
		// Round-robin scopes AND channels. Empty/duplicate queues relinquish slots, not capacity.
		const result: MemoryCandidate[] = [];
		const seen = new Set<string>();
		while (result.length < bound) {
			let added = false;
			for (const group of groups) {
				for (let attempt = 0; attempt < 2; attempt++) {
					const channel = (group.turn + attempt) % 2;
					const queue = group.channels[channel];
					while (
						group.offsets[channel] < queue.length &&
						seen.has(queue[group.offsets[channel]].memory.id)
					)
						group.offsets[channel]++;
					const candidate = queue[group.offsets[channel]++];
					if (!candidate) continue;
					seen.add(candidate.memory.id);
					result.push(candidate);
					group.turn = 1 - channel;
					added = true;
					break;
				}
				if (result.length === bound) break;
			}
			if (!added) break;
		}
		return result;
	}
	/** Consolidation neighbors only; public recall applies the separate semantic answerability head. */
	retrieve(
		user: string,
		project: string | null,
		query: string,
		vector: Float32Array,
		intent: MemoryRecallIntent = { mode: 'current' },
		limit = 12
	): ContextualMemory[] {
		const candidates = this.retrieveCandidates(user, project, query, vector, intent);
		const ranked = shortlistMemoryCandidates(candidates, query, Math.min(40, limit));
		return this.findMany(ranked.map((candidate) => candidate.memory.id));
	}
	forget(uuid: string, userId: string) {
		this.db.transaction(() => {
			const memory = this.find(uuid);
			if (!memory || memory.userId !== userId) throw new Error('Memory not found');
			const fingerprints = [
				sourceHash(memory.text.trim().toLowerCase()),
				...memory.evidence.map((e) => sourceHash(e.text)),
			];
			for (const fingerprint of fingerprints)
				this.db.prepare('INSERT OR IGNORE INTO suppression VALUES(?,?)').run(userId, fingerprint);
			// Remove assertions sharing the forgotten evidence; retained paraphrases must not expose it.
			const ids = new Map<string, number>();
			for (const e of memory.evidence) {
				const rows = this.db
					.prepare(
						"SELECT m.uuid,m.id FROM memories m JOIN memory_evidence me ON me.memory_id=m.id JOIN evidence e ON e.id=me.evidence_id WHERE m.user_id=? AND json_extract(e.data,'$.sourceId')=? AND json_extract(e.data,'$.messageId')=? AND json_extract(e.data,'$.text')=?"
					)
					.all(userId, e.sourceId, e.messageId, e.text) as {
					uuid: string;
					id: number;
				}[];
				for (const row of rows) ids.set(row.uuid, row.id);
			}
			ids.set(
				uuid,
				(
					this.db.prepare('SELECT id FROM memories WHERE uuid=?').get(uuid) as {
						id: number;
					}
				).id
			);
			for (const [removed, id] of ids) {
				this.db.prepare('DELETE FROM memory_fts WHERE rowid=?').run(id);
				this.db.prepare('DELETE FROM memory_vectors WHERE rowid=?').run(BigInt(id));
				this.db.prepare('DELETE FROM memories WHERE id=?').run(id);
				this.db
					.prepare('DELETE FROM relationships WHERE from_id=? OR to_id=?')
					.run(removed, removed);
			}
			const texts = memory.evidence.map((e) => e.text);
			// Retain queued payloads and checkpoints. Suppression blocks use, including
			// in-flight responses; deleting the queue would orphan durable claims.
			this.db
				.prepare(
					`INSERT INTO extraction_quarantine(id,reason,quarantined_at)
				SELECT q.id,'Evidence or comparison memory was forgotten',? FROM ingestion_queue q
				LEFT JOIN ingestion_work w ON w.id=q.id JOIN sources s ON s.id=q.source_id
				WHERE s.excluded=0 AND s.user_id=? AND
				(EXISTS (SELECT 1 FROM json_each(q.data,'$.evidence') e WHERE json_extract(e.value,'$.text') IN (SELECT value FROM json_each(?)))
				OR EXISTS (SELECT 1 FROM json_each(COALESCE(w.data,q.data),'$.nearby') n WHERE json_extract(n.value,'$.id') IN (SELECT value FROM json_each(?))))
				ON CONFLICT(id) DO NOTHING`
				)
				.run(Date.now(), userId, JSON.stringify(texts), JSON.stringify([...ids.keys()]));
			this.db
				.prepare('DELETE FROM evidence WHERE id NOT IN (SELECT evidence_id FROM memory_evidence)')
				.run();
		})();
	}
	close() {
		this.db.pragma('wal_checkpoint(TRUNCATE)');
		this.db.close();
	}
}
