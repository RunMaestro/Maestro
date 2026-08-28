/**
 * Parquet File Handles
 *
 * Owns the open-file side of the parquet preview: one long-lived positional
 * reader per previewed file, its footer metadata, and the schema summary the
 * renderer needs before it asks for a single row.
 *
 * The file itself never crosses IPC. A parquet file routinely outgrows RAM,
 * and the whole reason the format exists is that you can answer a question by
 * reading a few kilobytes of footer plus the specific column chunks involved.
 * Reading a 4 GB file into a string to hand the renderer a "preview" would
 * throw that away twice over.
 *
 * hyparquet is loaded lazily. It is ESM-only and about 150 KB of parser, and
 * most sessions never open a parquet file, so the cost is deferred to the
 * first preview rather than paid at every app launch.
 */

import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import os from 'os';
import path from 'path';

import type { AsyncBuffer, Compressors, FileMetaData, SchemaTree } from 'hyparquet';

import type {
	ParquetColumnInfo,
	ParquetColumnStats,
	ParquetFileInfo,
	ParquetPhysicalType,
	ParquetValueKind,
} from '../../shared/parquet/types';
import { isParquetFile } from '../../shared/parquet/preview';
import { getSshRemoteById } from '../stores/getters';
import { readBinaryFileRemoteAsBase64, statRemote } from '../utils/remote-fs';

/**
 * Largest remote file the SSH path will pull down.
 *
 * Remote reads go through `base64` over the SSH text channel, which means the
 * whole file materializes in main-process memory twice on the way to disk.
 * Refusing loudly above this beats an opaque out-of-memory crash, and the
 * message tells the user the one thing that actually helps: copy it locally.
 */
const MAX_REMOTE_BYTES = 512 * 1024 * 1024;

/** Handles idle longer than this are closed to release their file descriptor. */
const HANDLE_IDLE_MS = 15 * 60 * 1000;

/** The `ARROW:schema` blob is a base64 IPC message, useless and huge in a UI. */
const NOISY_METADATA_KEYS = new Set(['ARROW:schema']);

/** Longest key/value metadata value forwarded to the renderer. */
const MAX_METADATA_VALUE_CHARS = 2000;

type HyparquetModule = typeof import('hyparquet');

let hyparquetPromise: Promise<{ hyparquet: HyparquetModule; compressors: Compressors }> | null =
	null;

/**
 * Load hyparquet and its extra codecs once, on first use.
 *
 * Snappy ships inside hyparquet because it is what virtually every writer
 * emits; gzip, brotli, zstd, and lz4 come from the companion package so a file
 * written by a non-default pipeline still opens.
 */
export function loadParquetReader(): Promise<{
	hyparquet: HyparquetModule;
	compressors: Compressors;
}> {
	hyparquetPromise ??= (async () => {
		const [hyparquet, compressorModule] = await Promise.all([
			import('hyparquet'),
			import('hyparquet-compressors'),
		]);
		return { hyparquet, compressors: compressorModule.compressors as Compressors };
	})();
	return hyparquetPromise;
}

/**
 * An `AsyncBuffer` over an open file descriptor that counts what it reads.
 *
 * The byte counter is not instrumentation for its own sake: it is how the
 * engine reports pruning honestly. hyparquet decides internally which column
 * chunks and pages to fetch, so the only truthful measure of "how much of this
 * file did that filter actually touch" is the bytes that crossed this
 * boundary.
 */
export interface CountingAsyncBuffer extends AsyncBuffer {
	/** Total bytes read through this buffer since it was opened. */
	readonly bytesRead: number;
	/** Snapshot the counter, for measuring a single scan step. */
	mark(): number;
}

