/**
 * Read and repetition opportunities in the context ONE model request shows.
 *
 * An agent that reads a file twice sends the second copy to the model as a
 * fresh tool result. While the first result is still in the model's context,
 * the second could have been "unchanged" or a small delta. This module finds
 * those pairs. It only OBSERVES: it does not edit a request, read the
 * filesystem or touch the compression cache, so it cannot change what the model
 * sees or a verdict the cache has frozen. Nothing persists between calls: a
 * baseline is a result in the request being analyzed, never a remembered one.
 *
 * ## Inputs
 *
 * The descriptor path is the only source: `findToolResultDescriptors()` in
 * `compress.ts` already links each result to its call and decodes the call's
 * input. {@link readEventsFromDescriptors} turns the results of the read tools
 * into {@link ReadEvent}s, and {@link analyzeReadOpportunities} relates them.
 * They are two steps so that a caller with another source of evidence, and
 * proof of the context it came from, can supply events itself.
 *
 * ## What is a pair
 *
 * A read is a `repeat` of an earlier one only when ALL of these hold:
 *
 *   - the same read tool and the same absolute path (compared as
 *     `normalizeWorktreePath` spells it, with no `.` or `..` segment),
 *   - the same `offset` and `limit`, exactly as the two calls sent them,
 *   - the same context, with no reset between them, and
 *   - when both results print line numbers, the same first line number.
 *
 * The baseline is the nearest earlier read that matches, so three reads make two
 * pairs. `identical` and `changed` compare the SHA-256 of the exact decoded
 * texts (`contentHash()`, the hash the compression cache uses for a text); both
 * hashes are kept on the finding. What a `changed` pair differs by is not
 * computed here: a finding names the two versions, and a preview built on it
 * reads their texts from the events.
 *
 * ## What is never a pair
 *
 * Everything below is reported `unsupported` with a reason, never as a
 * reference. Each is a case where the evidence for "same file, same range, still
 * in the model's context" is missing, and each is a refusal to guess:
 *
 *   - Partial ranges: the same path read at a different range, unless both
 *     results print line numbers and the two ranges do not overlap.
 *   - External changes: a path outside the workspace roots the caller supplied,
 *     which other programs change without the context showing how.
 *   - Unknown numbering: line numbers that are inconsistent, or printed by one
 *     result and not the other.
 *   - Binary-looking text, failed reads, text the proxy already compressed,
 *     content that is not one plain text, and parameters or paths it cannot
 *     compare.
 *   - A tool id shared by several calls or results (its call is unproven).
 *   - Resets: a `compaction` item in the history replaced what came before it.
 *   - Incremental or provider-managed history (`previous_response_id`,
 *     `conversation`, `context_management`): a visible result may not be
 *     retained, and a retained one may not be visible.
 *   - Another context (a subagent, a tab): see the `context` field of
 *     {@link ReadEvent}.
 *
 * ## Work bounds
 *
 * Every limit in {@link READ_OPPORTUNITY_LIMITS} is explicit. A result longer
 * than `maxResultChars` is `too-large` and is never decoded. Past `maxReads` or
 * `maxTotalChars` the remaining reads are `over-budget` and `complete` is
 * false. A bound never produces a pair. The line scan allocates no per-line
 * array, and every pattern that reads a result's text is linear in its length.
 */

import { isBinaryContent } from '../../../shared/fileKinds';
import { isAbsolutePath } from '../../../shared/formatters';
import type {
	TokenProxyOriginalLineRange,
	TokenProxyRequestKind,
} from '../../../shared/local-models/token-proxy';
import { normalizeToolName } from '../../../shared/toolActivityLabel';
import { isPathAtOrUnderRoot, normalizeWorktreePath } from '../../../shared/worktreePaths';
import { parseCompressionMarker, type ToolResultDescriptor } from './compress';
import { contentHash } from './compression-cache';
import { isNullSpan, memberOf, stringValue, type JsonSpan } from './json-spans';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export interface ReadOpportunityLimits {
	/** Read results examined per request. */
	maxReads: number;
	/** Length of one result's JSON string literal. Decoding never makes a text longer. */
	maxResultChars: number;
	/** Decoded characters across all the reads examined. */
	maxTotalChars: number;
}

