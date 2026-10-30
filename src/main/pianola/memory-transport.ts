import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { threadId } from 'node:worker_threads';
import type {
	MemoryTransportActivation,
	MemoryTransportEligibility,
	MemoryTransportEvidence,
} from '../../shared/pianola/memory';

const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const ACTIVE = "state IN ('reserved','sending','body','unknown')";
interface Gate {
	bank_id: string;
	epoch: string | null;
	fence: string;
	state: string;
	tracked_origin: number;
	config_sha: string | null;
	policy: string | null;
}
interface Permit {
	id: string;
	runtime: string;
	job_id: string;
	claim: string;
	stage: string;
	reservation: string;
	state: string;
}
export class MemoryTransportError extends Error {
	constructor(
		readonly code: string,
		readonly status: number | null,
		readonly contentType: string,
		readonly terminal: string
	) {
		super(
			'Memory transport ' +
				code +
				' (status=' +
				(status ?? 'unknown') +
				', type=' +
				contentType +
				', terminal=' +
				terminal +
				')'
		);
	}
}
function evidence(value: MemoryTransportEvidence): void {
	if (
		!value ||
		!/^[a-f0-9]{64}$/.test(value.sha256) ||
		typeof value.reference !== 'string' ||
		!/^[A-Za-z0-9:/._-]{1,256}$/.test(value.reference)
	)
		throw new Error('Positive supervisor evidence reference required');
}
let buildSha: string | undefined;
function runtimeBuild(): string {
	// The supervisor binds this module/bundle fingerprint to its final release manifest.
	return (buildSha ??= digest(fs.readFileSync(__filename, 'utf8')));
}

