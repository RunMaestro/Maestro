import { describe, it, expect } from 'vitest';

import { buildParquetPreviewMarker, isParquetPreviewMarker } from '../../../shared/parquet/preview';
import {
	buildSqlitePreviewMarker,
	hasSqliteHeader,
	isSqliteCandidateFile,
	isSqlitePreviewMarker,
	parseSqlitePreviewMarker,
	SQLITE_HEADER_LENGTH,
	SQLITE_HEADER_MAGIC,
	SQLITE_SCHEME,
} from '../../../shared/sqlite/preview';

const MAGIC = new TextEncoder().encode('SQLite format 3\0');

describe('SQLITE_HEADER_MAGIC', () => {
	it('is the 16-byte string from the SQLite file format spec', () => {
		expect(SQLITE_HEADER_LENGTH).toBe(16);
		expect(Array.from(SQLITE_HEADER_MAGIC)).toEqual(Array.from(MAGIC));
	});
});

describe('hasSqliteHeader', () => {
	it('accepts the exact magic', () => {
		expect(hasSqliteHeader(MAGIC)).toBe(true);
	});

	it('accepts the magic followed by the rest of a database header', () => {
		const page = new Uint8Array(100);
		page.set(MAGIC, 0);
		page[16] = 0x10; // page size 4096, high byte
		expect(hasSqliteHeader(page)).toBe(true);
	});

	it('accepts a Node Buffer', () => {
		expect(hasSqliteHeader(Buffer.from('SQLite format 3\0extra', 'latin1'))).toBe(true);
	});

	it('rejects an empty or truncated header', () => {
		expect(hasSqliteHeader(new Uint8Array(0))).toBe(false);
		expect(hasSqliteHeader(MAGIC.subarray(0, 15))).toBe(false);
	});

	it('rejects the text without its trailing NUL', () => {
		expect(hasSqliteHeader(new TextEncoder().encode('SQLite format 3 '))).toBe(false);
	});

	it('rejects SQLite 2 and other formats that share the extension', () => {
		// SQLite 2 databases start "** This file contains an SQLite 2.1 database **".
		expect(hasSqliteHeader(new TextEncoder().encode('** This file contains an SQLite 2'))).toBe(
			false
		);
		// Berkeley DB btree magic sits at offset 12, so the first bytes are page data.
		expect(hasSqliteHeader(new Uint8Array(16).fill(0))).toBe(false);
	});

	it('rejects random bytes, as a SQLCipher file reads', () => {
		const encrypted = new Uint8Array(16);
		for (let i = 0; i < encrypted.length; i++) encrypted[i] = (i * 73 + 41) & 0xff;
		expect(hasSqliteHeader(encrypted)).toBe(false);
	});
});

describe('isSqliteCandidateFile', () => {
	it('recognizes the common SQLite extensions, case-insensitively', () => {
		for (const name of [
			'app.db',
			'app.DB',
			'app.db3',
			'app.sqlite',
			'app.sqlite3',
			'a.s3db',
			'a.sl3',
		]) {
			expect(isSqliteCandidateFile(`/data/${name}`)).toBe(true);
		}
	});

	it('handles Windows separators', () => {
		expect(isSqliteCandidateFile('C:\\data\\app.sqlite')).toBe(true);
	});

	it('ignores an extension that only appears in a parent directory', () => {
		expect(isSqliteCandidateFile('/data/app.db/LOCK')).toBe(false);
	});

	it('ignores sidecars and unrelated files', () => {
		expect(isSqliteCandidateFile('/data/app.db-wal')).toBe(false);
		expect(isSqliteCandidateFile('/data/app.db-shm')).toBe(false);
		expect(isSqliteCandidateFile('/data/app.db-journal')).toBe(false);
		expect(isSqliteCandidateFile('/data/notes.md')).toBe(false);
		expect(isSqliteCandidateFile('/data/.db')).toBe(false);
	});
});

describe('SQLite preview marker', () => {
	it('round-trips the path through its own scheme', () => {
		const marker = buildSqlitePreviewMarker('/data/app.db');
		expect(marker.startsWith(`${SQLITE_SCHEME}://preview/`)).toBe(true);
		expect(isSqlitePreviewMarker(marker)).toBe(true);
		expect(parseSqlitePreviewMarker(marker)).toBe('/data/app.db');
	});

	it('keeps Unicode and URL-hostile filenames intact', () => {
		const path = '/data/naïve #1 ?50% 数据.sqlite';
		expect(parseSqlitePreviewMarker(buildSqlitePreviewMarker(path))).toBe(path);
	});

	it('is never confused with the parquet marker', () => {
		// Each viewer must only ever be handed its own format's marker.
		const parquet = buildParquetPreviewMarker('/data/app.db');
		expect(isSqlitePreviewMarker(parquet)).toBe(false);
		expect(parseSqlitePreviewMarker(parquet)).toBeNull();
		expect(isParquetPreviewMarker(buildSqlitePreviewMarker('/data/app.db'))).toBe(false);
	});

	it('rejects non-markers and malformed payloads', () => {
		expect(isSqlitePreviewMarker('SQLite format 3\0')).toBe(false);
		expect(isSqlitePreviewMarker(null)).toBe(false);
		expect(isSqlitePreviewMarker(undefined)).toBe(false);
		expect(parseSqlitePreviewMarker(`${SQLITE_SCHEME}://preview/zz`)).toBeNull();
	});
});
