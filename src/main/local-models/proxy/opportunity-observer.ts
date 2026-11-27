/**
 * Read opportunities, observed on the requests the proxy already reads.
 *
 * Phase 04 built three pure steps: the analyzer relates the reads of one request
 * (`read-opportunities.ts`), re-read previews measure a repeated read against a
 * delta or an "unchanged" marker (`read-previews.ts`), and outlines measure a
 * source file against its imports and signatures (`code-structure.ts`). This
 * module runs them for the report, for the requests of an agent in a
 * compressing mode, whose bodies the proxy has read and sent on already. It
 * only OBSERVES: it edits no request and opens no cache. Separately applied
 * compression is reflected in each preview's delivery field.
 *
 * ## Off the forwarding path
 *
 * The server calls {@link OpportunityObserver.observe} on a later turn of the
 * event loop, after the body is on its way, and it returns at once: the pass
 * starts on yet another turn, one pass runs at a time, a request that arrives
 * during one is counted as skipped and released, and the pass hands the event
 * loop back between its steps. A passthrough request is streamed unread and is
 * never examined. Measured on synthetic Messages bodies (Node 24), a whole pass
 * cost 3 ms for 200 KB, 10 ms for 1.3 MB and 38 ms for 6 MB of history, almost
 * all of it hashing and scanning the history; a body past
 * {@link OPPORTUNITY_OBSERVER_LIMITS} is skipped without being parsed.
 *
 * ## What is counted
 *
 * Every request carries the whole history again, so counting its reads would
 * count one read once per later request. Only the NEWEST results are counted:
 * the run of tool results at the end of the message list, which is what this
 * request adds. A request that ends in anything else (a new prompt) adds none,
 * and the results before it were counted by the request that carried them last.
 * The older reads are still the baselines the newest ones are related to, and
 * the analysis window is the newest reads that fit the analyzer's bounds, so
 * the bounds fall on the oldest history and never on what the request adds.
 * A client that resends a request is observed twice; a request skipped as busy
 * loses its newest results. Neither can be told apart without remembering
 * conversations, which the proxy cannot identify (see
 * {@link TOKEN_PROXY_UNAVAILABLE_IDENTITY}), so nothing is remembered: the
 * tallies are fixed-size numbers and a short list of recent previews, kept for
 * the life of the process.
 *
 * ## What leaves the process
 *
 * A preview holds lines of a file. Before it is kept it goes through
 * `redactSecrets()` and is cut for display, so the report that crosses to the
 * Settings panel and the CLI never carries the raw text.
 */

import {
	TOKEN_PROXY_OPPORTUNITY_NOTE,
	TOKEN_PROXY_UNAVAILABLE_IDENTITY,
	type TokenProxyObservationSkip,
	type TokenProxyOpportunity,
	type TokenProxyOpportunityOutlines,
	type TokenProxyOpportunityPreviews,
	type TokenProxyOpportunityReads,
	type TokenProxyReadOpportunities,
	type TokenProxyRequestKind,
} from '../../../shared/local-models/token-proxy';
import { redactSecrets } from '../../../shared/redactSecrets';
import { yieldToEventLoop } from '../../utils/concurrency';
import { buildCodeStructurePreviews, CODE_STRUCTURE_LIMITS } from './code-structure';
import { findToolResultDescriptors, type ToolResultDescriptor } from './compress';
import { memberOf, parseJsonSpans, stringValue, type JsonSpan } from './json-spans';
import {
	analyzeReadOpportunities,
	countFindings,
	isReadToolName,
	READ_OPPORTUNITY_LIMITS,
	readEventsFromDescriptors,
	type ReadOpportunityReport,
} from './read-opportunities';
import {
	buildReadPreviews,
	MARKER_HASH_CHARS,
	READ_PREVIEW_LIMITS,
	resultDeliveries,
	type RequestView,
} from './read-previews';
import type { TokenProxyObservedRequest } from './server';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export interface OpportunityObserverLimits {
	/** Characters of a request body that are examined. A larger body is skipped unread. */
	maxBodyChars: number;
	/** Previews the report keeps, newest first. */
	maxRecent: number;
	/** Characters of one preview the report shows. */
	maxPreviewChars: number;
}

