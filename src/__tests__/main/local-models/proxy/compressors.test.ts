/**
 * @file compressors.test.ts
 *
 * The token proxy's heuristic compressors. Each is a pure function, and each
 * must name what it left out in the text it returns.
 */

import { describe, it, expect } from 'vitest';
import {
	compressCommandOutput,
	compressJson,
	compressJsonTable,
	compressLogs,
	compressWithHeuristics,
	JSON_ARRAY_HEAD_ITEMS,
	JSON_ARRAY_TAIL_ITEMS,
	LONG_LINE_KEEP_CHARS,
	LONG_LINE_MAX_CHARS,
	truncateLongLines,
} from '../../../../main/local-models/proxy/compressors';
import { parseJsonSpans } from '../../../../main/local-models/proxy/json-spans';

/** `count` rows, each long enough that a sampled array leaves out real text. */
function rows(count: number): Array<{ id: number; name: string }> {
	return Array.from({ length: count }, (_, id) => ({ id, name: `record number ${id} of many` }));
}

describe('compressCommandOutput', () => {
	const statusRows = () => Array.from({ length: 300 }, (_, index) => ` M file ${index}.ts`);
	const logHeader = (hash: string) => [
		`commit ${hash}`,
		'Author: Fixture Author <fixture@example.invalid>',
		'Date:   Fri Nov 6 10:11:12 2026 -0600',
		'',
	];
	const searchRows = () =>
		Array.from({ length: 20 }, (_, index) => {
			const snippet = index === 9 ? 'warning: missing symbol at source.ts:27:4' : `match ${index}`;
			return `src/directory with spaces/工程/worker.ts:${index + 1}:${snippet}`;
		});

	it('groups Git status classes and retains every opaque path and rename destination', () => {
		const special = [
			'R  old name.ts -> new name.ts',
			' A added.ts',
			'AM staged and edited.ts',
			' D removed.ts',
			'T  changed type.ts',
			'C  original.ts -> copy.ts',
			'?? 工程/new file.ts',
			'!! ignored file',
			'UU conflicted.ts',
			' M "quoted \\t file.ts"',
			' M trailing space.ts ',
		];
		const lines = ['## acappella...origin/acappella [ahead 2]', ...statusRows(), ...special];
		const text = `${lines.join('\n')}\n`;
		const result = compressCommandOutput(text);
		expect(result?.compressor).toBe('git-status');
		expect(result?.text).toContain('311 entries grouped by XY; all paths retained');
		expect(result?.text).toContain(lines[0]);
		expect(result?.text).toContain('[ M] 302 entries');
		for (const line of lines.slice(1)) expect(result?.text.split('\n')).toContain(line.slice(3));
		for (const line of special) expect(result?.text).toContain(`[${line.slice(0, 2)}]`);
		expect(result?.text.endsWith('\n')).toBe(true);
		expect(result?.text.length).toBeLessThan(text.length);
	});

	it('keeps commit hashes, merge parents, authors, dates, subjects and diagnostic sections', () => {
		const first = 'a'.repeat(40);
		const second = 'b'.repeat(64);
		const header = logHeader(second);
		header.splice(1, 0, 'Merge: abcdef012345 fedcba987654');
		const text = [
			...logHeader(first),
			'    Refine scheduling',
			...Array.from({ length: 18 }, (_, index) => `    background detail number ${index}`),
			'    Warning: unresolved import at src/工程/source.ts:27:4',
			'        at resolve (src/loader.ts:8:1)',
			'',
			...header,
			'    Join the histories',
			'    https://example.invalid/issue/123',
			'    related hash 0123456789abcdef0123456789abcdef01234567',
		].join('\n');
		const result = compressCommandOutput(text);
		expect(result?.compressor).toBe('git-log');
		for (const line of [
			...logHeader(first),
			...header,
			'    Refine scheduling',
			'    Join the histories',
			'    Warning: unresolved import at src/工程/source.ts:27:4',
			'        at resolve (src/loader.ts:8:1)',
			'    https://example.invalid/issue/123',
			'    related hash 0123456789abcdef0123456789abcdef01234567',
		]) {
			expect(result?.text.split('\n')).toContain(line);
		}
		expect(result?.text).toContain('[maestro: 18 Git message lines omitted]');
		expect(result?.text).toContain('[maestro: 1 Git message lines omitted]');
		expect(result?.text.length).toBeLessThan(text.length);
	});

	it('samples search records per file, keeps a unique selected-file match and counts each gap', () => {
		const lines = searchRows();
		lines.splice(10, 0, 'src/工程/selected file.ts:27:the only selected-file hit');
		const text = `${lines.join('\n')}\n`;
		const result = compressCommandOutput(text);
		expect(result?.compressor).toBe('search');
		expect(result?.text).toContain('21 output records in 2 filename prefixes');
		expect(result?.text).toContain('counts are records, not occurrences');
		expect(result?.text).toContain('"src/directory with spaces/工程/worker.ts"; 20 records');
		expect(result?.text).toContain('"src/工程/selected file.ts"; 1 records');
		expect(result?.text.split('\n')).toContain('27:the only selected-file hit');
		expect(result?.text.split('\n')).toContain('10:warning: missing symbol at source.ts:27:4');
		expect(result?.text).toContain('[maestro: 6 search records omitted]');
		expect(result?.text).toContain('[maestro: 8 search records omitted]');
		expect(result?.text).not.toContain('9:match 8');
		expect(result?.text.endsWith('\n')).toBe(true);
		expect(result?.text.length).toBeLessThan(text.length);
	});

	it.each(['5:\tentry:', '123:numeric text:', '7:8:numeric path component:', 'part:12:text:'])(
		'preserves every suffix with ambiguous columns, numeric snippets or path components: %s',
		(prefix) => {
			const path = 'src/a sufficiently long directory/column matches.ts';
			const suffixes = Array.from({ length: 30 }, (_, index) => `${index + 1}:${prefix}${index}`);
			const text = suffixes.map((suffix) => `${path}:${suffix}`).join('\n');
			const result = compressCommandOutput(text);
			expect(result?.compressor).toBe('search');
			expect(result?.text).toContain(JSON.stringify(path));
			for (const suffix of suffixes) expect(result?.text.split('\n')).toContain(suffix);
			expect(result?.text).not.toContain('search records omitted');
			expect(result?.text.length).toBeLessThan(text.length);
		}
	);

	it('retains a unique middle-file match when numeric colon segments obscure the filename', () => {
		const prefix = 'src/a sufficiently long directory/records';
		const lines = Array.from({ length: 30 }, (_, index) => `${prefix}:${index + 1}:match ${index}`);
		const unique = '314:selected file:27:only match in the colon-bearing filename';
		lines.splice(15, 0, `${prefix}:${unique}`);
		const text = lines.join('\n');
		const result = compressCommandOutput(text);
		expect(result?.compressor).toBe('search');
		expect(result?.text).toContain('31 output records in 1 filename prefixes');
		expect(result?.text.split('\n')).toContain(unique);
		expect(result?.text).toContain('[maestro: 12 search records omitted]');
		expect(result?.text).toContain('[maestro: 13 search records omitted]');
		expect(result?.text.length).toBeLessThan(text.length);
	});

	it.each(['error', 'warning', 'fatal', 'panic'])(
		'leaves diagnostic prefixes resembling search filenames to existing behavior: %s',
		(prefix) => {
			const text = Array.from(
				{ length: 30 },
				(_, index) => `${prefix}:${index + 1}:unique diagnostic detail ${index}`
			).join('\n');
			expect(compressCommandOutput(text)).toBeNull();
		}
	);

	it('keeps long diagnostic, URL, hash and path evidence in otherwise sampled search output', () => {
		const path = 'src/a long directory/worker.ts';
		const evidence = [
			`Error: ${'x'.repeat(1300)}`,
			'https://example.invalid/reports/123',
			'hash 0123456789abcdef0123456789abcdef01234567',
			'/tmp/工程/space name.ts:27:4',
		];
		const snippets = Array.from({ length: 50 }, (_, index) => `ordinary match ${index}`);
		snippets.splice(20, evidence.length, ...evidence);
		const text = snippets.map((snippet, index) => `${path}:${index + 1}:${snippet}`).join('\n');
		const result = compressCommandOutput(text);
		for (const [index, snippet] of evidence.entries()) {
			expect(result?.text.split('\n')).toContain(`${index + 21}:${snippet}`);
		}
		expect(result?.compressor).toBe('search');
		expect(result?.text).toContain('search records omitted');
		expect(result?.text.length).toBeLessThan(text.length);
	});

	it.each([
		'abcdef0 custom subject\nfedcba0 another custom subject',
		'commit abcdef0\ncustom layout',
		'commit ' + 'a'.repeat(40) + '\nauthor custom raw header',
		'M src/a.ts\nA src/b.ts',
		' M src/a.ts\n?M src/b.ts',
		'On branch acappella\nChanges not staged for commit:',
		'src/count.ts:42\nsrc/other.ts:9',
		'src/context.ts-12-context\nsrc/context.ts:13:match',
		String.raw`C:\work\source.ts:12:match`,
		'src/colon:name.ts:12:match',
		'src/heading.ts\n12:match',
		'src/a.ts:12:match\n8 matches in 2 files',
		'Binary file src/image.bin matches',
		'ERROR: search failed',
	])('leaves unsupported/custom/ambiguous formats to existing behavior: %s', (text) => {
		expect(compressCommandOutput(text)).toBeNull();
	});

	it.each(['\0', '\x01', '\x1b[31m', '\r', '\x7f', '\u0085', '\u009b31m'])(
		'refuses NUL-like and terminal-control data anywhere: %s',
		(control) => {
			const status = statusRows().join('\n') + control;
			const search = searchRows().join('\n') + control;
			expect(compressCommandOutput(status)).toBeNull();
			expect(compressCommandOutput(search)).toBeNull();
		}
	);

	it('leaves diff/custom log trailers and mixed pipeline output whole', () => {
		const log = [...logHeader('a'.repeat(40)), '    Subject', ...statusRows()].join('\n');
		expect(compressCommandOutput(log)).toBeNull();
		expect(compressCommandOutput([...statusRows(), 'total 300 files'].join('\n'))).toBeNull();
		expect(compressCommandOutput([...searchRows(), ' M src/extra.ts'].join('\n'))).toBeNull();
	});

	it('returns no candidate when scan/evidence limits or marker overhead prevent reduction', () => {
		expect(compressCommandOutput('')).toBeNull();
		expect(compressCommandOutput(' M a.ts\n')).toBeNull();
		expect(compressCommandOutput('src/a.ts:1:match\n')).toBeNull();
		expect(compressCommandOutput(' M a.ts\n'.repeat(10_001))).toBeNull();
		expect(compressCommandOutput(' M ' + 'a'.repeat(262_144))).toBeNull();
		const largeEvidence = Array.from(
			{ length: 20 },
			(_, index) => `src/worker.ts:${index + 1}:Error: ${index} ${'x'.repeat(1000)}`
		).join('\n');
		expect(compressCommandOutput(largeEvidence)).toBeNull();
	});

	it('dispatches by content and returns command candidates without further line cuts', () => {
		for (const text of [statusRows().join('\n'), searchRows().join('\n')]) {
			const first = compressCommandOutput(text);
			expect(first).not.toBeNull();
			expect(compressCommandOutput(text)).toEqual(first);
			expect(compressWithHeuristics(text)).toEqual({
				text: first?.text,
				applied: [first?.compressor],
			});
		}
	});
});

