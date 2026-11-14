/**
 * @file token-proxy-replay.test.ts
 *
 * The token proxy's real compressors, replayed offline over the user's own
 * Claude Code transcripts. Every earlier decision about the proxy rested on a
 * synthetic session or two; this answers from real tool results:
 *
 *   - how the tool-result volume splits by tool (file reads against shell
 *     output) and by size;
 *   - how much of it each profile can touch, and what each profile saves
 *     (`full` is a result the model already read, `complete` is a fresh one in
 *     `compress-early` mode);
 *   - how much is repeated inside one session;
 *   - what that is worth in prompt cost units.
 *
 * Each result is decided by `compressRequestBody()` itself over a minimal
 * request body that holds that one result, never by a copy of its rules. The
 * cache is a scratch directory this test removes; the model tier is stubbed
 * to `skipped`, so nothing is paid for.
 *
 * PRIVACY. The transcripts hold private work. The report holds numbers and the
 * tool bucket names only, never a path, a directory or project name, a tool or
 * server name, a command, or any tool-result text. The test asserts that before
 * it passes.
 *
 * Reads the transcripts, so it is opt-in. SKIPPED unless
 *   MAESTRO_TOKEN_PROXY_REPLAY=1
 * Inputs:
 *   MAESTRO_TOKEN_PROXY_REPLAY_DIRS       transcript roots, separated by the
 *                                         platform's path delimiter (default
 *                                         ~/.claude/projects and ~/.claude-pai/projects)
 *   MAESTRO_TOKEN_PROXY_REPLAY_DAYS       by file modification time (default 14)
 *   MAESTRO_TOKEN_PROXY_REPLAY_MAX_BYTES  newest files first (default 3 GB)
 *   MAESTRO_TOKEN_PROXY_REPLAY_REPORT     where the Markdown report goes
 * Run with:
 *   MAESTRO_TOKEN_PROXY_REPLAY=1 MAESTRO_TOKEN_PROXY_REPLAY_REPORT="$PWD/docs/research/token-proxy-replay-2026-11.md" npx vitest run src/__tests__/main/local-models/proxy/token-proxy-replay.test.ts
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

const RUN = process.env.MAESTRO_TOKEN_PROXY_REPLAY === '1';

/** Scratch space for the compression cache. Nothing here is the user's real cache. */
const { SCRATCH } = vi.hoisted(() => {
	const fs = require('fs') as typeof import('fs');
	const nodeOs = require('os') as typeof import('os');
	const nodePath = require('path') as typeof import('path');
	return {
		SCRATCH: fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'maestro-token-proxy-replay-')),
	};
});

vi.mock('electron', () => ({
	app: { getPath: () => SCRATCH },
	safeStorage: { isEncryptionAvailable: () => false },
}));

