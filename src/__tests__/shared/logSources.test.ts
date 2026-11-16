/**
 * @file logSources.test.ts
 *
 * The System Log Viewer's sources: the id guard, which sources are files, the
 * line stamp a supervised process's log is written with, and how a log file is
 * read into timed, leveled entries.
 */

import { describe, it, expect } from 'vitest';
import {
	inferLogLineLevel,
	isFileLogSource,
	isLogSourceId,
	LOG_SOURCE_IDS,
	LOG_SOURCES,
	logLineStamp,
	parseLogSourceEntries,
} from '../../shared/logSources';

describe('log sources', () => {
	it('lists every id once, Maestro first', () => {
		expect(LOG_SOURCES.map((source) => source.id)).toEqual([...LOG_SOURCE_IDS]);
		expect(LOG_SOURCES[0].id).toBe('maestro');
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

describe('logLineStamp', () => {
	it('is the ISO time in brackets and a space', () => {
		expect(logLineStamp(Date.parse('2026-11-13T04:24:10.263Z'))).toBe(
			'[2026-11-13T04:24:10.263Z] '
		);
	});
});

describe('parseLogSourceEntries', () => {
	const START = Date.parse('2026-11-13T04:24:10.000Z');
	const parse = (text: string, fallback = 0) =>
		parseLogSourceEntries(text, 'model-server', fallback);

	it('reads a stamped line as its time, with the source as context', () => {
		expect(parse('[2026-11-13T04:24:10.000Z] Starting llama-server\n')).toEqual([
			{
				timestamp: START,
				level: 'info',
				message: 'Starting llama-server',
				context: 'model-server',
				source: 'model-server',
			},
		]);
	});

	it("takes llama.cpp's level letter and drops its elapsed time from the message", () => {
		const entries = parse(
			'[2026-11-13T04:24:10.000Z] 0.00.041.602 I srv  init: Use --ui (or deprecated --webui)\n' +
				'[2026-11-13T04:24:10.100Z] 0.00.094.096 W srv  security: router mode enabled\n' +
				'[2026-11-13T04:24:10.200Z] 0.00.094.097 E srv  load_model: failed\n' +
				'[2026-11-13T04:24:10.300Z] 0.00.094.098 D srv  detail\n'
		);
		expect(entries.map((entry) => [entry.level, entry.message])).toEqual([
			// "deprecated" no longer reads as a warning: the line says it is info.
			['info', 'srv  init: Use --ui (or deprecated --webui)'],
			['warn', 'srv  security: router mode enabled'],
			['error', 'srv  load_model: failed'],
			['debug', 'srv  detail'],
		]);
		// The stamp wins over the elapsed time.
		expect(entries[0].timestamp).toBe(START);
	});

	it('places an older unstamped llama.cpp line from the run start', () => {
		const entries = parse(
			'[2026-11-13T04:24:10.000Z] Starting llama-server\n' +
				'0.00.041.400 I cmn  common_param: verbosity = 3\n' +
				'2149.10.909.201 I srv  operator(): cleaning up before exit...\n' +
				'[2026-11-14T16:13:21.214Z] Exited\n'
		);
		expect(entries.map((entry) => entry.timestamp)).toEqual([
			START,
			START + 41,
			START + 2149 * 60_000 + 10_000 + 909,
			Date.parse('2026-11-14T16:13:21.214Z'),
		]);
	});

	it('gives a line with no time of its own the time of the line before', () => {
		const entries = parse('[2026-11-13T04:24:10.000Z] first\n  continued stack frame\n');
		expect(entries[1]).toMatchObject({ timestamp: START, message: 'continued stack frame' });
	});

	it('gives a cut-off line the next known time, or the fallback when none is known', () => {
		expect(
			parse('0.00.001.000 I srv  orphan\n[2026-11-13T04:24:10.000Z] Exited\n').map(
				(entry) => entry.timestamp
			)
		).toEqual([START, START]);
		expect(parse('0.00.001.000 I srv  orphan\n', 42)[0].timestamp).toBe(42);
	});

	it('reads a level from the words of a line without a letter', () => {
		expect(parse('[2026-11-13T04:24:10.000Z] spawn failed\n')[0].level).toBe('error');
	});

	it('splits on LF and CRLF and drops blank and stamp-only lines', () => {
		expect(parse('one\r\n\n[2026-11-13T04:24:10.000Z] \ntwo\n').map((e) => e.message)).toEqual([
			'one',
			'two',
		]);
	});

	it('is empty for empty text', () => {
		expect(parse('')).toEqual([]);
	});
});