describe('successful validation output candidates', () => {
	// Independently authored shapes of the repo's Vitest, Vite and ESLint
	// reports. These are fixture strings, never commands to launch a workload.
	const passingFiles = Array.from(
		{ length: 120 },
		(_, index) => ` ✓ src/__tests__/fixture ${index}.test.ts (3 tests) ${index + 1}ms`
	);
	const totals = [
		' Test Files  120 passed (120)',
		'      Tests  360 passed | 2 skipped | 1 todo (363)',
		'   Start at  10:11:12',
		'   Duration  2.34s (transform 1.20s, tests 120ms, environment 0ms)',
	];
	const vitest = [' RUN  v4.1.11 /fixture/maestro', ...passingFiles, ...totals].join('\n');
	const artifacts = Array.from(
		{ length: 80 },
		(_, index) => `dist/renderer/assets/chunk-${index}.js${' '.repeat(50)}1.23 kB  | gzip: 0.80 kB`
	);
	const vite = [
		'vite v8.3.4 building client environment for production...',
		'transforming...',
		'✓ 1256 modules transformed.',
		'rendering chunks...',
		'computing gzip size...',
		...artifacts,
		'✓ built in 3.45s',
	].join('\n');
	const lintRows = Array.from({ length: 80 }, (_, index) => [
		`/fixture/src/工程/file ${index}.ts`,
		`        ${index + 1}:3        warning        Unused binding ${index}  @typescript-eslint/no-unused-vars`,
	]);
	const eslint = [...lintRows.flat(), '✖ 80 problems (0 errors, 80 warnings)'].join('\n');

	it('keeps every Vitest filename, case count, duration, summary and explicit exit status', () => {
		const text = `${vitest}\nExit code: 0\n`;
		const result = compressCommandOutput(text);
		expect(result?.compressor).toBe('test-output');
		expect(result?.text).toContain('top-level ✓ prefixes omitted; all records retained');
		for (const row of passingFiles) expect(result?.text.split('\n')).toContain(row.slice(3));
		for (const row of totals) expect(result?.text.split('\n')).toContain(row);
		expect(result?.text.split('\n')).toContain('Exit code: 0');
		expect(result?.text.endsWith('\n')).toBe(true);
		expect(result?.text.length).toBeLessThan(text.length);
	});

	it('keeps named warnings, locations, causal excerpts and diagnostic-like passing names verbatim', () => {
		const diagnostics = [
			'Warning: delayed fixture timer at src/工程/timer.ts:27:4',
			'    timer source excerpt',
			'    at schedule (src/工程/timer.ts:27:4)',
			' ✓ src/__tests__/error-handling.test.ts (2 tests) 1ms',
			' ✓ Custom reporter checkpoint retained',
			' ✓ src/__tests__/unknown-duration.test.ts (2 tests) pending',
			'   ✓ timer scope 1ms',
			'     ✓ repeated case name 1ms',
			'   ✓ scheduler scope 1ms',
			'     ✓ repeated case name 2ms',
			'hash 0123456789abcdef0123456789abcdef01234567',
		];
		const text = [
			' RUN  v4.1.11 /fixture/maestro',
			...passingFiles,
			...diagnostics,
			...totals,
		].join('\n');
		const result = compressCommandOutput(text);
		expect(result?.compressor).toBe('test-output');
		for (const row of diagnostics) expect(result?.text.split('\n')).toContain(row);
	});

	it('does not invent start times, overall durations or exit metadata when absent', () => {
		const text = [' RUN  v4.1.11 /fixture/maestro', ...passingFiles, ...totals.slice(0, 2)].join(
			'\n'
		);
		const result = compressCommandOutput(text);
		expect(result?.compressor).toBe('test-output');
		expect(result?.text).not.toMatch(/Start at|Duration|Exit code/);
		for (const row of passingFiles) expect(result?.text).toContain(row.slice(3));
	});

	it('keeps every build artifact/size and named warning while counting progress omissions', () => {
		const diagnostics = [
			'[plugin builtin:vite-reporter]',
			'(!) Some chunks are larger than 500 kB after minification. Consider:',
			'- Use dynamic import() to split the application',
			'https://example.invalid/build/config#chunk-size',
			`Warning: large inline payload ${'x'.repeat(1200)}`,
			'dist/renderer/assets/工程 file.js        2.40 kB  | gzip: 1.30 kB',
		];
		const text = vite.replace('✓ built in 3.45s', [...diagnostics, '✓ built in 3.45s'].join('\n'));
		const result = compressCommandOutput(text);
		expect(result?.compressor).toBe('build-output');
		for (let index = 0; index < artifacts.length; index++) {
			expect(result?.text.split('\n')).toContain(
				`dist/renderer/assets/chunk-${index}.js 1.23 kB | gzip: 0.80 kB`
			);
		}
		for (const row of diagnostics) expect(result?.text.split('\n')).toContain(row);
		expect(result?.text).toContain('✓ 1256 modules transformed.');
		expect(result?.text).toContain('✓ built in 3.45s');
		expect(result?.text).toContain('[maestro: 1 Vite progress lines omitted]');
		expect(result?.text).toContain('[maestro: 2 Vite progress lines omitted]');
		expect(result?.text.length).toBeLessThan(text.length);
	});

	it('retains each ESLint warning location/message/rule and its Unicode/spaced filename', () => {
		const result = compressCommandOutput(eslint);
		expect(result?.compressor).toBe('lint-output');
		for (const [index, [path]] of lintRows.entries()) {
			expect(result?.text.split('\n')).toContain(path);
			expect(result?.text.split('\n')).toContain(
				`${index + 1}:3 warning Unused binding ${index}  @typescript-eslint/no-unused-vars`
			);
		}
		expect(result?.text).toContain('✖ 80 problems (0 errors, 80 warnings)');
		expect(result?.text).not.toMatch(/Duration|Exit code/);
		expect(result?.text.length).toBeLessThan(eslint.length);
	});

	it('folds repeated diagnostic regions with counts and retains distinct warnings', () => {
		const diagnostic = ['Warning: fixture clock is slow', '    at wait (src/clock.ts:7:1)'];
		const text = vite.replace(
			'✓ built in 3.45s',
			[
				...diagnostic,
				...diagnostic,
				...diagnostic,
				'Warning: fixture output is large',
				'✓ built in 3.45s',
			].join('\n')
		);
		const result = compressCommandOutput(text);
		expect(result?.compressor).toBe('build-output');
		for (const row of diagnostic) expect(result?.text.split('\n')).toContain(row);
		expect(result?.text).toContain('[maestro: previous 2 lines repeated 2 more times]');
		expect(result?.text).toContain('Warning: fixture output is large');
	});

	it.each([
		['test-output', vitest],
		['build-output', vite],
		['lint-output', eslint],
	])('is content-only, deterministic and shorter including notes: %s', (compressor, text) => {
		const result = compressCommandOutput(text);
		expect(result?.compressor).toBe(compressor);
		expect(compressCommandOutput(text)).toEqual(result);
		expect(result?.text.length).toBeLessThan(text.length);
		expect(compressWithHeuristics(text)).toEqual({ text: result?.text, applied: [compressor] });
	});

	it.each([
		vitest.replace('120 passed (120)', '1 failed | 119 passed (120)'),
		vitest.replace('360 passed | 2 skipped | 1 todo (363)', '1 failed | 359 passed (360)'),
		vitest.replace('120 passed (120)', '120 passed (121)'),
		vitest.replace('120 passed (120)', '9007199254740993 passed (9007199254740993)'),
		vitest.replace(' Test Files', ' × failed a concrete assertion\n Test Files'),
		vitest.replace(' Test Files', ' FAIL src/example.test.ts\n Test Files'),
		vitest.replace(' Test Files', 'Process exited with code 1\n Test Files'),
		vitest.replace(' Test Files', 'Exit code: -1\n Test Files'),
		vitest.replace(' Test Files', 'Process exited with status: +01\n Test Files'),
		vitest.replace(' Test Files', ' RUN  v4.1.11 /second/run\n Test Files'),
		vitest.replace(totals[1], ''),
		vitest.replace(totals[0], ''),
		vitest + '\n Test Files  120 passed (120)',
		vitest + '\n   Start at  10:11:12',
		vitest + '\n   Duration  2.34s',
		vitest + '\nExit code: 0\nExit code: 0',
		vitest.replace(totals[2], 'Exit code: 0'),
		vitest + '\nnext command output',
		vite.replace('✓ built in 3.45s', 'build failed in 3.45s'),
		vite.replace('✓ built in 3.45s', 'Error: unresolved module\n✓ built in 3.45s'),
		vite.replace('✓ built in 3.45s', 'Exit code: -1\n✓ built in 3.45s'),
		vite + '\nProcess exited with code 2',
		vite + '\nnext command output',
		vite + '\nvite v8.3.4 building for production...\n✓ built in 1s',
		eslint.replace('(0 errors, 80 warnings)', '(1 errors, 79 warnings)'),
		eslint.replace(
			'✖ 80 problems (0 errors, 80 warnings)',
			'✖ 81 problems (0 errors, 81 warnings)'
		),
		eslint.replace('        1:3        warning', '        1:3        error'),
		eslint.replace(lintRows[0][0] + '\n', ''),
		eslint.replace(lintRows[0][0], '/fixture/empty-file.ts\n' + lintRows[0][0]),
		eslint.replace(lintRows[0][0], '  unsupported indented filename'),
		eslint.replace('✖ 80 problems', '/fixture/empty-file.ts\n✖ 80 problems'),
		eslint + '\n✖ 80 problems (0 errors, 80 warnings)',
		eslint + '\nExit code: 1',
	])('refuses incomplete, inconsistent, mixed or explicitly failed output: %#', (text) => {
		expect(compressCommandOutput(text)).toBeNull();
	});

	it.each([
		'PASS all tests',
		'TAP version 13\n1..1\nok 1 - fixture',
		'Build completed successfully\nartifact.js 123 kB',
		'No lint problems found',
		'✔ 80 problems (0 errors, 80 warnings)',
		' RUN  v4.1.11 /fixture/maestro\n Test Files  1 passed (1)\n      Tests  3 passed (3)',
	])('leaves unknown formats and marker-only expansion to existing behavior: %s', (text) => {
		expect(compressCommandOutput(text)).toBeNull();
	});

	it('keeps validation evidence whole when the scan or distinct-evidence budget is exceeded', () => {
		const evidence = Array.from(
			{ length: 20 },
			(_, index) => `Warning: ${index} ${'x'.repeat(1000)}`
		).join('\n');
		expect(compressCommandOutput(vite.replace('transforming...', evidence))).toBeNull();
		expect(compressCommandOutput(vitest + '\n'.repeat(10_001))).toBeNull();
		expect(compressCommandOutput(vite.replace('transforming...', 'x'.repeat(262_144)))).toBeNull();
	});

	it.each(['\0', '\x1b[31m', '\r', '\u0085'])(
		'leaves terminal-control validation output to existing behavior: %s',
		(control) => {
			for (const text of [vitest, vite, eslint])
				expect(compressCommandOutput(text + control)).toBeNull();
		}
	);
});

