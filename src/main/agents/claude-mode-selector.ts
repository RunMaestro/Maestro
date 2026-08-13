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
	session: { percent: number; resetsAt: string };
	weekAllModels: { percent: number; resetsAt: string };
	weekSonnetOnly: { percent: number; resetsAt: string };
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

	const sessionResetsAt = new Date(snap.session.resetsAt);
	const weekResetsAt = new Date(snap.weekAllModels.resetsAt);
	const sessionWindowOpen = input.now < sessionResetsAt;
	const weekWindowOpen = input.now < weekResetsAt;

	const sessionOverThreshold = snap.session.percent >= LIMIT_THRESHOLD_PERCENT;
	const weekOverThreshold = snap.weekAllModels.percent >= LIMIT_THRESHOLD_PERCENT;

	const limitTriggered =
		(sessionOverThreshold && sessionWindowOpen) || (weekOverThreshold && weekWindowOpen);
	if (limitTriggered) {
		return { mode: 'api', reason: 'limit' };
	}

	// Sticky-limit: a previous turn already fell back. Hold the API choice as
	// long as either reset window remains open. We don't persist which limit
	// fired, so the disjunction is the safest interpretation.
	if (input.perTabReason === 'limit' && (sessionWindowOpen || weekWindowOpen)) {
		return { mode: 'api', reason: 'limit' };
	}

	return { mode: 'interactive', reason: 'auto' };
}