function createCountingAsyncBuffer(handle: FileHandle, byteLength: number): CountingAsyncBuffer {
	let bytesRead = 0;
	return {
		byteLength,
		get bytesRead() {
			return bytesRead;
		},
		mark() {
			return bytesRead;
		},
		async slice(start: number, end?: number): Promise<ArrayBuffer> {
			const from = Math.max(0, Math.min(start, byteLength));
			const to = Math.max(from, Math.min(end ?? byteLength, byteLength));
			const length = to - from;
			if (length === 0) return new ArrayBuffer(0);
			const buffer = Buffer.allocUnsafe(length);
			let filled = 0;
			// A positional read can come back short on large requests, so loop
			// until the slice is complete rather than trusting one call.
			while (filled < length) {
				const { bytesRead: read } = await handle.read(
					buffer,
					filled,
					length - filled,
					from + filled
				);
				if (read <= 0) break;
				filled += read;
			}
			bytesRead += filled;
			// Copy into a fresh ArrayBuffer rather than handing back a view of
			// Buffer's pooled one. Two reasons: the pool is shared, so a raw
			// view would alias unrelated data, and the reader checks
			// `instanceof ArrayBuffer` - which fails across JS realms, exactly
			// what a Buffer-backed ArrayBuffer hits under a jsdom test env.
			const out = new ArrayBuffer(filled);
			new Uint8Array(out).set(buffer.subarray(0, filled));
			return out;
		},
	};
}

/** One open parquet file, shared by every query against it. */
export interface OpenParquetFile {
	id: string;
	/** Path as the user knows it (remote path when the file came over SSH). */
	displayPath: string;
	/** Path actually being read - a temp copy for remote files. */
	localPath: string;
	sshRemoteId?: string;
	/** True when `localPath` is a downloaded copy this module must clean up. */
	isTempCopy: boolean;
	fileHandle: FileHandle;
	buffer: CountingAsyncBuffer;
	metadata: FileMetaData;
	info: ParquetFileInfo;
	compressors: Compressors;
	/** Modification time at open, used to detect the file changing underneath. */
	mtimeMs: number;
	lastUsedAt: number;
	/** Cached scan sessions, owned by parquet-query.ts. */
	scans: Map<string, unknown>;
}

const openFiles = new Map<string, OpenParquetFile>();
let reaperTimer: NodeJS.Timeout | null = null;

/** Close handles nobody has touched in a while so descriptors are not leaked. */
function startReaper(): void {
	if (reaperTimer) return;
	reaperTimer = setInterval(() => {
		const now = Date.now();
		for (const [id, file] of openFiles) {
			if (now - file.lastUsedAt > HANDLE_IDLE_MS) void closeParquetFile(id);
		}
		if (openFiles.size === 0 && reaperTimer) {
			clearInterval(reaperTimer);
			reaperTimer = null;
		}
	}, HANDLE_IDLE_MS);
	// An interval that keeps the event loop alive would delay app quit for as
	// long as the idle window.
	reaperTimer.unref?.();
}

// ─── Schema description ───────────────────────────────────────────────────────

/** Map a parquet schema element onto the coarse kind the viewer reasons about. */
function classifyColumn(element: SchemaTree['element'], nested: boolean): ParquetValueKind {
	if (nested) return 'json';
	const logical = element.logical_type;
	if (logical) {
		switch (logical.type) {
			case 'STRING':
			case 'ENUM':
			case 'UUID':
				return 'string';
			case 'JSON':
			case 'BSON':
			case 'VARIANT':
			case 'GEOMETRY':
			case 'GEOGRAPHY':
				return 'json';
			case 'DECIMAL':
				return 'decimal';
			case 'DATE':
				return 'date';
			case 'TIME':
				return 'time';
			case 'TIMESTAMP':
				return 'timestamp';
			case 'INTEGER':
				return 'integer';
			case 'FLOAT16':
				return 'float';
		}
	}
	switch (element.converted_type) {
		case 'UTF8':
		case 'ENUM':
			return 'string';
		case 'JSON':
		case 'BSON':
			return 'json';
		case 'DECIMAL':
			return 'decimal';
		case 'DATE':
			return 'date';
		case 'TIME_MILLIS':
		case 'TIME_MICROS':
			return 'time';
		case 'TIMESTAMP_MILLIS':
		case 'TIMESTAMP_MICROS':
			return 'timestamp';
	}
	switch (element.type) {
		case 'BOOLEAN':
			return 'boolean';
		case 'INT32':
		case 'INT64':
			return 'integer';
		case 'INT96':
			// INT96 exists only as a legacy nanosecond timestamp.
			return 'timestamp';
		case 'FLOAT':
		case 'DOUBLE':
			return 'float';
		case 'BYTE_ARRAY':
		case 'FIXED_LEN_BYTE_ARRAY':
			// An un-annotated byte array is decoded as UTF-8 by default, so it
			// behaves as a string everywhere except when it really is not one.
			return 'string';
		default:
			return 'string';
	}
}

