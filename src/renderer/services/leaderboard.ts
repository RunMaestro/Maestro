/**
 * Leaderboard service - ships achievement time deltas to the RunMaestro
 * leaderboard.
 *
 * The server builds its totals from `deltaMs` submissions (delta mode, so a
 * user running Maestro on several machines aggregates correctly). A
 * `cumulativeTimeMs` sent WITHOUT a delta is ignored for an already-registered
 * user, since the server keeps its own totals. That means any local time which
 * never ships a delta drifts permanently below the leaderboard total.
 *
 * So: every path that grows `autoRunStats.cumulativeTimeMs` must also submit
 * its delta through here, or the local Conductor level and the leaderboard
 * silently diverge.
 *
 * A dropped delta is UNRECOVERABLE without help: the client has no way to tell
 * the server "my total is right, yours is not", so every lost submission is
 * permanent and additive. Two ledgers in settings close that hole:
 *
 *   - `leaderboardDeltaOutbox` holds deltas whose submission failed (offline,
 *     server error, no auth token yet). Flushed on the next launch and after
 *     each successful submit, in queue order.
 *   - `leaderboardUncommittedAutoRunMs` holds Auto Run time already credited
 *     locally by the 60s timer but not yet shipped, because Auto Run submits
 *     its whole elapsed time once at completion. A quit, crash, or kill between
 *     the two loses the run's entire time; on the next launch whatever is left
 *     in the counter is queued instead.
 *
 * Both only accrue while the user is registered - an unregistered install ships
 * its local cumulative total at registration time, so queueing deltas earned
 * before that would double-count them.
 */

import { useSettingsStore, selectIsLeaderboardRegistered } from '../stores/settingsStore';
import { notifyToast } from '../stores/notificationStore';
import { getBadgeForTime } from '../constants/conductorBadges';
import { formatDurationCompact } from '../../shared/duration';
import { captureException, captureMessage } from '../utils/sentry';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';

/** Settings key holding the queue of deltas that failed to submit. */
export const LEADERBOARD_OUTBOX_KEY = 'leaderboardDeltaOutbox';
/** Settings key holding when the user was last told about a drift. */
export const LEADERBOARD_DRIFT_NOTIFIED_KEY = 'leaderboardDriftNotifiedAt';
/** Settings key holding locally-credited Auto Run time not yet submitted. */
export const LEADERBOARD_UNCOMMITTED_KEY = 'leaderboardUncommittedAutoRunMs';

/**
 * Cap on queued entries. Reached only after a very long offline stretch; the
 * oldest entries are then collapsed into one aggregate rather than dropped,
 * because dropping an entry loses the user's time for good.
 */
const MAX_OUTBOX_ENTRIES = 200;

/**
 * How far the local total may sit above the server before it counts as drift
 * rather than a submission still in flight.
 */
export const LEADERBOARD_DRIFT_TOLERANCE_MS = 60_000;

/** Drift worth interrupting the user over. Below this, log and Sentry only. */
const DRIFT_NOTIFY_THRESHOLD_MS = 5 * 60_000;

/** Never nag more than once a day about the same standing drift. */
const DRIFT_NOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface PendingLeaderboardDelta {
	id: string;
	deltaMs: number;
	deltaRuns: number;
	source?: 'auto-run' | 'cue';
	queuedAt: number;
}

export interface SubmitLeaderboardTimeDeltaArgs {
	/** Time to add to the server total. Must already be applied locally. */
	deltaMs: number;
	/**
	 * Runs to add to the server total. Defaults to 0 for time that is not an
	 * Auto Run (e.g. Cue), so `totalRuns` keeps matching the local value.
	 *
	 * Send an explicit 0 rather than omitting the field. The server picks
	 * delta mode vs legacy mode off `deltaRuns !== undefined`, and legacy mode
	 * overwrites the server-aggregated run count with this one device's local
	 * total. Omitting it here would silently clobber a multi-device user's
	 * `total_runs` on every Cue submission.
	 */
	deltaRuns?: number;
	/** What earned this time. Lets the server treat Cue's higher submission
	 * frequency differently (notification suppression) without inferring it
	 * from `deltaRuns === 0`. */
	source?: 'auto-run' | 'cue';
}

// ============================================================================
// Ledger persistence
// ============================================================================