export const READ_OPPORTUNITY_LIMITS: Readonly<ReadOpportunityLimits> = Object.freeze({
	maxReads: 256,
	maxResultChars: 1_048_576,
	maxTotalChars: 8_388_608,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Why a read is not related to an earlier one. A reason names the missing
 * evidence; it is never a verdict about the file.
 */
export type ReadUnsupportedReason =
	/** The result's tool id is shared, so which call (and path and range) it answers is unproven. */
	| 'ambiguous-tool-id'
	/** The request continues server-held history, so earlier reads are not visible here. */
	| 'incremental-history'
	/** The request asks the provider to edit its own context, so a visible result may not be retained. */
	| 'managed-context'
	/** A work bound was reached before this read was examined. */
	| 'over-budget'
	/** The call is marked as failed, so the text is an error and not the file. */
	| 'failed-read'
	/** The call has parameters other than one path, `offset` and `limit`, or a value that is not a plain count. */
	| 'unsupported-parameters'
	/** The path is not absolute, has a `.` or `..` segment, or is absurdly long: which file it names is unproven. */
	| 'unresolved-path'
	/** The path is outside every workspace root supplied: other programs may change it unseen. */
	| 'outside-workspace'
	/** The result is not exactly one decodable text part. */
	| 'non-text-content'
	/** The result's text is longer than {@link ReadOpportunityLimits.maxResultChars}. */
	| 'too-large'
	/** The text ends with the proxy's own compression marker, so it is not the file's text. */
	| 'compressed-text'
	/** The text has null bytes or many control characters. */
	| 'binary-looking'
	/** The result prints line numbers that are inconsistent, or only one of two results does. */
	| 'unknown-numbering'
	/** The path was read at an overlapping (or unproven non-overlapping) different range. */
	| 'partial-range'
	/** The same read happened before a reset, so the earlier result is not retained. */
	| 'reset-between'
	/** The same read happened in a context this one is not proven to share. */
	| 'other-context';

/** One result of a read tool, as the analyzer is given it. */
interface ReadEventShared {
	/** Position in the visible context, ascending across the events of one analysis. */
	order: number;
	/**
	 * Opaque identity of the context window the result was visible in. Reads
	 * relate only inside one context. The descriptor path supplies a single
	 * context for the whole request, because the proxy cannot tell a subagent or
	 * a tab from its parent; a caller that can prove more labels each window.
	 */
	context: string;
	/** Resets seen in `context` before this result. Reads in different epochs never relate. */
	epoch: number;
	callId: string | null;
}

export type ReadEvent =
	/** Ruled out from its call or its request alone; there is no text to examine. */
	| (ReadEventShared & {
			status: 'skipped';
			reason: ReadUnsupportedReason;
			tool: string | null;
			path: string | null;
	  })
	| (ReadEventShared & {
			status: 'read';
			tool: string;
			/** Canonical absolute path. */
			path: string;
			/** As the call sent them; `null` when absent. */
			offset: number | null;
			limit: number | null;
			/** The exact decoded result text. Never copied into a finding. */
			text: string;
	  });

export interface ReadRef {
	/** The event's `order`; for the descriptor path, an index into its descriptors. */
	order: number;
	callId: string | null;
	tool: string | null;
	path: string | null;
}

/** One read whose text was examined. */
export interface ReadVersion extends ReadRef {
	path: string;
	offset: number | null;
	limit: number | null;
	/** The line numbers the result printed (inclusive, 1-based), or null when it printed none. */
	numbered: TokenProxyOriginalLineRange | null;
	/** SHA-256 of the exact decoded text: `contentHash()`, the key the compression cache uses. */
	hash: string;
	chars: number;
	lines: number;
}

export type ReadFinding =
	/** No earlier read of this range is visible: a baseline for later ones. */
	| { status: 'first'; read: ReadVersion }
	| {
			status: 'repeat';
			relation: 'identical' | 'changed';
			baseline: ReadVersion;
			read: ReadVersion;
	  }
	/** `version` is null when the text was never examined. */
	| {
			status: 'unsupported';
			reason: ReadUnsupportedReason;
			read: ReadRef;
			version: ReadVersion | null;
	  };

export interface ReadOpportunityCounts {
	examined: number;
	first: number;
	identical: number;
	changed: number;
	unsupported: number;
	unsupportedByReason: Partial<Record<ReadUnsupportedReason, number>>;
}

export interface ReadOpportunityReport {
	version: 1;
	/** Nothing in a report edits a request or a cached verdict. */
	mode: 'observation';
	/** False when a work bound left reads unexamined. */
	complete: boolean;
	findings: ReadFinding[];
	counts: ReadOpportunityCounts;
}

// ---------------------------------------------------------------------------
// From descriptors to events
// ---------------------------------------------------------------------------

/**
 * Read tools whose input is a path with an optional `offset` and `limit`
 * (`read`: Claude Code and OpenCode; `read_file`), matched on
 * `normalizeToolName`. Any other tool, a shell `cat` included, is not a read
 * here: the dialect list is small on purpose.
 */
const READ_TOOLS: ReadonlySet<string> = new Set(['read', 'readfile']);

const PATH_KEYS: readonly string[] = ['file_path', 'filePath', 'path', 'absolute_path'];
const RANGE_KEYS: readonly string[] = ['offset', 'limit'];

/** The one context a request shows; see {@link ReadEvent.context}. */
const REQUEST_CONTEXT = 'request';

/** A count spelled as a plain decimal integer: no sign, fraction or exponent. */
const COUNT_LEXEME = /^(?:0|[1-9]\d{0,8})$/;

/** Longer than any system accepts (Linux `PATH_MAX`), so not worth comparing. */
const MAX_PATH_CHARS = 4096;

/**
 * The form two reads of one file are compared in, or `null` when the text does
 * not name one file unambiguously: a relative path depends on a working
 * directory the request does not show, and `..` can cross a link.
 */
function canonicalPath(raw: string): string | null {
	if (raw.length > MAX_PATH_CHARS || !isAbsolutePath(raw)) return null;
	if (raw.includes('\0') || /[\r\n]/.test(raw)) return null;
	// `\name` alone is drive-relative on Windows, and `//name` is not one root on every system.
	if (/^\\(?!\\)/.test(raw) || raw.startsWith('//')) return null;
	const path = normalizeWorktreePath(raw, raw.startsWith('/'));
	return path.split('/').some((segment) => segment === '.' || segment === '..') ? null : path;
}

/** `null` for an absent or `null` value, `undefined` for one that is not a plain count. */
function countParameter(source: string, span: JsonSpan | undefined): number | null | undefined {
	if (!span) return null;
	if (span.kind !== 'scalar') return undefined;
	const lexeme = source.slice(span.start, span.end);
	if (lexeme === 'null') return null;
	return COUNT_LEXEME.test(lexeme) ? Number(lexeme) : undefined;
}

interface ReadParameters {
	path: string;
	offset: number | null;
	limit: number | null;
}

function readParameters(
	input: ToolResultDescriptor['input']
): ReadParameters | ReadUnsupportedReason {
	if (input.kind !== 'structured') return 'unsupported-parameters';
	const { source, span } = input;
	if (span.kind !== 'object') return 'unsupported-parameters';
	const keys = span.members.map((member) => member.key);
	const pathKeys = keys.filter((key) => PATH_KEYS.includes(key));
	if (
		pathKeys.length !== 1 ||
		keys.some((key) => !PATH_KEYS.includes(key) && !RANGE_KEYS.includes(key))
	) {
		return 'unsupported-parameters';
	}
	const raw = stringValue(source, memberOf(span, pathKeys[0]));
	const offset = countParameter(source, memberOf(span, 'offset'));
	const limit = countParameter(source, memberOf(span, 'limit'));
	if (raw === undefined || offset === undefined || limit === undefined) {
		return 'unsupported-parameters';
	}
	const path = canonicalPath(raw);
	return path === null ? 'unresolved-path' : { path, offset, limit };
}

function resultText(
	body: string,
	descriptor: ToolResultDescriptor,
	limits: ReadOpportunityLimits
): { text: string } | { reason: ReadUnsupportedReason } {
	if (descriptor.contentStatus !== 'text' || descriptor.contentSpans.length !== 1) {
		return { reason: 'non-text-content' };
	}
	const span = descriptor.contentSpans[0];
	if (span.end - span.start > limits.maxResultChars) return { reason: 'too-large' };
	const text = stringValue(body, span);
	return text === undefined ? { reason: 'non-text-content' } : { text };
}

/** Why the request's history cannot show what the model retains, or `null`. */
function historyLimit(
	kind: TokenProxyRequestKind,
	body: string,
	root: JsonSpan
): ReadUnsupportedReason | null {
	const present = (key: string): boolean => {
		const value = memberOf(root, key);
		return value !== undefined && !isNullSpan(body, value);
	};
	if (kind === 'openai-responses' && (present('previous_response_id') || present('conversation'))) {
		return 'incremental-history';
	}
	return present('context_management') ? 'managed-context' : null;
}

/**
 * Where, in document order, the history says what came before was replaced by
 * a summary: a `compaction` item (Responses) or content block (Messages). The
 * provider drops everything before one, though the client still sends it.
 */
function resetOffsets(kind: TokenProxyRequestKind, body: string, root: JsonSpan): number[] {
	const isCompaction = (span: JsonSpan): boolean =>
		stringValue(body, memberOf(span, 'type')) === 'compaction';
	const offsets: number[] = [];
	if (kind === 'openai-responses') {
		const input = memberOf(root, 'input');
		if (input?.kind === 'array') {
			for (const item of input.items) if (isCompaction(item)) offsets.push(item.start);
		}
	} else if (kind === 'anthropic-messages') {
		const messages = memberOf(root, 'messages');
		if (messages?.kind === 'array') {
			for (const message of messages.items) {
				const content = memberOf(message, 'content');
				if (content?.kind !== 'array') continue;
				for (const block of content.items) if (isCompaction(block)) offsets.push(block.start);
			}
		}
	}
	return offsets;
}

export interface ReadDescriptorInput {
	kind: TokenProxyRequestKind;
	body: string;
	/** `parseJsonSpans(body)`. */
	root: JsonSpan;
	/** `findToolResultDescriptors(kind, body, root)`: every result, in document order. */
	descriptors: readonly ToolResultDescriptor[];
	/**
	 * Absolute workspace roots the caller knows. A read outside every one is
	 * `outside-workspace`, so an empty list analyzes nothing.
	 */
	roots: readonly string[];
	limits?: Partial<ReadOpportunityLimits>;
}

export interface ReadEventScan {
	events: ReadEvent[];
	/** False when a work bound left reads unexamined. */
	complete: boolean;
}

/**
 * The read results of one request as events. A result that is not provably the
 * answer to a call of a read tool is not an event at all: with an unproven
 * call there is nothing to say it was a read.
 */
export function readEventsFromDescriptors(input: ReadDescriptorInput): ReadEventScan {
	const { kind, body, root, descriptors } = input;
	const limits = { ...READ_OPPORTUNITY_LIMITS, ...input.limits };
	const history = historyLimit(kind, body, root);
	const resets = resetOffsets(kind, body, root);
	const workspace = input.roots.flatMap((workspaceRoot) => canonicalPath(workspaceRoot) ?? []);
	const events: ReadEvent[] = [];
	let epoch = 0;
	let reads = 0;
	let decoded = 0;
	let complete = true;

	descriptors.forEach((descriptor, order) => {
		// Descriptors arrive in document order, so the resets passed so far only grow.
		while (epoch < resets.length && resets[epoch] <= descriptor.result.start) epoch++;
		const shared = { order, context: REQUEST_CONTEXT, epoch, callId: descriptor.callId };
		const skip = (tool: string | null, path: string | null, reason: ReadUnsupportedReason) => {
			events.push({ ...shared, status: 'skipped', reason, tool, path });
		};

		if (descriptor.linkage === 'ambiguous') return skip(null, null, 'ambiguous-tool-id');
		const tool = descriptor.toolName;
		if (descriptor.linkage !== 'matched' || !tool) return;
		if (!READ_TOOLS.has(normalizeToolName(tool))) return;

		if (reads++ >= limits.maxReads) {
			complete = false;
			return skip(tool, null, 'over-budget');
		}
		if (history) return skip(tool, null, history);
		if (descriptor.failureStatus === 'failed') return skip(tool, null, 'failed-read');
		const parameters = readParameters(descriptor.input);
		if (typeof parameters === 'string') return skip(tool, null, parameters);
		const { path, offset, limit } = parameters;
		if (!workspace.some((workspaceRoot) => isPathAtOrUnderRoot(path, workspaceRoot))) {
			return skip(tool, path, 'outside-workspace');
		}
		const result = resultText(body, descriptor, limits);
		if ('reason' in result) return skip(tool, path, result.reason);
		if (decoded + result.text.length > limits.maxTotalChars) {
			complete = false;
			return skip(tool, path, 'over-budget');
		}
		decoded += result.text.length;
		events.push({ ...shared, status: 'read', tool, path, offset, limit, text: result.text });
	});
	return { events, complete };
}

// ---------------------------------------------------------------------------
// Relating the reads
// ---------------------------------------------------------------------------

/**
 * `     3→text` (older builds print a tab): the line number a numbered read
 * prints before each line. A result whose first line lacks the prefix is
 * compared as plain text.
 */
const NUMBER_PREFIX = /[ ]*(\d{1,9})(?:\t|→)/y;

interface LineScan {
	lines: number;
	/**
	 * `none` when the first line has no number. `unknown` when it has one and a
	 * later line has none, or a number is out of sequence.
	 */
	numbering: TokenProxyOriginalLineRange | 'none' | 'unknown';
}

/** Count the lines (a final LF ends one and starts none) and read their numbering. */
function scanLines(text: string): LineScan {
	let lines = 0;
	let state: 'none' | 'numbered' | 'unknown' = 'none';
	let first = 0;
	let next = 0;
	for (let at = 0; at < text.length; ) {
		lines++;
		NUMBER_PREFIX.lastIndex = at;
		const match = NUMBER_PREFIX.exec(text);
		if (lines === 1 && match) {
			state = 'numbered';
			first = next = Number(match[1]);
		}
		if (state === 'numbered') {
			if (match && Number(match[1]) === next) next++;
			else state = 'unknown';
		}
		const lineFeed = text.indexOf('\n', at);
		if (lineFeed === -1) break;
		at = lineFeed + 1;
	}
	return {
		lines,
		numbering: state === 'numbered' ? { startLine: first, endLine: next - 1 } : state,
	};
}

/**
 * The text of a numbered read without the numbers it printed: each line's
 * leading spaces, digits and arrow (or tab) removed, every line break kept.
 * Call it only when {@link ReadVersion.numbered} is set, so each line has its
 * number. Two numbered reads whose lines moved differ in every number after the
 * move; compared without the numbers they differ only where the file does.
 */
export function withoutLineNumbers(text: string): string {
	const lines: string[] = [];
	for (let at = 0; at < text.length; ) {
		NUMBER_PREFIX.lastIndex = at;
		const match = NUMBER_PREFIX.exec(text);
		const lineFeed = text.indexOf('\n', at);
		const end = lineFeed === -1 ? text.length : lineFeed + 1;
		lines.push(text.slice(match ? at + match[0].length : at, end));
		at = end;
	}
	return lines.join('');
}

interface Seen {
	version: ReadVersion;
	context: string;
	epoch: number;
	/** The read tool and the range, as the call sent them. */
	rangeKey: string;
}

/** Whether two numbered results cover no common line. Anything unproven overlaps. */
function provablyDisjoint(a: ReadVersion, b: ReadVersion): boolean {
	return (
		a.numbered !== null &&
		b.numbered !== null &&
		(a.numbered.endLine < b.numbered.startLine || b.numbered.endLine < a.numbered.startLine)
	);
}

function countFindings(findings: readonly ReadFinding[]): ReadOpportunityCounts {
	const counts: ReadOpportunityCounts = {
		examined: findings.length,
		first: 0,
		identical: 0,
		changed: 0,
		unsupported: 0,
		unsupportedByReason: {},
	};
	for (const finding of findings) {
		if (finding.status === 'first') counts.first++;
		else if (finding.status === 'repeat') counts[finding.relation]++;
		else {
			counts.unsupported++;
			counts.unsupportedByReason[finding.reason] =
				(counts.unsupportedByReason[finding.reason] ?? 0) + 1;
		}
	}
	return counts;
}

/**
 * Relate the reads of one context to each other. Pure and deterministic: the
 * events are not modified, and the report holds hashes and sizes, never text.
 *
 * `events` are in context order. A read whose own text rules it out (binary,
 * compressed, unknown numbering) is never a baseline. A read that merely cannot
 * be related to an earlier one (partial range, reset, other context) is
 * still a baseline for the reads after it.
 */
export function analyzeReadOpportunities(
	events: readonly ReadEvent[],
	options: { complete?: boolean } = {}
): ReadOpportunityReport {
	const findings: ReadFinding[] = [];
	const seenByPath = new Map<string, Seen[]>();
	/** The nearest earlier read of exactly this path, range, context and epoch. */
	const latest = new Map<string, Seen>();

	for (const event of events) {
		const ref: ReadRef = {
			order: event.order,
			callId: event.callId,
			tool: event.tool,
			path: event.path,
		};
		if (event.status === 'skipped') {
			findings.push({ status: 'unsupported', reason: event.reason, read: ref, version: null });
			continue;
		}

		const { text, path } = event;
		const { lines, numbering } = scanLines(text);
		const version: ReadVersion = {
			...ref,
			path,
			offset: event.offset,
			limit: event.limit,
			numbered: typeof numbering === 'object' ? numbering : null,
			hash: contentHash(text),
			chars: text.length,
			lines,
		};
		const ruledOut: ReadUnsupportedReason | null = parseCompressionMarker(text)
			? 'compressed-text'
			: isBinaryContent(text)
				? 'binary-looking'
				: numbering === 'unknown'
					? 'unknown-numbering'
					: null;
		if (ruledOut) {
			findings.push({ status: 'unsupported', reason: ruledOut, read: ref, version });
			continue;
		}

		const rangeKey = JSON.stringify([normalizeToolName(event.tool), event.offset, event.limit]);
		const scopeKey = JSON.stringify([path, event.context, event.epoch, rangeKey]);
		const seen = seenByPath.get(path) ?? [];
		const baseline = latest.get(scopeKey)?.version;

		let reason: ReadUnsupportedReason | null = null;
		if (baseline) {
			// Equal requests that print different numbering are not the same view of the file.
			if (baseline.numbered?.startLine !== version.numbered?.startLine) {
				reason = 'unknown-numbering';
			}
		} else {
			const sameRange = seen.filter((entry) => entry.rangeKey === rangeKey);
			if (sameRange.some((entry) => entry.context === event.context)) reason = 'reset-between';
			else if (sameRange.length > 0) reason = 'other-context';
			else if (
				seen.some(
					(entry) =>
						entry.context === event.context &&
						entry.epoch === event.epoch &&
						!provablyDisjoint(entry.version, version)
				)
			) {
				reason = 'partial-range';
			}
		}

		if (reason) {
			findings.push({ status: 'unsupported', reason, read: ref, version });
		} else if (baseline) {
			findings.push({
				status: 'repeat',
				relation: baseline.hash === version.hash ? 'identical' : 'changed',
				baseline,
				read: version,
			});
		} else {
			findings.push({ status: 'first', read: version });
		}
		const entry: Seen = { version, context: event.context, epoch: event.epoch, rangeKey };
		latest.set(scopeKey, entry);
		seen.push(entry);
		seenByPath.set(path, seen);
	}

	return {
		version: 1,
		mode: 'observation',
		complete: options.complete ?? true,
		findings,
		counts: countFindings(findings),
	};
}