describe('compressJsonTable', () => {
	/** Reconstruct JSON punctuation without ever parsing/reprinting cell values. */
	function restoreTable(encoded: string): string {
		const [label, schema, ...data] = encoded.split('\n');
		expect(label).toContain('json-table v1; ' + data.length + ' rows;');
		const keys = parseJsonSpans(schema);
		if (keys?.kind !== 'array') throw new Error('Missing table schema');
		const literals = keys.items.map((key) => schema.slice(key.start, key.end));
		return (
			'[' +
			data
				.map((line) => {
					const cells = line.split('\t');
					expect(cells).toHaveLength(literals.length);
					return (
						'{' +
						cells
							.flatMap((cell, index) => (cell === '~' ? [] : [literals[index] + ':' + cell]))
							.join(',') +
						'}'
					);
				})
				.join(',') +
			']'
		);
	}

	it('keeps every row, including middle rows, with a deterministic labelled schema', () => {
		const input = JSON.stringify(rows(100));
		const result = compressJsonTable(input);
		expect(result?.compressor).toBe('json-table');
		expect(result?.text.split('\n')[1]).toBe('["id","name"]');
		expect(result?.text).toContain('50\t"record number 50 of many"');
		expect(result?.text).not.toContain('omitted');
		expect(result?.text.length).toBeLessThan(input.length);
		expect(restoreTable(result!.text)).toBe(input);
		expect(compressJsonTable(input)).toEqual(result);
	});

	it('distinguishes absent keys, null, empty strings, booleans and the sentinel as data', () => {
		const variants = [
			'{"long_presence_column":null,"long_optional_column":""}',
			'{"long_presence_column":true,"long_optional_column":false}',
			'{"long_optional_column":"~"}',
			'{"long_presence_column":""}',
			'{}',
		];
		const input =
			'[' + Array.from({ length: 40 }, (_, index) => variants[index % 5]).join(',') + ']';
		const result = compressJsonTable(input);
		expect(result?.text).toContain('\nnull\t""\ntrue\tfalse\n~\t"~"\n""\t~\n~\t~');
		expect(restoreTable(result!.text)).toBe(input);
	});

	it('copies exact numeric and escaped string/key lexemes instead of normalizing them', () => {
		const row =
			'{"\\u0069dentifier_column":900719925474099312345,' +
			'"exponent_column":1.00e+400,"negative_zero":-0,"fraction_column":0.000,' +
			'"text\\tcolumn\\n":' +
			'"  tabs\\tnewlines\\ncarriage\\rquote\\" slash\\/ \\\\ literal\\\\n café 🔑  "}';
		const input = '[' + Array.from({ length: 24 }, () => row).join(',') + ']';
		const result = compressJsonTable(input);
		expect(result?.text).toContain('900719925474099312345\t1.00e+400\t-0\t0.000');
		expect(result?.text.split('\n')[1]).toContain('"\\u0069dentifier_column"');
		expect(restoreTable(result!.text)).toBe(input);
	});

	it('preserves unusual keys, integer-key order, delimiter-like data and long cells', () => {
		const longValue = JSON.stringify('  retry\n\t[maestro: json-table v1] ~,|\\"  '.repeat(100));
		const row = '{"10":1,"2":2,"__proto__":null,"逗号,\\\"key":' + longValue + '}';
		const input = '[' + Array.from({ length: 12 }, () => row).join(',') + ']';
		const result = compressJsonTable(input);
		expect(result?.text.split('\n')[1]).toBe('["10","2","__proto__","逗号,\\\"key"]');
		expect(result?.text).toContain(longValue);
		expect(result?.text).not.toContain('characters omitted');
		expect(restoreTable(result!.text)).toBe(input);
		expect(compressWithHeuristics(input)).toEqual({ text: result?.text, applied: ['json-table'] });
	});

	it('allows newly discovered columns and compatible omissions without changing member order', () => {
		const variants = [
			'{"long_first_column":1}',
			'{"long_first_column":2,"long_second_column":3}',
			'{"long_second_column":4}',
		];
		const input =
			'[' + Array.from({ length: 30 }, (_, index) => variants[index % 3]).join(',') + ']';
		const result = compressJsonTable(input);
		expect(result?.text.split('\n')[1]).toBe('["long_first_column","long_second_column"]');
		expect(restoreTable(result!.text)).toBe(input);
	});

	it.each([
		'null',
		'42',
		'"scalar"',
		'[]',
		'{"column":{"nested":1}}',
		'{"column":[1,2]}',
		'{"long_column":1,"long_column":2}',
		'{"long_column":1,"long_\\u0063olumn":2}',
	])(
		'declines mixed, nested or duplicate-key rows without producing a partial table: %s',
		(row) => {
			const prefix = Array.from({ length: 30 }, () => '{"long_column":1}');
			expect(compressJsonTable('[' + [...prefix, row].join(',') + ']')).toBeNull();
		}
	);

	it('declines conflicting key spelling or member order rather than losing source evidence', () => {
		const prefix = Array.from(
			{ length: 30 },
			() => '{"long_first_column":1,"long_second_column":2}'
		);
		for (const row of [
			'{"long_\\u0066irst_column":3,"long_second_column":4}',
			'{"long_second_column":3,"long_first_column":4}',
			'{"new_column":3,"long_first_column":4}',
		]) {
			expect(compressJsonTable('[' + [...prefix, row].join(',') + ']')).toBeNull();
		}
	});

	it.each([
		'',
		'plain text',
		'{}',
		'[]',
		'[{},{}]',
		'[{"only_row":1}]',
		'[{"x":1},{"x":2}] trailing',
		'[{"x":"bad\\q"},{"x":2}]',
		'[{"x":"literal\nnewline"},{"x":2}]',
		'[{"x":NaN},{"x":2}]',
		'[{"x":01},{"x":2}]',
	])('declines invalid, empty or unsuitable documents: %s', (input) => {
		expect(compressJsonTable(input)).toBeNull();
	});

	it('requires a reduction after the label/schema and against ordinary minification', () => {
		const compact = '[{"x":1},{"x":2}]';
		const pretty = JSON.stringify(JSON.parse(compact), null, 10).padStart(1000, ' ');
		expect(compressJsonTable(compact)).toBeNull();
		expect(compressJsonTable(pretty)).toBeNull();
		expect(compressJson(pretty)).toEqual({ text: compact, applied: ['json'] });
	});

	it('bounds the input scan before parsing, including otherwise removable whitespace', () => {
		const compact = JSON.stringify(rows(30));
		const atLimit = compact.padStart(262_144, ' ');
		expect(compressJsonTable(atLimit)?.compressor).toBe('json-table');
		expect(compressJsonTable(' ' + atLimit)).toBeNull();
		expect(compressJsonTable('['.repeat(258) + '0' + ']'.repeat(258))).toBeNull();
	});

	it('bounds row count, schema width and rectangular cells including sparse cells', () => {
		const row = '{"long_scalar_column":0}';
		const makeRows = (count: number) =>
			'[' + Array.from({ length: count }, () => row).join(',') + ']';
		expect(compressJsonTable(makeRows(2_000))?.compressor).toBe('json-table');
		expect(compressJsonTable(makeRows(2_001))).toBeNull();
		const wideRow = Object.fromEntries(Array.from({ length: 64 }, (_, index) => ['c' + index, 0]));
		const atCellLimit = Array.from({ length: 256 }, () => wideRow);
		expect(compressJsonTable(JSON.stringify(atCellLimit))?.compressor).toBe('json-table');
		expect(compressJsonTable(JSON.stringify([...atCellLimit, {}]))).toBeNull();
		expect(compressJsonTable(JSON.stringify([wideRow, { ...wideRow, extra: 0 }]))).toBeNull();
	});

	it('prefers a reversible table to lossy sampling while retaining the existing JSON fallback', () => {
		const input = JSON.stringify(rows(100));
		const existing = compressJson(input);
		expect(existing?.applied).toEqual(['json']);
		expect(existing?.text).toContain('[maestro: 85 of 100 items omitted]');
		const table = compressJsonTable(input);
		expect(table).not.toBeNull();
		expect(compressWithHeuristics(input)).toEqual({ text: table?.text, applied: ['json-table'] });
		expect(restoreTable(table!.text)).toBe(input);
		const nested = JSON.stringify({ items: rows(100) });
		expect(compressJsonTable(nested)).toBeNull();
		expect(compressJson(nested)?.text).toContain('[maestro: 85 of 100 items omitted]');
		expect(compressWithHeuristics(nested)).toEqual(compressJson(nested));
		for (const input of ['[ {"x":1}, {"x":2} ]', '[{"x":1},{"x":{"y":2}}]']) {
			expect(compressJsonTable(input)).toBeNull();
			expect(compressWithHeuristics(input)).toEqual(compressJson(input));
		}
	});
});

