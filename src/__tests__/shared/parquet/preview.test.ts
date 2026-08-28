import { describe, it, expect } from 'vitest';

import {
	buildParquetPreviewMarker,
	isParquetFile,
	isParquetPreviewMarker,
	parseParquetPreviewMarker,
} from '../../../shared/parquet/preview';

describe('isParquetFile', () => {
	it('recognizes the parquet extensions', () => {
		expect(isParquetFile('/data/events.parquet')).toBe(true);
		expect(isParquetFile('/data/events.PARQUET')).toBe(true);
		expect(isParquetFile('/data/events.parq')).toBe(true);
		expect(isParquetFile('/data/events.pq')).toBe(true);
	});

	it('ignores an extension that only appears in a parent directory', () => {
		// Hive-style layouts are full of `.../table.parquet/part-0.snappy` paths,
		// and the file being opened there is the part, not the directory.
		expect(isParquetFile('/data/table.parquet/notes.txt')).toBe(false);
	});

	it('does not treat an extensionless file named parquet as one', () => {
		expect(isParquetFile('/data/parquet')).toBe(false);
		expect(isParquetFile('/data/events.parquet.gz')).toBe(false);
	});

	it('handles Windows separators', () => {
		expect(isParquetFile('C:\\data\\events.parquet')).toBe(true);
	});
});

describe('the preview marker', () => {
	it('round-trips a path', () => {
		const marker = buildParquetPreviewMarker('/data/events.parquet');
		expect(isParquetPreviewMarker(marker)).toBe(true);
		expect(parseParquetPreviewMarker(marker)).toBe('/data/events.parquet');
	});

	it('survives unicode, spaces, and URL punctuation in a filename', () => {
		const path = '/data/2024 métricas #1 (final)/?x=1.parquet';
		expect(parseParquetPreviewMarker(buildParquetPreviewMarker(path))).toBe(path);
	});

	it('rejects anything that is not a marker', () => {
		expect(isParquetPreviewMarker('id,name\n1,a')).toBe(false);
		expect(isParquetPreviewMarker(null)).toBe(false);
		expect(isParquetPreviewMarker(undefined)).toBe(false);
		expect(isParquetPreviewMarker('maestro-media://stream/abc/00')).toBe(false);
		expect(parseParquetPreviewMarker('maestro-parquet://preview/zz')).toBeNull();
	});
});