/** Human-readable logical type name for the schema panel. */
function describeLogicalType(element: SchemaTree['element']): string | null {
	const logical = element.logical_type;
	if (logical) {
		if (logical.type === 'DECIMAL') return `DECIMAL(${logical.precision},${logical.scale})`;
		if (logical.type === 'TIMESTAMP')
			return `TIMESTAMP(${logical.unit}${logical.isAdjustedToUTC ? ', UTC' : ''})`;
		if (logical.type === 'TIME') return `TIME(${logical.unit})`;
		if (logical.type === 'INTEGER')
			return `INT${logical.bitWidth}${logical.isSigned ? '' : ' unsigned'}`;
		return logical.type;
	}
	return element.converted_type ?? null;
}

/** Timestamp/time resolution, needed to compile filter literals for pushdown. */
function resolveTimeUnit(
	element: SchemaTree['element']
): 'MILLIS' | 'MICROS' | 'NANOS' | undefined {
	const logical = element.logical_type;
	if (logical && (logical.type === 'TIMESTAMP' || logical.type === 'TIME')) return logical.unit;
	switch (element.converted_type) {
		case 'TIMESTAMP_MILLIS':
		case 'TIME_MILLIS':
			return 'MILLIS';
		case 'TIMESTAMP_MICROS':
		case 'TIME_MICROS':
			return 'MICROS';
		default:
			return undefined;
	}
}

/**
 * Convert a statistics bound from its physical form into the wire form the
 * schema panel displays.
 *
 * Statistics are stored exactly as written, so a MICROS timestamp bound is a
 * raw microsecond integer and a DATE bound is a day count. This is display
 * only - the pushdown compiler deliberately works the other way, in the
 * physical domain, because that is the domain the bounds are compared in.
 */
function statValueToWire(
	value: unknown,
	kind: ParquetValueKind,
	timeUnit: 'MILLIS' | 'MICROS' | 'NANOS' | undefined
): string | number | boolean | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.getTime();
	if (ArrayBuffer.isView(value)) {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		let hex = '';
		for (const byte of bytes.subarray(0, 16)) hex += byte.toString(16).padStart(2, '0');
		return bytes.length > 16 ? `${hex}…` : hex;
	}
	if (typeof value === 'bigint') {
		if (kind === 'timestamp') {
			const perMs = timeUnit === 'MICROS' ? 1_000n : timeUnit === 'NANOS' ? 1_000_000n : 1n;
			return Number(value / perMs);
		}
		const asNumber = Number(value);
		return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
	}
	if (typeof value === 'number') {
		if (kind === 'date') return value * 86_400_000;
		return value;
	}
	if (typeof value === 'string' || typeof value === 'boolean') return value;
	return String(value);
}

/**
 * Fold per-row-group column chunk metadata into one summary per column.
 *
 * Every number here comes from the footer, so this is O(row groups) and costs
 * nothing even on a file with thousands of them.
 */