/**
 * Serializes every read-modify-write of the two ledgers. They live in settings
 * rather than the store, so two concurrent callers (a 60s tick landing while a
 * flush runs) would otherwise read the same value and one write would win.
 */
let ledgerChain: Promise<unknown> = Promise.resolve();

function onLedger<T>(work: () => Promise<T>): Promise<T> {
	const next = ledgerChain.then(work, work);
	// Keep the chain alive even when a link rejects.
	ledgerChain = next.catch(() => undefined);
	return next;
}

function isPendingDelta(value: unknown): value is PendingLeaderboardDelta {
	if (!value || typeof value !== 'object') return false;
	const entry = value as Partial<PendingLeaderboardDelta>;
	return (
		typeof entry.id === 'string' &&
		typeof entry.deltaMs === 'number' &&
		entry.deltaMs > 0 &&
		typeof entry.deltaRuns === 'number'
	);
}

async function readOutbox(): Promise<PendingLeaderboardDelta[]> {
	const raw = await window.maestro.settings.get(LEADERBOARD_OUTBOX_KEY);
	if (!Array.isArray(raw)) return [];
	return raw.filter(isPendingDelta);
}

async function writeOutbox(entries: PendingLeaderboardDelta[]): Promise<void> {
	await window.maestro.settings.set(LEADERBOARD_OUTBOX_KEY, entries);
}

/**
 * Collapse the oldest entries into a single aggregate so a long offline stretch
 * cannot grow the queue without bound. Time is preserved, only granularity is
 * lost.
 */
function capOutbox(entries: PendingLeaderboardDelta[]): PendingLeaderboardDelta[] {
	if (entries.length <= MAX_OUTBOX_ENTRIES) return entries;
	const overflow = entries.length - MAX_OUTBOX_ENTRIES + 1;
	const collapsed = entries.slice(0, overflow);
	const aggregate: PendingLeaderboardDelta = {
		id: generateId(),
		deltaMs: collapsed.reduce((sum, e) => sum + e.deltaMs, 0),
		deltaRuns: collapsed.reduce((sum, e) => sum + e.deltaRuns, 0),
		source: collapsed.some((e) => e.source !== 'cue') ? 'auto-run' : 'cue',
		queuedAt: collapsed[0]?.queuedAt ?? Date.now(),
	};
	return [aggregate, ...entries.slice(overflow)];
}

/**
 * Append a delta to the persisted outbox. Callers fire and forget; the returned
 * promise exists so a caller that needs the write to have landed (a test, a
 * shutdown path) can await it.
 */
export function queueLeaderboardDelta(args: SubmitLeaderboardTimeDeltaArgs): Promise<void> {
	const { deltaMs, deltaRuns = 0, source } = args;
	if (deltaMs <= 0) return Promise.resolve();
	return onLedger(async () => {
		const entries = await readOutbox();
		entries.push({ id: generateId(), deltaMs, deltaRuns, source, queuedAt: Date.now() });
		await writeOutbox(capOutbox(entries));
		logger.warn(
			`[Leaderboard] Queued ${Math.round(deltaMs / 1000)}s of unsubmitted time (${entries.length} pending)`
		);
	}).catch((error) => {
		captureException(error, { extra: { operation: 'leaderboard-outbox-queue', deltaMs } });
	});
}

/**
 * Credit locally-applied Auto Run time to the uncommitted counter. Called from
 * the 60s achievement timer with the same delta it applies locally, so a crash
 * mid-run leaves an exact record of what never shipped.
 */
export function noteAutoRunCreditAccrued(deltaMs: number): Promise<void> {
	if (deltaMs <= 0) return Promise.resolve();
	if (!selectIsLeaderboardRegistered(useSettingsStore.getState())) return Promise.resolve();
	return onLedger(async () => {
		const current = await window.maestro.settings.get(LEADERBOARD_UNCOMMITTED_KEY);
		const previous = typeof current === 'number' && current > 0 ? current : 0;
		await window.maestro.settings.set(LEADERBOARD_UNCOMMITTED_KEY, previous + deltaMs);
	}).catch(() => undefined);
}

/**
 * Retire uncommitted time once a run's delta has been sent or queued. Clamps at
 * zero: with concurrent runs the completing run subtracts its full elapsed time
 * while another run's ticks are still in the counter, so the counter can only
 * ever under-report, never invent time.
 */
