/**
 * The token proxy's heuristic compressors: pure functions from a tool result's
 * text to a shorter text.
 *
 * Each one is deterministic. The same input gives the same output in every
 * process and on every machine, with no clock, no randomness and no model, so
 * a tool result compresses to the same bytes on every turn and the provider's
 * cached prefix survives.
 *
 * Which compressor a text gets is decided by what the text IS, in this order:
 *
 *   1. **Scalar tables** ({@link compressJsonTable}): eligible arrays retain
 *      every key/value lexeme in a labelled table, before lossy JSON sampling.
 *   2. **JSON** ({@link compressJson}): a text that is one JSON object or
 *      array is minified, its long arrays are sampled (head, tail, and a count
 *      of what was left out), and its long string values get the two line
 *      compressors below. The result is still JSON. The line compressors are
 *      never run over the whole document: minified JSON is one line, and
 *      truncating that line would cut the structure in half.
 *   3. **Command output** ({@link compressCommandOutput}): recognized output
 *      shapes get their own labelled reduction, without command metadata.
 *   4. **Logs** ({@link compressLogs}): anything else has its terminal escapes
 *      stripped, its carriage-return overwrites collapsed, and its repeated
 *      lines (and repeated blocks of lines) folded into one copy and a count.
 *   5. **Long lines** ({@link truncateLongLines}): then unprotected lines past
 *      {@link LONG_LINE_MAX_CHARS} are cut, with a count of what was cut.
 *      Diagnostic evidence and causal sections stay whole. Uncertain or
 *      over-budget protection keeps the original instead of dropping evidence.
 *
 * Everything a compressor leaves out is named in the text it returns, in a
 * `[maestro: ...]` note, so the model reading it knows something is missing
 * and how much.
 *
 * Numbers and strings inside JSON are copied as the text they were, never
 * parsed and re-printed: an identifier past 2^53 survives.
 */

import { processCarriageReturns, stripAnsiCodes } from '../../../shared/stringUtils';
import { parseJsonSpans, stringValue, type JsonSpan } from './json-spans';

export type HeuristicCompressorId =
	| 'json'
	| 'logs'
	| 'long-lines'
	| 'git-status'
	| 'git-log'
	| 'search'
	| 'test-output'
	| 'build-output'
	| 'lint-output'
	| 'json-table';

export interface HeuristicCompression {
	/** The text after compression. Equal to the input when nothing applied. */
	text: string;
	/** The compressors that changed something, in the order they ran. */
	applied: HeuristicCompressorId[];
}

/**
 * Which reductions a caller accepts.
 *
 * - `full`: every reduction above, including the ones that leave content out
 *   (JSON array sampling, long-line cuts, Git message and search sampling).
 * - `complete`: only reductions that keep every line of content the agent could
 *   act on: minifying, lossless tables, terminal escapes, folding repeats into a
 *   count, grouping Git status, and removing padding or progress frames. This
 *   is what `compress-early` uses, because there the model never reads the
 *   original and has no way to ask for what was left out.
 */
export type HeuristicProfile = 'full' | 'complete';

export interface HeuristicOptions {
	/** Defaults to `full`. */
	profile?: HeuristicProfile;
}

/** Command-output reducers that sample records, and so are `full` only. */
const SAMPLING_COMMAND_REDUCERS: ReadonlySet<string> = new Set(['git-log', 'search']);

/** An array longer than this is sampled. */
export const JSON_ARRAY_MAX_ITEMS = 20;
/** Items kept from the start of a sampled array. */
export const JSON_ARRAY_HEAD_ITEMS = 10;
/** Items kept from the end of a sampled array. */
export const JSON_ARRAY_TAIL_ITEMS = 5;
/**
 * A long array is only sampled when what would be left out is at least this
 * many characters of source. Twenty-one small integers are not worth a note.
 */
export const JSON_ARRAY_MIN_OMITTED_CHARS = 256;

/** A line longer than this is cut. */
export const LONG_LINE_MAX_CHARS = 1000;
/** What is kept of a line that is cut. */
export const LONG_LINE_KEEP_CHARS = 800;

/** The longest run of lines that is checked for repeating as a block. */
export const REPEAT_BLOCK_MAX_LINES = 8;

