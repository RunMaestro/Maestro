/**
 * @vitest-environment node
 *
 * The proxy request writer (`recordProxyRequest`) against a real SQLite engine
 * and the real `proxy_requests` table, built by the real migrations.
 *
 * `proxy-requests.test.ts` pins the order of the bound values against a fake
 * statement. This file pins the thing that order is for: each fact lands in the
 * column that is named for it, a fact the request does not state is NULL (which
 * every reader takes as unknown), and the INSERT fills every column the table
 * has, so a column added to the schema cannot be left empty by the writer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations } from '../../../main/stats/migrations';
import {
	clearProxyRequestsCache,
	getProxyRequestUsage,
	recordProxyRequest,
} from '../../../main/stats/proxy-requests';
import { ADD_PROXY_REQUEST_TELEMETRY_COLUMNS } from '../../../main/stats/schema';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';
import {
	CONSISTENT_BLOCK_COUNTS,
	currentProxyRow,
	legacyProxyRow,
	passthroughProxyRow,
	skippedProxyRow,
} from '../../helpers/proxyTelemetryFixtures';

const TELEMETRY_NAMES = ADD_PROXY_REQUEST_TELEMETRY_COLUMNS.map((column) => column.name);

function openDb(): Database.Database {
	const Shim = nodeSqliteBetterSqlite3Mock().default;
	const db = new Shim(':memory:') as unknown as Database.Database;
	runMigrations(db);
	return db;
}

/** One stored row, as a plain object. */
function stored(db: Database.Database, id: string): Record<string, unknown> {
	const row = db.prepare('SELECT * FROM proxy_requests WHERE id = ?').get(id);
	return { ...(row as object) };
}

/** The columns the telemetry contract added, of one stored row. */
function telemetryOf(db: Database.Database, id: string): Record<string, unknown> {
	const row = stored(db, id);
	return Object.fromEntries(TELEMETRY_NAMES.map((name) => [name, row[name]]));
}

const ALL_UNKNOWN = Object.fromEntries(TELEMETRY_NAMES.map((name) => [name, null]));

