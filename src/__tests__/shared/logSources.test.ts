/**
 * @file logSources.test.ts
 *
 * The System Log Viewer's sources: the id guard, which sources are files, and
 * how a plain log line is read into lines and levels.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_LOG_SOURCE,
	inferLogLineLevel,
	isFileLogSource,
	isLogSourceId,
	LOG_SOURCE_IDS,
	LOG_SOURCES,
	parseLogLines,
} from '../../shared/logSources';

describe('log sources', () => {
	it('lists every id once, Maestro first and default', () => {
		expect(LOG_SOURCES.map((source) => source.id)).toEqual([...LOG_SOURCE_IDS]);
		expect(LOG_SOURCES[0].id).toBe('maestro');
		expect(DEFAULT_LOG_SOURCE).toBe('maestro');
	});

	it('accepts only known ids', () => {
		expect(isLogSourceId('maestro')).toBe(true);
		expect(isLogSourceId('model-server')).toBe(true);
		expect(isLogSourceId('/etc/passwd')).toBe(false);
		expect(isLogSourceId(undefined)).toBe(false);
	});

	it('treats every source but Maestro as a file', () => {
		expect(isFileLogSource('maestro')).toBe(false);
		expect(isFileLogSource('model-server')).toBe(true);
	});
});

describe('inferLogLineLevel', () => {
	it.each([
		['srv load_model: failed to load model', 'error'],
		['error: invalid argument', 'error'],
		['GGML_ASSERT ... aborted', 'error'],
		['warning: no GPU found', 'warn'],
		['main: server is listening on http://127.0.0.1:57792', 'info'],
		['request: GET /health 200', 'info'],
	])('%s -> %s', (line, level) => {
		expect(inferLogLineLevel(line)).toBe(level);
	});

	it('does not read a level word inside another word', () => {
		expect(inferLogLineLevel('terrorists')).toBe('info');
		expect(inferLogLineLevel('forewarned')).toBe('info');
	});
});

describe('parseLogLines', () => {
	it('splits on LF and CRLF, numbers by position, and drops blank lines', () => {
		expect(parseLogLines('one\r\n\ntwo failed\n')).toEqual([
			{ number: 1, text: 'one', level: 'info' },
			{ number: 3, text: 'two failed', level: 'error' },
		]);
	});

	it('is empty for empty text', () => {
		expect(parseLogLines('')).toEqual([]);
	});
});
