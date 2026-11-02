/** Independent Cue receipts. SQLite/keyring work is hosted in a bounded worker. */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import type { AnchorStore } from '../utils/keyring-anchor';
import { HostReceiptLedger } from '../plugins/host-receipt-ledger';
import { installCueReceiptReaderFloor, CUE_RECEIPT_READER_VERSION } from './cue-receipt-schema';
import type { AuthIdentity } from '../plugins/authorization-ledger';
import type { PluginEventReceiptRow } from '../plugins/plugin-cue-events';

export interface CueReceiptBaseline {
	rows: { key: string; row: PluginEventReceiptRow; identity?: AuthIdentity }[];
	/** Authenticated retained contents only; does not assert pre-cutover completeness. */
	coverage: 'retained-authenticated-only';
}
export interface CueStoredReceipt {
	receiptOwner: string;
	receipt: PluginEventReceiptRow;
	phase: 'reserved' | 'dispatching' | 'accepted';
	attempt: string;
	outcomeReservation: boolean;
	execution?: { owner: string; runId: string };
	result?: { success: boolean; response: null; sessionId?: null };
}
interface Cutover {
	receiptControl: true;
	reader: number;
	coverage: CueReceiptBaseline['coverage'];
	digest: string;
	identities: AuthIdentity[];
	phase: 'prepared' | 'stable';
	controlFinal?: true;
}

