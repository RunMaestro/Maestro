/**
 * The routing log: what the Conductor decided, and whether it was right.
 *
 * "It sent that to the wrong agent" is unanswerable without this file. The
 * decision is gone the moment the tab changes, the roster it was made against
 * has already moved on, and the user remembers the outcome rather than the
 * utterance. So every routing turn is recorded with the four things that make a
 * misroute diagnosable - what was said, how much context the Brain had, what it
 * chose, and how sure it was - plus what happened next.
 *
 * The outcome is the point. A decision the user immediately corrected is a miss
 * even though nothing errored, and a decision that asked a question instead of
 * guessing is neither a hit nor a miss. Without those two distinctions the log
 * says "100% dispatched" for a router that is wrong half the time, so
 * {@link routingQuality} counts them separately and the hit rate excludes
 * corrections rather than hiding them.
 *
 * Storage follows the app's existing conventions: one atomically written JSON
 * file under `userData`, capped at {@link MAX_ENTRIES}, serialized through a
 * keyed write queue like the history manager's per-session files. Utterances are
 * truncated: this is a routing log, not a transcript of everything the user has
 * ever said in their office.
 */

import * as path from 'path';
import { app } from 'electron';

import type { RouteDecision } from '../../../shared/acappella/route-decision';
import { routeTargetSessionId } from '../../../shared/acappella/route-decision';
import { truncateCommand } from '../../../shared/formatters';
import { atomicWriteJson, createKeyedWriteQueue } from '../../utils/atomic-json-store';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = 'ACappella';

/** Entries retained. Enough to measure a session's routing, small enough to be free. */
export const MAX_ENTRIES = 200;

/** Utterances are truncated to this before anything is written to disk. */
const MAX_UTTERANCE_CHARS = 200;

/** Writes are batched: a routing turn must not wait on a file. */
const FLUSH_DELAY_MS = 2000;

/**
 * What became of one decision.
 *
 *   - `dispatched` - it reached an agent and a tab.
 *   - `clarified`  - the router asked instead of guessing. Not a miss.
 *   - `corrected`  - it was dispatched and then the user moved it. A miss.
 *   - `failed`     - the dispatch itself could not be performed.
 */
export type RoutingOutcome = 'dispatched' | 'clarified' | 'corrected' | 'failed';