export const OPPORTUNITY_OBSERVER_LIMITS: Readonly<OpportunityObserverLimits> = Object.freeze({
	maxBodyChars: 8_388_608,
	maxRecent: 25,
	maxPreviewChars: 8_192,
});

/** Shown beside the unavailable identity fields. */
const IDENTITY_NOTE =
	'The proxy knows an agent from the gateway URL it was given and a request body. Neither names a tab, a native session, a subagent or a context window, so a baseline is only ever an earlier result in the same request, and nothing is remembered between requests.';

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

/** What one examined request contributes to the tallies. */
export interface RequestObservation {
	/** The newest results held at least one read. */
	withReads: boolean;
	/** A work bound left reads or pairs unexamined. */
	incomplete: boolean;
	reads: TokenProxyOpportunityReads;
	previews: TokenProxyOpportunityPreviews;
	outlines: TokenProxyOpportunityOutlines;
	/** The previews built, in document order. */
	opportunities: TokenProxyOpportunity[];
}

/** Item types of a Responses `input` list that carry a tool's output. */
const RESPONSES_RESULT_TYPES: ReadonlySet<string> = new Set([
	'function_call_output',
	'custom_tool_call_output',
]);

/**
 * Where the newest tool results begin, or null when the request ends in
 * anything but results. Messages: the final message. Chat Completions: the run
 * of `tool` messages at the end. Responses: the run of output items at the end.
 */
function newestResultsStart(
	kind: TokenProxyRequestKind,
	body: string,
	root: JsonSpan
): number | null {
	const list = memberOf(root, kind === 'openai-responses' ? 'input' : 'messages');
	if (list?.kind !== 'array' || list.items.length === 0) return null;
	const { items } = list;
	// Results are blocks of a user message, so the final message holds them or none.
	if (kind === 'anthropic-messages') return items[items.length - 1].start;
	const isResult = (item: JsonSpan): boolean =>
		kind === 'openai-chat-completions'
			? stringValue(body, memberOf(item, 'role')) === 'tool'
			: RESPONSES_RESULT_TYPES.has(stringValue(body, memberOf(item, 'type')) ?? '');
	let first = items.length;
	while (first > 0 && isResult(items[first - 1])) first--;
	return first === items.length ? null : items[first].start;
}

/** A tool result that provably answers a call of a read tool. */
function isReadResult(descriptor: ToolResultDescriptor): boolean {
	return (
		descriptor.linkage === 'matched' &&
		descriptor.toolName !== null &&
		isReadToolName(descriptor.toolName)
	);
}

/**
 * The first descriptor of the analysis window: the newest results whose reads
 * fit the analyzer's bounds. The analyzer spends its bounds from the oldest read
 * onward, which would leave the newest reads over budget in a long history, so
 * the oldest are left out instead. Sizes are the results' literal lengths, which
 * a decoded text never exceeds.
 */
function windowStart(descriptors: readonly ToolResultDescriptor[]): number {
	let reads = 0;
	let chars = 0;
	let from = descriptors.length;
	while (from > 0) {
		const descriptor = descriptors[from - 1];
		if (isReadResult(descriptor)) {
			reads++;
			for (const span of descriptor.contentSpans) chars += span.end - span.start;
			if (
				reads > READ_OPPORTUNITY_LIMITS.maxReads ||
				chars > READ_OPPORTUNITY_LIMITS.maxTotalChars
			) {
				break;
			}
		}
		from--;
	}
	return from;
}

/** The request as the proxy sent it on, with its results lined up against `sent` by position. */
function forwardedView(
	request: TokenProxyObservedRequest,
	sent: RequestView,
	from: number
): RequestView {
	if (request.forwarded === request.sent) return sent;
	const root = parseJsonSpans(request.forwarded);
	const descriptors = root ? findToolResultDescriptors(request.kind, request.forwarded, root) : [];
	// An empty or misaligned list proves nothing, so no delivery is claimed.
	return { body: request.forwarded, descriptors: descriptors.slice(from) };
}