describe('compressJson', () => {
	it('minifies a document and reports the json compressor', () => {
		const pretty = JSON.stringify({ a: 1, b: { c: [1, 2, 3] } }, null, 2);
		expect(compressJson(pretty)).toEqual({ text: '{"a":1,"b":{"c":[1,2,3]}}', applied: ['json'] });
	});

	it('returns the text itself, with nothing applied, when it is already minimal', () => {
		const text = '{"a":1,"b":[1,2,3]}';
		expect(compressJson(text)).toEqual({ text, applied: [] });
	});

	it('samples a long array: head, a count of what was left out, tail', () => {
		const data = rows(100);
		const result = compressJson(JSON.stringify(data));
		const out = JSON.parse(result?.text ?? 'null') as unknown[];

		expect(out).toHaveLength(JSON_ARRAY_HEAD_ITEMS + 1 + JSON_ARRAY_TAIL_ITEMS);
		expect(out.slice(0, JSON_ARRAY_HEAD_ITEMS)).toEqual(data.slice(0, JSON_ARRAY_HEAD_ITEMS));
		expect(out[JSON_ARRAY_HEAD_ITEMS]).toBe('[maestro: 85 of 100 items omitted]');
		expect(out.slice(-JSON_ARRAY_TAIL_ITEMS)).toEqual(data.slice(-JSON_ARRAY_TAIL_ITEMS));
		expect(result?.applied).toEqual(['json']);
	});

	it('samples arrays wherever they sit, and leaves short ones whole', () => {
		const doc = { meta: { tags: ['a', 'b', 'c'] }, pages: [{ items: rows(60) }] };
		const out = JSON.parse(compressJson(JSON.stringify(doc))?.text ?? 'null') as typeof doc;
		expect(out.meta.tags).toEqual(['a', 'b', 'c']);
		expect(out.pages[0].items).toHaveLength(JSON_ARRAY_HEAD_ITEMS + 1 + JSON_ARRAY_TAIL_ITEMS);
		expect(out.pages[0].items[JSON_ARRAY_HEAD_ITEMS]).toBe('[maestro: 45 of 60 items omitted]');
	});

	it('does not sample a long array of small items: the note would save nothing', () => {
		const numbers = Array.from({ length: 30 }, (_, n) => n);
		const text = JSON.stringify(numbers);
		expect(compressJson(text)).toEqual({ text, applied: [] });
	});

	it('copies numbers and strings as the text they were', () => {
		// 2^53 is where a parsed number starts to round; the escapes must not be
		// re-spelled either.
		const text = String.raw`{ "id": 12345678901234567890, "big": 1.0e400, "s": "tab\there \/ slash" }`;
		expect(compressJson(text)?.text).toBe(
			String.raw`{"id":12345678901234567890,"big":1.0e400,"s":"tab\there \/ slash"}`
		);
	});

	it('is not JSON for anything but one object or array', () => {
		expect(compressJson('plain text')).toBeNull();
		expect(compressJson('{"a":1} trailing')).toBeNull();
		expect(compressJson('{not json}')).toBeNull();
		expect(compressJson('"a string"')).toBeNull();
		expect(compressJson('42')).toBeNull();
		expect(compressJson('')).toBeNull();
	});

	it('runs the line compressors over a long string value and stays valid JSON', () => {
		// The shape of a shell tool result: one large field holding the output.
		const output = Array.from({ length: 200 }, () => 'retrying connection to db').join('\n');
		const text = JSON.stringify({ output, metadata: { exit_code: 1 } });
		const result = compressJson(text);
		const out = JSON.parse(result?.text ?? 'null') as { output: string; metadata: unknown };

		expect(out.output).toBe(
			'retrying connection to db\n[maestro: previous line repeated 199 more times]'
		);
		expect(out.metadata).toEqual({ exit_code: 1 });
		expect(result?.applied).toEqual(['json', 'logs']);
	});

	it('never truncates the document itself as one long line', () => {
		const text = JSON.stringify(
			Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`key_${n}`, `value ${n}`]))
		);
		expect(text.length).toBeGreaterThan(LONG_LINE_MAX_CHARS);
		// Already minimal, nothing to sample, no long value: it comes back whole.
		expect(compressWithHeuristics(text)).toEqual({ text, applied: [] });
	});
});

