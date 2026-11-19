/**
 * Playbook Telemetry - anonymous usage of official Playbook Exchange
 * playbooks, captured to a local outbox and submitted in batches to
 * runmaestro.ai. Modelled on `src/main/cue/cue-telemetry.ts`, with Cue's
 * envelope verbatim and a different privacy rule (see below).
 *
 * Events (shapes and builders in `src/shared/playbookTelemetry.ts`):
 * - `install`        - an Exchange import finished (`importMarketplacePlaybook`).
 * - `run_started`    - a playbook run began.
 * - `run_completed`  - it ended, with its status, duration, and document counts.
 * - `run_failed`     - one per failing task, at most five per run, never for
 *   a run the user stopped. Carries the same fingerprint a filed issue does.
 *
 * Privacy (PROPOSAL D17): playbook ids are public slugs, so they are NOT
 * hashed; hashing them would destroy the signal. The private things are not
 * fields at all: no project path, parameter value, agent name, or user. Only
 * the envelope's `client_id` (the installation id) identifies anything. Only
 * playbooks whose `provenance.sourceChannel` is `official` are recorded; a
 * local-manifest playbook would send names its author chose.
 *
 * Gating (every check runs on every call):
 * - `MAESTRO_DISABLE_PLAYBOOK_TELEMETRY=1` → hard disable.
 * - Unpackaged (dev) builds never record or send.
 * - `playbookTelemetryEnabled` must be true. It defaults to false: the user
 *   opts in, because riding default-on toggles to authorize a new egress
 *   channel is not consent.
 * - The server may return `X-Playbook-Telemetry-Backoff: <seconds>`.
 *
 * Cadence: flushed from `stats:end-autorun` (the same quiet window Cue uses),
 * at app quit, and when the outbox passes a threshold. No timer.
 *
 * Outbox: a JSON file in userData. The volume is single-digit events per
 * day, so a SQLite table would be all cost and no benefit.
 */

import * as fsSync from 'fs';
import { logger } from '../utils/logger';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { atomicWriteJson } from '../utils/atomic-json-store';
import { generateUUID } from '../../shared/uuid';
import { playbookFailureFingerprint } from '../../shared/playbookFailure';
import {
	buildPlaybookInstallEvent,
	buildPlaybookRunCompletedEvent,
	buildPlaybookRunFailedEvents,
	buildPlaybookRunStartedEvent,
	type PlaybookTelemetryEvent,
	type PlaybookTelemetryEventType,
	type PlaybookTelemetryRunEnd,
	type PlaybookTelemetryRunStart,
	type PlaybookTelemetrySubject,
} from '../../shared/playbookTelemetry';

const LOG_CONTEXT = '[PlaybookTelemetry]';

/** Schema version of the wire payload - bumped on breaking format changes. */
const SCHEMA_VERSION = 1;

const DEFAULT_TELEMETRY_ENDPOINT = 'https://runmaestro.ai/api/v1/playbooks/stats';

export const PLAYBOOK_TELEMETRY_BACKOFF_HEADER = 'X-Playbook-Telemetry-Backoff';

export const PLAYBOOK_TELEMETRY_KILL_SWITCH = 'MAESTRO_DISABLE_PLAYBOOK_TELEMETRY';

/** Server-side caps, mirrored so an oversized batch is never sent. */
const MAX_EVENTS_PER_BATCH = 500;
const MAX_PAYLOAD_BYTES = 256 * 1024;

/** Flush early when the outbox grows this far between Auto Run completions. */
const OUTBOX_FLUSH_THRESHOLD = 50;

/**
 * The outbox never holds more than this. A machine that is offline for weeks
 * drops its oldest events rather than growing a file without bound.
 */
const MAX_OUTBOX_EVENTS = 1000;

const FETCH_TIMEOUT_MS = 10_000;

// ============================================================================
// Wire types
// ============================================================================

interface PlaybookTelemetryPayload {
	schema_version: number;
	client_id: string;
	app_version: string;
	platform: string;
	window_start: string;
	window_end: string;
	events: PlaybookTelemetryEvent[];
	totals: Record<PlaybookTelemetryEventType, number>;
}

interface OutboxRow {
	id: string;
	createdAt: number;
	event: PlaybookTelemetryEvent;
}

// ============================================================================
// Module configuration
// ============================================================================

export interface PlaybookTelemetryConfig {
	getInstallationId: () => string | null;
	getAppVersion: () => string;
	getPlatform: () => string;
	/** `playbookTelemetryEnabled === true`. Read on every call. */
	isEnabled: () => boolean;
	/** `app.isPackaged`: a dev build never records or sends. */
	isPackaged: () => boolean;
	/** The outbox JSON file. */
	outboxPath: string;
	endpoint?: string;
}

interface ModuleState {
	config: PlaybookTelemetryConfig | null;
	/** Loaded lazily from `outboxPath` on first use. */
	outbox: OutboxRow[] | null;
	/** Runs in flight, by run key (the agent id: one Auto Run per agent). */
	runs: Map<string, PlaybookTelemetryRunStart>;
	backoffUntil: number;
	flushInFlight: boolean;
	/** Serializes outbox writes so a later snapshot never lands under an earlier one. */
	persistChain: Promise<void>;
}