/** The findings for the given results only, recounted. */
function narrow(report: ReadOpportunityReport, orders: ReadonlySet<number>): ReadOpportunityReport {
	const findings = report.findings.filter((finding) => orders.has(finding.read.order));
	return { ...report, findings, counts: countFindings(findings) };
}

/** `text` cut to at most `max` characters, at a line break when one is in range. */
function cutAtLine(text: string, max: number): string {
	if (text.length <= max) return text;
	const lineBreak = text.lastIndexOf('\n', max);
	return text.slice(0, lineBreak > 0 ? lineBreak : max);
}

/**
 * A preview as the report shows it: redacted, then cut. Redaction sees four
 * times what is shown, so a secret that ends inside the shown part is whole when
 * it is matched; a secret is far shorter than the difference.
 */
function shown(text: string, maxChars: number) {
	const window = cutAtLine(text, maxChars * 4);
	const { text: safe, redacted } = redactSecrets(window);
	const display = cutAtLine(safe, maxChars);
	return {
		text: display,
		textChars: text.length,
		cut: window.length < text.length || display.length < safe.length,
		redacted,
	};
}

/** The counts of a builder, copied: a report never shares an object with a builder. */
function copyReasons(reasons: Partial<Record<string, number>>): Record<string, number> {
	const copy: Record<string, number> = {};
	for (const [reason, count] of Object.entries(reasons)) if (count) copy[reason] = count;
	return copy;
}

function emptyObservation(): RequestObservation {
	return {
		withReads: false,
		incomplete: false,
		reads: {
			examined: 0,
			first: 0,
			identical: 0,
			changed: 0,
			unsupported: 0,
			unsupportedByReason: {},
		},
		previews: {
			examined: 0,
			unchanged: 0,
			delta: 0,
			unsupported: 0,
			unsupportedByReason: {},
			potentialChars: 0,
			potentialTokens: 0,
		},
		outlines: {
			examined: 0,
			outlined: 0,
			unsupported: 0,
			unsupportedByReason: {},
			potentialChars: 0,
			potentialTokens: 0,
		},
		opportunities: [],
	};
}

/**
 * Examine the newest reads of one request. Pure apart from the turns it hands
 * back to the event loop: it reads no file, opens no cache and keeps nothing.
 * `roots` are the agent's working directories; a read outside them is
 * `outside-workspace`. Returns the reason a request is not examined instead of
 * an observation.
 */
