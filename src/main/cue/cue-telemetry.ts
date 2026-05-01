/**
 * Cue Telemetry — captures `trigger_fired` and `run_completed` events to a
 * local outbox and submits them in batches to runmaestro.ai.
 *
 * Wire contract is documented in CLAUDE-CUE.md (§Telemetry). Two event types
 * cover all server-side rollups:
 *
 * - `trigger_fired`  — emitted from `cue-dispatch-service.ts` once per
 *   subscription dispatch (NOT once per fan-out target). Carries the source
 *   event type so the server can bucket by trigger kind.
 * - `run_completed`  — emitted from `cue-engine.ts`'s `onRunCompleted`
 *   callback once per natural run completion. Carries hashed pipeline id,
 *   raw chain root id, parent run id, duration, status, and `task_kind`
 *   ("agent_handoff" | "command_node" | "trigger_action") so the server
 *   derives "tasks run" from a single source of truth.
 *
 * Privacy:
 * - Pipeline / subscription / trigger names are sha256-hashed with the local
 *   installationId as salt: `sha256(installationId + ":" + name).slice(0,16)`.
 *   Stable per install, not cross-correlatable across users.
 * - `chain_root_id` is left raw because it's already a random UUID assigned
 *   at run-start with no semantic content.
 * - The outbox stores serialized events (already hashed) — no plaintext
 *   names ever land on disk in the telemetry table.
 *
 * Gating:
 * - `MAESTRO_DISABLE_CUE_TELEMETRY=1` env var → hard disable (collection
 *   AND submission no-op). Read on every call so test harnesses can flip it.
 * - `encoreFeatures.usageStats === true && encoreFeatures.maestroCue === true`
 *   → required to record OR submit. Mirrors `isCueStatsEnabled` in
 *   `cue-stats.ts` so the renderer's Cue stats tab and the telemetry channel
 *   share a single opt-out.
 * - Server may return `X-Cue-Telemetry-Backoff: <seconds>` to throttle the
 *   client without an app update; honored until the backoff expires.
 *
 * Cadence:
 * - Primary flush trigger: an autorun completion calls `flushTelemetry()`
 *   from `stats:end-autorun`. This is the user's natural quiet window.
 * - Fallback: app-quit flush + outbox-threshold flush (>= 200 rows).
 * - No timer-based flush — burning battery on idle installs is not the goal.
 */

import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import {
	insertTelemetryEvent,
	getTelemetryBatch,
	deleteTelemetryEvents,
	countTelemetryEvents,
} from './cue-db';

const LOG_CONTEXT = '[CueTelemetry]';

/** Schema version of the wire payload — bumped on breaking format changes. */
const SCHEMA_VERSION = 1;

/** Endpoint for telemetry submission. Module-level so tests can override. */
const DEFAULT_TELEMETRY_ENDPOINT = 'https://runmaestro.ai/api/v1/cue/stats';

/**
 * Submission caps (server-side enforced, mirrored here so we don't even try
 * to send oversized batches). Server returns 202 + `{dropped: N}` if it has
 * to truncate, but we can save a round trip.
 */
const MAX_EVENTS_PER_BATCH = 500;
const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * Threshold-flush guard: if the outbox grows past this without an autorun
 * completing (e.g. a Cue-only user who never runs Auto Run), flush anyway so
 * the outbox doesn't grow unbounded. Picked deliberately above the
 * MAX_EVENTS_PER_BATCH so a single threshold flush always sends a full batch.
 */
const OUTBOX_FLUSH_THRESHOLD = 200;

/** Fetch timeout for telemetry POSTs. Short — telemetry is best-effort. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Hash truncation length. 16 hex chars = 64 bits of entropy, enough to
 * distinguish O(billions) of distinct names without collision risk while
 * keeping the wire payload compact. Not cryptographic — only obfuscation.
 */
const HASH_PREFIX_LENGTH = 16;

// ============================================================================
// Wire types
// ============================================================================

export type CueTelemetryEventType = 'trigger_fired' | 'run_completed';