const state: ModuleState = {
	config: null,
	outbox: null,
	runs: new Map(),
	backoffUntil: 0,
	flushInFlight: false,
	persistChain: Promise.resolve(),
};

/** Configure the module. Calling again replaces the prior config. */
export function configurePlaybookTelemetry(config: PlaybookTelemetryConfig): void {
	state.config = config;
	state.outbox = null;
}

/** Reset module state. Test-only. */
export function resetPlaybookTelemetryForTests(): void {
	state.config = null;
	state.outbox = null;
	state.runs.clear();
	state.backoffUntil = 0;
	state.flushInFlight = false;
	state.persistChain = Promise.resolve();
}

/** Resolve once every queued outbox write has landed. Test-only. */
export function playbookTelemetryWritesSettled(): Promise<void> {
	return state.persistChain;
}

// ============================================================================
// Gating
// ============================================================================

function isTelemetryActive(): boolean {
	if (process.env[PLAYBOOK_TELEMETRY_KILL_SWITCH] === '1') return false;
	const config = state.config;
	if (!config) return false;
	if (!config.isPackaged()) return false;
	return config.isEnabled();
}

// ============================================================================
// Outbox
// ============================================================================

function isOutboxRow(value: unknown): value is OutboxRow {
	if (!value || typeof value !== 'object') return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === 'string' &&
		typeof row.createdAt === 'number' &&
		!!row.event &&
		typeof row.event === 'object' &&
		typeof (row.event as Record<string, unknown>).type === 'string'
	);
}

function loadOutbox(): OutboxRow[] {
	if (state.outbox) return state.outbox;
	const outboxPath = state.config!.outboxPath;
	let rows: OutboxRow[] = [];
	try {
		const parsed: unknown = JSON.parse(fsSync.readFileSync(outboxPath, 'utf8'));
		rows = Array.isArray(parsed) ? parsed.filter(isOutboxRow) : [];
	} catch (err) {
		// ENOENT is the normal first run. A corrupt file is dropped rather than
		// blocking telemetry forever: the events are best-effort by design.
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			logger.warn(
				`Playbook telemetry outbox unreadable, starting empty: ${err instanceof Error ? err.message : String(err)}`,
				LOG_CONTEXT
			);
		}
	}
	state.outbox = rows;
	return rows;
}

function persistOutbox(): void {
	const outboxPath = state.config!.outboxPath;
	const snapshot = [...loadOutbox()];
	state.persistChain = state.persistChain
		.then(() => atomicWriteJson(outboxPath, snapshot))
		.catch((err) => {
			logger.warn(
				`Playbook telemetry outbox write failed: ${err instanceof Error ? err.message : String(err)}`,
				LOG_CONTEXT
			);
		});
}

function enqueueEvents(events: PlaybookTelemetryEvent[]): void {
	if (events.length === 0) return;
	const outbox = loadOutbox();
	const now = Date.now();
	for (const event of events) {
		outbox.push({ id: generateUUID(), createdAt: now, event });
	}
	if (outbox.length > MAX_OUTBOX_EVENTS) {
		outbox.splice(0, outbox.length - MAX_OUTBOX_EVENTS);
	}
	persistOutbox();
	if (outbox.length >= OUTBOX_FLUSH_THRESHOLD) {
		void flushPlaybookTelemetry({ reason: 'threshold' });
	}
}

// ============================================================================
// Recording
// ============================================================================

/** An Exchange import finished. Recorded only for an official playbook. */
export function recordPlaybookInstall(subject: PlaybookTelemetrySubject): void {
	if (!isTelemetryActive()) return;
	const event = buildPlaybookInstallEvent(subject);
	if (event) enqueueEvents([event]);
}

/**
 * A playbook run began on `runKey` (the agent id). Remembers the run so its
 * end can name the playbook, and records `run_started`.
 */
export function notePlaybookRunStarted(runKey: string, start: PlaybookTelemetryRunStart): void {
	// A run that starts while telemetry is off is never tracked, so turning it
	// on mid-run does not send a `run_completed` with no `run_started`.
	state.runs.delete(runKey);
	if (!isTelemetryActive()) return;
	const event = buildPlaybookRunStartedEvent(start);
	if (!event) return;
	state.runs.set(runKey, start);
	enqueueEvents([event]);
}

/**
 * The run on `runKey` ended. Records `run_completed` and its `run_failed`
 * events. A key with no tracked start (telemetry was off, the playbook is not
 * official, or the app restarted mid-run) records nothing.
 */
export function notePlaybookRunEnded(runKey: string, end: PlaybookTelemetryRunEnd): void {
	const start = state.runs.get(runKey);
	state.runs.delete(runKey);
	if (!start || !isTelemetryActive()) return;
	const completed = buildPlaybookRunCompletedEvent(start, end);
	if (!completed) return;
	enqueueEvents([
		completed,
		...buildPlaybookRunFailedEvents(start, end, playbookFailureFingerprint),
	]);
}

