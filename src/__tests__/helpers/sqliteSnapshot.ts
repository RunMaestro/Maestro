/** Bounded SQL comparisons: retain hashes, never BLOBs or assertion-inspect payloads. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson } from '../../shared/canonicalJson';

/** Only call for a declared BLOB column; numeric-key JSON objects are not metadata. */
export function sqliteBlobDigest(value: unknown): string {
	const digest = createHash('sha256');
	if (ArrayBuffer.isView(value)) {
		digest.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	} else {
		const object = value as { type?: string; data?: unknown; [key: string]: unknown } | null;
		const bytes = object?.type === 'Buffer' ? object.data : value;
		if (!bytes || typeof bytes !== 'object') throw new TypeError('Invalid BLOB representation');
		const length = Array.isArray(bytes) ? bytes.length : Object.keys(bytes).length;
		const chunk = new Uint8Array(4096);
		for (let offset = 0; offset < length; offset += chunk.length) {
			const size = Math.min(chunk.length, length - offset);
			for (let index = 0; index < size; index++) {
				const byte = (bytes as Record<number, unknown>)[offset + index];
				if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)
					throw new TypeError('Invalid BLOB byte');
				chunk[index] = byte;
			}
			digest.update(chunk.subarray(0, size));
		}
	}
	return digest.digest('hex');
}

type TableDigest = {
	count: number;
	schema: string;
	sha256: string;
	rows: Record<string, Record<string, string>>;
};
export type SqliteSnapshot = Record<string, TableDigest>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

/** SQL iterators release each raw row before the next; keys and columns hold digests only. */
export function snapshotSqlite(db: Database.Database): SqliteSnapshot {
	return db.transaction(() => {
		const snapshot: SqliteSnapshot = {};
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		for (const { name } of tables) {
			const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all() as {
				name: string;
				type: string;
				pk: number;
			}[];
			const keys = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
			const order = keys.length ? keys.map((key) => quote(key.name)).join(',') : 'rowid';
			const schema = hash(canonicalJson(columns));
			const table: TableDigest = { count: 0, schema, sha256: '', rows: {} };
			const digest = createHash('sha256');
			digest.update(schema);
			for (const row of db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${order}`).iterate()) {
				const values = row as Record<string, unknown>;
				const key = hash(
					canonicalJson(keys.length ? keys.map((key) => values[key.name]) : table.count)
				);
				const cells = Object.fromEntries(
					columns.map((column) => {
						const value = values[column.name];
						return [
							column.name,
							column.type.toUpperCase() === 'BLOB' && value !== null
								? sqliteBlobDigest(value)
								: hash(typeof value === 'string' ? `string:${value}` : canonicalJson(value)),
						];
					})
				);
				table.rows[key] = cells;
				digest.update(canonicalJson({ key, cells }));
				table.count++;
			}
			table.sha256 = digest.digest('hex');
			snapshot[name] = table;
		}
		return snapshot;
	})();
}

/** Never return source values. A failed assertion can print at most 20 short locations. */
export function compareSqliteSnapshots(before: SqliteSnapshot, after: SqliteSnapshot): string[] {
	const differences: string[] = [];
	for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
		const a = before[name];
		const b = after[name];
		if (a?.count === b?.count && a?.sha256 === b?.sha256) continue;
		if (a?.schema !== b?.schema) differences.push(`${name.slice(0, 60)}: schema`);
		if (differences.length === 20) return differences;
		if (!a || !b || a.count !== b.count) differences.push(`${name.slice(0, 60)}: row count`);
		if (differences.length === 20) return differences;
		for (const key of new Set([...Object.keys(a?.rows ?? {}), ...Object.keys(b?.rows ?? {})])) {
			const left = a?.rows[key] ?? {};
			const right = b?.rows[key] ?? {};
			for (const column of new Set([...Object.keys(left), ...Object.keys(right)])) {
				if (left[column] !== right[column])
					differences.push(`${name.slice(0, 60)}:${key.slice(0, 16)}:${column.slice(0, 60)}`);
				if (differences.length === 20) return differences;
			}
		}
	}
	return differences;
}
