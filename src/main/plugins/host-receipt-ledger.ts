/** Indexed host-private receipts shared by Cue and Relay. Responses expire; execution fences do not. */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import type { AnchorStore } from '../utils/keyring-anchor';

export interface HostReceiptLedgerLimits {
	messages: number;
	mappings: number;
	responseBytes: number;
	responseCount: number;
	valueBytes: number;
	pages: number;
	/** Optional per-owner admission bound, used by Cue. */
	ownerMessages?: number;
}
export const HOST_RECEIPT_LEDGER_LIMITS: Readonly<HostReceiptLedgerLimits> = Object.freeze({
	messages: 1_000_000,
	mappings: 10_000,
	responseBytes: 32 * 1024 * 1024,
	responseCount: 256,
	valueBytes: 256 * 1024,
	pages: 65536,
});
interface Row {
	key: string;
	kind: string;
	value: string;
	proof: string;
	agent_id: string | null;
	provider_id: string | null;
}
interface Checkpoint {
	key: string;
	root: string;
	pending?: { root: string; epoch: number };
}

/** Owns one connection per synchronous operation: no open handle survives app shutdown.
 * An independent credential-store checkpoint detects file rollback/deletion. It never
 * reads or changes plugin grants, their epoch, or provider authorization.
 */
export class HostReceiptLedger {
	private readonly file: string;
	private readonly lockFile: string;
	private readonly limits: HostReceiptLedgerLimits;
	private failed = false;
	private readonly empty: string[] = [];
	private readonly turnReserveBytes = 2 * 1024 * 1024;
	constructor(
		private readonly baseDir: string,
		private readonly anchor: AnchorStore,
		limits: Partial<HostReceiptLedgerLimits> = {}
	) {
		this.empty[16] = createHash('sha256').update('relay-empty-leaf-v1').digest('hex');
		for (let depth = 15; depth >= 0; depth--)
			this.empty[depth] = this.node(this.empty[depth + 1], this.empty[depth + 1]);
		this.file = path.join(baseDir, 'receipts.sqlite');
		this.lockFile = path.join(baseDir, 'receipt-checkpoint-lock.sqlite');
		this.limits = { ...HOST_RECEIPT_LEDGER_LIMITS, ...limits };
		for (const value of Object.values(this.limits))
			if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid Relay ledger limit');
	}
	private digest(checkpoint: Checkpoint, key: string, kind: string, value: string): string {
		return createHmac('sha256', checkpoint.key)
			.update(canonicalJson(['relay-ledger-v1', key, kind, value]))
			.digest('hex');
	}
	private node(left: string, right: string): string {
		return createHash('sha256')
			.update('relay-node-v1:' + left + right)
			.digest('hex');
	}
	private route(key: string): string {
		return [...createHash('sha256').update(key).digest().subarray(0, 2)]
			.map((n) => n.toString(2).padStart(8, '0'))
			.join('');
	}
	private bucket(db: Database.Database, checkpoint: Checkpoint, bucket: number): string {
		const rows = db
			.prepare('SELECT key,kind,value,proof FROM entries WHERE bucket=? ORDER BY key LIMIT 257')
			.all(bucket) as Row[];
		if (rows.length > 256) throw Error('Relay receipt index bucket capacity reached');
		if (!rows.length) return this.empty[16];
		for (const row of rows) {
			if (
				parseInt(this.route(row.key), 2) !== bucket ||
				this.digest(checkpoint, row.key, row.kind, row.value) !== row.proof
			)
				throw Error('Relay receipt integrity failure');
		}
		return createHash('sha256')
			.update(canonicalJson(['relay-bucket-v1', rows.map((row) => [row.key, row.proof])]))
			.digest('hex');
	}
	private verify(db: Database.Database, checkpoint: Checkpoint, key: string): Row | undefined {
		const row = db.prepare('SELECT * FROM entries WHERE key=?').get(key) as Row | undefined;
		if (row && this.digest(checkpoint, row.key, row.kind, row.value) !== row.proof)
			throw Error('Relay receipt integrity failure');
		const route = this.route(key);
		let root = this.bucket(db, checkpoint, parseInt(route, 2));
		for (let depth = 15; depth >= 0; depth--) {
			const bit = route[depth],
				sibling = route.slice(0, depth) + (bit === '0' ? '1' : '0');
			const other = db.prepare('SELECT hash FROM tree WHERE prefix=?').get(sibling) as
				| { hash: string }
				| undefined;
			const hash = other?.hash ?? this.empty[depth + 1];
			root = bit === '0' ? this.node(root, hash) : this.node(hash, root);
		}
		if (root !== checkpoint.root) {
			this.failed = true;
			throw Error('Relay receipt rollback or deletion detected');
		}
		return row;
	}
	private updateTree(db: Database.Database, key: string): string {
		const route = this.route(key);
		const anchor = this.anchor.read();
		if (!anchor) throw Error('Relay receipt checkpoint unavailable');
		const checkpoint = JSON.parse(anchor.installSecret) as Checkpoint;
		const rootBucket = this.bucket(db, checkpoint, parseInt(route, 2));
		let root = rootBucket;
		const write = (prefix: string, hash: string, depth: number) => {
			if (hash === this.empty[depth]) db.prepare('DELETE FROM tree WHERE prefix=?').run(prefix);
			else
				db.prepare(
					'INSERT INTO tree VALUES (?,?) ON CONFLICT(prefix) DO UPDATE SET hash=excluded.hash'
				).run(prefix, hash);
		};
		write(route, root, 16);
		for (let depth = 15; depth >= 0; depth--) {
			const bit = route[depth],
				sibling = route.slice(0, depth) + (bit === '0' ? '1' : '0');
			const other = db.prepare('SELECT hash FROM tree WHERE prefix=?').get(sibling) as
				| { hash: string }
				| undefined;
			const hash = other?.hash ?? this.empty[depth + 1];
			root = bit === '0' ? this.node(root, hash) : this.node(hash, root);
			write(route.slice(0, depth), root, depth);
		}
		return root;
	}
	private use<T>(action: (db: Database.Database, checkpoint: Checkpoint, epoch: number) => T): T {
		if (this.failed || !this.anchor.available())
			throw Error('Relay receipt checkpoint unavailable');
		let db: Database.Database | undefined;
		let lock: Database.Database | undefined;
		try {
			for (const candidate of [
				this.baseDir,
				this.file,
				this.file + '-wal',
				this.file + '-shm',
				this.file + '-journal',
				this.lockFile,
				this.lockFile + '-journal',
				this.lockFile + '-wal',
				this.lockFile + '-shm',
			]) {
				try {
					const stat = fs.lstatSync(candidate);
					if (
						stat.isSymbolicLink() ||
						(candidate === this.baseDir ? !stat.isDirectory() : !stat.isFile())
					)
						throw Error('Relay receipt path must be a private directory or regular file');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				}
			}
			// Hold a separate SQLite write lock across receipt commit AND native checkpoint
			// finalization/recovery. Another worker must never stabilize an obsolete base.
			// SQLite releases this kernel lock when a worker dies; it carries no authority.
			fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
			lock = new Database(this.lockFile, { timeout: 5000 });
			lock.exec('BEGIN EXCLUSIVE');
			const anchor = this.anchor.read();
			if (!anchor) {
				// Never bless an existing unauthenticated database or legacy JSON as empty.
				if (
					fs.existsSync(this.file) ||
					fs.existsSync(path.join(this.baseDir, 'sh.maestro.relay', 'store.json'))
				)
					throw Error('Relay receipts require authenticated migration before admission');
				fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
				this.anchor.write({
					installSecret: JSON.stringify({
						key: randomBytes(32).toString('hex'),
						root: this.empty[0],
					}),
					epoch: 0,
				});
			} else if (
				!fs.existsSync(this.file) &&
				!(anchor.epoch === 0 && JSON.parse(anchor.installSecret).root === this.empty[0])
			)
				throw Error('Relay receipt database was removed');
			const current = this.anchor.read();
			if (!current) throw Error('Relay receipt checkpoint unavailable');
			const checkpoint = JSON.parse(current.installSecret) as Checkpoint;
			if (
				!/^[0-9a-f]{64}$/.test(checkpoint.key) ||
				!/^[0-9a-f]{64}$/.test(checkpoint.root) ||
				!Number.isSafeInteger(current.epoch) ||
				current.epoch < 0 ||
				(checkpoint.pending !== undefined &&
					(!/^[0-9a-f]{64}$/.test(checkpoint.pending.root) ||
						checkpoint.pending.epoch !== current.epoch + 1))
			)
				throw Error('Relay receipt checkpoint invalid');
			db = new Database(this.file);
			if (db.pragma('page_size', { simple: true }) !== 4096)
				throw Error('Relay receipt database page size unsupported');
			db.pragma('journal_mode = WAL');
			db.pragma('synchronous = FULL');
			db.pragma(`max_page_count = ${this.limits.pages}`);
			db.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,root TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY,kind TEXT NOT NULL,value TEXT NOT NULL,proof TEXT NOT NULL,agent_id TEXT,provider_id TEXT,bucket INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS relay_bucket ON entries(bucket);
    CREATE INDEX IF NOT EXISTS relay_kind ON entries(kind);
    CREATE INDEX IF NOT EXISTS relay_provider ON entries(agent_id,provider_id) WHERE kind='mapping';
    CREATE TABLE IF NOT EXISTS tree(prefix TEXT PRIMARY KEY,hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY,body TEXT NOT NULL,bytes INTEGER NOT NULL,seq INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS relay_response_order ON responses(seq);`);
			const meta = db.prepare('SELECT epoch,root FROM meta WHERE id=1').get() as
				| { epoch: number; root: string }
				| undefined;
			if (!meta && current.epoch === 0 && checkpoint.root === this.empty[0])
				db.prepare('INSERT INTO meta VALUES (1,0,?)').run(checkpoint.root);
			else if (
				!meta ||
				!(
					(meta.epoch === current.epoch && meta.root === checkpoint.root) ||
					(checkpoint.pending &&
						meta.epoch === checkpoint.pending.epoch &&
						meta.root === checkpoint.pending.root)
				)
			)
				throw Error('Relay receipt rollback detected');
			if (checkpoint.pending) {
				// A prepared transition was never acknowledged. Recover exactly its base or target;
				// stable checkpoints never accept their predecessor. No provider can start before ACK.
				const recovered = meta ?? { epoch: current.epoch, root: checkpoint.root };
				const stable = {
					installSecret: JSON.stringify({ key: checkpoint.key, root: recovered.root }),
					epoch: recovered.epoch,
				};
				this.anchor.write(stable);
				if (canonicalJson(this.anchor.read()) !== canonicalJson(stable))
					throw Error('Relay receipt checkpoint recovery failed');
				return action(db, { key: checkpoint.key, root: recovered.root }, recovered.epoch);
			}
			return action(db, checkpoint, current.epoch);
		} finally {
			try {
				db?.close();
			} finally {
				lock?.close();
			}
		}
	}
	get(key: string): string | null {
		return this.use((db, checkpoint) => {
			const row = this.verify(db, checkpoint, key);
			if (!row) return null;
			const value = JSON.parse(row.value);
			if (row.kind === 'receipt' && value.result) {
				const body = db.prepare('SELECT body FROM responses WHERE key=?').get(key) as
					| { body: string }
					| undefined;
				if (body && this.digest(checkpoint, key, 'response', body.body) === value.responseProof)
					value.result.response = body.body;
				else value.result.response = null;
			}
			return JSON.stringify(value);
		});
	}
	mappingKeys(): string[] {
		return this.use((db, checkpoint) => {
			const state = this.verify(db, checkpoint, 'system:counts');
			const counts = state ? JSON.parse(state.value) : {};
			const rows = db
				.prepare("SELECT key FROM entries WHERE kind='mapping' LIMIT ?")
				.all(this.limits.mappings + 1) as { key: string }[];
			if (rows.length !== (counts.mapping ?? 0))
				throw Error('Relay mapping index integrity failure');
			return rows.map((row) => {
				const item = this.verify(db, checkpoint, row.key);
				if (!item || item.kind !== 'mapping') throw Error('Relay mapping integrity failure');
				return row.key;
			});
		});
	}
	private providerKey(agentId: string, providerId: string): string {
		return (
			'binding:' +
			createHash('sha256')
				.update(canonicalJson([agentId, providerId]))
				.digest('hex')
		);
	}
	assertProviderAvailable(agentId: string, providerId: string, conversationId: string): void {
		const prior = this.get(this.providerKey(agentId, providerId));
		if (prior && JSON.parse(prior).conversationId !== conversationId)
			throw Error('Provider session already maps to another Relay conversation');
	}
	private availableBytes(db: Database.Database): number {
		return (
			(this.limits.pages -
				Number(db.pragma('page_count', { simple: true })) +
				Number(db.pragma('freelist_count', { simple: true }))) *
			4096
		);
	}
	private ensureCapacity(db: Database.Database, inflight: number): void {
		const required = inflight * this.turnReserveBytes;
		for (
			let dropped = 0;
			this.availableBytes(db) < required && dropped < this.limits.responseCount;
			dropped++
		) {
			const oldest = db.prepare('SELECT key FROM responses ORDER BY seq LIMIT 1').get() as
				| { key: string }
				| undefined;
			if (!oldest) break;
			db.prepare('DELETE FROM responses WHERE key=?').run(oldest.key);
		}
		if (this.availableBytes(db) < required)
			throw Error('Relay physical outcome capacity reached; new admission refused');
	}
	/** Essential rows commit together. Two MiB per in-flight turn stays unavailable to
	 * other admissions/cache writes until its bounded outcome, mapping and binding commit.
	 * This exceeds their three 64KiB metadata rows plus bounded Merkle/index splits.
	 * Message count is an upper bound; the physical page budget can refuse earlier.
	 * This reserves SQLite pages, not OS disk space or keyring availability. */
	private mutate(
		changes: { key: string; value: string | null }[],
		admissionKey?: string,
		expected?: { key: string; value: string | null }
	): void {
		const bodies: { key: string; body: string }[] = [];
		this.use((db, checkpoint, epoch) => {
			if (epoch >= Number.MAX_SAFE_INTEGER) throw Error('Relay receipt checkpoint exhausted');
			if (expected) {
				const actual = this.verify(db, checkpoint, expected.key)?.value ?? null;
				if (
					canonicalJson(actual === null ? null : JSON.parse(actual)) !==
					canonicalJson(expected.value === null ? null : JSON.parse(expected.value))
				)
					throw Error('Receipt compare-and-set conflict');
			}
			const countsRow = this.verify(db, checkpoint, 'system:counts');
			const counts: Record<string, number> = countsRow ? JSON.parse(countsRow.value) : {};
			const rows = changes.map(({ key, value }) => {
				const old = this.verify(db, checkpoint, key);
				if (key === admissionKey && old) throw Error('Relay admission already exists');
				const prior = old ? JSON.parse(old.value) : {};
				const parsed = value === null ? {} : JSON.parse(value);
				const kind =
					value === null
						? (old?.kind ?? '')
						: typeof parsed.tabId === 'string' && typeof parsed.agentId === 'string'
							? 'mapping'
							: parsed.providerBinding === true
								? 'binding'
								: parsed.receiptControl === true
									? 'control'
									: 'receipt';
				if (
					old?.kind === 'binding' &&
					value !== null &&
					parsed.conversationId !== prior.conversationId
				)
					throw Error('Provider session already maps to another Relay conversation');
				if (old && value !== null && old.kind !== kind)
					throw Error('Relay ledger entry kind conflict');
				if (old?.kind === 'receipt' && typeof prior.receiptOwner === 'string')
					counts['owner:' + prior.receiptOwner] = (counts['owner:' + prior.receiptOwner] ?? 0) - 1;
				if (kind === 'receipt' && value !== null && typeof parsed.receiptOwner === 'string') {
					if (parsed.receiptOwner.length > 128) throw Error('Receipt owner too large');
					const ownerKey = 'owner:' + parsed.receiptOwner;
					counts[ownerKey] = (counts[ownerKey] ?? 0) + 1;
					if (
						this.limits.ownerMessages !== undefined &&
						counts[ownerKey] > this.limits.ownerMessages
					)
						throw Error('Receipt owner capacity reached');
				}
				if (old) counts[old.kind] = (counts[old.kind] ?? 0) - 1;
				if (value !== null) counts[kind] = (counts[kind] ?? 0) + 1;
				if (old?.kind === 'receipt' && prior.outcomeReservation === true && !prior.result)
					counts.inflight = (counts.inflight ?? 0) - 1;
				if (
					kind === 'receipt' &&
					value !== null &&
					parsed.outcomeReservation === true &&
					!parsed.result
				)
					counts.inflight = (counts.inflight ?? 0) + 1;
				if (old?.kind === 'receipt' && prior.providerReservation === true) {
					counts.reservations = (counts.reservations ?? 0) - 1;
					if (!prior.result) counts.inflight = (counts.inflight ?? 0) - 1;
				}
				if (kind === 'receipt' && value !== null && parsed.providerReservation === true) {
					counts.reservations = (counts.reservations ?? 0) + 1;
					if (!parsed.result) counts.inflight = (counts.inflight ?? 0) + 1;
				}
				if (kind === 'receipt' && parsed.result) {
					const body =
						typeof parsed.result.response === 'string' ? parsed.result.response : undefined;
					parsed.result = {
						success: parsed.result.success === true,
						response: null,
						sessionId: parsed.result.sessionId ?? null,
						...(parsed.result.error ? { error: String(parsed.result.error).slice(0, 2000) } : {}),
						// Exactly one host-generated receipt, retained within the bounded outcome reservation.
						...(Array.isArray(parsed.result.originalAttachments) &&
						parsed.result.originalAttachments.length === 1
							? {
									originalAttachments: parsed.result.originalAttachments.map(
										(receipt: { filename: string; bytes: number; sha256: string }) => ({
											filename: String(receipt.filename).slice(0, 255),
											bytes: receipt.bytes,
											sha256: String(receipt.sha256).slice(0, 64),
										})
									),
								}
							: {}),
						...(parsed.result.tabId ? { tabId: parsed.result.tabId } : {}),
						...(parsed.result.conversationId
							? { conversationId: parsed.result.conversationId }
							: {}),
					};
					if (body !== undefined && Buffer.byteLength(body) <= this.limits.valueBytes) {
						parsed.responseProof = this.digest(checkpoint, key, 'response', body);
						bodies.push({ key, body });
					}
				}
				const stored = value === null ? null : JSON.stringify(parsed);
				if (
					((old?.kind === 'receipt' && prior.result) ||
						(old?.kind === 'control' && prior.controlFinal === true)) &&
					(stored === null || canonicalJson(JSON.parse(stored)) !== canonicalJson(prior))
				)
					throw Error('Cannot replace an executed Relay receipt');
				if (stored !== null && Buffer.byteLength(stored) > 64 * 1024)
					throw Error('Relay ledger metadata too large');
				return {
					key,
					kind,
					stored,
					agentId: kind === 'mapping' ? parsed.agentId : null,
					providerId: kind === 'mapping' ? (parsed.providerSessionId ?? null) : null,
				};
			});
			if (
				(counts.receipt ?? 0) > this.limits.messages ||
				(counts.control ?? 0) > 1025 ||
				(counts.mapping ?? 0) > this.limits.mappings ||
				(counts.binding ?? 0) + (counts.reservations ?? 0) > this.limits.mappings
			)
				throw Error('Relay receipt capacity reached; new admission refused');
			let root = checkpoint.root;
			db.transaction(() => {
				const current = this.anchor.read();
				const meta = db.prepare('SELECT epoch,root FROM meta WHERE id=1').get() as {
					epoch: number;
					root: string;
				};
				if (
					!current ||
					current.epoch !== epoch ||
					canonicalJson(JSON.parse(current.installSecret)) !== canonicalJson(checkpoint) ||
					meta.epoch !== epoch ||
					meta.root !== checkpoint.root
				)
					throw Error('Relay receipt writer changed before commit; admission refused');
				this.ensureCapacity(db, counts.inflight ?? 0);
				for (const { key, kind, stored, agentId, providerId } of rows) {
					if (stored === null) {
						db.prepare('DELETE FROM entries WHERE key=?').run(key);
						db.prepare('DELETE FROM responses WHERE key=?').run(key);
					} else {
						const proof = this.digest(checkpoint, key, kind, stored);
						db.prepare(
							'INSERT INTO entries VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,value=excluded.value,proof=excluded.proof,agent_id=excluded.agent_id,provider_id=excluded.provider_id,bucket=excluded.bucket'
						).run(key, kind, stored, proof, agentId, providerId, parseInt(this.route(key), 2));
					}
					root = this.updateTree(db, key);
				}
				const countValue = JSON.stringify(counts),
					countKey = 'system:counts';
				db.prepare(
					'INSERT INTO entries VALUES (?,?,?,?,NULL,NULL,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,proof=excluded.proof'
				).run(
					countKey,
					'system',
					countValue,
					this.digest(checkpoint, countKey, 'system', countValue),
					parseInt(this.route(countKey), 2)
				);
				root = this.updateTree(db, countKey);
				this.ensureCapacity(db, counts.inflight ?? 0);
				db.prepare('UPDATE meta SET epoch=?,root=? WHERE id=1').run(epoch + 1, root);
				const prepared = {
					installSecret: JSON.stringify({
						key: checkpoint.key,
						root: checkpoint.root,
						pending: { root, epoch: epoch + 1 },
					}),
					epoch,
				};
				this.anchor.write(prepared);
				if (canonicalJson(this.anchor.read()) !== canonicalJson(prepared))
					throw Error('Relay receipt checkpoint write failed');
			})();
			const next = {
				installSecret: JSON.stringify({ key: checkpoint.key, root }),
				epoch: epoch + 1,
			};
			this.anchor.write(next);
			if (canonicalJson(this.anchor.read()) !== canonicalJson(next))
				throw Error('Relay receipt checkpoint finalize failed');
		});
		// The response cache is not authority. It cannot prevent essential outcome ACK.
		for (const { key, body } of bodies) {
			try {
				this.use((db, checkpoint, epoch) =>
					db.transaction(() => {
						const countsRow = this.verify(db, checkpoint, 'system:counts');
						const counts = countsRow ? JSON.parse(countsRow.value) : {};
						db.prepare('DELETE FROM responses WHERE key=?').run(key);
						let total = db
							.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM responses')
							.get() as { n: number; bytes: number };
						while (
							total.n &&
							(total.n >= this.limits.responseCount ||
								total.bytes + Buffer.byteLength(body) > this.limits.responseBytes)
						) {
							const oldest = db
								.prepare('SELECT key,bytes FROM responses ORDER BY seq LIMIT 1')
								.get() as { key: string; bytes: number };
							db.prepare('DELETE FROM responses WHERE key=?').run(oldest.key);
							total = { n: total.n - 1, bytes: total.bytes - oldest.bytes };
						}
						if (Buffer.byteLength(body) > this.limits.responseBytes) return;
						db.prepare('INSERT INTO responses VALUES (?,?,?,?)').run(
							key,
							body,
							Buffer.byteLength(body),
							epoch
						);
						const available = this.availableBytes(db);
						if (available < (counts.inflight ?? 0) * this.turnReserveBytes)
							throw Error('Relay response cache capacity reached');
					})()
				);
			} catch {
				/* Preserve stable outcome/tombstone; an absent body is a silent replay. */
			}
		}
	}
	set(key: string, value: string): void {
		const mapping = JSON.parse(value);
		const changes = [{ key, value }];
		if (
			typeof mapping.agentId === 'string' &&
			typeof mapping.tabId === 'string' &&
			mapping.providerSessionId
		) {
			this.assertProviderAvailable(
				mapping.agentId,
				mapping.providerSessionId,
				mapping.conversationId
			);
			const binding = this.providerKey(mapping.agentId, mapping.providerSessionId);
			if (!this.get(binding))
				changes.unshift({
					key: binding,
					value: JSON.stringify({ providerBinding: true, conversationId: mapping.conversationId }),
				});
		}
		this.mutate(changes);
	}
	/** Native-lock CAS used by Cue admission/execution claims. No grant mutation. */
	compareAndSet(key: string, expected: string | null, value: string | null): void {
		this.mutate([{ key, value }], expected === null && value !== null ? key : undefined, {
			key,
			value: expected,
		});
	}
	reserveTurn(key: string, value: string, mappingKey?: string, mapping?: string): void {
		if (this.get(key) !== null) throw Error('Relay admission already exists');
		this.mutate(
			[
				{ key, value: JSON.stringify({ ...JSON.parse(value), providerReservation: true }) },
				...(mappingKey && mapping ? [{ key: mappingKey, value: mapping }] : []),
			],
			key
		);
	}
	finishTurn(receiptKey: string, receipt: string, mappingKey: string, mapping: string): void {
		const outcome = JSON.parse(receipt),
			owner = JSON.parse(mapping);
		delete owner.pendingReceiptKey;
		const pending = this.get(receiptKey);
		if (!pending || JSON.parse(pending).providerReservation !== true)
			throw Error('Relay outcome has no admission reservation');
		try {
			const changes = [
				{
					key: receiptKey,
					value: JSON.stringify({
						...outcome,
						providerReservation:
							!owner.providerSessionId &&
							owner.interrupted !== false &&
							outcome.result?.executionStarted !== false,
					}),
				},
				{ key: mappingKey, value: JSON.stringify(owner) },
			];
			if (owner.providerSessionId) {
				this.assertProviderAvailable(owner.agentId, owner.providerSessionId, owner.conversationId);
				const binding = this.providerKey(owner.agentId, owner.providerSessionId);
				if (!this.get(binding))
					changes.unshift({
						key: binding,
						value: JSON.stringify({ providerBinding: true, conversationId: owner.conversationId }),
					});
			}
			this.mutate(changes);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!/already maps to another Relay|index bucket capacity/.test(error.message)
			)
				throw error;
			// Unknown provider keys can hit a full Merkle bucket or conflict. Retain the
			// outcome under already reserved keys, fence continuation, and preserve the answer.
			this.mutate([
				{
					key: receiptKey,
					value: JSON.stringify({
						...outcome,
						providerReservation: true,
						result: {
							...outcome.result,
							success: false,
							error:
								'Provider ownership could not be committed; inspect the retained conversation answer',
						},
					}),
				},
				{
					key: mappingKey,
					value: JSON.stringify({ ...owner, interrupted: true, pendingReceiptKey: receiptKey }),
				},
			]);
			throw error;
		}
	}
	settleTurn(key: string, providerId?: string): void {
		const value = this.get(key);
		if (!value) return;
		const receipt = JSON.parse(value);
		if (receipt.result) return;
		this.mutate([
			{
				key,
				value: JSON.stringify({
					...receipt,
					result: {
						success: false,
						response: null,
						sessionId: providerId ?? null,
						error: 'Previous Relay execution interrupted; inspect conversation before retrying',
					},
				}),
			},
		]);
	}
	deletePending(key: string): void {
		const value = this.get(key);
		if (!value) return;
		if (value && JSON.parse(value).result) throw Error('Cannot delete an executed Relay receipt');
		this.mutate([{ key, value: null }]);
	}
	/** Uninstall removes mappings and payloads, preserving permanent execution tombstones. */
	purgeMappings(): void {
		for (const key of this.mappingKeys()) this.mutate([{ key, value: null }]);
		this.use((db) => {
			db.prepare('DELETE FROM responses').run();
		});
	}
}