// ============================================================================
// Submission
// ============================================================================

export interface PlaybookTelemetryFlushOptions {
	reason: 'autorun' | 'app-quit' | 'threshold' | 'manual';
}

export interface PlaybookTelemetryFlushResult {
	ok: boolean;
	reason: 'sent' | 'noop' | 'disabled' | 'in-flight' | 'backoff' | 'empty' | 'error';
	sent?: number;
	error?: string;
}

function removeRows(ids: ReadonlySet<string>): void {
	const outbox = loadOutbox();
	const kept = outbox.filter((row) => !ids.has(row.id));
	outbox.length = 0;
	outbox.push(...kept);
	persistOutbox();
}

function computeTotals(events: PlaybookTelemetryEvent[]): PlaybookTelemetryPayload['totals'] {
	const totals: PlaybookTelemetryPayload['totals'] = {
		install: 0,
		run_started: 0,
		run_completed: 0,
		run_failed: 0,
	};
	for (const event of events) totals[event.type]++;
	return totals;
}

/**
 * POST one batch from the outbox. On 2xx the sent rows are removed; on 4xx
 * the batch is dropped (the server will not accept it on retry); on 5xx or a
 * network error the rows stay for the next flush.
 */
export async function flushPlaybookTelemetry(
	opts: PlaybookTelemetryFlushOptions = { reason: 'manual' }
): Promise<PlaybookTelemetryFlushResult> {
	if (!isTelemetryActive()) return { ok: false, reason: 'disabled' };
	if (state.flushInFlight) return { ok: false, reason: 'in-flight' };
	if (Date.now() < state.backoffUntil) return { ok: false, reason: 'backoff' };

	const config = state.config!;
	const installationId = config.getInstallationId();
	if (!installationId) return { ok: false, reason: 'noop' };

	const rows = loadOutbox().slice(0, MAX_EVENTS_PER_BATCH);
	if (rows.length === 0) return { ok: true, reason: 'empty' };

	state.flushInFlight = true;
	try {
		const ids = new Set(rows.map((row) => row.id));
		const events = rows.map((row) => row.event);
		const payload: PlaybookTelemetryPayload = {
			schema_version: SCHEMA_VERSION,
			client_id: installationId,
			app_version: config.getAppVersion(),
			platform: config.getPlatform(),
			window_start: new Date(rows[0].createdAt).toISOString(),
			window_end: new Date(rows[rows.length - 1].createdAt).toISOString(),
			events,
			totals: computeTotals(events),
		};

		const body = JSON.stringify(payload);
		if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
			// Drop the oldest half so the next flush makes progress.
			const dropCount = Math.max(1, Math.ceil(rows.length / 2));
			removeRows(new Set(rows.slice(0, dropCount).map((row) => row.id)));
			logger.warn(
				`Playbook telemetry batch exceeded ${MAX_PAYLOAD_BYTES} bytes - dropped ${dropCount} events`,
				LOG_CONTEXT
			);
			return { ok: false, reason: 'error', error: 'payload-too-large' };
		}

		const response = await fetchWithTimeout(
			config.endpoint ?? DEFAULT_TELEMETRY_ENDPOINT,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': `Maestro/${config.getAppVersion()}`,
				},
				body,
			},
			FETCH_TIMEOUT_MS
		);

		const backoffHeader = response.headers.get(PLAYBOOK_TELEMETRY_BACKOFF_HEADER);
		if (backoffHeader) {
			const seconds = parseInt(backoffHeader, 10);
			if (Number.isFinite(seconds) && seconds > 0) {
				state.backoffUntil = Date.now() + seconds * 1000;
				logger.info(`Server requested playbook telemetry backoff for ${seconds}s`, LOG_CONTEXT);
			}
		}

		if (response.ok) {
			removeRows(ids);
			logger.info(
				`Submitted ${events.length} playbook telemetry events (reason=${opts.reason})`,
				LOG_CONTEXT
			);
			return { ok: true, reason: 'sent', sent: events.length };
		}

		if (response.status >= 400 && response.status < 500) {
			removeRows(ids);
			logger.warn(
				`Playbook telemetry rejected with ${response.status} - dropped ${events.length} events`,
				LOG_CONTEXT
			);
			return { ok: false, reason: 'error', error: `http-${response.status}` };
		}

		logger.warn(
			`Playbook telemetry submission failed (${response.status}) - will retry next flush`,
			LOG_CONTEXT
		);
		return { ok: false, reason: 'error', error: `http-${response.status}` };
	} catch (err) {
		// Offline, DNS, timeout: expected at scale, so logged and not reported.
		// The rows stay for the next flush.
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(`Playbook telemetry submission error: ${message}`, LOG_CONTEXT);
		return { ok: false, reason: 'error', error: message };
	} finally {
		state.flushInFlight = false;
	}
}
