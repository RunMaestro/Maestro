import { describe, expect, it } from 'vitest';

import {
	TABULAR_EXPORT_FILE_FILTERS,
	createTabularRowEncoder,
	csvField,
	isTabularExportFormat,
	tabularExportFormatForPath,
	tabularRecordKeys,
} from '../../shared/tabularExport';

describe('tabularExportFormatForPath', () => {
	it('reads JSON Lines from .jsonl and .ndjson, in any case, and CSV from anything else', () => {
		expect(tabularExportFormatForPath('/tmp/out.jsonl')).toBe('jsonl');
		expect(tabularExportFormatForPath('/tmp/OUT.NDJSON')).toBe('jsonl');
		expect(tabularExportFormatForPath('/tmp/out.csv')).toBe('csv');
		expect(tabularExportFormatForPath('/tmp/out')).toBe('csv');
		expect(tabularExportFormatForPath('/tmp/out.jsonl.txt')).toBe('csv');
	});

	it('offers CSV first in a save dialog', () => {
		expect(TABULAR_EXPORT_FILE_FILTERS.map((filter) => filter.extensions[0])).toEqual([
			'csv',
			'jsonl',
		]);
	});

	it('knows the two formats and nothing else', () => {
		expect(isTabularExportFormat('csv')).toBe(true);
		expect(isTabularExportFormat('jsonl')).toBe(true);
		expect(isTabularExportFormat('json')).toBe(false);
		expect(isTabularExportFormat(undefined)).toBe(false);
	});
});

describe('csvField', () => {
	it('quotes only a field whose content forces it, doubling inner quotes', () => {
		expect(csvField('plain')).toBe('plain');
		expect(csvField('a,b')).toBe('"a,b"');
		expect(csvField('say "hi"')).toBe('"say ""hi"""');
		expect(csvField('two\nlines')).toBe('"two\nlines"');
		expect(csvField('cr\r')).toBe('"cr\r"');
	});

	it('writes NULL as an empty field and numbers as their text', () => {
		expect(csvField(null)).toBe('');
		expect(csvField(1.5)).toBe('1.5');
		expect(csvField(9007199254740993n)).toBe('9007199254740993');
		expect(csvField(true)).toBe('true');
	});
});

describe('tabularRecordKeys', () => {
	it('keeps distinct names and suffixes repeats', () => {
		expect(tabularRecordKeys(['a', 'b', 'a', 'a'])).toEqual(['a', 'b', 'a_2', 'a_3']);
	});

	it('skips a suffix another column already uses', () => {
		expect(tabularRecordKeys(['a', 'a_2', 'a'])).toEqual(['a', 'a_2', 'a_3']);
	});
});

describe('createTabularRowEncoder', () => {
	it('writes CSV with a header line', () => {
		const encoder = createTabularRowEncoder('csv', ['id', 'note, with comma']);
		expect(encoder.header).toBe('id,"note, with comma"\n');
		expect(encoder.row([1, 'x "y"'])).toBe('1,"x ""y"""\n');
		expect(encoder.row([null, ''])).toBe(',\n');
	});

	it('writes one JSON object per row, with no header', () => {
		const encoder = createTabularRowEncoder('jsonl', ['id', 'name']);
		expect(encoder.header).toBe('');
		const line = encoder.row([1, 'a\nb']);
		expect(line).toBe('{"id":1,"name":"a\\nb"}\n');
		expect(JSON.parse(line)).toEqual({ id: 1, name: 'a\nb' });
	});

	it('keeps every digit of a bigint and writes a non-finite number as a string', () => {
		const encoder = createTabularRowEncoder('jsonl', ['big', 'inf', 'nan', 'missing']);
		const line = encoder.row([9007199254740993n, Infinity, NaN]);
		expect(line).toBe('{"big":9007199254740993,"inf":"Infinity","nan":"NaN","missing":null}\n');
	});

	it('keys a repeated column apart so no value is lost', () => {
		const encoder = createTabularRowEncoder('jsonl', ['a', 'a']);
		expect(JSON.parse(encoder.row([1, 2]))).toEqual({ a: 1, a_2: 2 });
	});
});