function describeColumns(metadata: FileMetaData, schema: SchemaTree): ParquetColumnInfo[] {
	const columns: ParquetColumnInfo[] = [];

	for (const child of schema.children) {
		const nested = child.children.length > 0;
		const element = child.element;
		const kind = classifyColumn(element, nested);
		const timeUnit = resolveTimeUnit(element);
		const stats: ParquetColumnStats = { nullCount: 0, min: null, max: null, partial: false };

		let compressedBytes = 0;
		let uncompressedBytes = 0;
		let compression: string | null = null;
		let minRaw: unknown;
		let maxRaw: unknown;
		let sawStats = false;

		for (const rowGroup of metadata.row_groups) {
			// A nested column occupies several leaf chunks; sum them all so the
			// size figures describe the whole column as the user sees it.
			const chunks = rowGroup.columns.filter(
				(chunk) => chunk.meta_data?.path_in_schema[0] === element.name
			);
			if (chunks.length === 0) {
				stats.partial = true;
				continue;
			}
			for (const chunk of chunks) {
				const meta = chunk.meta_data;
				if (!meta) continue;
				compressedBytes += Number(meta.total_compressed_size);
				uncompressedBytes += Number(meta.total_uncompressed_size);
				compression ??= meta.codec;
			}

			// Min/max only mean anything for a single-leaf (i.e. flat) column.
			const statistics = chunks.length === 1 ? chunks[0].meta_data?.statistics : undefined;
			if (!statistics) {
				stats.partial = true;
				continue;
			}
			if (statistics.null_count !== undefined && stats.nullCount !== null) {
				stats.nullCount += Number(statistics.null_count);
			} else {
				stats.nullCount = null;
			}
			const min = statistics.min_value ?? statistics.min;
			const max = statistics.max_value ?? statistics.max;
			if (min === undefined || max === undefined) {
				stats.partial = true;
				continue;
			}
			sawStats = true;
			if (minRaw === undefined || compareRaw(min, minRaw) < 0) minRaw = min;
			if (maxRaw === undefined || compareRaw(max, maxRaw) > 0) maxRaw = max;
		}

		if (sawStats) {
			stats.min = statValueToWire(minRaw, kind, timeUnit);
			stats.max = statValueToWire(maxRaw, kind, timeUnit);
		}

		columns.push({
			name: element.name,
			physicalType: (element.type as ParquetPhysicalType | undefined) ?? null,
			logicalType: describeLogicalType(element),
			kind,
			...(timeUnit ? { timeUnit } : {}),
			optional: element.repetition_type !== 'REQUIRED',
			nested,
			compression,
			compressedBytes,
			uncompressedBytes,
			stats,
		});
	}

	return columns;
}

/** Ordering for raw statistics bounds while folding row groups together. */
function compareRaw(a: unknown, b: unknown): number {
	if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
	if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) return 0;
	if (typeof a === 'bigint' || typeof b === 'bigint') {
		if (typeof a === 'string' || typeof b === 'string') return String(a) < String(b) ? -1 : 1;
		const left = a as bigint | number;
		const right = b as bigint | number;
		return left < right ? -1 : left > right ? 1 : 0;
	}
	if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
	return 0;
}

// ─── Opening ──────────────────────────────────────────────────────────────────

/**
 * Pull a remote parquet file into a local cache directory.
 *
 * The cache key is the remote path plus its size and mtime, so re-opening the
 * same unchanged file is free and an updated one is re-fetched. There is no
 * SSH byte-range server, so a remote parquet file has to become a local one
 * before any of the format's random access applies.
 */
async function materializeRemoteFile(remotePath: string, sshRemoteId: string): Promise<string> {
	const sshConfig = getSshRemoteById(sshRemoteId);
	if (!sshConfig) throw new Error(`SSH remote not found: ${sshRemoteId}`);

	const remoteStat = await statRemote(remotePath, sshConfig);
	const remoteSize = remoteStat.success ? (remoteStat.data?.size ?? 0) : 0;
	if (remoteSize > MAX_REMOTE_BYTES) {
		throw new Error(
			`Remote parquet file is ${Math.round(remoteSize / (1024 * 1024))} MB. ` +
				`Maestro fetches remote files whole (there is no byte-range channel over SSH), ` +
				`so open files above ${MAX_REMOTE_BYTES / (1024 * 1024)} MB by copying them locally first.`
		);
	}

	const cacheDir = path.join(os.tmpdir(), 'maestro-parquet-cache');
	await fs.mkdir(cacheDir, { recursive: true });
	const key = createHash('sha256')
		.update(`${sshRemoteId}:${remotePath}:${remoteSize}:${remoteStat.data?.mtime ?? ''}`)
		.digest('hex')
		.slice(0, 32);
	const localPath = path.join(cacheDir, `${key}.parquet`);

	const existing = await fs.stat(localPath).catch(() => null);
	if (existing?.isFile() && (remoteSize === 0 || existing.size === remoteSize)) return localPath;

	const result = await readBinaryFileRemoteAsBase64(remotePath, sshConfig);
	if (!result.success)
		throw new Error(result.error || `Failed to fetch remote parquet file: ${remotePath}`);
	await fs.writeFile(localPath, Buffer.from(result.data ?? '', 'base64'));
	return localPath;
}

