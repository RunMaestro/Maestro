import { describe, it, expect } from 'vitest';
import { serializeError, toLoggableData } from '../../shared/serializeError';

describe('serializeError', () => {
	it('keeps name, message and stack, which JSON.stringify drops', () => {
		const err = new TypeError('boom');
		expect(JSON.stringify(err)).toBe('{}');
		const out = serializeError(err);
		expect(out).toMatchObject({ name: 'TypeError', message: 'boom', stack: err.stack });
		expect(JSON.parse(JSON.stringify(out)).message).toBe('boom');
	});

	it('keeps enumerable extras such as a Node error code', () => {
		const err = Object.assign(new Error('nope'), { code: 'ENOENT' });
		expect(serializeError(err)).toMatchObject({ code: 'ENOENT', message: 'nope' });
	});

	it('flattens a cause chain', () => {
		const err = Object.assign(new Error('outer'), { cause: new Error('inner') });
		expect(serializeError(err).cause).toMatchObject({ message: 'inner' });
	});

	it('wraps a primitive and passes a plain object through', () => {
		expect(serializeError('text')).toEqual({ value: 'text' });
		const obj = { a: 1 };
		expect(serializeError(obj)).toBe(obj);
	});
});

describe('toLoggableData', () => {
	it('converts a top-level Error', () => {
		expect(toLoggableData(new Error('x'))).toMatchObject({ message: 'x' });
	});

	it('converts an Error held by a plain object key without mutating the input', () => {
		const err = new Error('inner');
		const data = { path: '/a', error: err };
		const out = toLoggableData(data) as Record<string, unknown>;
		expect(out).not.toBe(data);
		expect(out.path).toBe('/a');
		expect(out.error).toMatchObject({ message: 'inner' });
		expect(data.error).toBe(err);
	});

	it('returns data with no Errors by reference', () => {
		const data = { a: 1 };
		expect(toLoggableData(data)).toBe(data);
		const arr = [1, 2];
		expect(toLoggableData(arr)).toBe(arr);
		expect(toLoggableData(undefined)).toBeUndefined();
		expect(toLoggableData('s')).toBe('s');
	});
});