/** Bound the synchronous evidence scan; larger texts keep their original bytes. */
const IMPORTANT_LINE_SCAN_MAX_CHARS = 256 * 1024;
const IMPORTANT_LINE_SCAN_MAX_LINES = 10_000;
/** Budget for distinct protected lines, so repeated stack frames can still fold. */
const IMPORTANT_LINE_MAX_CHARS = 16_000;

/** Bound both sparse schemas and rectangular table expansion. */
const JSON_TABLE_MAX_ROWS = 2_000;
const JSON_TABLE_MAX_COLUMNS = 64;
const JSON_TABLE_MAX_CELLS = 16_384;

function isDiagnosticLine(line: string): boolean {
	return /\b(?:\w*(?:error|exception)|warn(?:ing)?|fatal|panic|fail(?:ed|ure)?)\b|^\s*(?:Caused by:|Traceback\b|During handling\b|The above exception\b)/i.test(
		line
	);
}

/**
 * Evidence to keep whole, not a success/failure classifier. False positives
 * deliberately reduce compression. A null result vetoes shortening entirely.
 */
function importantLineIndexes(lines: string[]): Set<number> | null {
	if (lines.length > IMPORTANT_LINE_SCAN_MAX_LINES) return null;
	const important = new Set<number>();
	const distinct = new Set<string>();
	let chars = 0;
	let causal = false;
	for (let index = 0; index < lines.length; index++) {
		const raw = lines[index];
		const line = raw.includes('\x1b') || raw.includes('\x07') ? stripAnsiCodes(raw) : raw;
		const diagnostic = isDiagnosticLine(line);
		// Keep indented messages, source/caret excerpts and stack continuations
		// after a diagnostic, through the next blank or unindented ordinary line.
		causal =
			diagnostic ||
			(causal &&
				(/^\s+\S/.test(line) ||
					/^\[maestro: previous (?:line|\d+ lines) repeated \d+ more times?\]$/.test(line)));
		const evidence =
			causal ||
			/^\s*(?:at\s+\S|File\s+")/.test(line) ||
			/[/\\][^\s/\\]+|(?:^|\s)\S+\.\w+[:(]\d/.test(line) ||
			/\b(?:[a-f\d]{7,64}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|\d{16,})\b/i.test(line) ||
			/(?:^|\s)[\w.-]*(?:id|hash|sha|token|key)\s*[:=]\s*\S+/i.test(line);
		if (!evidence) continue;
		important.add(index);
		if (distinct.has(raw)) continue;
		distinct.add(raw);
		chars += raw.length + 1;
		if (chars > IMPORTANT_LINE_MAX_CHARS) return null;
	}
	return important;
}

function arrayNote(omitted: number, total: number): string {
	return `[maestro: ${omitted} of ${total} items omitted]`;
}

function repeatNote(period: number, repeats: number): string {
	const what = period === 1 ? 'previous line' : `previous ${period} lines`;
	return `[maestro: ${what} repeated ${repeats} more ${repeats === 1 ? 'time' : 'times'}]`;
}

function lineNote(cut: number): string {
	return ` [maestro: ${cut} more characters on this line]`;
}

/**
 * Content-only command-output candidates for the heuristic pipeline.
 * No command label, execution, filesystem access or context baseline is used.
 * Unknown/custom layouts return null for the existing heuristics to handle.
 */
export function compressCommandOutput(
	text: string,
	options: HeuristicOptions = {}
): {
	text: string;
	compressor: 'git-status' | 'git-log' | 'search' | 'test-output' | 'build-output' | 'lint-output';
} | null {
	const complete = options.profile === 'complete';
	if (text.length > IMPORTANT_LINE_SCAN_MAX_CHARS) return null;
	// Refuse NUL-delimited records, terminal control data and CR overwrites.
	// Tabs in search snippets remain exact; no terminal normalization is needed.
	for (const char of text) {
		const code = char.charCodeAt(0);
		if ((code < 32 && char !== '\n' && char !== '\t') || (code >= 127 && code <= 159)) {
			return null;
		}
	}
	const lines = text.split('\n');
	if (lines.at(-1) === '') lines.pop();
	if (lines.length === 0 || lines.length > IMPORTANT_LINE_SCAN_MAX_LINES) return null;
	const reducers = [
		['git-status', compressGitStatus],
		['git-log', compressGitLog],
		['search', compressSearchRecords],
		['test-output', compressTestOutput],
		['build-output', compressBuildOutput],
		['lint-output', compressLintOutput],
	] as const;
	for (const [compressor, reduce] of reducers) {
		if (complete && SAMPLING_COMMAND_REDUCERS.has(compressor)) continue;
		const reduced = reduce(lines);
		if (reduced === null) continue;
		const replacement = reduced + (text.endsWith('\n') ? '\n' : '');
		// Include all headings and omission notes in the reduction decision.
		return replacement.length < text.length ? { text: replacement, compressor } : null;
	}
	return null;
}

/** Group porcelain-v1/short XY records without interpreting their path spelling. */
function compressGitStatus(lines: string[]): string | null {
	const groups = new Map<string, string[]>();
	const branch = lines[0].startsWith('## ') ? lines[0] : null;
	for (const line of branch ? lines.slice(1) : lines) {
		const status = line.slice(0, 2);
		if (
			line[2] !== ' ' ||
			line.length < 4 ||
			status === '  ' ||
			!/^(?:[ MARCDT][ MARCDT]|\?\?|!!|DD|AU|UD|UA|DU|AA|UU)$/.test(status)
		) {
			return null;
		}
		// parseGitStatusPorcelain drops rename destinations and trims final path
		// whitespace. These opaque slices must preserve both, including quotes.
		const paths = groups.get(status) ?? [];
		paths.push(line.slice(3));
		groups.set(status, paths);
	}
	if (groups.size === 0) return null;
	const total = lines.length - (branch ? 1 : 0);
	const out = [`[maestro: Git status; ${total} entries grouped by XY; all paths retained]`];
	if (branch) out.push(branch);
	for (const [status, paths] of groups) {
		out.push(`[${status}] ${paths.length} entries`, ...paths);
	}
	return out.join('\n');
}

/** Default Git log only: exact commit/merge/author/date headers, indented messages. */
function compressGitLog(lines: string[]): string | null {
	const commit = /^commit (?:[a-f0-9]{40}|[a-f0-9]{64})(?: \([^\n]+\))?$/;
	const out: string[] = [];
	let index = 0;
	while (index < lines.length) {
		if (!commit.test(lines[index])) return null;
		out.push(lines[index++]);
		if (/^Merge: [a-f0-9]{7,64}(?: [a-f0-9]{7,64})+$/.test(lines[index] ?? '')) {
			out.push(lines[index++]);
		}
		if (!/^Author: .+ <[^<>]+>$/.test(lines[index] ?? '')) return null;
		out.push(lines[index++]);
		if (
			!/^Date: {3}(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} \d{2}:\d{2}:\d{2} \d{4} [+-]\d{4}$/.test(
				lines[index] ?? ''
			)
		) {
			return null;
		}
		out.push(lines[index++]);
		if (lines[index++] !== '') return null;
		out.push('');
		const message: string[] = [];
		while (index < lines.length && !commit.test(lines[index])) {
			const line = lines[index++];
			if (line !== '' && !line.startsWith('    ')) return null;
			message.push(line);
		}
		const subject = message.findIndex((line) => line.trim().length > 0);
		if (subject < 0) return null;
		const protectedLines = importantLineIndexes(message);
		if (protectedLines === null) return null;
		protectedLines.add(subject);
		out.push(...sampleCommandLines(message, protectedLines, 'Git message lines'));
	}
	return out.join('\n');
}

/**
 * Grep/rg filename:line[:column]:text records. Keep the whole numeric/text
 * suffix, since a numeric snippet can look exactly like a column field.
 * Context lines, count-only output, stats and nonnumeric colon-bearing paths
 * are unsupported. Numeric suffix ambiguity keeps every affected record.
 */
function compressSearchRecords(lines: string[]): string | null {
	const groups = new Map<string, Array<{ suffix: string; snippet: string }>>();
	for (const line of lines) {
		const match = /^([^:\t]+):([1-9]\d*):(.*)$/.exec(line);
		if (!match) return null;
		const [, file, number, snippet] = match;
		// A diagnostic prefix can resemble a filename:line record. The snippet
		// scan below must not hide diagnostics by stripping that prefix away.
		if (isDiagnosticLine(file)) return null;
		const records = groups.get(file) ?? [];
		records.push({ suffix: `${number}:${snippet}`, snippet });
		groups.set(file, records);
	}
	const out = [
		`[maestro: search; ${lines.length} output records in ${groups.size} filename prefixes; counts are records, not occurrences]`,
	];
	for (const [file, records] of groups) {
		const protectedLines = importantLineIndexes(records.map((record) => record.snippet));
		if (protectedLines === null) return null;
		for (let index = 0; index < records.length; index++) {
			// Always retain a sample from EVERY file, including a unique file
			// whose only result appears in the middle of the overall output.
			// Further numeric fields can belong to a column, snippet or even a
			// colon-bearing filename; keep those suffixes without guessing.
			if (
				records.length <= 8 ||
				index < 3 ||
				index >= records.length - 2 ||
				/(?:^|:)\d+:/.test(records[index].snippet)
			) {
				protectedLines.add(index);
			}
		}
		out.push(
			`[maestro: filename prefix ${JSON.stringify(file)}; ${records.length} records; original numeric/text suffixes]`,
			...sampleCommandLines(
				records.map((record) => record.suffix),
				protectedLines,
				'search records'
			)
		);
	}
	return out.join('\n');
}

/** Name every omitted region; retained lines are copied without truncation. */
function sampleCommandLines(lines: string[], keep: Set<number>, unit: string): string[] {
	const out: string[] = [];
	let index = 0;
	while (index < lines.length) {
		if (keep.has(index)) {
			out.push(lines[index++]);
			continue;
		}
		const start = index;
		while (index < lines.length && !keep.has(index)) index++;
		out.push(`[maestro: ${index - start} ${unit} omitted]`);
	}
	return out;
}

/**
 * Small, content-only validation formats used by Maestro's scripts: Vitest's
 * RUN/totals, Vite's production build and ESLint's warning-only stylish report.
 * No passing file, case, artifact, count or duration is sampled. Only known
 * status prefixes/alignment and named progress regions can be removed.
 * Unknown formats, incomplete summaries and conflicting failures fall back.
 */
function compressTestOutput(lines: string[]): string | null {
	const first = lines.find((line) => line.trim() !== '');
	if (!/^\s*RUN {2}v\d+\.\d+\.\d+(?:-[\w.-]+)? .+$/.test(first ?? '')) return null;
	const files = lines.findIndex((line) => /^\s*Test Files\s+/.test(line));
	const tests = lines.findIndex((line) => /^\s*Tests\s+/.test(line));
	if (
		files < 0 ||
		tests <= files ||
		!successfulTestTotals(lines[files], 'Test Files') ||
		!successfulTestTotals(lines[tests], 'Tests')
	) {
		return null;
	}
	// A complete footer is required. Do not silently accept a second command,
	// watch-mode restart, repeated totals or a truncated/unknown footer field.
	if (
		lines.slice(files + 1, tests).some((line) => line.trim() !== '') ||
		lines.slice(0, files).filter((line) => /^\s*RUN {2}v/.test(line)).length !== 1
	) {
		return null;
	}
	let previousField = -1;
	for (const line of lines.slice(tests + 1)) {
		const footer = line.trim();
		if (!footer) continue;
		if (
			!/^(?:Start at\s+\d{2}:\d{2}:\d{2}|Duration\s+\d+(?:\.\d+)?(?:ms|s)(?: \([^\n]+\))?|Exit code: 0)$/.test(
				footer
			)
		) {
			return null;
		}
		// Fields are optional, but duplicates/reordering can indicate merged runs.
		const field = footer.startsWith('Start at') ? 0 : footer.startsWith('Duration') ? 1 : 2;
		if (field <= previousField) return null;
		previousField = field;
	}
	const compacted = lines.map((line, index) => {
		if (index >= files) return line;
		// Only known root file/count/duration rows lose a checkmark. Nested cases
		// and unknown records keep their status and surrounding hierarchy.
		const pass = /^ ✓ (\S.* \(\d+ tests?(?: \| \d+ skipped)?\) \d+(?:\.\d+)?(?:ms|s))$/.exec(line);
		return pass && !isDiagnosticLine(pass[1]) ? pass[1] : line;
	});
	return validationOutput(
		lines,
		compacted,
		'Vitest: top-level ✓ prefixes omitted; all records retained'
	);
}

/** Explicit passed/skipped/todo totals, with no failed/unknown status or rounding. */
function successfulTestTotals(line: string, label: 'Test Files' | 'Tests'): boolean {
	const summary = line.trim().slice(label.length).trim();
	const match = /^(\d+) passed(?: \| (\d+) skipped)?(?: \| (\d+) todo)? \((\d+)\)$/.exec(summary);
	if (!match) return false;
	const counts = match.slice(1).map((value) => Number(value ?? 0));
	return (
		counts.every(Number.isSafeInteger) &&
		counts[0] > 0 &&
		counts[0] + counts[1] + counts[2] === counts[3]
	);
}

function compressBuildOutput(lines: string[]): string | null {
	const nonblank = lines.filter((line) => line.trim() !== '');
	if (
		!/^vite v\d+\.\d+\.\d+(?:-[\w.-]+)? building (?:client environment )?for production\.\.\.$/.test(
			nonblank[0] ?? ''
		) ||
		!/^✓ built in \d+(?:\.\d+)?(?:ms|s)$/.test(nonblank.at(-1) ?? '') ||
		lines.filter((line) => /^vite v/.test(line)).length !== 1 ||
		lines.filter((line) => /^✓ built in /.test(line)).length !== 1
	) {
		return null;
	}
	const keep = importantLineIndexes(lines);
	if (keep === null) return null;
	const compacted = lines.map((line, index) => {
		if (!/^(?:transforming|rendering chunks|computing gzip size)\.\.\.$/.test(line)) {
			keep.add(index);
		}
		// Vite's space-free dist paths and size columns only. Paths containing
		// spaces, custom output paths and unknown columns stay exactly as sent.
		const asset =
			/^(dist\/\S+) {2,}(\d+(?:\.\d+)? (?:kB|MB))(?: {2,}(\| gzip: +\d+(?:\.\d+)? (?:kB|MB)))?$/.exec(
				line
			);
		return asset ? `${asset[1]} ${asset[2]}${asset[3] ? ` ${asset[3]}` : ''}` : line;
	});
	return validationOutput(
		lines,
		sampleCommandLines(compacted, keep, 'Vite progress lines'),
		'Vite: column padding omitted; all artifacts/sizes retained'
	);
}

function compressLintOutput(lines: string[]): string | null {
	const nonblank = lines.filter((line) => line.trim() !== '');
	const summary = /^✖ (\d+) problems \(0 errors, (\d+) warnings\)$/.exec(nonblank.at(-1) ?? '');
	if (!summary || summary[1] !== summary[2] || !Number.isSafeInteger(Number(summary[1]))) {
		return null;
	}
	let warnings = 0;
	let hasFile = false;
	let fileWarnings = 0;
	const summaryIndex = lines.lastIndexOf(nonblank.at(-1)!);
	const compacted: string[] = [];
	for (const [index, line] of lines.entries()) {
		if (line.trim() === '' || index === summaryIndex) {
			compacted.push(line);
			continue;
		}
		const warning = /^ +(\d+:\d+) +warning +(.+)$/.exec(line);
		if (warning) {
			if (!hasFile) return null;
			warnings++;
			fileWarnings++;
			compacted.push(`${warning[1]} warning ${warning[2]}`);
		} else {
			// Stylish associates locations with an opaque, unindented filename.
			// A missing group, unknown continuation or extra summary is ambiguous.
			if (/^\s|^✖/.test(line) || (hasFile && fileWarnings === 0)) return null;
			hasFile = true;
			fileWarnings = 0;
			compacted.push(line);
		}
	}
	// Missing rows, merged reports and unsupported reporters are not a known
	// warning-only layout. Keep the summary and all warning/rule text exact.
	if (fileWarnings === 0 || warnings !== Number(summary[1])) return null;
	return validationOutput(
		lines,
		compacted,
		'ESLint: location/severity padding omitted; all warnings retained'
	);
}

function validationOutput(lines: string[], compacted: string[], note: string): string | null {
	if (importantLineIndexes(lines) === null) return null;
	// These are contradictions, not a general success detector. A warning may
	// contain the word "error"; retain it rather than treat all such prose as a
	// failed invocation. Explicit provider failures are vetoed before the cache.
	if (
		lines.some((line) =>
			/^\s*(?:FAIL(?:\s|$)|[×✗❯]|(?:\w*Error|ERROR|FATAL|panic):)|\b[1-9]\d* (?:failed|errors?)\b|\bexit(?:ed)?(?: with)? (?:code|status)\s*:?\s*[+-]?0*[1-9]\d*\b/i.test(
				line
			)
		)
	) {
		return null;
	}
	// Existing repeat folding keeps each distinct diagnostic and causal block,
	// naming every repeated region. It cannot invent totals or exit metadata.
	return `[maestro: ${note}]\n${compressLogs(compacted.join('\n'))}`;
}

/** Content-only dispatch; structured candidates never undergo whole-text line cuts. */
export function compressWithHeuristics(
	text: string,
	options: HeuristicOptions = {}
): HeuristicCompression {
	const table = compressJsonTable(text);
	if (table) return { text: table.text, applied: [table.compressor] };
	const json = compressJson(text, options);
	if (json) return json;
	const command = compressCommandOutput(text, options);
	return command
		? { text: command.text, applied: [command.compressor] }
		: compressPlainText(text, options);
}

/** The two line compressors, in order. The `complete` profile never cuts a line. */
function compressPlainText(text: string, options: HeuristicOptions = {}): HeuristicCompression {
	const applied: HeuristicCompressorId[] = [];
	const folded = compressLogs(text);
	// A raw carriage return surviving log normalization signals a veto.
	if (folded === text && text.includes('\r')) return { text, applied: [] };
	if (folded !== text) applied.push('logs');
	const cut = options.profile === 'complete' ? folded : truncateLongLines(folded);
	if (cut !== folded) applied.push('long-lines');
	// Every omission note is included in this comparison. The request layer
	// separately requires its recovery marker and minimum reduction to fit.
	if (cut.length >= text.length) return { text, applied: [] };
	return { text: cut, applied };
}

/**
 * Prepare a reversible scalar-row candidate for content-only dispatch.
 * Contract: docs/research/token-optimization-analysis.md, json-table v1.
 * Keys/cells keep their source lexemes; only inter-token whitespace is lost.
 * Valid JSON literals cannot contain the literal tab/newline delimiters.
 * A bare ~ is not a JSON value and unambiguously denotes an absent key.
 */
export function compressJsonTable(text: string): {
	text: string;
	compressor: 'json-table';
} | null {
	if (text.length > IMPORTANT_LINE_SCAN_MAX_CHARS) return null;
	const source = text.trim();
	if (source[0] !== '[') return null;
	try {
		// Validate string escapes/control characters; never render parsed values.
		JSON.parse(source);
	} catch (error) {
		if (error instanceof SyntaxError || error instanceof RangeError) return null;
		throw error;
	}
	const root = parseJsonSpans(source);
	if (root?.kind !== 'array' || root.items.length < 2 || root.items.length > JSON_TABLE_MAX_ROWS) {
		return null;
	}
	const columns = new Map<string, { index: number; literal: string }>();
	const rows: Map<string, string>[] = [];
	// Exact-lexeme minification size, including brackets and row separators.
	let minifiedLength = root.items.length + 1;
	for (const item of root.items) {
		if (item.kind !== 'object') return null;
		const row = new Map<string, string>();
		let previousColumn = -1;
		minifiedLength += 2 + Math.max(0, item.members.length - 1);
		for (const member of item.members) {
			if (member.value.kind !== 'scalar' && member.value.kind !== 'string') return null;
			if (row.has(member.key)) return null;
			const literal = source.slice(member.keyStart, member.keyEnd);
			let column = columns.get(member.key);
			if (!column) {
				if (columns.size >= JSON_TABLE_MAX_COLUMNS) return null;
				column = { index: columns.size, literal };
				columns.set(member.key, column);
				if (columns.size * root.items.length > JSON_TABLE_MAX_CELLS) return null;
			}
			// One schema must reconstruct each row's member order and key spelling.
			if (column.literal !== literal || column.index <= previousColumn) return null;
			previousColumn = column.index;
			const value = source.slice(member.value.start, member.value.end);
			row.set(member.key, value);
			minifiedLength += literal.length + 1 + value.length;
		}
		rows.push(row);
	}
	if (columns.size === 0) return null;
	const schema = `[${Array.from(columns.values(), (column) => column.literal).join(',')}]`;
	const encoded = [
		`[maestro: json-table v1; ${rows.length} rows; lossless scalar lexemes; tab-separated cells; ~ = missing key; keys below]`,
		schema,
		...rows.map((row) => Array.from(columns.keys(), (key) => row.get(key) ?? '~').join('\t')),
	].join('\n');
	// Include the format label/schema, and prefer minification if it is smaller.
	// Request integration owns the additional recovery marker/minimum savings.
	return encoded.length < Math.min(text.length, minifiedLength)
		? { text: encoded, compressor: 'json-table' }
		: null;
}

/**
 * Minify a JSON document, sample its long arrays and compress its long string
 * values. `null` when the text is not one JSON object or array, so the caller
 * treats it as lines instead.
 */
export function compressJson(
	text: string,
	options: HeuristicOptions = {}
): HeuristicCompression | null {
	const source = text.trim();
	if (source[0] !== '{' && source[0] !== '[') return null;
	try {
		JSON.parse(source);
	} catch (error) {
		// Not JSON (or nested deeper than the engine reads): a text of lines.
		if (error instanceof SyntaxError || error instanceof RangeError) return null;
		throw error;
	}
	const root = parseJsonSpans(source);
	if (!root) return null;

	const nested = new Set<HeuristicCompressorId>();
	const compressed = renderJson(source, root, nested, options);
	if (compressed === text) return { text, applied: [] };
	const applied: HeuristicCompressorId[] = ['json'];
	if (nested.has('logs')) applied.push('logs');
	if (nested.has('long-lines')) applied.push('long-lines');
	return { text: compressed, applied };
}

function renderJson(
	source: string,
	span: JsonSpan,
	nested: Set<HeuristicCompressorId>,
	options: HeuristicOptions
): string {
	switch (span.kind) {
		case 'scalar':
			return source.slice(span.start, span.end);
		case 'string':
			return renderJsonString(source, span, nested, options);
		case 'object':
			return `{${span.members
				.map(
					(member) =>
						`${source.slice(member.keyStart, member.keyEnd)}:${renderJson(source, member.value, nested, options)}`
				)
				.join(',')}}`;
		case 'array': {
			const items = options.profile === 'complete' ? span.items : sampledItems(span.items);
			if (items === span.items) {
				return `[${items.map((item) => renderJson(source, item, nested, options)).join(',')}]`;
			}
			const head = items.slice(0, JSON_ARRAY_HEAD_ITEMS);
			const tail = items.slice(JSON_ARRAY_HEAD_ITEMS);
			const omitted = span.items.length - items.length;
			return `[${[
				...head.map((item) => renderJson(source, item, nested, options)),
				JSON.stringify(arrayNote(omitted, span.items.length)),
				...tail.map((item) => renderJson(source, item, nested, options)),
			].join(',')}]`;
		}
	}
}

/** The items an array keeps: all of them (the same array), or its head and tail. */
function sampledItems(items: JsonSpan[]): JsonSpan[] {
	if (items.length <= JSON_ARRAY_MAX_ITEMS) return items;
	const firstOmitted = items[JSON_ARRAY_HEAD_ITEMS];
	const lastOmitted = items[items.length - JSON_ARRAY_TAIL_ITEMS - 1];
	if (lastOmitted.end - firstOmitted.start < JSON_ARRAY_MIN_OMITTED_CHARS) return items;
	return [
		...items.slice(0, JSON_ARRAY_HEAD_ITEMS),
		...items.slice(items.length - JSON_ARRAY_TAIL_ITEMS),
	];
}

/**
 * A string value as it was, unless it is long: a shell result is often a JSON
 * object whose one large field is the output, and that field is a text of
 * lines like any other.
 */
function renderJsonString(
	source: string,
	span: JsonSpan,
	nested: Set<HeuristicCompressorId>,
	options: HeuristicOptions
): string {
	const literal = source.slice(span.start, span.end);
	if (literal.length - 2 <= LONG_LINE_MAX_CHARS) return literal;
	const decoded = stringValue(source, span);
	if (decoded === undefined) return literal;
	const compressed = compressPlainText(decoded, options);
	if (compressed.applied.length === 0) return literal;
	for (const id of compressed.applied) nested.add(id);
	return JSON.stringify(compressed.text);
}

/**
 * Strip terminal escapes, collapse carriage-return overwrites (a progress bar
 * becomes its last frame), and fold repeated lines and blocks into one copy
 * and a count.
 */
export function compressLogs(text: string): string {
	if (text.length > IMPORTANT_LINE_SCAN_MAX_CHARS) return text;
	let cleaned = text;
	// Only a text that carries an escape or a bell is handed to the stripper:
	// it also removes bare shell-integration sequences, which plain text could
	// resemble.
	if (cleaned.includes('\x1b') || cleaned.includes('\x07')) cleaned = stripAnsiCodes(cleaned);
	const originalLines = cleaned.split('\n');
	const important = importantLineIndexes(originalLines);
	if (important === null) return text;
	// Ordinary CRLF is safe. An overwrite on an evidence-bearing line may
	// conceal a unique diagnostic in an earlier frame, so keep the raw text.
	for (const index of important) {
		if (originalLines[index].replace(/\r$/, '').includes('\r')) return text;
	}
	if (cleaned.includes('\r')) cleaned = processCarriageReturns(cleaned);
	const lines = cleaned.split('\n');
	const folded = foldRepeatedLines(lines);
	return folded === lines ? cleaned : folded.join('\n');
}

/** The lines with every repeat folded, or the same array when none was. */
function foldRepeatedLines(lines: string[]): string[] {
	const out: string[] = [];
	let folded = false;
	let at = 0;
	while (at < lines.length) {
		const repeat = repeatAt(lines, at);
		if (!repeat) {
			out.push(lines[at++]);
			continue;
		}
		for (let offset = 0; offset < repeat.period; offset++) out.push(lines[at + offset]);
		out.push(repeatNote(repeat.period, repeat.repeats));
		at += repeat.period * (repeat.repeats + 1);
		folded = true;
	}
	return folded ? out : lines;
}

/**
 * The repeat that starts at `at`: the shortest block (1 to
 * {@link REPEAT_BLOCK_MAX_LINES} lines) that is followed by copies of itself,
 * when folding those copies removes more text than the note adds.
 */
function repeatAt(lines: string[], at: number): { period: number; repeats: number } | null {
	for (let period = 1; period <= REPEAT_BLOCK_MAX_LINES; period++) {
		if (at + 2 * period > lines.length) break;
		let repeats = 0;
		while (sameBlock(lines, at, at + (repeats + 1) * period, period)) repeats++;
		if (repeats === 0) continue;
		let blockChars = period;
		for (let offset = 0; offset < period; offset++) blockChars += lines[at + offset].length;
		if (repeats * blockChars > repeatNote(period, repeats).length + 1) return { period, repeats };
	}
	return null;
}

function sameBlock(lines: string[], a: number, b: number, period: number): boolean {
	if (b + period > lines.length) return false;
	for (let offset = 0; offset < period; offset++) {
		if (lines[a + offset] !== lines[b + offset]) return false;
	}
	return true;
}

/** Cut unprotected long lines, saying how much was cut in each region. */
export function truncateLongLines(text: string): string {
	if (text.length <= LONG_LINE_MAX_CHARS) return text;
	if (text.length > IMPORTANT_LINE_SCAN_MAX_CHARS) return text;
	const lines = text.split('\n');
	const important = importantLineIndexes(lines);
	if (important === null) return text;
	let changed = false;
	const shortened = lines.map((line, index) => {
		if (line.length <= LONG_LINE_MAX_CHARS || important.has(index)) return line;
		changed = true;
		// Never between the halves of a surrogate pair.
		const last = line.charCodeAt(LONG_LINE_KEEP_CHARS - 1);
		const keep = last >= 0xd800 && last <= 0xdbff ? LONG_LINE_KEEP_CHARS - 1 : LONG_LINE_KEEP_CHARS;
		return `${line.slice(0, keep)}${lineNote(line.length - keep)}`;
	});
	return changed ? shortened.join('\n') : text;
}