export async function observeRequest(
	request: TokenProxyObservedRequest,
	roots: readonly string[],
	observedAt: number,
	limits: Readonly<OpportunityObserverLimits> = OPPORTUNITY_OBSERVER_LIMITS
): Promise<RequestObservation | { skipped: TokenProxyObservationSkip }> {
	const { kind, sent } = request;
	if (sent.length > limits.maxBodyChars) return { skipped: 'too-large' };
	if (roots.length === 0) return { skipped: 'no-workspace' };
	const root = parseJsonSpans(sent);
	if (!root) return { skipped: 'unreadable' };

	const all = findToolResultDescriptors(kind, sent, root);
	const from = windowStart(all);
	const descriptors = all.slice(from);
	const start = newestResultsStart(kind, sent, root);
	const newest = new Set<number>();
	if (start !== null) {
		descriptors.forEach((descriptor, order) => {
			if (descriptor.result.start >= start && isReadResult(descriptor)) newest.add(order);
		});
	}
	// Most requests end in a shell result or an edit: nothing to hash or relate.
	if (newest.size === 0) return emptyObservation();

	const scan = readEventsFromDescriptors({ kind, body: sent, root, descriptors, roots });
	await yieldToEventLoop();
	const report = narrow(analyzeReadOpportunities(scan.events, { complete: scan.complete }), newest);
	await yieldToEventLoop();
	const sentView: RequestView = { body: sent, descriptors };
	const deliveries = resultDeliveries(sentView, forwardedView(request, sentView, from));
	const previews = buildReadPreviews({ report, events: scan.events, deliveries });
	await yieldToEventLoop();
	const outlines = await buildCodeStructurePreviews({ report, events: scan.events, deliveries });

	const opportunities: TokenProxyOpportunity[] = [];
	const origin = { observedAt, agentId: request.agentId, route: request.route, requestKind: kind };
	for (const preview of previews.previews) {
		if (preview.status !== 'preview') continue;
		opportunities.push({
			kind: preview.kind === 'unchanged' ? 'unchanged-read' : 'read-delta',
			...origin,
			tool: preview.target.tool,
			callId: preview.target.callId,
			path: preview.target.path,
			sourceHash: preview.target.hash.slice(0, MARKER_HASH_CHARS),
			baseline: {
				callId: preview.baseline.callId,
				hash: preview.baseline.hash.slice(0, MARKER_HASH_CHARS),
			},
			baselineBasis: preview.baselineBasis,
			delivery: preview.targetDelivery,
			potential: { ...preview.potential },
			parser: null,
			changes: preview.changes && { ...preview.changes },
			...shown(preview.text, limits.maxPreviewChars),
		});
	}
	for (const outline of outlines.previews) {
		if (outline.status !== 'preview') continue;
		opportunities.push({
			kind: 'code-outline',
			...origin,
			tool: outline.read.tool,
			callId: outline.read.callId,
			path: outline.read.path,
			sourceHash: outline.read.hash.slice(0, MARKER_HASH_CHARS),
			baseline: null,
			baselineBasis: null,
			delivery: outline.delivery,
			potential: { ...outline.potential },
			parser: { ...outline.parser },
			changes: null,
			...shown(outline.text, limits.maxPreviewChars),
		});
	}

	return {
		withReads: true,
		incomplete: !scan.complete || !previews.complete || !outlines.complete,
		reads: {
			...report.counts,
			unsupportedByReason: copyReasons(report.counts.unsupportedByReason),
		},
		previews: {
			...previews.counts,
			unsupportedByReason: copyReasons(previews.counts.unsupportedByReason),
		},
		outlines: {
			...outlines.counts,
			unsupportedByReason: copyReasons(outlines.counts.unsupportedByReason),
		},
		opportunities,
	};
}

// ---------------------------------------------------------------------------
// The tallies
// ---------------------------------------------------------------------------

interface Tally {
	unsupportedByReason: Record<string, number>;
	[key: string]: number | Record<string, number>;
}

const add = (a: number, b: number): number => Math.min(Number.MAX_SAFE_INTEGER, a + b);

/** `from` added into `into`, every sum saturating at the largest safe integer. */
function addCounts(into: Tally, from: Tally): void {
	for (const [key, value] of Object.entries(from)) {
		if (typeof value !== 'number') continue;
		const current = into[key];
		into[key] = add(typeof current === 'number' ? current : 0, value);
	}
	for (const [reason, count] of Object.entries(from.unsupportedByReason)) {
		into.unsupportedByReason[reason] = add(into.unsupportedByReason[reason] ?? 0, count);
	}
}

export interface OpportunityLedger {
	/** Fold in one examined request. */
	record(observation: RequestObservation): void;
	/** Count a request the proxy read and did not examine. */
	skip(reason: TokenProxyObservationSkip): void;
	/** An independent copy of everything the report shows. */
	snapshot(): TokenProxyReadOpportunities;
	reset(): void;
}

function emptyState(since: number) {
	const empty = emptyObservation();
	return {
		since,
		observed: 0,
		withReads: 0,
		incomplete: 0,
		skipped: { busy: 0, 'too-large': 0, unreadable: 0, 'no-workspace': 0, failed: 0 },
		reads: empty.reads,
		previews: empty.previews,
		outlines: empty.outlines,
		recent: [] as TokenProxyOpportunity[],
	};
}