/**
 * Open a parquet file and read its footer.
 *
 * Re-opens the same path when the file has changed on disk, so a tab left open
 * while a pipeline rewrites the file picks up the new data instead of decoding
 * pages at offsets that no longer mean anything.
 */
export async function openParquetFile(
	filePath: string,
	sshRemoteId?: string
): Promise<ParquetFileInfo> {
	if (!isParquetFile(filePath)) throw new Error(`Not a parquet file: ${filePath}`);

	const localPath = sshRemoteId ? await materializeRemoteFile(filePath, sshRemoteId) : filePath;
	const stat = await fs.stat(localPath);
	if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);

	for (const file of openFiles.values()) {
		if (
			file.displayPath === filePath &&
			file.sshRemoteId === sshRemoteId &&
			file.mtimeMs === stat.mtimeMs
		) {
			file.lastUsedAt = Date.now();
			return file.info;
		}
	}

	const { hyparquet, compressors } = await loadParquetReader();
	const fileHandle = await fs.open(localPath, 'r');

	try {
		const buffer = createCountingAsyncBuffer(fileHandle, stat.size);
		const metadata = await hyparquet.parquetMetadataAsync(buffer);
		const schema = hyparquet.parquetSchema(metadata);

		const id = randomUUID();
		const info: ParquetFileInfo = {
			handle: id,
			displayPath: filePath,
			fileBytes: stat.size,
			totalRows: Number(metadata.num_rows),
			columns: describeColumns(metadata, schema),
			rowGroups: metadata.row_groups.map((group) => ({
				rows: Number(group.num_rows),
				compressedBytes: Number(group.total_compressed_size ?? group.total_byte_size),
			})),
			createdBy: metadata.created_by ?? null,
			formatVersion: metadata.version,
			keyValueMetadata: (metadata.key_value_metadata ?? [])
				.filter((entry) => !NOISY_METADATA_KEYS.has(entry.key))
				.map((entry) => ({
					key: entry.key,
					value: (entry.value ?? '').slice(0, MAX_METADATA_VALUE_CHARS),
				})),
			...(sshRemoteId ? { fetchedFromRemote: true } : {}),
		};

		openFiles.set(id, {
			id,
			displayPath: filePath,
			localPath,
			...(sshRemoteId ? { sshRemoteId } : {}),
			isTempCopy: Boolean(sshRemoteId),
			fileHandle,
			buffer,
			metadata,
			info,
			compressors,
			mtimeMs: stat.mtimeMs,
			lastUsedAt: Date.now(),
			scans: new Map(),
		});
		startReaper();
		return info;
	} catch (error) {
		await fileHandle.close().catch(() => undefined);
		throw error;
	}
}

/** Look up an open handle, refreshing its idle timer. */
export function getParquetFile(handle: string): OpenParquetFile {
	const file = openFiles.get(handle);
	if (!file) throw new Error('Parquet file handle is no longer open. Reopen the file to continue.');
	file.lastUsedAt = Date.now();
	return file;
}

/** Close a handle and drop its cached scans. Safe to call more than once. */
export async function closeParquetFile(handle: string): Promise<void> {
	const file = openFiles.get(handle);
	if (!file) return;
	openFiles.delete(handle);
	file.scans.clear();
	await file.fileHandle.close().catch(() => undefined);
}

/** Close every handle. Called on app quit. */
export async function closeAllParquetFiles(): Promise<void> {
	await Promise.all([...openFiles.keys()].map((handle) => closeParquetFile(handle)));
	if (reaperTimer) {
		clearInterval(reaperTimer);
		reaperTimer = null;
	}
}

/** Test seam: how many handles are currently open. */
export function openParquetFileCount(): number {
	return openFiles.size;
}