export function noteAutoRunCreditSettled(elapsedMs: number): Promise<void> {
	if (elapsedMs <= 0) return Promise.resolve();
	return onLedger(async () => {
		const current = await window.maestro.settings.get(LEADERBOARD_UNCOMMITTED_KEY);
		const previous = typeof current === 'number' && current > 0 ? current : 0;
		await window.maestro.settings.set(
			LEADERBOARD_UNCOMMITTED_KEY,
			Math.max(0, previous - elapsedMs)
		);
	}).catch(() => undefined);
}

/**
 * Move any Auto Run time left over from a previous session (quit or crash
 * before the completion submit) into the outbox. Returns the recovered ms.
 * Run this at startup BEFORE the first flush, and only while registered.
 */
export async function recoverUncommittedAutoRunCredit(): Promise<number> {
	return onLedger(async () => {
		const current = await window.maestro.settings.get(LEADERBOARD_UNCOMMITTED_KEY);
		const pending = typeof current === 'number' && current > 0 ? current : 0;
		if (pending <= 0) return 0;
		await window.maestro.settings.set(LEADERBOARD_UNCOMMITTED_KEY, 0);
		const entries = await readOutbox();
		entries.push({
			id: generateId(),
			deltaMs: pending,
			deltaRuns: 0,
			source: 'auto-run',
			queuedAt: Date.now(),
		});
		await writeOutbox(capOutbox(entries));
		logger.warn(
			`[Leaderboard] Recovered ${Math.round(pending / 60000)}m of Auto Run time from a previous session`
		);
		return pending;
	}).catch((error) => {
		captureException(error, { extra: { operation: 'leaderboard-uncommitted-recover' } });
		return 0;
	});
}

// ============================================================================
// Submission
// ============================================================================

/**
 * POST one delta. Returns false for any outcome that did not reach the server's
 * totals, so the caller can queue it rather than lose it.
 */