export class CueReceiptLedger {
	private readonly ledger: HostReceiptLedger;
	constructor(
		baseDir: string,
		private readonly cueDbPath: string,
		anchor: AnchorStore,
		limits: { messages?: number; ownerMessages?: number; pages?: number } = {}
	) {
		if (
			!fs.existsSync(path.join(baseDir, 'receipts.sqlite')) &&
			anchor.available() &&
			!anchor.read() &&
			fs.existsSync(cueDbPath)
		) {
			const stat = fs.lstatSync(cueDbPath);
			if (!stat.isFile() || stat.isSymbolicLink())
				throw Error('Cue receipt path is not a regular file');
			const previous = new Database(cueDbPath, { readonly: true, fileMustExist: true });
			try {
				if (
					previous
						.prepare("SELECT 1 FROM sqlite_master WHERE name='cue_plugin_receipts' AND type='view'")
						.get()
				)
					throw Error('Cue independent receipt checkpoint was removed; explicit recovery required');
			} finally {
				previous.close();
			}
		}
		this.ledger = new HostReceiptLedger(baseDir, anchor, {
			messages: 100_000,
			ownerMessages: 4096,
			...limits,
		});
	}
	private key(pluginId: string, key: string): string {
		return (
			'cue:' +
			createHash('sha256')
				.update(canonicalJson([pluginId, key]))
				.digest('hex')
		);
	}
	private manifestKey(pluginId: string): string {
		return this.key(pluginId, 'cutover');
	}
	private floor(): void {
		for (const candidate of [
			this.cueDbPath,
			this.cueDbPath + '-wal',
			this.cueDbPath + '-shm',
			this.cueDbPath + '-journal',
		]) {
			try {
				const stat = fs.lstatSync(candidate);
				if (!stat.isFile() || stat.isSymbolicLink())
					throw Error('Cue receipt path is not a regular file');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		}
		const db = new Database(this.cueDbPath, { fileMustExist: true, timeout: 5000 });
		try {
			installCueReceiptReaderFloor(db);
		} finally {
			db.close();
		}
	}
	private cutover(pluginId: string): Cutover | null {
		const value = this.ledger.get(this.manifestKey(pluginId));
		const parsed = value ? (JSON.parse(value) as Cutover) : null;
		if (parsed && parsed.reader !== CUE_RECEIPT_READER_VERSION)
			throw Error('Cue receipt reader version unsupported');
		return parsed;
	}
	transitionState(pluginId: string): Cutover | null {
		return this.cutover(pluginId);
	}
	prepare(pluginId: string, baseline: CueReceiptBaseline): void {
		if (baseline.coverage !== 'retained-authenticated-only' || baseline.rows.length > 4096)
			throw Error('Cue receipt baseline unavailable');
		const sorted = [...baseline.rows].sort((a, b) => a.key.localeCompare(b.key));
		if (new Set(sorted.map((r) => r.key)).size !== sorted.length)
			throw Error('Cue receipt baseline conflict');
		const digest = createHash('sha256').update(canonicalJson(sorted)).digest('hex');
		const identities = [
			...new Map(
				sorted.flatMap((r) =>
					r.identity ? [[canonicalJson(r.identity), r.identity] as const] : []
				)
			).values(),
		];
		if (identities.length > 128) throw Error('Cue historical identity capacity reached');
		const manifestKey = this.manifestKey(pluginId);
		let before = this.ledger.get(manifestKey);
		if (before) {
			const existing = this.cutover(pluginId)!;
			if (existing.phase === 'stable') {
				this.floor();
				return;
			}
			if (existing.digest !== digest) throw Error('Cue prepared history changed before cutover');
		} else {
			const prepared: Cutover = {
				receiptControl: true,
				reader: CUE_RECEIPT_READER_VERSION,
				coverage: baseline.coverage,
				digest,
				identities,
				phase: 'prepared',
			};
			this.ledger.compareAndSet(manifestKey, null, JSON.stringify(prepared));
			before = JSON.stringify(prepared);
		}
		for (const item of sorted) {
			const key = this.key(pluginId, item.key);
			const stored = JSON.stringify({
				receiptOwner: pluginId,
				receipt: item.row,
				historicalIdentity: item.identity,
				phase: 'accepted',
				attempt: 'historical',
				outcomeReservation: false,
				result: { success: true, response: null, sessionId: null },
			});
			const existing = this.ledger.get(key);
			if (existing) {
				if (canonicalJson(JSON.parse(existing)) !== canonicalJson(JSON.parse(stored)))
					throw Error('Cue historical receipt conflict');
			} else this.ledger.compareAndSet(key, null, stored);
		}
		// Native checkpoint first, guarded Cue schema second, final readiness ACK last.
		this.floor();
		const stable: Cutover = { ...JSON.parse(before!), phase: 'stable', controlFinal: true };
		this.ledger.compareAndSet(manifestKey, before, JSON.stringify(stable));
	}
	ready(pluginId: string): void {
		if (this.cutover(pluginId)?.phase !== 'stable')
			throw Error('Cue authenticated cutover is not ready');
		this.floor();
	}
	read(pluginId: string, key: string): CueStoredReceipt | null {
		this.ready(pluginId);
		const value = this.ledger.get(this.key(pluginId, key));
		return value ? (JSON.parse(value) as CueStoredReceipt) : null;
	}
	historical(pluginId: string, keys: string[]): { key: string; value: unknown }[] {
		if (keys.length > 128) throw Error('Cue historical lookup limit');
		this.ready(pluginId);
		return keys.flatMap((key) => {
			const value = this.ledger.get(this.key(pluginId, key));
			return value ? [{ key, value: JSON.parse(value) }] : [];
		});
	}
	reserve(pluginId: string, key: string, receipt: PluginEventReceiptRow, attempt: string): void {
		this.ready(pluginId);
		const value: CueStoredReceipt = {
			receiptOwner: pluginId,
			receipt,
			phase: 'reserved',
			attempt,
			outcomeReservation: true,
		};
		this.ledger.compareAndSet(this.key(pluginId, key), null, JSON.stringify(value));
	}
	private change(
		pluginId: string,
		key: string,
		update: (row: CueStoredReceipt) => CueStoredReceipt | null
	): void {
		this.ready(pluginId);
		const actualKey = this.key(pluginId, key),
			before = this.ledger.get(actualKey);
		if (!before) throw Error('Cue receipt admission missing');
		const row = update(JSON.parse(before));
		this.ledger.compareAndSet(actualKey, before, row ? JSON.stringify(row) : null);
	}
	dispatch(pluginId: string, key: string, attempt: string): void {
		this.change(pluginId, key, (row) => {
			if (row.attempt !== attempt || row.phase !== 'reserved' || row.execution || row.result)
				throw Error('Cue dispatch admission changed');
			return { ...row, phase: 'dispatching' };
		});
	}
	accepted(pluginId: string, key: string, attempt: string, filtered = false): void {
		this.change(pluginId, key, (row) => {
			if (row.attempt !== attempt || row.phase === 'reserved')
				throw Error('Cue publish admission changed');
			if (row.result) return row;
			return {
				...row,
				phase: 'accepted',
				...(filtered
					? { outcomeReservation: false, result: { success: true, response: null } }
					: {}),
			};
		});
	}
	cancelPublish(pluginId: string, key: string, attempt: string): void {
		this.change(pluginId, key, (row) => {
			if (row.attempt !== attempt || row.execution || row.result)
				throw Error('Cue cancellation cannot reopen uncertain execution');
			return null;
		});
	}
	claim(pluginId: string, key: string, receiptId: string, owner: string, runId: string): boolean {
		let claimed = false;
		this.change(pluginId, key, (row) => {
			if (row.receipt.receiptId !== receiptId || row.phase === 'reserved' || row.result) return row;
			if (row.execution) {
				claimed = row.execution.owner === owner && row.execution.runId === runId;
				return row;
			}
			claimed = true;
			// The durable execution claim itself is the complete replay fence. Cue stores
			// no response body or provider binding after this boundary. Releasing the
			// physical outcome allowance cannot reopen it, even if finalization fails.
			return { ...row, execution: { owner, runId }, outcomeReservation: false };
		});
		return claimed;
	}
	settle(
		pluginId: string,
		key: string,
		receiptId: string,
		owner: string,
		runId: string,
		started: boolean
	): void {
		this.change(pluginId, key, (row) => {
			if (
				row.receipt.receiptId !== receiptId ||
				row.execution?.owner !== owner ||
				row.execution.runId !== runId
			)
				throw Error('Cue execution owner changed');
			if (row.result) return row;
			if (!started) return null;
			return {
				...row,
				phase: 'accepted',
				outcomeReservation: false,
				result: { success: true, response: null, sessionId: null },
			};
		});
	}
}