describe('compressLogs', () => {
	it('folds a repeated line into one copy and a count', () => {
		const text = ['start', ...Array.from({ length: 40 }, () => 'INFO heartbeat ok'), 'end'].join(
			'\n'
		);
		expect(compressLogs(text)).toBe(
			'start\nINFO heartbeat ok\n[maestro: previous line repeated 39 more times]\nend'
		);
	});

	it('folds a repeated block of lines', () => {
		const frame = ['  at handler (server.js:10:5)', '  at next (router.js:44:9)'];
		const text = ['Error: boom', ...frame, ...frame, ...frame, ...frame, 'done'].join('\n');
		expect(compressLogs(text)).toBe(
			['Error: boom', ...frame, '[maestro: previous 2 lines repeated 3 more times]', 'done'].join(
				'\n'
			)
		);
	});

	it('leaves a repeat alone when the note would be longer than what it replaces', () => {
		const text = 'ok\nok\nok\n\n\n\nend';
		expect(compressLogs(text)).toBe(text);
	});

	it('strips terminal escapes', () => {
		expect(compressLogs('\x1b[31merror:\x1b[0m build failed\x1b[K')).toBe('error: build failed');
	});

	it('keeps the last frame of a carriage-return progress line', () => {
		expect(compressLogs('fetch 10%\rfetch 55%\rfetch 100%\ndone')).toBe('fetch 100%\ndone');
	});

	it('returns the same text when there is nothing to do', () => {
		const text = 'one\ntwo\nthree';
		expect(compressLogs(text)).toBe(text);
	});
});