describe.skipIf(!canLoadNodeSqlite())('the proxy request writer on the real v22 table', () => {
	beforeEach(() => {
		clearProxyRequestsCache();
	});

	it('stores a current row whole: each fact in the column named for it', () => {
		const db = openDb();

		const id = recordProxyRequest(db, currentProxyRow());

		expect(telemetryOf(db, id)).toEqual({
			effective_mode: 'compress-early',
			blocks_protected: 0,
			blocks_vetoed_failed: 1,
			blocks_vetoed_recovery: 0,
			blocks_vetoed_retrieval: 2,
			blocks_candidates: 9,
			blocks_below_threshold: 3,
			blocks_kept: 2,
			blocks_store_failed: 1,
			blocks_model_failed: 1,
			provider_input_reportedness: 'reported',
			provider_cache_read_reportedness: 'reported',
			provider_cache_write_reportedness: 'reported',
			provider_output_reportedness: 'reported',
		});
		// The columns that existed before are written as they always were.
		expect(stored(db, id)).toMatchObject({
			mode: 'compress',
			blocks_compressed: 3,
			cache_hits: 2,
			provider_input_tokens: 4_000,
			provider_cache_read_tokens: 120_000,
			provider_cache_write_tokens: 0,
			provider_output_tokens: 600,
		});
	});

	it('names the position of every count, so a swap would show', () => {
		const db = openDb();
		const distinct = {
			protected: 11,
			vetoed: { failed: 12, recovery: 13, retrieval: 14 },
			candidates: 15,
			belowThreshold: 16,
			kept: 17,
			storeFailed: 18,
			modelFailed: 19,
		};

		const id = recordProxyRequest(db, currentProxyRow({ blockCounts: distinct }));

		expect(telemetryOf(db, id)).toMatchObject({
			blocks_protected: 11,
			blocks_vetoed_failed: 12,
			blocks_vetoed_recovery: 13,
			blocks_vetoed_retrieval: 14,
			blocks_candidates: 15,
			blocks_below_threshold: 16,
			blocks_kept: 17,
			blocks_store_failed: 18,
			blocks_model_failed: 19,
		});
	});

	it('names the class of every reportedness, in the order the counts have', () => {
		const db = openDb();

		const id = recordProxyRequest(
			db,
			currentProxyRow({
				providerUsageReportedness: {
					input: 'unreported',
					cacheRead: 'derived',
					cacheWrite: 'not-applicable',
					output: 'reported',
				},
			})
		);

		expect(telemetryOf(db, id)).toMatchObject({
			provider_input_reportedness: 'unreported',
			provider_cache_read_reportedness: 'derived',
			provider_cache_write_reportedness: 'not-applicable',
			provider_output_reportedness: 'reported',
		});
	});

	it('fills every column of the table when a row states everything', () => {
		const db = openDb();
		const columns = (db.pragma('table_info(proxy_requests)') as Array<{ name: string }>).map(
			(column) => column.name
		);

		const id = recordProxyRequest(
			db,
			currentProxyRow({ skipReason: 'failed', routedTo: 'maestro-server:qwen3.5-4b' })
		);

		const row = stored(db, id);
		expect(columns).toHaveLength(39);
		// A column the INSERT does not name would be NULL here.
		expect(columns.filter((column) => row[column] === null)).toEqual([]);
	});

	it('stores a row that states no telemetry as unknown, provider counts included', () => {
		const db = openDb();

		const id = recordProxyRequest(db, legacyProxyRow());

		// The tokens are stored; how they were given was never recorded, so it is unknown.
		expect(telemetryOf(db, id)).toEqual(ALL_UNKNOWN);
		expect(stored(db, id)).toMatchObject({ provider_input_tokens: 4_000 });
	});

	it('stores the mode of a request nobody read, and no counts', () => {
		const db = openDb();

		const id = recordProxyRequest(db, passthroughProxyRow());

		expect(telemetryOf(db, id)).toEqual({ ...ALL_UNKNOWN, effective_mode: 'passthrough' });
	});

	it('stores the mode of a request that was forwarded unread, and no counts', () => {
		const db = openDb();

		const id = recordProxyRequest(db, skippedProxyRow('too-large'));

		expect(telemetryOf(db, id)).toEqual({ ...ALL_UNKNOWN, effective_mode: 'compress-early' });
		expect(stored(db, id)).toMatchObject({ mode: 'compress', skip_reason: 'too-large' });
	});

	it('keeps both compress modes apart in effective_mode while mode stores them as one', () => {
		const db = openDb();

		const delayed = recordProxyRequest(db, currentProxyRow({ effectiveMode: 'compress' }));
		const early = recordProxyRequest(db, currentProxyRow({ effectiveMode: 'compress-early' }));

		expect(stored(db, delayed)).toMatchObject({ mode: 'compress', effective_mode: 'compress' });
		expect(stored(db, early)).toMatchObject({ mode: 'compress', effective_mode: 'compress-early' });
	});

	it('keeps a counted zero apart from an unknown', () => {
		const db = openDb();
		const zeros = {
			protected: 0,
			vetoed: { failed: 0, recovery: 0, retrieval: 0 },
			candidates: 0,
			belowThreshold: 0,
			kept: 0,
			storeFailed: 0,
			modelFailed: 0,
		};

		recordProxyRequest(
			db,
			currentProxyRow({ blockCounts: zeros, blocksCompressed: 0, cacheHits: 0 })
		);
		recordProxyRequest(db, currentProxyRow());
		recordProxyRequest(db, passthroughProxyRow());

		expect({
			...(db
				.prepare(
					`SELECT COUNT(*) AS requests, COUNT(blocks_candidates) AS counted,
					        SUM(blocks_candidates) AS candidates
					 FROM proxy_requests`
				)
				.get() as object),
		}).toEqual({
			requests: 3,
			// The counted zero and the counted nine; the request nobody read is no count at all.
			counted: 2,
			candidates: CONSISTENT_BLOCK_COUNTS.candidates,
		});
	});

	it('leaves what the existing aggregator reads as it was', () => {
		const db = openDb();
		recordProxyRequest(db, currentProxyRow());
		recordProxyRequest(db, passthroughProxyRow());

		const totals = getProxyRequestUsage(db, 'all').totals;

		expect(totals).toMatchObject({
			requests: 2,
			compressRequests: 1,
			originalTokens: 10_000,
			sentTokens: 7_500,
		});
	});
});