import {
	compressRequestBody,
	DEFAULT_COMPRESS_MIN_TOKENS,
	DEFAULT_MODEL_MIN_TOKENS,
	type CompressRequestResult,
} from '../../../../main/local-models/proxy/compress';
import { createCompressionCache } from '../../../../main/local-models/proxy/compression-cache';
import { forEachJsonlLine } from '../../../../main/utils/jsonl-stream';
import { estimateTokenCount, formatCount, formatSize } from '../../../../shared/formatters';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function numberEnv(name: string, fallback: number): number {
	const raw = (process.env[name] ?? '').trim();
	const value = raw === '' ? NaN : Number(raw);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

const DAYS = numberEnv('MAESTRO_TOKEN_PROXY_REPLAY_DAYS', 14);
const MAX_BYTES = numberEnv('MAESTRO_TOKEN_PROXY_REPLAY_MAX_BYTES', 3 * 1024 * 1024 * 1024);
const REPORT_PATH =
	(process.env.MAESTRO_TOKEN_PROXY_REPLAY_REPORT ?? '').trim() ||
	path.join(os.tmpdir(), 'token-proxy-replay.md');
const ROOTS = (
	(process.env.MAESTRO_TOKEN_PROXY_REPLAY_DIRS ?? '').trim()
		? (process.env.MAESTRO_TOKEN_PROXY_REPLAY_DIRS as string).split(path.delimiter)
		: [
				path.join(os.homedir(), '.claude', 'projects'),
				path.join(os.homedir(), '.claude-pai', 'projects'),
			]
)
	.map((dir) => dir.trim())
	.filter(Boolean);

/** Results replayed at once. Each holds one tool result in memory. */
const CONCURRENCY = 16;

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

const BUCKETS = [
	'Bash',
	'Read',
	'Grep',
	'Glob',
	'Edit/Write',
	'Web',
	'Task',
	'mcp',
	'other',
] as const;
type Bucket = (typeof BUCKETS)[number];

function bucketOf(toolName: string | undefined): Bucket {
	if (!toolName) return 'other';
	if (toolName.startsWith('mcp__')) return 'mcp';
	switch (toolName) {
		case 'Bash':
		case 'BashOutput':
		case 'KillShell':
			return 'Bash';
		case 'Read':
			return 'Read';
		case 'Grep':
			return 'Grep';
		case 'Glob':
			return 'Glob';
		case 'Edit':
		case 'Write':
		case 'MultiEdit':
		case 'NotebookEdit':
			return 'Edit/Write';
		case 'WebFetch':
		case 'WebSearch':
			return 'Web';
		case 'Task':
		case 'Agent':
			return 'Task';
		default:
			return 'other';
	}
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Extensions read as prose, for the extractive-model bound. Classified here, never printed. */
const PROSE_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst']);

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

type Profile = 'full' | 'complete';
const PROFILES: readonly Profile[] = ['full', 'complete'];

interface Tally {
	count: number;
	tokens: number;
	cost: number;
}

function tally(): Tally {
	return { count: 0, tokens: 0, cost: 0 };
}

function add(target: Tally, tokens: number, cost: number): void {
	target.count++;
	target.tokens += tokens;
	target.cost += cost;
}

interface ProfileTally {
	eligibleResults: number;
	eligibleTokens: number;
	compressedResults: number;
	keptResults: number;
	savedTokens: number;
	costAfter: number;
}

function profileTally(): ProfileTally {
	return {
		eligibleResults: 0,
		eligibleTokens: 0,
		compressedResults: 0,
		keptResults: 0,
		savedTokens: 0,
		costAfter: 0,
	};
}

type ByBucket<T> = Record<Bucket, T>;

function byBucket<T>(make: () => T): ByBucket<T> {
	return Object.fromEntries(BUCKETS.map((bucket) => [bucket, make()])) as ByBucket<T>;
}

type ReadRepeat = 'identical' | 'contained' | 'neither';
const READ_REPEATS: readonly ReadRepeat[] = ['identical', 'contained', 'neither'];

interface Totals {
	results: ByBucket<Tally>;
	imageOnlyResults: number;
	bands: { small: Tally; medium: Tally; large: Tally };
	profiles: Record<Profile, ByBucket<ProfileTally>>;
	/** Combination of compressor ids -> bucket -> blocks and tokens saved. */
	compressors: Record<Profile, Map<string, ByBucket<{ blocks: number; saved: number }>>>;
	identicalText: ByBucket<Tally>;
	readRepeats: Record<ReadRepeat, Tally & { afterEdit: number; afterEditTokens: number }>;
	/** Read results at or over the threshold that neither profile shortens. */
	readUnshortened: { prose: Tally; other: Tally };
	readProse: { all: Tally; eligible: Tally };
	modelSized: Tally;
}

function emptyTotals(): Totals {
	return {
		results: byBucket(tally),
		imageOnlyResults: 0,
		bands: { small: tally(), medium: tally(), large: tally() },
		profiles: { full: byBucket(profileTally), complete: byBucket(profileTally) },
		compressors: { full: new Map(), complete: new Map() },
		identicalText: byBucket(tally),
		readRepeats: {
			identical: { ...tally(), afterEdit: 0, afterEditTokens: 0 },
			contained: { ...tally(), afterEdit: 0, afterEditTokens: 0 },
			neither: { ...tally(), afterEdit: 0, afterEditTokens: 0 },
		},
		readUnshortened: { prose: tally(), other: tally() },
		readProse: { all: tally(), eligible: tally() },
		modelSized: tally(),
	};
}

// ---------------------------------------------------------------------------
// Reading one transcript
// ---------------------------------------------------------------------------

interface ToolCall {
	name: string;
	input: unknown;
}

/** One tool result, held until the file is read and then replayed. */
interface PendingResult {
	id: string;
	call: ToolCall | undefined;
	bucket: Bucket;
	/** The result's content as the transcript holds it, text parts only. */
	content: string | Array<{ type: 'text'; text: string }>;
	isError: boolean | undefined;
	tokens: number;
	/** Distinct assistant messages in its segment before it, and the segment. */
	assistantAt: number;
	segment: number;
	prose: boolean;
	identicalText: boolean;
	readRepeat: ReadRepeat | null;
	readAfterEdit: boolean;
}

interface ReadSeen {
	hashes: Set<string>;
	lineSets: Set<string>[];
}

const NUMBERED_LINE = /^\s*(\d+)[\t→](.*)$/;

/** The `n<TAB>text` lines of a Read result, the form `cat -n` prints. */
function numberedLines(text: string): Set<string> {
	const lines = new Set<string>();
	for (const line of text.split('\n')) {
		const match = NUMBERED_LINE.exec(line);
		if (match) lines.add(`${match[1]}\t${match[2]}`);
	}
	return lines;
}

function textHash(text: string): string {
	return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function recordOf(line: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function asObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringField(value: unknown, key: string): string | undefined {
	const field = asObject(value)?.[key];
	return typeof field === 'string' ? field : undefined;
}

interface FileScan {
	pending: PendingResult[];
	/** Results with no text (images only), left out of every figure. */
	imageOnly: number;
	/** Distinct assistant messages in each segment (a compaction starts a new one). */
	segmentEnds: number[];
	sessionIds: Set<string>;
}

/**
 * Read one transcript line by line. Only `user` and `assistant` records are
 * conversation; the other record types (request blobs, snapshots) repeat
 * content that is already counted.
 */
async function scanTranscript(file: string, seenToolUseIds: Set<string>): Promise<FileScan> {
	const pending: PendingResult[] = [];
	let imageOnly = 0;
	const segmentEnds: number[] = [];
	const sessionIds = new Set<string>();
	const calls = new Map<string, ToolCall>();
	const seenTexts = new Set<string>();
	const reads = new Map<string, ReadSeen>();
	const editedSinceRead = new Set<string>();
	const assistantIds = new Set<string>();
	let assistantCount = 0;
	let segment = 0;

	const endSegment = () => {
		segmentEnds[segment] = assistantCount;
		segment++;
		assistantCount = 0;
		assistantIds.clear();
	};

	await forEachJsonlLine(file, (line) => {
		const record = recordOf(line);
		if (!record) return;
		const sessionId = record.sessionId;
		if (typeof sessionId === 'string') sessionIds.add(sessionId);
		const type = record.type;
		if (
			(type === 'system' && record.subtype === 'compact_boundary') ||
			record.isCompactSummary === true
		) {
			endSegment();
			return;
		}
		if (type !== 'user' && type !== 'assistant') return;
		const message = asObject(record.message);
		const content = message?.content;

		if (type === 'assistant') {
			// Claude Code writes one line per content block; one message is one request.
			const id = stringField(message, 'id');
			if (!id || !assistantIds.has(id)) {
				if (id) assistantIds.add(id);
				assistantCount++;
			}
			if (!Array.isArray(content)) return;
			for (const block of content) {
				if (stringField(block, 'type') !== 'tool_use') continue;
				const blockId = stringField(block, 'id');
				const name = stringField(block, 'name');
				if (!blockId || !name) continue;
				const input = asObject(block)?.input;
				calls.set(blockId, { name, input });
				const filePath = stringField(input, 'file_path') ?? stringField(input, 'notebook_path');
				if (EDIT_TOOLS.has(name) && filePath) editedSinceRead.add(filePath);
			}
			return;
		}

		if (!Array.isArray(content)) return;
		for (const block of content) {
			if (stringField(block, 'type') !== 'tool_result') continue;
			const id = stringField(block, 'tool_use_id');
			if (!id || seenToolUseIds.has(id)) continue;
			seenToolUseIds.add(id);
			const raw = asObject(block)?.content;
			let parts: string[];
			let stored: PendingResult['content'];
			if (typeof raw === 'string') {
				parts = [raw];
				stored = raw;
			} else if (Array.isArray(raw)) {
				const textParts = raw.flatMap((part) =>
					stringField(part, 'type') === 'text' && typeof asObject(part)?.text === 'string'
						? [{ type: 'text' as const, text: asObject(part)?.text as string }]
						: []
				);
				parts = textParts.map((part) => part.text);
				stored = textParts;
			} else {
				parts = [];
				stored = [];
			}
			if (parts.length === 0 || parts.every((part) => part === '')) {
				imageOnly++;
				continue;
			}
			const call = calls.get(id);
			const bucket = bucketOf(call?.name);
			const joined = parts.join('\n');
			const tokens = parts.reduce((sum, part) => sum + estimateTokenCount(part), 0);

			const hash = textHash(joined);
			const identicalText = seenTexts.has(hash);
			seenTexts.add(hash);

			let readRepeat: ReadRepeat | null = null;
			let readAfterEdit = false;
			let prose = false;
			const filePath = call?.name === 'Read' ? stringField(call.input, 'file_path') : undefined;
			if (filePath) {
				prose = PROSE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
				const lines = numberedLines(joined);
				const seen = reads.get(filePath);
				if (seen) {
					readAfterEdit = editedSinceRead.has(filePath);
					if (seen.hashes.has(hash)) readRepeat = 'identical';
					else if (
						lines.size > 0 &&
						seen.lineSets.some((earlier) => [...lines].every((key) => earlier.has(key)))
					)
						readRepeat = 'contained';
					else readRepeat = 'neither';
				}
				const entry = seen ?? { hashes: new Set<string>(), lineSets: [] };
				entry.hashes.add(hash);
				if (lines.size > 0) entry.lineSets.push(lines);
				reads.set(filePath, entry);
				editedSinceRead.delete(filePath);
			}

			const isError = asObject(block)?.is_error;
			pending.push({
				id,
				call,
				bucket,
				content: stored,
				isError: typeof isError === 'boolean' ? isError : undefined,
				tokens,
				assistantAt: assistantCount,
				segment,
				prose,
				identicalText,
				readRepeat,
				readAfterEdit,
			});
		}
	});
	segmentEnds[segment] = assistantCount;
	return { pending, imageOnly, segmentEnds, sessionIds };
}

// ---------------------------------------------------------------------------
// Replaying one result through the product
// ---------------------------------------------------------------------------

/**
 * The smallest Anthropic request that holds this result as an answered one: a
 * user turn after it, so the `full` profile may shorten it. `early` reads it
 * with the `complete` profile, as `compress-early` does for a fresh result.
 */
function requestBodyFor(result: PendingResult): string {
	const toolResult: Record<string, unknown> = {
		type: 'tool_result',
		tool_use_id: result.id,
		content: result.content,
	};
	if (result.isError !== undefined) toolResult.is_error = result.isError;
	const messages: unknown[] = [{ role: 'user', content: 'replay' }];
	if (result.call) {
		messages.push({
			role: 'assistant',
			content: [
				{ type: 'tool_use', id: result.id, name: result.call.name, input: result.call.input ?? {} },
			],
		});
	}
	messages.push(
		{ role: 'user', content: [toolResult] },
		{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
		{ role: 'user', content: 'next' }
	);
	return JSON.stringify({ model: 'replay', max_tokens: 1, messages });
}

/** Prompt cost units of a result carried whole: one cache write, then one read per later request. */
function passthroughCost(tokens: number, later: number): number {
	return tokens * (1.25 + 0.1 * later);
}

/**
 * `full`: the result goes out whole on the request after it, and shortened
 * from the next one on, which writes the shortened form once more.
 */
function fullCost(tokens: number, after: number, later: number): number {
	if (after === tokens || later <= 1) return passthroughCost(tokens, later);
	return 1.25 * tokens + after * (1.25 + 0.1 * (later - 1));
}

function eligibleTokensOf(result: PendingResult, replay: CompressRequestResult): number {
	if (replay.stats.compressed + replay.stats.kept === 0) return 0;
	const parts =
		typeof result.content === 'string' ? [result.content] : result.content.map((p) => p.text);
	return parts
		.map((part) => estimateTokenCount(part))
		.filter((tokens) => tokens >= DEFAULT_COMPRESS_MIN_TOKENS)
		.reduce((sum, tokens) => sum + tokens, 0);
}

async function replayResult(
	result: PendingResult,
	later: number,
	cache: ReturnType<typeof createCompressionCache>,
	totals: Totals
): Promise<void> {
	const body = requestBodyFor(result);
	const before = passthroughCost(result.tokens, later);
	add(totals.results[result.bucket], result.tokens, before);
	const band =
		result.tokens < DEFAULT_COMPRESS_MIN_TOKENS
			? totals.bands.small
			: result.tokens < DEFAULT_MODEL_MIN_TOKENS
				? totals.bands.medium
				: totals.bands.large;
	add(band, result.tokens, before);
	if (result.tokens >= DEFAULT_MODEL_MIN_TOKENS) add(totals.modelSized, result.tokens, before);
	if (result.identicalText) add(totals.identicalText[result.bucket], result.tokens, before);
	if (result.readRepeat) {
		const repeat = totals.readRepeats[result.readRepeat];
		add(repeat, result.tokens, before);
		if (result.readAfterEdit) {
			repeat.afterEdit++;
			repeat.afterEditTokens += result.tokens;
		}
	}
	if (result.bucket === 'Read' && result.prose) {
		add(totals.readProse.all, result.tokens, before);
		if (result.tokens >= DEFAULT_COMPRESS_MIN_TOKENS)
			add(totals.readProse.eligible, result.tokens, before);
	}

	const saved: Record<Profile, number> = { full: 0, complete: 0 };
	for (const profile of PROFILES) {
		const replay = await compressRequestBody('anthropic-messages', body, {
			cache,
			summarize: async () => ({ status: 'skipped' }),
			early: profile === 'complete',
		});
		const target = totals.profiles[profile][result.bucket];
		const eligible = eligibleTokensOf(result, replay);
		const savedTokens = replay.stats.originalTokens - replay.stats.compressedTokens;
		saved[profile] = savedTokens;
		const after = result.tokens - savedTokens;
		target.costAfter +=
			profile === 'full' ? fullCost(result.tokens, after, later) : passthroughCost(after, later);
		if (eligible > 0) {
			target.eligibleResults++;
			target.eligibleTokens += eligible;
			if (replay.stats.compressed > 0) target.compressedResults++;
			else target.keptResults++;
		}
		target.savedTokens += savedTokens;
		for (const block of replay.blocks) {
			const key = [...block.compressors].sort().join('+');
			const row = totals.compressors[profile].get(key) ?? byBucket(() => ({ blocks: 0, saved: 0 }));
			row[result.bucket].blocks++;
			row[result.bucket].saved += block.originalTokens - block.compressedTokens;
			totals.compressors[profile].set(key, row);
		}
	}
	if (
		result.bucket === 'Read' &&
		result.tokens >= DEFAULT_COMPRESS_MIN_TOKENS &&
		saved.full === 0 &&
		saved.complete === 0
	) {
		add(
			result.prose ? totals.readUnshortened.prose : totals.readUnshortened.other,
			result.tokens,
			before
		);
	}
}

async function inPool<T>(
	items: T[],
	limit: number,
	run: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const item = items[next++];
			await run(item);
		}
	});
	await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Finding the transcripts
// ---------------------------------------------------------------------------

interface TranscriptFile {
	file: string;
	size: number;
	mtimeMs: number;
	subagent: boolean;
}

function walkTranscripts(root: string, out: Map<string, TranscriptFile>, since: number): void {
	let entries: import('fs').Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) {
			walkTranscripts(full, out, since);
			continue;
		}
		if (!entry.name.endsWith('.jsonl')) continue;
		let real: string;
		try {
			real = realpathSync(full);
		} catch {
			continue;
		}
		if (out.has(real)) continue;
		const stat = statSync(real);
		if (!stat.isFile() || stat.mtimeMs < since) continue;
		out.set(real, {
			file: real,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			subagent: path.basename(path.dirname(real)) === 'subagents',
		});
	}
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function pct(part: number, whole: number): string {
	if (whole === 0) return '0.0%';
	const value = ((part / whole) * 100).toFixed(1);
	// Sums taken in a different order differ in the last bits; that is not a loss.
	return `${value === '-0.0' ? '0.0' : value}%`;
}

function n(value: number): string {
	return formatCount(Math.round(value));
}

function table(header: string[], rows: string[][]): string {
	const lines = [
		`| ${header.join(' | ')} |`,
		`| ${header.map(() => '---').join(' | ')} |`,
		...rows.map((row) => `| ${row.join(' | ')} |`),
	];
	return lines.join('\n');
}

interface RunInfo {
	files: number;
	subagentFiles: number;
	bytes: number;
	sessions: number;
	results: number;
	oldestMs: number;
	newestMs: number;
	cappedFiles: number;
	elapsedMs: number;
}

function day(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function renderReport(totals: Totals, info: RunInfo): string {
	const sum = (pick: (bucket: Bucket) => number) =>
		BUCKETS.reduce((acc, bucket) => acc + pick(bucket), 0);
	const allTokens = sum((b) => totals.results[b].tokens);
	const allCost = sum((b) => totals.results[b].cost);
	const allResults = sum((b) => totals.results[b].count);
	const out: string[] = [];

	out.push(
		'---',
		'type: research',
		'title: Token proxy replay over real Claude Code transcripts',
		`created: ${day(Date.now())}`,
		'tags:',
		'  - token-proxy',
		'  - local-models',
		'related:',
		"  - '[[local-models]]'",
		'---',
		'',
		'# Token proxy replay, 2026-11',
		'',
		'The token proxy compressors, replayed offline over real Claude Code transcripts by',
		'`token-proxy-replay.test.ts`. Each tool result was decided by `compressRequestBody()` itself, once',
		'with the `full` profile (a result the model has already read, `compress` mode) and once with the',
		'`complete` profile (a fresh result, `compress-early` mode). The model tier was stubbed to',
		'`skipped`, so these are the heuristics alone.',
		'',
		'## The run',
		'',
		`- Transcripts modified from ${day(info.oldestMs)} to ${day(info.newestMs)} (the last ${DAYS} days, newest first, capped at ${formatSize(MAX_BYTES)}).`,
		`- Files read: ${n(info.files)} (${n(info.subagentFiles)} of them subagent transcripts), ${formatSize(info.bytes)}.` +
			(info.cappedFiles > 0
				? ` ${n(info.cappedFiles)} older files in the window were left out by the byte cap.`
				: ''),
		`- Sessions: ${n(info.sessions)} distinct session ids. Each file is one context for the repeat and cost figures (a subagent has its own).`,
		`- Tool results with text: ${n(allResults)}. Results with no text (images only) are left out: ${n(totals.imageOnlyResults)}. A tool use id is counted once, even where a resumed session copied it.`,
		"- Tokens are estimated at 4 characters per token (`estimateTokenCount()`), the proxy's own estimate.",
		'- Repeat figures are upper bounds: the replay cannot see what a session had compacted away, so an',
		'  earlier result it counts against may no longer have been in the context.',
		`- The replay took ${(info.elapsedMs / 60000).toFixed(1)} minutes.`,
		''
	);

	out.push(
		'## 1. Volume by tool',
		'',
		table(
			['Bucket', 'Results', 'Tokens', 'Share of tokens', 'Cost units', 'Share of cost'],
			[
				...BUCKETS.map((b) => [
					b,
					n(totals.results[b].count),
					n(totals.results[b].tokens),
					pct(totals.results[b].tokens, allTokens),
					n(totals.results[b].cost),
					pct(totals.results[b].cost, allCost),
				]),
				['All', n(allResults), n(allTokens), '100.0%', n(allCost), '100.0%'],
			]
		),
		''
	);

	out.push(
		'## 2. Volume by size',
		'',
		table(
			['Result size', 'Results', 'Tokens', 'Share of tokens', 'Share of cost'],
			[
				['under 1000 tokens', totals.bands.small],
				['1000 to 8000', totals.bands.medium],
				['8000 or more', totals.bands.large],
			].map(([label, t]) => {
				const value = t as Tally;
				return [
					label as string,
					n(value.count),
					n(value.tokens),
					pct(value.tokens, allTokens),
					pct(value.cost, allCost),
				];
			})
		),
		'',
		`Results under ${DEFAULT_COMPRESS_MIN_TOKENS} tokens are never touched by either profile. Results of ${DEFAULT_MODEL_MIN_TOKENS} or more are the ones the model tier would be offered after the heuristics.`,
		''
	);

	out.push('## 3. What each profile saves', '');
	for (const profile of PROFILES) {
		const rows = totals.profiles[profile];
		const eligible = sum((b) => rows[b].eligibleTokens);
		const saved = sum((b) => rows[b].savedTokens);
		const costAfter = sum((b) => rows[b].costAfter);
		out.push(
			`### Profile \`${profile}\`${profile === 'full' ? ' (compress: the result was already read)' : ' (compress-early: the result is fresh)'}`,
			'',
			table(
				[
					'Bucket',
					'Eligible results',
					'Eligible tokens',
					'Shortened',
					'Kept',
					'Tokens saved',
					'Tokens after',
					'Saved of eligible',
					'Saved of all',
					'Cost after',
					'Cost saved',
				],
				[
					...BUCKETS.map((b) => {
						const r = rows[b];
						return [
							b,
							n(r.eligibleResults),
							n(r.eligibleTokens),
							n(r.compressedResults),
							n(r.keptResults),
							n(r.savedTokens),
							n(r.eligibleTokens - r.savedTokens),
							pct(r.savedTokens, r.eligibleTokens),
							pct(r.savedTokens, totals.results[b].tokens),
							n(r.costAfter),
							pct(totals.results[b].cost - r.costAfter, totals.results[b].cost),
						];
					}),
					[
						'All',
						n(sum((b) => rows[b].eligibleResults)),
						n(eligible),
						n(sum((b) => rows[b].compressedResults)),
						n(sum((b) => rows[b].keptResults)),
						n(saved),
						n(eligible - saved),
						pct(saved, eligible),
						pct(saved, allTokens),
						n(costAfter),
						pct(allCost - costAfter, allCost),
					],
				]
			),
			''
		);
		const combos = [...totals.compressors[profile].entries()].sort(
			(a, b) => sum((x) => b[1][x].saved) - sum((x) => a[1][x].saved)
		);
		out.push(
			`Tokens saved by compressor, \`${profile}\` (a block several compressors shortened is listed under their combination):`,
			'',
			combos.length === 0
				? 'No block was shortened.'
				: table(
						['Compressors', 'Blocks', ...BUCKETS, 'All'],
						combos.map(([key, row]) => [
							key,
							n(sum((b) => row[b].blocks)),
							...BUCKETS.map((b) => n(row[b].saved)),
							n(sum((b) => row[b].saved)),
						])
					),
			''
		);
	}

	const identicalTokens = sum((b) => totals.identicalText[b].tokens);
	out.push(
		'## 4. Repeats inside one session',
		'',
		'Results whose text equals an earlier result in the same transcript:',
		'',
		table(
			['Bucket', 'Repeats', 'Tokens', 'Share of the bucket tokens', 'Cost units'],
			[
				...BUCKETS.map((b) => [
					b,
					n(totals.identicalText[b].count),
					n(totals.identicalText[b].tokens),
					pct(totals.identicalText[b].tokens, totals.results[b].tokens),
					n(totals.identicalText[b].cost),
				]),
				[
					'All',
					n(sum((b) => totals.identicalText[b].count)),
					n(identicalTokens),
					pct(identicalTokens, allTokens),
					n(sum((b) => totals.identicalText[b].cost)),
				],
			]
		),
		'',
		'Read results for a file already read in that session. "Contained" means every numbered line',
		'(line number and text both equal) is in one earlier Read result of that file:',
		'',
		table(
			[
				'Re-read',
				'Results',
				'Tokens',
				'Share of Read tokens',
				'Cost units',
				'After an Edit or Write',
				'Tokens after an edit',
			],
			READ_REPEATS.map((kind) => {
				const r = totals.readRepeats[kind];
				return [
					kind,
					n(r.count),
					n(r.tokens),
					pct(r.tokens, totals.results.Read.tokens),
					n(r.cost),
					n(r.afterEdit),
					n(r.afterEditTokens),
				];
			})
		),
		''
	);

	out.push(
		'## 5. Prompt cost units',
		'',
		'For each result, L is the number of later assistant messages in its transcript, stopping at a',
		'compaction. Before: `tokens x (1.25 + 0.1 x L)`, one cache write and one cache read per later',
		'request. `complete`: the same formula over the shortened tokens. `full`: the result goes out whole',
		'once and shortened from the next request on, so `1.25 x tokens + after x (1.25 + 0.1 x (L - 1))`',
		'when it was shortened and L is 2 or more, and the passthrough cost otherwise. Units are one',
		'uncached input token.',
		'',
		table(
			['Bucket', 'Before', 'After `full`', 'Saved `full`', 'After `complete`', 'Saved `complete`'],
			[
				...BUCKETS.map((b) => {
					const before = totals.results[b].cost;
					const full = totals.profiles.full[b].costAfter;
					const complete = totals.profiles.complete[b].costAfter;
					return [
						b,
						n(before),
						n(full),
						pct(before - full, before),
						n(complete),
						pct(before - complete, before),
					];
				}),
				(() => {
					const full = sum((b) => totals.profiles.full[b].costAfter);
					const complete = sum((b) => totals.profiles.complete[b].costAfter);
					return [
						'All',
						n(allCost),
						n(full),
						pct(allCost - full, allCost),
						n(complete),
						pct(allCost - complete, allCost),
					];
				})(),
			]
		),
		''
	);

	out.push(
		'## 6. Figures for the candidates',
		'',
		'Raw bounds the next section reads. Extensions were classified during the replay; only counts are kept.',
		'',
		table(
			['Figure', 'Results', 'Tokens', 'Share of all tokens', 'Cost units'],
			[
				['Read results of markdown or text files', totals.readProse.all],
				['the same, 1000 tokens or more', totals.readProse.eligible],
				[
					'Read results of 1000 tokens or more that neither profile shortens, markdown or text',
					totals.readUnshortened.prose,
				],
				[
					'Read results of 1000 tokens or more that neither profile shortens, other files',
					totals.readUnshortened.other,
				],
				[`Results of ${DEFAULT_MODEL_MIN_TOKENS} tokens or more`, totals.modelSized],
			].map(([label, t]) => {
				const value = t as Tally;
				return [
					label as string,
					n(value.count),
					n(value.tokens),
					pct(value.tokens, allTokens),
					n(value.cost),
				];
			})
		),
		''
	);

	return out.join('\n');
}

/** Every name the report must not contain: each directory a transcript was read from. */
function forbiddenNames(files: TranscriptFile[], roots: string[]): Set<string> {
	const names = new Set<string>();
	const addSegments = (dir: string) => {
		for (const segment of dir.split(path.sep)) if (segment.length > 2) names.add(segment);
	};
	for (const root of roots) addSegments(root);
	for (const { file } of files) addSegments(path.dirname(file));
	return names;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

describe.skipIf(!RUN)(
	'token proxy replay over real transcripts (MAESTRO_TOKEN_PROXY_REPLAY=1)',
	() => {
		afterAll(() => {
			rmSync(SCRATCH, { recursive: true, force: true });
		});

		it(
			'replays every tool result through both profiles and writes a report with numbers only',
			async () => {
				const started = Date.now();
				const since = started - DAYS * DAY_MS;
				const roots = [
					...new Set(
						ROOTS.flatMap((dir) => {
							try {
								return [realpathSync(dir)];
							} catch {
								return [];
							}
						})
					),
				];
				expect(roots.length).toBeGreaterThan(0);

				const found = new Map<string, TranscriptFile>();
				for (const root of roots) walkTranscripts(root, found, since);
				const newestFirst = [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
				const selected: TranscriptFile[] = [];
				let bytes = 0;
				for (const file of newestFirst) {
					if (bytes + file.size > MAX_BYTES) break;
					selected.push(file);
					bytes += file.size;
				}
				expect(selected.length).toBeGreaterThan(0);

				const cacheDir = path.join(SCRATCH, 'proxy-cache');
				mkdirSync(cacheDir, { recursive: true });
				const cache = createCompressionCache({ dir: () => cacheDir });

				// The harness itself: a folded log in the request body this replay builds
				// must come back shortened, or every figure below would read as "kept".
				const probe: PendingResult = {
					id: 'toolu_replay_probe',
					call: { name: 'Bash', input: { command: 'cat build.log' } },
					bucket: 'Bash',
					content: 'INFO worker heartbeat ok\n'.repeat(400),
					isError: false,
					tokens: 0,
					assistantAt: 0,
					segment: 0,
					prose: false,
					identicalText: false,
					readRepeat: null,
					readAfterEdit: false,
				};
				for (const early of [false, true]) {
					const replay = await compressRequestBody('anthropic-messages', requestBodyFor(probe), {
						cache,
						summarize: async () => ({ status: 'skipped' }),
						early,
					});
					expect(replay.stats.compressed).toBe(1);
				}
				const totals = emptyTotals();
				const seenToolUseIds = new Set<string>();
				const sessions = new Set<string>();

				for (const file of selected) {
					let scan: FileScan;
					try {
						scan = await scanTranscript(file.file, seenToolUseIds);
					} catch {
						continue;
					}
					for (const id of scan.sessionIds) sessions.add(id);
					totals.imageOnlyResults += scan.imageOnly;
					await inPool(scan.pending, CONCURRENCY, (result) =>
						replayResult(
							result,
							Math.max(0, (scan.segmentEnds[result.segment] ?? 0) - result.assistantAt),
							cache,
							totals
						)
					);
				}

				const report = renderReport(totals, {
					files: selected.length,
					subagentFiles: selected.filter((file) => file.subagent).length,
					bytes,
					sessions: sessions.size,
					results: BUCKETS.reduce((acc, b) => acc + totals.results[b].count, 0),
					oldestMs: Math.min(...selected.map((file) => file.mtimeMs)),
					newestMs: Math.max(...selected.map((file) => file.mtimeMs)),
					cappedFiles: newestFirst.length - selected.length,
					elapsedMs: Date.now() - started,
				});

				// Privacy: nothing read from a transcript may reach the report.
				expect(report.split('Edit/Write').join('')).not.toContain('/');
				expect(report).not.toContain('mcp__');
				for (const name of forbiddenNames(selected, roots)) expect(report).not.toContain(name);

				mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
				writeFileSync(REPORT_PATH, `${report}\n`, 'utf-8');
				console.log(`token proxy replay: report written (${report.length} characters)`);
			},
			60 * 60 * 1000
		);
	}
);