async function postLeaderboardDelta(args: SubmitLeaderboardTimeDeltaArgs): Promise<boolean> {
	const { deltaMs, deltaRuns = 0, source } = args;
	const state = useSettingsStore.getState();
	const registration = state.leaderboardRegistration;
	if (!registration?.authToken) return false;

	const stats = state.autoRunStats;
	const badge = getBadgeForTime(stats.cumulativeTimeMs);

	try {
		const result = await window.maestro.leaderboard.submit({
			email: registration.email,
			displayName: registration.displayName,
			githubUsername: registration.githubUsername,
			twitterHandle: registration.twitterHandle,
			linkedinHandle: registration.linkedinHandle,
			badgeLevel: badge?.level ?? 0,
			badgeName: badge?.name ?? 'No Badge Yet',
			cumulativeTimeMs: stats.cumulativeTimeMs,
			totalRuns: stats.totalRuns,
			longestRunMs: stats.longestRunMs || undefined,
			authToken: registration.authToken,
			deltaMs,
			deltaRuns,
			clientTotalTimeMs: stats.cumulativeTimeMs,
			source,
		});

		if (result.success) {
			useSettingsStore.getState().setLeaderboardRegistration({
				...registration,
				lastSubmissionAt: Date.now(),
			});
			return true;
		}
		logger.warn(`Leaderboard delta submission failed: ${result.error ?? result.message}`);
		return false;
	} catch (error) {
		// Background submission: a network blip must not break the run that
		// earned the time. The delta is queued by the caller instead of lost -
		// report it so the retry is visible rather than silent.
		captureException(error, {
			extra: { operation: 'leaderboard-delta-submit', deltaMs, deltaRuns },
		});
		logger.warn(
			`Leaderboard delta submission threw: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
		return false;
	}
}

/**
 * Submit a time delta for the registered user. No-ops when the user is not
 * registered or has not confirmed their email; anything that fails after that
 * point is queued for the next flush instead of being dropped.
 *
 * Call this AFTER the delta has been applied locally, so the accompanying
 * `cumulativeTimeMs` / `clientTotalTimeMs` reflect the same total the local
 * badge is showing and the server's discrepancy check stays quiet.
 */
export async function submitLeaderboardTimeDelta(
	args: SubmitLeaderboardTimeDeltaArgs
): Promise<void> {
	const { deltaMs, deltaRuns = 0, source } = args;
	if (deltaMs <= 0) return;

	const state = useSettingsStore.getState();
	if (!selectIsLeaderboardRegistered(state)) return;

	const registration = state.leaderboardRegistration;
	if (!registration) return;
	if (!registration.authToken) {
		// The token arrives when the user confirms their email. Queue rather
		// than warn-and-drop: the time is already on the local badge.
		logger.warn('Leaderboard delta queued: no auth token yet');
		await queueLeaderboardDelta({ deltaMs, deltaRuns, source });
		return;
	}

	const sent = await postLeaderboardDelta({ deltaMs, deltaRuns, source });
	if (!sent) await queueLeaderboardDelta({ deltaMs, deltaRuns, source });
}

/**
 * Drain the outbox in queue order. Stops at the first failure so a server that
 * is down does not burn the whole queue, and keeps the rest for the next
 * attempt. Safe to call when the queue is empty.
 */
export async function flushLeaderboardOutbox(): Promise<{ sent: number; pending: number }> {
	const state = useSettingsStore.getState();
	if (!selectIsLeaderboardRegistered(state) || !state.leaderboardRegistration?.authToken) {
		const pending = await readOutbox().catch(() => []);
		return { sent: 0, pending: pending.length };
	}

	return onLedger(async () => {
		let entries = await readOutbox();
		if (entries.length === 0) return { sent: 0, pending: 0 };

		let sent = 0;
		while (entries.length > 0) {
			const entry = entries[0];
			const ok = await postLeaderboardDelta({
				deltaMs: entry.deltaMs,
				deltaRuns: entry.deltaRuns,
				source: entry.source,
			});
			if (!ok) break;
			entries = entries.slice(1);
			sent++;
			await writeOutbox(entries);
		}

		if (sent > 0) {
			logger.info(`[Leaderboard] Flushed ${sent} queued delta(s), ${entries.length} still pending`);
		}
		return { sent, pending: entries.length };
	}).catch((error) => {
		captureException(error, { extra: { operation: 'leaderboard-outbox-flush' } });
		return { sent: 0, pending: -1 };
	});
}

// ============================================================================
// Drift detection
// ============================================================================

/**
 * Report a local total that sits ABOVE the server's.
 *
 * On an established install the server is the sum across every device, so
 * `server >= local` is the invariant. `local > server` is not a stale server to
 * be ignored - it is the signature of deltas that never landed, and because a
 * `cumulativeTimeMs` without a `deltaMs` is ignored for an existing user, the
 * gap can never close on its own. Surfacing it is the whole point: the previous
 * code took this branch silently, which latched the startup sync off forever.
 */
export async function reportLeaderboardDrift(localMs: number, serverMs: number): Promise<void> {
	const gap = localMs - serverMs;
	if (gap <= LEADERBOARD_DRIFT_TOLERANCE_MS) return;

	logger.warn(
		`[Leaderboard] Local total is ${formatDurationCompact(gap)} ahead of the server ` +
			`(local ${localMs}ms, server ${serverMs}ms). Deltas were dropped; the server cannot ` +
			`recover them without an explicit push.`
	);
	captureMessage('Leaderboard local total exceeds server total', {
		level: 'warning',
		extra: { localMs, serverMs, gapMs: gap },
	});

	if (gap < DRIFT_NOTIFY_THRESHOLD_MS) return;

	try {
		const last = await window.maestro.settings.get(LEADERBOARD_DRIFT_NOTIFIED_KEY);
		const lastAt = typeof last === 'number' ? last : 0;
		if (Date.now() - lastAt < DRIFT_NOTIFY_INTERVAL_MS) return;
		await window.maestro.settings.set(LEADERBOARD_DRIFT_NOTIFIED_KEY, Date.now());
	} catch {
		// A settings read failure must not cost the user the warning itself.
	}

	notifyToast({
		color: 'yellow',
		title: 'Leaderboard is behind your local time',
		message:
			`${formatDurationCompact(gap)} of your Conductor time never reached the leaderboard. ` +
			`Open Achievements > Leaderboard and use "Push Difference" to send it.`,
		dismissible: true,
	});
}