export type CueTelemetryTaskKind = 'agent_handoff' | 'command_node' | 'trigger_action';

export interface CueTelemetryTriggerFiredEvent {
	type: 'trigger_fired';
	ts: string;
	event_type: string;
	subscription_id_hash: string;
	pipeline_id_hash: string | null;
	trigger_id_hash: string;
}

export interface CueTelemetryRunCompletedEvent {
	type: 'run_completed';
	ts: string;
	task_kind: CueTelemetryTaskKind;
	subscription_id_hash: string;
	pipeline_id_hash: string | null;
	chain_root_id: string | null;
	parent_run_id: string | null;
	duration_ms: number;
	status: string;
}

export type CueTelemetryEvent = CueTelemetryTriggerFiredEvent | CueTelemetryRunCompletedEvent;

interface CueTelemetryPayload {
	schema_version: number;
	client_id: string;
	app_version: string;
	platform: string;
	window_start: string;
	window_end: string;
	events: CueTelemetryEvent[];
	totals: {
		trigger_fired: number;
		run_completed: number;
		execution_time_ms: number;
	};
}

// ============================================================================
// Module configuration
// ============================================================================

export interface CueTelemetryConfig {
	getInstallationId: () => string | null;
	getAppVersion: () => string;
	getPlatform: () => string;
	isEncoreEnabled: () => boolean;
	endpoint?: string;
}

interface ModuleState {
	config: CueTelemetryConfig | null;
	/** Wall-clock ms until which submissions are paused (server backoff). */
	backoffUntil: number;
	/** Guards against overlapping flushes — only one POST in flight at a time. */
	flushInFlight: boolean;
}

const state: ModuleState = {
	config: null,
	backoffUntil: 0,
	flushInFlight: false,
};

/**
 * Configure the telemetry module. Idempotent — calling more than once
 * replaces the prior config (used by tests, and by the engine when it
 * restarts with new dependencies).
 */
export function configureCueTelemetry(config: CueTelemetryConfig): void {
	state.config = config;
}

/** Reset module state. Test-only. */
export function resetCueTelemetryForTests(): void {
	state.config = null;
	state.backoffUntil = 0;
	state.flushInFlight = false;
}

// ============================================================================
// Gating
// ============================================================================

function isKillSwitchOn(): boolean {
	return process.env.MAESTRO_DISABLE_CUE_TELEMETRY === '1';
}

function isTelemetryActive(): boolean {
	if (isKillSwitchOn()) return false;
	if (!state.config) return false;
	if (!state.config.isEncoreEnabled()) return false;
	return true;
}

// ============================================================================
// Hashing
// ============================================================================

/**
 * Hash a name with the local installationId as salt. Returns null if no
 * installationId is available yet (engine started before main bootstrap
 * persisted the id) or if the input name is empty — callers store null to
 * avoid creating a misleading "empty-string" bucket on the server.
 */
export function hashName(
	name: string | undefined | null,
	installationId: string | null
): string | null {
	if (!installationId) return null;
	if (!name) return null;
	return crypto
		.createHash('sha256')
		.update(`${installationId}:${name}`)
		.digest('hex')
		.slice(0, HASH_PREFIX_LENGTH);
}

// ============================================================================
// Event recording
// ============================================================================

export interface RecordTriggerFiredArgs {
	eventType: string;
	subscriptionName: string;
	pipelineName?: string;
	/**
	 * The trigger source identifier (typically `event.triggerName` from the
	 * dispatched CueEvent, e.g. the file glob, schedule label, or repo name).
	 */
	triggerName: string;
}

export function recordTriggerFired(args: RecordTriggerFiredArgs): void {
	if (!isTelemetryActive()) return;
	const installationId = state.config!.getInstallationId();
	if (!installationId) return;

	const event: CueTelemetryTriggerFiredEvent = {
		type: 'trigger_fired',
		ts: new Date().toISOString(),
		event_type: args.eventType,
		subscription_id_hash: hashName(args.subscriptionName, installationId) ?? '',
		pipeline_id_hash: hashName(args.pipelineName, installationId),
		trigger_id_hash: hashName(args.triggerName, installationId) ?? '',
	};
	persistEvent(event);
}

