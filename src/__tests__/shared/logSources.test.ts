/**
 * @file logSources.test.ts
 *
 * The System Log Viewer's sources: the id guard, which sources are files, the
 * line stamp a supervised process's log is written with, and how a log file is
 * read into timed, leveled entries.
 */

import { describe, it, expect } from 'vitest';
import {
	filterLogEntries,
	formatLogEntryText,
	inferLogLineLevel,
	isFileLogSource,
	isLogSourceId,
	LOG_SOURCE_IDS,
	LOG_SOURCES,
	logEntryMatchesSearch,
	logLineStamp,
	mergeLogSourceEntries,
	parseLogSourceEntries,
	parseSystemLogsQuery,
	type SourcedLogEntry,
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

const entry = (overrides: Partial<SourcedLogEntry> = {}): SourcedLogEntry => ({
	timestamp: 1000,
	level: 'info',
	message: 'Test',
	...overrides,
});

describe('mergeLogSourceEntries', () => {
	it('interleaves both sources newest first, keeping file order within one time', () => {
		const maestro = [
			entry({ timestamp: 30, message: 'm30' }),
			entry({ timestamp: 10, message: 'm10' }),
		];
		const file = parseLogSourceEntries(
			'[1970-01-01T00:00:00.020Z] f20a\n[1970-01-01T00:00:00.020Z] f20b\n',
			'model-server',
			0
		);
		expect(mergeLogSourceEntries(maestro, file).map((e) => e.message)).toEqual([
			'm30',
			'f20b',
			'f20a',
			'm10',
		]);
	});

	it('returns a copy of Maestro entries when there are no file lines', () => {
		const maestro = [entry()];
		const merged = mergeLogSourceEntries(maestro, []);
		expect(merged).toEqual(maestro);
		expect(merged).not.toBe(maestro);
	});
});

describe('formatLogEntryText', () => {
	it('writes time, level, context, message and data', () => {
		expect(
			formatLogEntryText(
				entry({ timestamp: 0, level: 'warn', context: 'model-server', data: { a: 1 } })
			)
		).toBe('[1970-01-01T00:00:00.000Z] [WARN] [model-server] Test\n{\n  "a": 1\n}');
	});
});

describe('logEntryMatchesSearch', () => {
	it('matches the message, the context, and the data', () => {
		const e = entry({ message: 'Alpha', context: 'ModuleB', data: { note: 'searchable' } });
		expect(logEntryMatchesSearch(e, 'alpha')).toBe(true);
		expect(logEntryMatchesSearch(e, 'moduleb')).toBe(true);
		expect(logEntryMatchesSearch(e, 'searchable')).toBe(true);
		expect(logEntryMatchesSearch(e, 'missing')).toBe(false);
	});

	it('matches everything for an empty query', () => {
		expect(logEntryMatchesSearch(entry(), '')).toBe(true);
	});

	it('never matches across two fields', () => {
		expect(logEntryMatchesSearch(entry({ message: 'abc', context: 'def' }), 'cd')).toBe(false);
	});

	it('leaves data that cannot be serialized out of the search', () => {
		const data: Record<string, unknown> = {};
		data.self = data;
		const e = entry({ message: 'Test', data });
		expect(logEntryMatchesSearch(e, 'test')).toBe(true);
		expect(logEntryMatchesSearch(e, 'self')).toBe(false);
	});
});

describe('filterLogEntries', () => {
	const list = [
		entry({ level: 'error', message: 'load failed' }),
		entry({ level: 'info', message: 'listening' }),
	];

	it('keeps the named levels and the search hits, in any case', () => {
		expect(filterLogEntries(list, { levels: ['error'] }).map((e) => e.message)).toEqual([
			'load failed',
		]);
		expect(filterLogEntries(list, { search: '  LISTEN ' }).map((e) => e.message)).toEqual([
			'listening',
		]);
		expect(filterLogEntries(list, {})).toHaveLength(2);
	});
});

describe('parseSystemLogsQuery', () => {
	it('accepts known sources and levels, dropping repeats', () => {
		expect(
			parseSystemLogsQuery({
				sources: ['model-server', 'model-server'],
				levels: ['warn', 'error'],
				search: 'x',
				limit: 5,
			})
		).toEqual({
			query: { sources: ['model-server'], levels: ['warn', 'error'], search: 'x', limit: 5 },
		});
	});

	it('reads nothing as every source and level', () => {
		expect(parseSystemLogsQuery(undefined)).toEqual({ query: {} });
	});

	it('names an unknown source, level, or a bad limit', () => {
		expect(parseSystemLogsQuery({ sources: ['/etc/passwd'] })).toEqual({
			error: 'Unknown log source: /etc/passwd. Sources: maestro, model-server.',
		});
		expect(parseSystemLogsQuery({ levels: ['loud'] })).toMatchObject({
			error: expect.stringContaining('Unknown log level: loud.'),
		});
		expect(parseSystemLogsQuery({ sources: [] })).toEqual({ error: 'Name at least one source.' });
		expect(parseSystemLogsQuery({ limit: 0 })).toEqual({
			error: 'The limit must be a whole number above 0.',
		});
	});
});