/** Immutable debt is distinct from permits bounding owned local I/O, not old remote execution. */
export class MemoryTransport {
	constructor(private readonly db: Database.Database) {
		db.exec(`
   CREATE TABLE IF NOT EXISTS memory_transport_gate(id INTEGER PRIMARY KEY CHECK(id=1),bank_id TEXT NOT NULL,epoch TEXT,fence TEXT NOT NULL,state TEXT NOT NULL,tracked_origin INTEGER NOT NULL,config_sha TEXT,policy TEXT,activation TEXT);
   CREATE TABLE IF NOT EXISTS memory_transport_owners(id TEXT PRIMARY KEY,pid INTEGER NOT NULL,thread INTEGER NOT NULL,started_at INTEGER NOT NULL,build_sha TEXT NOT NULL,epoch TEXT,drain_fence TEXT);
   CREATE TABLE IF NOT EXISTS memory_transport_claims(claim TEXT PRIMARY KEY,runtime TEXT NOT NULL,state TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS memory_transport_permits(id TEXT PRIMARY KEY,runtime TEXT NOT NULL,job_id TEXT NOT NULL,claim TEXT NOT NULL,stage TEXT NOT NULL,reservation TEXT NOT NULL,state TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS memory_transport_active ON memory_transport_permits(state);
   CREATE TABLE IF NOT EXISTS memory_transport_requests(id TEXT PRIMARY KEY,permit TEXT NOT NULL,operation TEXT NOT NULL,state TEXT NOT NULL,status INTEGER,content_type TEXT,terminal TEXT);
   CREATE TABLE IF NOT EXISTS memory_transport_enqueues(job_id TEXT PRIMARY KEY,payload_sha TEXT NOT NULL,epoch TEXT);
   CREATE TABLE IF NOT EXISTS memory_transport_lineage(job_id TEXT PRIMARY KEY,payload_sha TEXT NOT NULL,kind TEXT NOT NULL,proof TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS memory_transport_legacy_usage(id TEXT PRIMARY KEY,snapshot TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS memory_transport_legacy_jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,blocked INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS memory_transport_legacy_checkpoint(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS memory_transport_legacy_owners(id TEXT PRIMARY KEY,owner TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS memory_transport_legacy_evidence(id TEXT PRIMARY KEY);
  `);
		db.transaction(() => {
			if (!this.gate()) {
				const empty =
					['sources', 'ingestion_queue', 'usage', 'episodes', 'evidence', 'memories'].every(
						(table) => this.count('SELECT COUNT(*) n FROM ' + table) === 0
					) &&
					!db
						.prepare(
							"SELECT 1 FROM metadata WHERE key='pendingExtraction' AND json_type(value)='object'"
						)
						.get();
				db.prepare(
					"INSERT INTO memory_transport_gate VALUES(1,?,NULL,?,'bootstrap',?,NULL,NULL,NULL)"
				).run(crypto.randomUUID(), crypto.randomUUID(), empty ? 1 : 0);
			}
			this.captureLegacy();
		}).immediate();
		db.exec(`
   CREATE TRIGGER IF NOT EXISTS memory_transport_usage_update BEFORE UPDATE ON usage WHEN EXISTS(SELECT 1 FROM memory_transport_legacy_usage WHERE id=OLD.id) BEGIN SELECT RAISE(ABORT,'Historical accounting is immutable'); END;
   CREATE TRIGGER IF NOT EXISTS memory_transport_usage_delete BEFORE DELETE ON usage WHEN EXISTS(SELECT 1 FROM memory_transport_legacy_usage WHERE id=OLD.id) BEGIN SELECT RAISE(ABORT,'Historical accounting is immutable'); END;
   CREATE TRIGGER IF NOT EXISTS memory_transport_job_update BEFORE UPDATE OF id,source_id,data ON ingestion_queue WHEN EXISTS(SELECT 1 FROM memory_transport_legacy_jobs WHERE id=OLD.id) BEGIN SELECT RAISE(ABORT,'Historical queue payload is immutable'); END;
   CREATE TRIGGER IF NOT EXISTS memory_transport_job_delete BEFORE DELETE ON ingestion_queue WHEN EXISTS(SELECT 1 FROM memory_transport_legacy_jobs WHERE id=OLD.id) BEGIN SELECT RAISE(ABORT,'Historical queue payload is immutable'); END;
   CREATE TRIGGER IF NOT EXISTS memory_transport_checkpoint_update BEFORE UPDATE ON metadata WHEN EXISTS(SELECT 1 FROM memory_transport_legacy_checkpoint WHERE key=OLD.key) BEGIN SELECT RAISE(ABORT,'Historical checkpoint is immutable'); END;
   CREATE TRIGGER IF NOT EXISTS memory_transport_checkpoint_delete BEFORE DELETE ON metadata WHEN EXISTS(SELECT 1 FROM memory_transport_legacy_checkpoint WHERE key=OLD.key) BEGIN SELECT RAISE(ABORT,'Historical checkpoint is immutable'); END;
   CREATE TRIGGER IF NOT EXISTS memory_transport_owner_update BEFORE UPDATE OF owner ON ingestion_work WHEN EXISTS(SELECT 1 FROM memory_transport_legacy_owners WHERE id=OLD.id) AND NEW.owner IS NOT OLD.owner BEGIN SELECT RAISE(ABORT,'Historical uncertainty ownership is immutable'); END;
  `);
		for (const table of [
			'memory_transport_legacy_usage',
			'memory_transport_legacy_jobs',
			'memory_transport_legacy_checkpoint',
			'memory_transport_legacy_owners',
			'memory_transport_legacy_evidence',
			'memory_transport_enqueues',
			'memory_transport_lineage',
		]) {
			db.exec(
				'CREATE TRIGGER IF NOT EXISTS ' +
					table +
					'_update BEFORE UPDATE ON ' +
					table +
					" BEGIN SELECT RAISE(ABORT,'Transport audit is immutable'); END; CREATE TRIGGER IF NOT EXISTS " +
					table +
					'_delete BEFORE DELETE ON ' +
					table +
					" BEGIN SELECT RAISE(ABORT,'Transport audit is immutable'); END;"
			);
		}
	}
	private gate(): Gate | undefined {
		return this.db.prepare('SELECT * FROM memory_transport_gate WHERE id=1').get() as
			| Gate
			| undefined;
	}
	private count(sql: string): number {
		return (this.db.prepare(sql).get() as { n: number }).n;
	}
	configSha(): string {
		return digest(
			(this.db.prepare("SELECT value FROM metadata WHERE key='config'").get() as { value: string })
				.value
		);
	}
	private captureLegacy(): void {
		const addUsage = this.db.prepare(
			'INSERT OR IGNORE INTO memory_transport_legacy_usage VALUES(?,?)'
		);
		const rows = this.db
			.prepare(
				"SELECT * FROM usage u WHERE state IN ('reserved','uncertain') AND NOT EXISTS(SELECT 1 FROM memory_transport_permits p WHERE p.reservation=u.id)"
			)
			.all() as { id: string }[];
		for (const row of rows) addUsage.run(row.id, JSON.stringify(row));
		this.db
			.prepare(
				`INSERT OR IGNORE INTO memory_transport_legacy_jobs
   SELECT q.id,q.data,CASE WHEN EXISTS(SELECT 1 FROM ingestion_work w WHERE w.id=q.id AND
    ((json_extract(w.data,'$.sent')=1 AND json_extract(w.data,'$.extracted') IS NULL) OR (json_extract(w.data,'$.verificationSent')=1 AND json_extract(w.data,'$.verified') IS NULL)))
    OR EXISTS(SELECT 1 FROM json_each(q.data,'$.evidence') e JOIN memory_transport_legacy_evidence h ON h.id=json_extract(e.value,'$.id'))
    OR (json_extract(q.data,'$.sent')=1 AND json_extract(q.data,'$.extracted') IS NULL) OR (json_extract(q.data,'$.verificationSent')=1 AND json_extract(q.data,'$.verified') IS NULL) THEN 1 ELSE 0 END
   FROM ingestion_queue q WHERE NOT EXISTS(SELECT 1 FROM memory_transport_lineage l WHERE l.job_id=q.id) AND NOT EXISTS(SELECT 1 FROM memory_transport_enqueues n WHERE n.job_id=q.id)`
			)
			.run();
		this.db
			.prepare(
				`INSERT OR IGNORE INTO memory_transport_legacy_jobs
		 SELECT q.id,q.data,1 FROM ingestion_queue q JOIN metadata m ON json_extract(m.value,'$.id')=q.id
		 WHERE m.key='pendingExtraction' AND ((json_extract(m.value,'$.sent')=1 AND json_extract(m.value,'$.extracted') IS NULL) OR (json_extract(m.value,'$.verificationSent')=1 AND json_extract(m.value,'$.verified') IS NULL))`
			)
			.run();
		this.db
			.prepare(
				"INSERT OR IGNORE INTO memory_transport_legacy_checkpoint SELECT key,value FROM metadata WHERE key='pendingExtraction' AND json_type(value)='object'"
			)
			.run();
		this.db
			.prepare(
				'INSERT OR IGNORE INTO memory_transport_legacy_owners SELECT id,owner FROM ingestion_work WHERE owner IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memory_transport_permits p WHERE p.job_id=ingestion_work.id)'
			)
			.run();
		this.db
			.prepare(
				"INSERT OR IGNORE INTO memory_transport_legacy_evidence SELECT json_extract(e.value,'$.id') FROM memory_transport_legacy_jobs q,json_each(q.payload,'$.evidence') e WHERE json_extract(e.value,'$.id') IS NOT NULL"
			)
			.run();
		const hasLegacy =
			this.count('SELECT COUNT(*) n FROM memory_transport_legacy_usage') +
			this.count('SELECT COUNT(*) n FROM memory_transport_legacy_jobs') +
			this.count('SELECT COUNT(*) n FROM memory_transport_legacy_checkpoint');
		if (hasLegacy && this.gate()!.tracked_origin)
			this.db
				.prepare(
					"UPDATE memory_transport_gate SET tracked_origin=0,state='fenced',epoch=NULL WHERE id=1"
				)
				.run();
	}
	legacySha(): string {
		return digest(
			JSON.stringify(
				[
					'memory_transport_legacy_usage',
					'memory_transport_legacy_jobs',
					'memory_transport_legacy_checkpoint',
					'memory_transport_legacy_owners',
				].map((table) => this.db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all())
			)
		);
	}
	registerOwner(): string {
		const id = crypto.randomUUID();
		this.db
			.prepare(
				"INSERT INTO memory_transport_owners VALUES(?,?,?,?,?,?,(SELECT CASE WHEN state='fenced' THEN fence ELSE NULL END FROM memory_transport_gate WHERE id=1))"
			)
			.run(id, process.pid, threadId, Date.now(), runtimeBuild(), this.gate()!.epoch);
		return id;
	}
	private untracked(): boolean {
		return (
			!!this.db
				.prepare(
					`SELECT 1 FROM usage u WHERE state IN ('reserved','uncertain') AND NOT EXISTS(SELECT 1 FROM memory_transport_legacy_usage h WHERE h.id=u.id) AND NOT EXISTS(SELECT 1 FROM memory_transport_permits p WHERE p.reservation=u.id) LIMIT 1`
				)
				.get() ||
			!!this.db
				.prepare(
					"SELECT 1 FROM metadata m WHERE m.key='pendingExtraction' AND json_type(m.value)='object' AND NOT EXISTS(SELECT 1 FROM memory_transport_legacy_checkpoint h WHERE h.key=m.key)"
				)
				.get() ||
			!!this.db
				.prepare(
					'SELECT 1 FROM ingestion_queue q WHERE NOT EXISTS(SELECT 1 FROM memory_transport_lineage l WHERE l.job_id=q.id) AND NOT EXISTS(SELECT 1 FROM memory_transport_enqueues n WHERE n.job_id=q.id) AND NOT EXISTS(SELECT 1 FROM memory_transport_legacy_jobs h WHERE h.id=q.id) LIMIT 1'
				)
				.get()
		);
	}
	ready(runtime: string): boolean {
		return this.db
			.transaction(() => {
				let gate = this.gate()!;
				if (this.untracked()) return false;
				if (
					gate.tracked_origin &&
					gate.state !== 'active' &&
					this.count('SELECT COUNT(*) n FROM memory_transport_permits WHERE ' + ACTIVE) === 0 &&
					(gate.state === 'bootstrap' ||
						(
							this.db
								.prepare(
									'SELECT COUNT(*) n FROM memory_transport_owners WHERE drain_fence IS NOT (SELECT fence FROM memory_transport_gate WHERE id=1)'
								)
								.get() as { n: number }
						).n === 0)
				) {
					const epoch = crypto.randomUUID();
					this.db
						.prepare(
							"UPDATE memory_transport_gate SET epoch=?,state='active',config_sha=?,policy='tracked-origin' WHERE id=1"
						)
						.run(epoch, this.configSha());
					// Only the caller resumes a drained owner; old runtimes stay retired.
					this.db
						.prepare('UPDATE memory_transport_owners SET epoch=? WHERE drain_fence IS NULL')
						.run(epoch);
					this.db
						.prepare('UPDATE memory_transport_owners SET epoch=?,drain_fence=NULL WHERE id=?')
						.run(epoch, runtime);
					gate = this.gate()!;
				}
				return (
					gate.state === 'active' &&
					gate.config_sha === this.configSha() &&
					!!this.db
						.prepare(
							'SELECT 1 FROM memory_transport_owners WHERE id=? AND epoch=? AND drain_fence IS NULL'
						)
						.get(runtime, gate.epoch)
				);
			})
			.immediate();
	}
	requireReady(runtime: string): void {
		if (!this.ready(runtime))
			throw new Error(
				'Memory transport admission closed: positive owner/drain and legacy lineage evidence required'
			);
	}
	fence(): ReturnType<MemoryTransport['status']> {
		this.db
			.transaction(() => {
				this.captureLegacy();
				this.db
					.prepare("UPDATE memory_transport_gate SET state='fenced',fence=? WHERE id=1")
					.run(crypto.randomUUID());
				// A drained owner cannot acquire work again without being explicitly resumed.
				// Carry its positive drain witness forward instead of reviving a retired runtime.
				this.db
					.prepare(
						'UPDATE memory_transport_owners SET drain_fence=(SELECT fence FROM memory_transport_gate WHERE id=1) WHERE drain_fence IS NOT NULL'
					)
					.run();
			})
			.immediate();
		return this.status();
	}
	drainOwner(runtime: string): void {
		this.db
			.transaction(() => {
				if (this.gate()!.state !== 'fenced')
					throw new Error('Fence admissions before acknowledging drain');
				if (
					this.db
						.prepare('SELECT 1 FROM memory_transport_permits WHERE runtime=? AND ' + ACTIVE)
						.get(runtime) ||
					this.db
						.prepare("SELECT 1 FROM memory_transport_claims WHERE runtime=? AND state='working'")
						.get(runtime)
				)
					throw new Error('Owned work/transport has no positive terminal evidence');
				if (
					!this.db
						.prepare('UPDATE memory_transport_owners SET drain_fence=? WHERE id=?')
						.run(this.gate()!.fence, runtime).changes
				)
					throw new Error('Transport owner unknown');
			})
			.immediate();
	}
	activate(value: MemoryTransportActivation): void {
		for (const proof of [
			value.localDrain,
			value.writerBoundary,
			value.backup,
			value.cohort?.decision,
		])
			evidence(proof);
		if (
			!/^[a-f0-9]{64}$/.test(value.releaseSha256) ||
			!['complete-lineage', 'hold-ambiguous-legacy'].includes(value.cohort.policy)
		)
			throw new Error('Explicit release/cohort decision required');
		this.db
			.transaction(() => {
				const gate = this.gate()!;
				if (
					gate.state !== 'fenced' ||
					value.bankId !== gate.bank_id ||
					value.fence !== gate.fence ||
					value.configSha256 !== this.configSha() ||
					value.legacySha256 !== this.legacySha()
				)
					throw new Error('Stale or mismatched transport activation evidence');
				if (
					this.count('SELECT COUNT(*) n FROM memory_transport_permits WHERE ' + ACTIVE) ||
					this.count(
						'SELECT COUNT(*) n FROM memory_transport_owners WHERE drain_fence IS NOT (SELECT fence FROM memory_transport_gate WHERE id=1)'
					)
				)
					throw new Error('Every registered owner must positively drain the current fence');
				if (
					this.db
						.prepare('SELECT 1 FROM memory_transport_owners WHERE build_sha!=? LIMIT 1')
						.get(value.releaseSha256)
				)
					throw new Error('Release fingerprint must match every registered owner');
				if (this.untracked())
					throw new Error('Untracked producer state must be isolated before activation');
				const epoch = crypto.randomUUID();
				this.db
					.prepare(
						"UPDATE memory_transport_gate SET epoch=?,state='active',config_sha=?,policy=?,activation=? WHERE id=1"
					)
					.run(epoch, this.configSha(), value.cohort.policy, JSON.stringify(value));
				this.db.prepare('UPDATE memory_transport_owners SET epoch=?,drain_fence=NULL').run(epoch);
			})
			.immediate();
	}
	recordEnqueue(id: string, payload: string): void {
		if (!this.db.inTransaction) throw new Error('Queue and native lineage must commit atomically');
		if (this.db.prepare('SELECT 1 FROM memory_transport_legacy_jobs WHERE id=?').get(id)) return;
		const overlap = this.db
			.prepare(
				"SELECT 1 FROM json_each(?,'$.evidence') e JOIN memory_transport_legacy_evidence h ON h.id=json_extract(e.value,'$.id') LIMIT 1"
			)
			.get(payload);
		if (overlap) return;
		this.db
			.prepare('INSERT INTO memory_transport_enqueues VALUES(?,?,?)')
			.run(id, digest(payload), this.gate()!.epoch);
		if (this.gate()!.tracked_origin)
			this.db
				.prepare("INSERT OR IGNORE INTO memory_transport_lineage VALUES(?,?,'native',?)")
				.run(
					id,
					digest(payload),
					JSON.stringify({ bankId: this.gate()!.bank_id, origin: 'controller-enqueue' })
				);
	}
	admit(value: MemoryTransportEligibility): void {
		evidence(value.evidence);
		this.db
			.transaction(() => {
				const gate = this.gate()!;
				if (
					gate.state !== 'active' ||
					gate.config_sha !== this.configSha() ||
					(gate.policy !== 'complete-lineage' &&
						!(
							gate.policy === 'hold-ambiguous-legacy' &&
							!this.db
								.prepare('SELECT 1 FROM memory_transport_legacy_jobs WHERE id=?')
								.get(value.jobId)
						))
				)
					throw new Error('Explicit complete-lineage activation is required to admit legacy work');
				const row = this.db
					.prepare(
						'SELECT q.data,COALESCE(w.data,q.data) work,h.blocked FROM ingestion_queue q LEFT JOIN ingestion_work w ON w.id=q.id LEFT JOIN memory_transport_legacy_jobs h ON h.id=q.id WHERE q.id=?'
					)
					.get(value.jobId) as { data: string; work: string; blocked: number } | undefined;
				if (
					!row ||
					digest(row.data) !== value.payloadSha256 ||
					!['never-submitted', 'cached-complete'].includes(value.kind)
				)
					throw new Error('Eligibility must match exact original queue payload');
				if (
					this.db.prepare('SELECT 1 FROM episodes WHERE id=? AND committed=1').get(value.jobId) ||
					this.db.prepare('SELECT 1 FROM extraction_quarantine WHERE id=?').get(value.jobId) ||
					row.blocked
				)
					throw new Error('Completed, quarantined or uncertain work cannot be admitted');
				const work = JSON.parse(row.work);
				if (
					value.kind === 'never-submitted' &&
					(work.sent || work.verificationSent || work.reservation || work.verificationReservation)
				)
					throw new Error('Known prior stage forbids never-submitted admission');
				if (
					value.kind === 'cached-complete' &&
					(!work.extracted || (!work.verified && work.extracted.records?.length !== 0))
				)
					throw new Error('Complete received stage receipts required');
				this.db
					.prepare('INSERT INTO memory_transport_lineage VALUES(?,?,?,?)')
					.run(value.jobId, value.payloadSha256, value.kind, JSON.stringify(value.evidence));
			})
			.immediate();
	}
	claim(runtime: string, claim: string): { id: string; data: string } | undefined {
		return this.db
			.transaction(() => {
				if (
					!this.ready(runtime) ||
					JSON.parse(
						(
							this.db.prepare("SELECT value FROM metadata WHERE key='paused'").get() as
								| { value: string }
								| undefined
						)?.value ?? 'true'
					) !== false
				)
					return;
				if (
					this.count("SELECT COUNT(*) n FROM memory_transport_claims WHERE state='working'") >= 5 ||
					this.count('SELECT COUNT(*) n FROM memory_transport_permits WHERE ' + ACTIVE) >= 5
				)
					return;
				const row = this.db
					.prepare(
						`SELECT q.id,q.data original,l.payload_sha,COALESCE(w.data,q.data) data FROM ingestion_queue q JOIN sources s ON s.id=q.source_id JOIN memory_transport_lineage l ON l.job_id=q.id LEFT JOIN ingestion_work w ON w.id=q.id
    WHERE s.excluded=0 AND s.user_id=json_extract((SELECT value FROM metadata WHERE key='config'),'$.userId') AND q.error IS NULL AND w.owner IS NULL
    AND NOT EXISTS(SELECT 1 FROM extraction_quarantine x WHERE x.id=q.id) AND NOT EXISTS(SELECT 1 FROM episodes e WHERE e.id=q.id AND e.committed=1)
    AND NOT EXISTS(SELECT 1 FROM memory_transport_legacy_jobs h WHERE h.id=q.id AND h.blocked=1) ORDER BY q.rowid LIMIT 1`
					)
					.get() as { id: string; data: string; original: string; payload_sha: string } | undefined;
				if (!row) return;
				if (digest(row.original) !== row.payload_sha)
					throw new Error('Queue payload differs from its no-replay lineage');
				this.db
					.prepare('INSERT OR IGNORE INTO ingestion_work(id,data) VALUES(?,?)')
					.run(row.id, row.data);
				if (
					!this.db
						.prepare('UPDATE ingestion_work SET owner=?,claimed_at=? WHERE id=? AND owner IS NULL')
						.run(claim, Date.now(), row.id).changes
				)
					return;
				this.db
					.prepare("INSERT INTO memory_transport_claims VALUES(?,?,'working')")
					.run(claim, runtime);
				return row;
			})
			.immediate();
	}
	endClaim(claim: string, isolated = false): void {
		if (
			this.db
				.prepare('SELECT 1 FROM memory_transport_permits WHERE claim=? AND ' + ACTIVE)
				.get(claim) &&
			(!isolated ||
				this.db
					.prepare(
						"SELECT 1 FROM memory_transport_permits WHERE claim=? AND state IN ('reserved','sending','body')"
					)
					.get(claim))
		)
			throw new Error('Claim still owns an active/unknown transport');
		this.db
			.prepare("UPDATE memory_transport_claims SET state=? WHERE claim=? AND state='working'")
			.run(isolated ? 'isolated' : 'ended', claim);
	}
	begin(
		runtime: string,
		jobId: string,
		claim: string,
		stage: 'extract' | 'verify',
		reservation: string,
		authority: () => boolean
	): MemoryTransportScope | undefined {
		if (!this.db.inTransaction)
			throw new Error('Transport permit, accounting and sent checkpoint require one transaction');
		this.requireReady(runtime);
		if (
			!authority() ||
			!this.db.prepare('SELECT 1 FROM ingestion_work WHERE id=? AND owner=?').get(jobId, claim) ||
			!this.db
				.prepare(
					"SELECT 1 FROM memory_transport_claims WHERE claim=? AND runtime=? AND state='working'"
				)
				.get(claim, runtime)
		)
			throw new Error('Transport source or job authority lost');
		if (this.count('SELECT COUNT(*) n FROM memory_transport_permits WHERE ' + ACTIVE) >= 5) return;
		if (this.db.prepare('SELECT 1 FROM memory_transport_legacy_usage WHERE id=?').get(reservation))
			throw new Error('Historical accounting cannot be resubmitted or settled');
		const id = crypto.randomUUID();
		this.db
			.prepare("INSERT INTO memory_transport_permits VALUES(?,?,?,?,?,?,'reserved')")
			.run(id, runtime, jobId, claim, stage, reservation);
		return new MemoryTransportScope(this, id, authority);
	}
	startRequest(id: string, operation: string, authority: () => boolean): string {
		return this.db
			.transaction(() => {
				const permit = this.db
					.prepare('SELECT * FROM memory_transport_permits WHERE id=?')
					.get(id) as Permit;
				if (!permit || !['reserved', 'sending'].includes(permit.state))
					throw new Error('Transport permit has ended or has an open body');
				this.requireReady(permit.runtime);
				if (
					!authority() ||
					!this.db
						.prepare('SELECT 1 FROM ingestion_work WHERE id=? AND owner=?')
						.get(permit.job_id, permit.claim) ||
					!this.db
						.prepare(
							"SELECT 1 FROM memory_transport_claims WHERE claim=? AND runtime=? AND state='working'"
						)
						.get(permit.claim, permit.runtime)
				)
					throw new Error('Late send rejected: owner or source authority lost');
				const request = crypto.randomUUID();
				this.db
					.prepare("INSERT INTO memory_transport_requests VALUES(?,?,?,'sending',NULL,NULL,NULL)")
					.run(request, id, operation);
				this.db.prepare("UPDATE memory_transport_permits SET state='sending' WHERE id=?").run(id);
				return request;
			})
			.immediate();
	}
	response(id: string, request: string, status: number, mime: string): void {
		this.db
			.transaction(() => {
				this.db
					.prepare(
						"UPDATE memory_transport_requests SET state='body',status=?,content_type=? WHERE id=? AND permit=? AND state='sending'"
					)
					.run(status, mime, request, id);
				this.db.prepare("UPDATE memory_transport_permits SET state='body' WHERE id=?").run(id);
			})
			.immediate();
	}
	terminal(id: string, request: string, kind: string): void {
		this.db
			.transaction(() => {
				if (
					!this.db
						.prepare(
							"UPDATE memory_transport_requests SET state='ended',terminal=? WHERE id=? AND permit=? AND state IN ('sending','body')"
						)
						.run(kind, request, id).changes
				)
					throw new Error('Transport terminal witness does not match active request');
				this.db.prepare("UPDATE memory_transport_permits SET state='sending' WHERE id=?").run(id);
			})
			.immediate();
	}
	unknown(id: string, request: string): void {
		this.db
			.transaction(() => {
				this.db
					.prepare(
						"UPDATE memory_transport_requests SET state='unknown',terminal='unproven-close' WHERE id=? AND permit=? AND state IN ('sending','body')"
					)
					.run(request, id);
				this.db.prepare("UPDATE memory_transport_permits SET state='unknown' WHERE id=?").run(id);
			})
			.immediate();
	}
	finish(id: string): void {
		this.db
			.transaction(() => {
				if (
					this.db
						.prepare("SELECT 1 FROM memory_transport_requests WHERE permit=? AND state!='ended'")
						.get(id)
				)
					throw new Error('Open/unknown body forbids permit release');
				if (
					!this.db
						.prepare(
							"UPDATE memory_transport_permits SET state='ended' WHERE id=? AND state IN ('reserved','sending')"
						)
						.run(id).changes
				)
					throw new Error('Transport permit cannot end without terminal evidence');
			})
			.immediate();
	}
	status() {
		const gate = this.gate()!;
		return {
			bankId: gate.bank_id,
			epoch: gate.epoch,
			fence: gate.fence,
			state: gate.state,
			configSha256: this.configSha(),
			legacySha256: this.legacySha(),
			cohortPolicy: gate.policy,
			activePermits: this.count('SELECT COUNT(*) n FROM memory_transport_permits WHERE ' + ACTIVE),
			owners: this.db
				.prepare(
					'SELECT id,pid,thread,started_at,build_sha,epoch,drain_fence FROM memory_transport_owners ORDER BY id'
				)
				.all(),
			historicalReservations: this.count('SELECT COUNT(*) n FROM memory_transport_legacy_usage'),
			blockedLegacyJobs: this.count(
				'SELECT COUNT(*) n FROM memory_transport_legacy_jobs WHERE blocked=1'
			),
		};
	}
}