export interface RecordRunCompletedArgs {
	subscriptionName: string;
	pipelineName?: string;
	taskKind: CueTelemetryTaskKind;
	chainRootId?: string | null;
	parentRunId?: string | null;
	durationMs: number;
	status: string;
}

export function recordRunCompleted(args: RecordRunCompletedArgs): void {
	if (!isTelemetryActive()) return;
	const installationId = state.config!.getInstallationId();
	if (!installationId) return;

	const event: CueTelemetryRunCompletedEvent = {
		type: 'run_completed',
		ts: new Date().toISOString(),
		task_kind: args.taskKind,
		subscription_id_hash: hashName(args.subscriptionName, installationId) ?? '',
		pipeline_id_hash: hashName(args.pipelineName, installationId),
		chain_root_id: args.chainRootId ?? null,
		parent_run_id: args.parentRunId ?? null,
		duration_ms: Math.max(0, Math.floor(args.durationMs)),
		status: args.status,
	};
	persistEvent(event);
}

function persistEvent(event: CueTelemetryEvent): void {
	// Telemetry is best-effort: any DB failure here (insert OR the COUNT(*)
	// behind countTelemetryEvents) must NOT bubble out of recordTriggerFired
	// / recordRunCompleted, since those run on the dispatch and completion
	// hot paths.
	try {
		const id = crypto.randomUUID();
		insertTelemetryEvent(id, JSON.stringify(event));
		// Threshold-flush safety net for installs that never run Auto Run.
		// Cheap — countTelemetryEvents is a single COUNT(*) on a small table.
		const size = countTelemetryEvents();
		if (size >= OUTBOX_FLUSH_THRESHOLD) {
			void flushTelemetry({ reason: 'threshold' });
		}
	} catch (err) {
		logger.warn(
			`Telemetry outbox write failed: ${err instanceof Error ? err.message : String(err)}`,
			LOG_CONTEXT
		);
	}
}

// ============================================================================
// Submission
// ============================================================================

export interface FlushOptions {
	reason: 'autorun' | 'app-quit' | 'threshold' | 'manual';
}

export interface FlushResult {
	ok: boolean;
	reason: 'sent' | 'noop' | 'disabled' | 'in-flight' | 'backoff' | 'empty' | 'error';
	sent?: number;
	error?: string;
}

/**
 * Drain the outbox by POSTing one batch to the telemetry endpoint. Returns
 * a result describing what happened — callers (autorun completion, app-quit,
 * threshold) don't act on it but tests and observers can.
 *
 * On success: deletes submitted rows from the outbox.
 * On failure: leaves rows in place; next flush retries them.
 * On 4xx with `X-Cue-Telemetry-Backoff: <seconds>`: pauses subsequent flushes
 *   until the deadline.
 */