/** Fixed-size tallies and a short list of recent previews. Nothing here is persisted. */
export function createOpportunityLedger(
	options: { now?: () => number; limits?: Readonly<OpportunityObserverLimits> } = {}
): OpportunityLedger {
	const now = options.now ?? Date.now;
	const limits = options.limits ?? OPPORTUNITY_OBSERVER_LIMITS;
	let state = emptyState(now());

	return {
		record(observation) {
			state.observed = add(state.observed, 1);
			if (observation.withReads) state.withReads = add(state.withReads, 1);
			if (observation.incomplete) state.incomplete = add(state.incomplete, 1);
			addCounts(state.reads, observation.reads);
			addCounts(state.previews, observation.previews);
			addCounts(state.outlines, observation.outlines);
			state.recent = [...[...observation.opportunities].reverse(), ...state.recent].slice(
				0,
				limits.maxRecent
			);
		},
		skip(reason) {
			state.skipped[reason] = add(state.skipped[reason], 1);
		},
		snapshot() {
			const report: TokenProxyReadOpportunities = {
				version: 1,
				mode: 'observation',
				note: TOKEN_PROXY_OPPORTUNITY_NOTE,
				realized: false,
				tokenCountKind: 'character-estimate',
				since: state.since,
				coverage: {
					scope: 'process-lifetime',
					attribution: 'newest-tool-results',
					observed: state.observed,
					withReads: state.withReads,
					incomplete: state.incomplete,
					skipped: state.skipped,
				},
				identity: {
					known: ['agent'],
					unavailable: [...TOKEN_PROXY_UNAVAILABLE_IDENTITY],
					note: IDENTITY_NOTE,
				},
				limits: {
					bodyChars: limits.maxBodyChars,
					readsPerRequest: READ_OPPORTUNITY_LIMITS.maxReads,
					previewPairs: READ_PREVIEW_LIMITS.maxPairs,
					outlineSources: CODE_STRUCTURE_LIMITS.maxSources,
					recentPreviews: limits.maxRecent,
					previewTextChars: limits.maxPreviewChars,
				},
				reads: state.reads,
				previews: state.previews,
				outlines: state.outlines,
				recent: state.recent,
			};
			// Plain data throughout, so a JSON copy is a deep copy: a caller cannot
			// reach the ledger's own objects through what it was handed.
			return JSON.parse(JSON.stringify(report)) as TokenProxyReadOpportunities;
		},
		reset() {
			state = emptyState(now());
		},
	};
}

// ---------------------------------------------------------------------------
// The observer
// ---------------------------------------------------------------------------

export interface OpportunityObserverDeps {
	/** The agent's working directories, read when a request is examined. */
	rootsFor: (agentId: string | null) => readonly string[];
	/** Reports a pass that failed. The request it came from was not affected. Must not throw. */
	onFailure?: (error: unknown) => void;
	now?: () => number;
	limits?: Readonly<OpportunityObserverLimits>;
}

export interface OpportunityObserver extends Pick<OpportunityLedger, 'snapshot' | 'reset'> {
	/**
	 * Offer a forwarded request. Returns at once and does none of the work in the
	 * caller's turn: the examination starts on a later turn of the event loop and
	 * hands the loop back between its steps.
	 */
	observe(request: TokenProxyObservedRequest): void;
	/** Resolves when the pass in flight, if any, has finished. For tests and shutdown. */
	idle(): Promise<void>;
}

/** One pass at a time over a ledger. The only stateful piece the service holds. */
export function createOpportunityObserver(deps: OpportunityObserverDeps): OpportunityObserver {
	const now = deps.now ?? Date.now;
	const limits = deps.limits ?? OPPORTUNITY_OBSERVER_LIMITS;
	const ledger = createOpportunityLedger({ now, limits });
	let running: Promise<void> | null = null;

	async function examine(request: TokenProxyObservedRequest): Promise<void> {
		try {
			// The first slice (parse and scan) is milliseconds on a large history:
			// not the caller's to wait for.
			await yieldToEventLoop();
			const result = await observeRequest(request, deps.rootsFor(request.agentId), now(), limits);
			if ('skipped' in result) ledger.skip(result.skipped);
			else ledger.record(result);
		} catch (error) {
			ledger.skip('failed');
			deps.onFailure?.(error);
		}
	}

	return {
		observe(request) {
			if (running) {
				ledger.skip('busy');
				return;
			}
			running = examine(request).finally(() => {
				running = null;
			});
		},
		idle: async () => {
			await running;
		},
		snapshot: () => ledger.snapshot(),
		reset: () => ledger.reset(),
	};
}
