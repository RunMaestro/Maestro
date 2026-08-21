/**
 * Claude Mode Selector
 *
 * Pure, deterministic function for deciding whether a Claude Code spawn runs
 * via the API headless path (`claude --print`) or the interactive TUI driver
 * (`maestro-p`, which drives the real claude TUI to spend Max-plan quota).
 *
 * Only called when the per-agent Batch Mode toggle is on. With the toggle
 * gating the entire mechanism, the previous global pin / per-tab manual pin
 * inputs are gone - selection is purely automatic, falling back to API when
 * the latest usage snapshot shows either the 5-hour or 7-day window at or
 * above `LIMIT_THRESHOLD_PERCENT`, and sticky-holding the fallback until both
 * windows have rolled over.
 *
 * No side effects. No I/O. Inputs are not mutated.
 */

export const LIMIT_THRESHOLD_PERCENT = 99;

/**
 * A single usage snapshot for one canonical `CLAUDE_CONFIG_DIR` account.
 * Sourced from `maestro-p --status` and persisted in `claudeUsageStore`.
 *
 * `authState` distinguishes a real measurement from a "Not logged in" stub.
 * The field is optional purely for back-compat with snapshots persisted
 * before the field existed - readers MUST treat absence as `'authenticated'`
 * and only suppress the percentages / show a CTA when it's explicitly
 * `'unauthenticated'`.
 */
export interface UsageSnapshot {
	sampledAt: string;
	configDirKey: string;
	authState?: 'authenticated' | 'unauthenticated';
	// `resetsAt` is absent when claude painted a percentage but no "Resets ..."
	// row for that window (it omits the row for an idle 0% session). Consumers
	// render the percentage anyway and drop the reset caption.
	session: { percent: number; resetsAt?: string };
	weekAllModels: { percent: number; resetsAt?: string };
	/**
	 * The separately-metered premium-model weekly limit. The field name is
	 * historical - claude has renamed this window from "Sonnet only" to "Opus"
	 * to "Fable" - so `label` carries whatever the panel actually called it.
	 */
	weekSonnetOnly: { percent: number; resetsAt?: string; label?: string };
}

export interface SelectModeInput {
	/** `session.claudeInteractive.modeReason`, defaulting to `'auto'` when the field is absent. */
	perTabReason: 'auto' | 'limit';
	/** Latest snapshot for the spawn's effective config dir, or null if none cached. */
	usageSnapshot: UsageSnapshot | null;
	/** Injected wall clock so callers (and tests) own the time source. */
	now: Date;
}

export interface SelectModeResult {
	mode: 'interactive' | 'api';
	reason: 'auto' | 'limit';
}

export function selectMode(input: SelectModeInput): SelectModeResult {
	const snap = input.usageSnapshot;
	if (!snap) {
		return { mode: 'interactive', reason: 'auto' };
	}

	const sessionWindow = windowState(snap.session.resetsAt, input.now);
	const weekWindow = windowState(snap.weekAllModels.resetsAt, input.now);
	// An unknown reset time does NOT veto the fallback: the reset time is here
	// to age out a cached percentage, and the snapshot's own TTL already bounds
	// that, so refusing to act on a freshly-sampled 100% because the panel
	// printed no reset row would be the wrong way to be cautious.
	const sessionWindowOpen = sessionWindow !== 'closed';
	const weekWindowOpen = weekWindow !== 'closed';

	const sessionOverThreshold = snap.session.percent >= LIMIT_THRESHOLD_PERCENT;
	const weekOverThreshold = snap.weekAllModels.percent >= LIMIT_THRESHOLD_PERCENT;

	const limitTriggered =
		(sessionOverThreshold && sessionWindowOpen) || (weekOverThreshold && weekWindowOpen);
	if (limitTriggered) {
		return { mode: 'api', reason: 'limit' };
	}

	// Sticky-limit: a previous turn already fell back. Hold the API choice as
	// long as either reset window remains open. We don't persist which limit
	// fired, so the disjunction is the safest interpretation. Unlike the
	// trigger above this demands a KNOWN open window - an unknown reset time
	// carries no expiry, so treating it as open would latch API mode until the
	// snapshot's 24h TTL ran out.
	if (input.perTabReason === 'limit' && (sessionWindow === 'open' || weekWindow === 'open')) {
		return { mode: 'api', reason: 'limit' };
	}

	return { mode: 'interactive', reason: 'auto' };
}

type WindowState = 'open' | 'closed' | 'unknown';

/**
 * Classify a quota window from its scraped reset time. `unknown` covers both a
 * missing reset (claude paints no "Resets ..." row for an idle window) and an
 * unparseable one; callers decide which way to lean, since the two checks in
 * `selectMode` want opposite answers.
 */
function windowState(resetsAt: string | undefined, now: Date): WindowState {
	if (!resetsAt) return 'unknown';
	const at = new Date(resetsAt);
	if (Number.isNaN(at.getTime())) return 'unknown';
	return now < at ? 'open' : 'closed';
}