export async function flushTelemetry(
	opts: FlushOptions = { reason: 'manual' }
): Promise<FlushResult> {
	if (!isTelemetryActive()) return { ok: false, reason: 'disabled' };
	if (state.flushInFlight) return { ok: false, reason: 'in-flight' };
	if (Date.now() < state.backoffUntil) return { ok: false, reason: 'backoff' };

	const config = state.config!;
	const installationId = config.getInstallationId();
	if (!installationId) return { ok: false, reason: 'noop' };

	const rows = getTelemetryBatch(MAX_EVENTS_PER_BATCH);
	if (rows.length === 0) return { ok: true, reason: 'empty' };

	state.flushInFlight = true;
	try {
		const events: CueTelemetryEvent[] = [];
		const ids: string[] = [];
		for (const row of rows) {
			let parsed: CueTelemetryEvent | null = null;
			try {
				parsed = JSON.parse(row.eventJson) as CueTelemetryEvent;
			} catch {
				// Malformed row — drop it from the outbox so it doesn't poison
				// future flushes. We bundle it into `ids` so the success path
				// deletes it.
				ids.push(row.id);
				continue;
			}
			events.push(parsed);
			ids.push(row.id);
		}
		if (events.length === 0) {
			deleteTelemetryEvents(ids);
			return { ok: true, reason: 'empty' };
		}

		const windowStart = new Date(rows[0].createdAt).toISOString();
		const windowEnd = new Date(rows[rows.length - 1].createdAt).toISOString();

		const totals = computeTotals(events);

		const payload: CueTelemetryPayload = {
			schema_version: SCHEMA_VERSION,
			client_id: installationId,
			app_version: config.getAppVersion(),
			platform: config.getPlatform(),
			window_start: windowStart,
			window_end: windowEnd,
			events,
			totals,
		};

		const body = JSON.stringify(payload);
		if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
			// Drop the OLDEST half and try again next flush rather than
			// hanging forever on a too-large batch. getTelemetryBatch returns
			// rows oldest-first, so slice from the front. Half is arbitrary
			// but guarantees forward progress; ceil() ensures we always make
			// progress even on a 1-row batch.
			const dropCount = Math.max(1, Math.ceil(ids.length / 2));
			const dropIds = ids.slice(0, dropCount);
			deleteTelemetryEvents(dropIds);
			logger.warn(
				`Telemetry batch exceeded ${MAX_PAYLOAD_BYTES} bytes — dropped ${dropIds.length} events`,
				LOG_CONTEXT
			);
			return { ok: false, reason: 'error', error: 'payload-too-large' };
		}

		const response = await fetchWithTimeout(config.endpoint ?? DEFAULT_TELEMETRY_ENDPOINT, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': `Maestro/${config.getAppVersion()}`,
			},
			body,
		});

		const backoffHeader = response.headers.get('X-Cue-Telemetry-Backoff');
		if (backoffHeader) {
			const seconds = parseInt(backoffHeader, 10);
			if (Number.isFinite(seconds) && seconds > 0) {
				state.backoffUntil = Date.now() + seconds * 1000;
				logger.info(`Server requested telemetry backoff for ${seconds}s`, LOG_CONTEXT);
			}
		}

		// 2xx (including 202) — server accepted, drop the rows we sent.
		if (response.ok) {
			deleteTelemetryEvents(ids);
			logger.info(
				`Submitted ${events.length} telemetry events (reason=${opts.reason})`,
				LOG_CONTEXT
			);
			return { ok: true, reason: 'sent', sent: events.length };
		}

		// 4xx — drop the batch (server thinks it's bad and won't accept on
		// retry). 5xx — keep, retry later. Either way, don't crash.
		if (response.status >= 400 && response.status < 500) {
			deleteTelemetryEvents(ids);
			logger.warn(
				`Telemetry rejected with ${response.status} — dropped ${events.length} events`,
				LOG_CONTEXT
			);
			return { ok: false, reason: 'error', error: `http-${response.status}` };
		}

		logger.warn(
			`Telemetry submission failed (${response.status}) — will retry next flush`,
			LOG_CONTEXT
		);
		return { ok: false, reason: 'error', error: `http-${response.status}` };
	} catch (err) {
		// Network errors (timeout, DNS, offline). Leave outbox rows in place
		// so the next flush retries them. Do NOT report to Sentry — these are
		// expected at scale and would generate noise.
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(`Telemetry submission error: ${message}`, LOG_CONTEXT);
		return { ok: false, reason: 'error', error: message };
	} finally {
		state.flushInFlight = false;
	}
}

function computeTotals(events: CueTelemetryEvent[]): CueTelemetryPayload['totals'] {
	let triggers = 0;
	let runs = 0;
	let runDurationMs = 0;
	for (const event of events) {
		if (event.type === 'trigger_fired') {
			triggers++;
		} else if (event.type === 'run_completed') {
			runs++;
			runDurationMs += event.duration_ms;
		}
	}
	return {
		trigger_fired: triggers,
		run_completed: runs,
		execution_time_ms: runDurationMs,
	};
}

async function fetchWithTimeout(
	url: string,
	options: RequestInit,
	timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...options, signal: controller.signal });
	} finally {
		clearTimeout(timeoutId);
	}
}