/** One routing turn, flattened so the file reads without cross-referencing. */
export interface RoutingLogEntry {
	id: string;
	at: number;
	utterance: string;
	/** Serialized size of the context the Brain saw, and what was left out of it. */
	contextChars: number;
	droppedTabs: number;
	brainProviderId: string;
	targetSessionId: string | null;
	tabAction: RouteDecision['tabAction'];
	tabId?: string;
	tabName?: string;
	confidence: number;
	clarify?: string;
	latencyMs: number;
	outcome: RoutingOutcome;
	/** Free text for a failure reason, or where a correction moved the prompt. */
	detail?: string;
	/** How many constrained retries this turn needed. 0 for the common case. */
	retries?: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let entries: RoutingLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let loaded = false;

const writeQueue = createKeyedWriteQueue();

/** Injectable in tests: the real path needs an Electron app object. */
let logFilePath: string | null = null;

function resolveLogFilePath(): string {
	if (logFilePath) return logFilePath;
	logFilePath = path.join(app.getPath('userData'), 'acappella', 'routing-log.json');
	return logFilePath;
}

/** Point the log at a different file. Test seam; production uses `userData`. */
export function setRoutingLogPath(filePath: string | null): void {
	logFilePath = filePath;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record one routing turn. Returns the entry id so the outcome can be attached
 * once it is known - the decision is logged before it is executed, so a dispatch
 * that never comes back still leaves evidence of what was attempted.
 */
export function recordRoutingTurn(input: {
	id: string;
	utterance: string;
	decision: RouteDecision;
	brainProviderId: string;
	latencyMs: number;
	contextChars?: number;
	droppedTabs?: number;
	outcome?: RoutingOutcome;
	retries?: number;
}): string {
	const entry: RoutingLogEntry = {
		id: input.id,
		at: Date.now(),
		utterance: truncate(input.utterance, MAX_UTTERANCE_CHARS),
		contextChars: input.contextChars ?? 0,
		droppedTabs: input.droppedTabs ?? 0,
		brainProviderId: input.brainProviderId,
		targetSessionId: routeTargetSessionId(input.decision.target),
		tabAction: input.decision.tabAction,
		tabId: input.decision.tabId,
		tabName: input.decision.tabName,
		confidence: input.decision.confidence,
		clarify: input.decision.clarify,
		latencyMs: input.latencyMs,
		outcome: input.outcome ?? (input.decision.clarify ? 'clarified' : 'dispatched'),
		retries: input.retries,
	};

	entries.push(entry);
	if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
	scheduleFlush();
	return entry.id;
}

/**
 * Attach the real outcome to a turn already recorded.
 *
 * A no-op for an id that has aged out of the ring, which is deliberate: an
 * outcome arriving for a turn two hundred decisions ago is not worth resurrecting
 * the entry for, and re-adding it would put it out of order.
 */
export function noteRoutingOutcome(id: string, outcome: RoutingOutcome, detail?: string): void {
	const entry = entries.find((candidate) => candidate.id === id);
	if (!entry) return;
	entry.outcome = outcome;
	if (detail) entry.detail = detail;
	scheduleFlush();
}

/** The log, newest last. A copy: callers must not be able to rewrite history. */
export function readRoutingLog(): RoutingLogEntry[] {
	return entries.map((entry) => ({ ...entry }));
}

/** The most recent turn, for the HUD's "why did it go there" line. */
export function lastRoutingTurn(): RoutingLogEntry | null {
	return entries.length > 0 ? { ...entries[entries.length - 1] } : null;
}

export interface RoutingQuality {
	turns: number;
	dispatched: number;
	clarified: number;
	corrected: number;
	failed: number;
	/**
	 * Dispatches the user did not have to correct, over all dispatches.
	 *
	 * Clarifications are excluded from both halves: asking is the correct
	 * behaviour below the confidence threshold, and counting it as either a hit
	 * or a miss would make the threshold impossible to tune.
	 */
	hitRate: number | null;
	/** Mean routing latency in ms, over turns that produced a decision. */
	meanLatencyMs: number | null;
}

/** Aggregate the log into the numbers the evaluation doc reports. */
export function routingQuality(): RoutingQuality {
	const counts = { dispatched: 0, clarified: 0, corrected: 0, failed: 0 };
	for (const entry of entries) counts[entry.outcome] += 1;

	const decided = counts.dispatched + counts.corrected;
	const latencies = entries.map((entry) => entry.latencyMs).filter((ms) => ms > 0);

	return {
		turns: entries.length,
		...counts,
		hitRate: decided > 0 ? counts.dispatched / decided : null,
		meanLatencyMs:
			latencies.length > 0
				? Math.round(latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length)
				: null,
	};
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Load the log from disk once, at first use. A missing file is an empty log. */
export async function loadRoutingLog(): Promise<void> {
	if (loaded) return;
	loaded = true;
	try {
		const { readFile } = await import('fs/promises');
		const raw = await readFile(resolveLogFilePath(), 'utf-8');
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) entries = (parsed as RoutingLogEntry[]).slice(-MAX_ENTRIES);
	} catch {
		/* no log yet, or it is unreadable: start fresh rather than fail a turn */
	}
}

function scheduleFlush(): void {
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		void flushRoutingLog();
	}, FLUSH_DELAY_MS);
	// A pending log write must never be the reason the app stays alive.
	flushTimer.unref?.();
}

/** Write the log now. Called by the debounced flush and on shutdown. */
export async function flushRoutingLog(): Promise<void> {
	const snapshot = readRoutingLog();
	try {
		// Inside the guard: resolving the path needs an Electron app object, and a
		// host that has none (a test, a headless spawn) must not turn a best-effort
		// log write into an unhandled rejection.
		const filePath = resolveLogFilePath();
		await writeQueue.enqueue(filePath, async () => {
			const { mkdir } = await import('fs/promises');
			await mkdir(path.dirname(filePath), { recursive: true });
			await atomicWriteJson(filePath, snapshot);
		});
	} catch (error) {
		// A log that cannot be written must not take a voice session with it.
		logger.warn(`Could not write the routing log: ${(error as Error).message}`, LOG_CONTEXT);
	}
}

/** Drop everything. Test seam, and the "clear routing history" action. */
export function resetRoutingLog(): void {
	entries = [];
	loaded = false;
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
}

/** One line, bounded. The truncation is the shared helper, never a new ladder. */
function truncate(text: string, limit: number): string {
	return truncateCommand(text.replace(/\s+/g, ' ').trim(), limit);
}