/** Mandatory owned I/O seam; errors never contain provider/private body text. */
export class MemoryTransportScope {
	private open = false;
	private ended = false;
	private uncertain = false;
	constructor(
		private readonly controller: MemoryTransport,
		readonly id: string,
		private readonly authority: () => boolean
	) {}
	async json(
		url: string,
		init: RequestInit,
		timeoutMs: number,
		operation: string
	): Promise<{ status: number; ok: boolean; data: unknown }> {
		for (let attempt = 0; ; attempt++) {
			init.signal?.throwIfAborted();
			try {
				return await this.requestJson(url, init, timeoutMs, operation);
			} catch (error) {
				if (
					url !== 'https://api.nan.builders/v1/chat/completions' ||
					operation !== 'hosted-chat' ||
					!(error instanceof MemoryTransportError) ||
					(error.status !== 429 && error.status !== 502 && error.status !== 524) ||
					error.terminal !== 'body-eof' ||
					attempt >= 30
				)
					throw error;
				// Keep the same permit and budget reservation while backing off. Each
				// physical retry is recorded and rechecks ownership/consent before sending.
				await new Promise<void>((resolve) =>
					setTimeout(resolve, Math.min(500 * 2 ** attempt, 30000))
				);
			}
		}
	}
	private async requestJson(
		url: string,
		init: RequestInit,
		timeoutMs: number,
		operation: string
	): Promise<{ status: number; ok: boolean; data: unknown }> {
		if (this.open || this.ended) throw new Error('Transport scope is not available');
		const request = this.controller.startRequest(this.id, operation, this.authority);
		this.open = true;
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), timeoutMs);
		timer.unref();
		let status: number | null = null,
			mime = 'absent',
			terminal = 'fetch-rejected';
		try {
			const response = await fetch(url, {
				...init,
				signal: init.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal,
			});
			status = response.status;
			const raw = (response.headers.get('content-type') ?? '')
				.split(';', 1)[0]
				.trim()
				.toLowerCase();
			mime = [
				'application/json',
				'application/jsonl',
				'application/x-ndjson',
				'text/html',
				'text/plain',
				'application/octet-stream',
			].includes(raw)
				? raw
				: raw
					? 'other'
					: 'absent';
			this.controller.response(this.id, request, status, mime);
			terminal = 'body-rejected';
			const body = await response.text();
			terminal = 'body-eof';
			this.controller.terminal(this.id, request, terminal);
			this.open = false;
			if (!response.ok) throw new MemoryTransportError('http-status', status, mime, terminal);
			let data: unknown;
			try {
				data = JSON.parse(body);
			} catch {
				throw new MemoryTransportError('non-json', status, mime, terminal);
			}
			return { status, ok: response.ok, data };
		} catch (error) {
			if (this.open) {
				this.controller.unknown(this.id, request);
				this.open = false;
				this.uncertain = true;
				terminal = 'unproven-close';
			}
			if (error instanceof MemoryTransportError) throw error;
			throw new MemoryTransportError(terminal, status, mime, terminal);
		} finally {
			clearTimeout(timer);
		}
	}
	finish(): void {
		if (this.open || this.ended) throw new Error('Transport scope cannot be ended');
		if (!this.uncertain) this.controller.finish(this.id);
		this.ended = true;
	}
}