describe('truncateLongLines', () => {
	it('cuts a long line and says how much was cut', () => {
		const long = 'x'.repeat(LONG_LINE_MAX_CHARS + 500);
		const out = truncateLongLines(`short\n${long}\nalso short`);
		expect(out).toBe(
			`short\n${'x'.repeat(LONG_LINE_KEEP_CHARS)} [maestro: ${
				LONG_LINE_MAX_CHARS + 500 - LONG_LINE_KEEP_CHARS
			} more characters on this line]\nalso short`
		);
	});

	it('leaves a line at the limit alone', () => {
		const text = `${'y'.repeat(LONG_LINE_MAX_CHARS)}\n${'z'.repeat(10)}`;
		expect(truncateLongLines(text)).toBe(text);
	});

	it('never cuts between the halves of a surrogate pair', () => {
		const emoji = String.fromCodePoint(0x1f600);
		// The pair straddles the cut point.
		const line = 'a'.repeat(LONG_LINE_KEEP_CHARS - 1) + emoji + 'b'.repeat(LONG_LINE_MAX_CHARS);
		const kept = truncateLongLines(line).split(' [maestro:')[0];
		expect(kept).toBe('a'.repeat(LONG_LINE_KEEP_CHARS - 1));
	});
});

describe('compressWithHeuristics', () => {
	it('keeps a unique middle diagnostic and names each shortened region', () => {
		const noise = 'x'.repeat(3000);
		const error = 'Error: missing signing certificate at src/release/sign.ts:83:7';
		const text = [noise, error, noise].join('\n');
		const result = compressWithHeuristics(text);
		const cut = `${'x'.repeat(800)} [maestro: 2200 more characters on this line]`;
		expect(result).toEqual({ text: [cut, error, cut].join('\n'), applied: ['long-lines'] });
		expect(result.text.length).toBeLessThan(text.length);
	});

	it.each([
		'Error: resolution failed',
		'warning TS6133: unused binding',
		'/tmp/工程/مقدمه/source.ts:41:8',
		'src/space name/écran.ts(31,4)',
		String.raw`C:\work\工程\source.ts:41:8`,
		'widget.ts:19:2',
		'https://example.invalid/build/735?artifact=release',
		'commit 9bcf84186d4f69e58553ab028597342d92b7ec19a',
		'request_id=req_fixture_4',
		'235187e7-2811-4232-9591-d9cb7f78be0b',
		'account 9007199254740993123',
		'ACCESS_TOKEN=fixture_value_for_preservation',
	])('preserves complete evidence beyond the old cut point: %s', (evidence) => {
		const line = `${'x'.repeat(1400)} ${evidence}`;
		const text = ['z'.repeat(4000), line, 'q'.repeat(4000)].join('\n');
		const result = compressWithHeuristics(text);
		expect(result.text.split('\n')[1]).toBe(line);
		expect(result.text.length).toBeLessThan(text.length);
		expect(result.applied).toEqual(['long-lines']);
		expect(compressWithHeuristics(text)).toEqual(result);
	});

	it('keeps causal stack sections and counts repeated frame blocks', () => {
		const frames = [
			'    at parse (/tmp/工程/parse.ts:41:8)',
			'    at serve (/tmp/工程/server.ts:90:3)',
		];
		const continuation = `    context ${'x'.repeat(1800)}`;
		const diagnostic = [
			'Error: connection closed',
			...frames,
			...frames,
			...frames,
			continuation,
			'Caused by: TypeError: missing reader',
			'    at open (/tmp/工程/io.ts:11:2)',
		].join('\n');
		const text = `${diagnostic}\n\n${'z'.repeat(4000)}`;
		const result = compressWithHeuristics(text);
		expect(result.text).toContain(
			[
				'Error: connection closed',
				...frames,
				'[maestro: previous 2 lines repeated 2 more times]',
				continuation,
				'Caused by: TypeError: missing reader',
				'    at open (/tmp/工程/io.ts:11:2)',
			].join('\n')
		);
		expect(result.applied).toEqual(['logs', 'long-lines']);
	});

	it('keeps long indented explanations after a folded diagnostic header', () => {
		const header = 'Error: dependency could not be loaded';
		const explanation = `    detail ${'x'.repeat(2000)}`;
		const text = [header, header, header, header, explanation].join('\n');
		expect(compressWithHeuristics(text)).toEqual({
			text: [header, '[maestro: previous line repeated 3 more times]', explanation].join('\n'),
			applied: ['logs'],
		});
	});

	it('budgets distinct evidence while still folding a large repeated stack', () => {
		const frame = '    at parse (/tmp/工程/parse.ts:41:8)';
		const text = `Error: recursion exhausted\n${Array.from({ length: 600 }, () => frame).join('\n')}`;
		expect(text.length).toBeGreaterThan(16_000);
		expect(compressWithHeuristics(text)).toEqual({
			text: `Error: recursion exhausted\n${frame}\n[maestro: previous line repeated 599 more times]`,
			applied: ['logs'],
		});
	});

	it('keeps Python traceback excerpts and the final exception', () => {
		const excerpt = `    ${'x'.repeat(1900)}`;
		const trace = [
			'Traceback (most recent call last):',
			'  File "/tmp/工程/reader.py", line 54, in read',
			excerpt,
			'    ^^^^^^^^^',
			'ValueError: invalid record',
		].join('\n');
		const result = compressWithHeuristics(`${'z'.repeat(4000)}\n${trace}`);
		expect(result.text).toContain(trace);
		expect(result.applied).toEqual(['long-lines']);
	});

	it('retains the exact original when distinct protected evidence exceeds its budget', () => {
		for (const text of [
			`\x1b[31mError: ${'x'.repeat(16_000)}\x1b[0m\n${'z'.repeat(4000)}`,
			Array.from({ length: 80 }, (_, n) => `warning ${n}: ${'x'.repeat(220)}`).join('\n'),
		]) {
			expect(compressWithHeuristics(text)).toEqual({ text, applied: [] });
			expect(compressLogs(text)).toBe(text);
			expect(truncateLongLines(text)).toBe(text);
		}
	});

	it('bounds the evidence scan by characters and line count without shortening', () => {
		for (const text of ['x'.repeat(256 * 1024 + 1), 'ordinary\n'.repeat(10_001)]) {
			expect(compressWithHeuristics(text)).toEqual({ text, applied: [] });
			expect(compressLogs(text)).toBe(text);
			expect(truncateLongLines(text)).toBe(text);
		}
	});

	it('retains evidence that a carriage-return overwrite would conceal', () => {
		const text = `\x1b[31mE\x1b[0mrror: ${'x'.repeat(1400)}\rprogress complete\n${'z'.repeat(4000)}`;
		expect(compressLogs(text)).toBe(text);
		expect(compressWithHeuristics(text)).toEqual({ text, applied: [] });
	});

	it('recognizes evidence even when ANSI splits a diagnostic word', () => {
		const text = `E\x1b[31mrror\x1b[0m: ${'x'.repeat(1800)}`;
		expect(truncateLongLines(text)).toBe(text);
	});

	it('still normalizes ANSI/CRLF and ordinary progress without cutting diagnostics', () => {
		const evidence = `\x1b[33mwarning: ${'x'.repeat(1300)}\x1b[0m\r\n`;
		const result = compressWithHeuristics(`fetch 10%\rfetch 100%\n${evidence}`);
		expect(result).toEqual({
			text: `fetch 100%\nwarning: ${'x'.repeat(1300)}\n`,
			applied: ['logs'],
		});
	});

	it('protects evidence inside a JSON output field without rounding numeric lexemes', () => {
		const error = `Error: failed at /tmp/工程/input.ts:19:2 ${'x'.repeat(1500)}`;
		const text = `{"id":9007199254740993123,"output":${JSON.stringify(
			['z'.repeat(4000), error, 'q'.repeat(4000)].join('\n')
		)}}`;
		const result = compressWithHeuristics(text);
		expect(result.text).toContain('"id":9007199254740993123');
		expect(JSON.parse(result.text).output.split('\n')[1]).toBe(error);
		expect(result.applied).toEqual(['json', 'long-lines']);
	});

	it('keeps the original when every long line is protected and no reduction fits', () => {
		const text = `Error: ${'x'.repeat(5000)}`;
		expect(compressWithHeuristics(text)).toEqual({ text, applied: [] });
		expect(truncateLongLines(text)).toBe(text);
	});

	it('runs logs, then long lines, over a text that is not JSON', () => {
		const text = [
			...Array.from({ length: 50 }, () => 'WARN slow query'),
			'q'.repeat(LONG_LINE_MAX_CHARS * 2),
		].join('\n');
		const result = compressWithHeuristics(text);
		expect(result.applied).toEqual(['logs', 'long-lines']);
		expect(result.text.split('\n')).toHaveLength(3);
	});

	it('applies nothing to ordinary source text', () => {
		const text = Array.from({ length: 80 }, (_, n) => `const value${n} = compute(${n});`).join(
			'\n'
		);
		expect(compressWithHeuristics(text)).toEqual({ text, applied: [] });
	});

	it('gives the same bytes for the same input, every time', () => {
		const inputs = [
			JSON.stringify({ rows: rows(500), log: 'retry\n'.repeat(300) }, null, 2),
			`${'\x1b[2K'}${'building...\n'.repeat(400)}${'z'.repeat(5000)}`,
		];
		for (const input of inputs) {
			const first = compressWithHeuristics(input);
			const second = compressWithHeuristics(input);
			expect(second).toEqual(first);
			expect(first.text.length).toBeLessThan(input.length);
		}
	});
});
