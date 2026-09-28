import { describe, it, expect } from 'vitest';

import { bindFilterExpression } from '../../../shared/parquet/filterExpression';
import { compileFilterPushdown } from '../../../shared/parquet/pushdown';
import type { ParquetColumnInfo } from '../../../shared/parquet/types';

function column(
	name: string,
	kind: ParquetColumnInfo['kind'],
	overrides: Partial<ParquetColumnInfo> = {}
): ParquetColumnInfo {
	return {
		name,
		physicalType: 'BYTE_ARRAY',
		logicalType: null,
		kind,
		optional: true,
		nested: false,
		compression: 'SNAPPY',
		compressedBytes: 0,
		uncompressedBytes: 0,
		stats: { nullCount: 0, min: null, max: null, partial: false },
		...overrides,
	};
}

const COLUMNS: ParquetColumnInfo[] = [
	column('region', 'string'),
	column('price', 'float', { physicalType: 'DOUBLE' }),
	column('id', 'integer', { physicalType: 'INT64' }),
	column('amount', 'decimal', {
		physicalType: 'FIXED_LEN_BYTE_ARRAY',
		logicalType: 'DECIMAL(10,2)',
	}),
	column('ts', 'timestamp', {
		physicalType: 'INT64',
		timeUnit: 'MICROS',
		logicalType: 'TIMESTAMP(MICROS)',
	}),
	column('day', 'date', { physicalType: 'INT32', logicalType: 'DATE' }),
	column('legacy_ts', 'timestamp', { physicalType: 'INT96' }),
	column('tags', 'json', { physicalType: null, nested: true, logicalType: 'LIST' }),
];

function compile(expression: string, now = Date.UTC(2024, 0, 15)) {
	const bound = bindFilterExpression(expression, COLUMNS, now);
	expect(bound.problem).toBeUndefined();
	return compileFilterPushdown(bound.node, COLUMNS);
}

describe('compileFilterPushdown', () => {
	it('passes an empty filter straight through as complete', () => {
		expect(compileFilterPushdown(null, COLUMNS)).toEqual({ complete: true });
	});

	it('compiles the ordering operators', () => {
		expect(compile('price > 100').filter).toEqual({ price: { $gt: 100 } });
		expect(compile('price >= 100').filter).toEqual({ price: { $gte: 100 } });
		expect(compile('price < 100').filter).toEqual({ price: { $lt: 100 } });
		expect(compile('price <= 100').filter).toEqual({ price: { $lte: 100 } });
		expect(compile('region = eu').filter).toEqual({ region: { $eq: 'eu' } });
		expect(compile('region != eu').filter).toEqual({ region: { $ne: 'eu' } });
	});

	it('compiles set membership and ranges', () => {
		expect(compile('region in (us, eu)').filter).toEqual({ region: { $in: ['us', 'eu'] } });
		expect(compile('region not in (us)').filter).toEqual({ region: { $nin: ['us'] } });
		expect(compile('id between 10 and 20').filter).toEqual({ id: { $gte: 10, $lte: 20 } });
	});

	it('compiles a timestamp literal in epoch milliseconds, the domain statistics live in', () => {
		// Statistics are converted by the reader while the footer is parsed, so
		// a MICROS timestamp bound must be milliseconds. Compiling to
		// microseconds would make every bound 1000x too large and prune the
		// entire file - the exact failure this assertion pins down.
		const ms = Date.UTC(2024, 1, 1);
		expect(compile('ts >= 2024-02-01').filter).toEqual({ ts: { $gte: ms } });
		expect(compile('day < 2024-02-01').filter).toEqual({ day: { $lt: ms } });
	});

	it('compiles a decimal bound in its scaled form, matching converted statistics', () => {
		expect(compile('amount > 9.99').filter).toEqual({ amount: { $gt: 9.99 } });
	});

	it('drops a conjunct it cannot express but keeps the rest of the AND', () => {
		const result = compile('region = eu and region ~ acme');
		expect(result.filter).toEqual({ region: { $eq: 'eu' } });
		expect(result.complete).toBe(false);
	});

	it('drops the WHOLE disjunction when one branch cannot be expressed', () => {
		// Narrowing one branch of a union would discard rows the other branch
		// matches, so an OR is all-or-nothing.
		const result = compile('region = eu or region ~ acme');
		expect(result.filter).toBeUndefined();
		expect(result.complete).toBe(false);
	});

	it('keeps a fully expressible disjunction', () => {
		expect(compile('region = eu or region = us').filter).toEqual({
			$or: [{ region: { $eq: 'eu' } }, { region: { $eq: 'us' } }],
		});
	});

	it('refuses negation, null tests, matching, and bare terms', () => {
		for (const expression of ['not (region = eu)', 'region is null', 'region ^= ac', 'acme']) {
			const result = compile(expression);
			expect([expression, result.filter]).toEqual([expression, undefined]);
			expect([expression, result.complete]).toEqual([expression, false]);
		}
	});

	it('refuses nested columns and deprecated INT96 timestamps', () => {
		expect(compile('tags ~ us').filter).toBeUndefined();
		expect(compile('legacy_ts > 2024-01-01').filter).toBeUndefined();
	});

	it('reports a fully expressible predicate as complete', () => {
		const result = compile('region = eu and price > 100 and id between 1 and 9');
		expect(result.complete).toBe(true);
		expect(result.filter).toEqual({
			$and: [{ region: { $eq: 'eu' } }, { price: { $gt: 100 } }, { id: { $gte: 1, $lte: 9 } }],
		});
	});

	it('never compiles a null literal into a bound', () => {
		expect(compile('region = null').filter).toBeUndefined();
	});
});
