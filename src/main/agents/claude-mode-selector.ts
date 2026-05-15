/**
 * Claude Mode Selector
 *
 * Pure, deterministic function for deciding whether a Claude Code spawn runs
 * via the API headless path (`claude --print`) or the interactive TUI driver
 * (`maestro-p`, which drives the real claude TUI to spend Max-plan quota).
 *
 * The decision combines three layers of input, in strict precedence order:
 *   1. The global `claudeCode.headlessMode` setting — when pinned to
 *      `'interactive'` or `'api'`, it overrides everything below and is
 *      surfaced with reason `'user'`.
 *   2. The per-tab `claudeInteractive` block — when its `modeReason` is
 *      `'user'`, the tab was manually pinned via the overlay menu and that
 *      pin wins over the auto-resolver.
 *   3. Auto-resolution against the latest `UsageSnapshot` — at or above
 *      `LIMIT_THRESHOLD_PERCENT` on either the session window or the
 *      week-all-models window, fall back to API with reason `'limit'`
 *      (unless `autoFallbackOnLimit` is false, in which case the user
 *      explicitly opted out of fallback and we stay interactive).
 *      Sticky-limit holds the API choice until BOTH reset windows close.
 *
 * No side effects. No I/O. Inputs are not mutated. The same inputs always
 * produce the same output, so the selector is trivially testable and safe
 * to call on every spawn.
 *
 * `UsageSnapshot` is declared here (and re-exported by `claudeUsageStore`)
 * so the snapshot store and the selector share a single source of truth
 * without a circular import.
 */

/**
 * Threshold (in percent) above which the auto-resolver treats a usage window
 * as "limit hit" and falls back to API mode. Exported so the snapshot store,
 * UI badge, and any future surfaces consult one constant instead of
 * hardcoding 95 in multiple places.
 */
export const LIMIT_THRESHOLD_PERCENT = 95;

/**
 * A single usage snapshot for one canonical `CLAUDE_CONFIG_DIR` account.
 * Sourced from `maestro-p --status` and persisted in `claudeUsageStore`.
 *
 * `percent` values are integer-or-fractional 0..100; `resetsAt` is an ISO
 * timestamp marking when the corresponding rolling window resets. The
 * selector reads `session` and `weekAllModels`; `weekSonnetOnly` is carried
 * for the eventual UI badge but is not part of the fallback decision.
 */
export interface UsageSnapshot {
	/** ISO timestamp at which this snapshot was sampled on the local host. */
	sampledAt: string;
	/** Canonical resolved CLAUDE_CONFIG_DIR path that keyed this snapshot. */
	configDirKey: string;
	/** Five-hour session window. */
	session: { percent: number; resetsAt: string };
	/** Seven-day all-models window. */
	weekAllModels: { percent: number; resetsAt: string };
	/** Seven-day Sonnet-only window (informational; not used by the selector). */
	weekSonnetOnly: { percent: number; resetsAt: string };
}

export interface SelectModeInput {
	/** Global setting `claudeCode.headlessMode`. */
	headlessMode: 'interactive' | 'api' | 'auto';
	/** `session.claudeInteractive.modeReason`, defaulting to `'auto'` when the field is absent. */
	perTabReason: 'user' | 'auto' | 'limit';
	/** `session.claudeInteractive.mode`, defaulting to `'api'` when the field is absent. */
	perTabMode: 'interactive' | 'api';
	/** Latest snapshot for the spawn's effective config dir, or null if none cached. */
	usageSnapshot: UsageSnapshot | null;
	/** Mirrors setting `claudeCode.autoFallbackToApiOnLimit`. */
	autoFallbackOnLimit: boolean;
	/** Injected wall clock so callers (and tests) own the time source. */
	now: Date;
}

export interface SelectModeResult {
	mode: 'interactive' | 'api';
	reason: 'user' | 'auto' | 'limit';
}

/**
 * Decide which Claude binary to spawn and tag the decision with a reason
 * suitable for persisting back into `session.claudeInteractive`.
 *
 * Pure: no I/O, no logging, no mutation of inputs. Safe to call on every
 * spawn and on every render that wants to preview the decision.
 */
export function selectMode(input: SelectModeInput): SelectModeResult {
	// 1. Global setting pin wins absolutely.
	if (input.headlessMode === 'interactive' || input.headlessMode === 'api') {
		return { mode: input.headlessMode, reason: 'user' };
	}

	// 2. Per-tab manual pin (from the overlay menu) wins over auto-resolution.
	if (input.perTabReason === 'user') {
		return { mode: input.perTabMode, reason: 'user' };
	}

	// 3. headlessMode === 'auto' AND no per-tab user pin.
	const snap = input.usageSnapshot;
	if (snap) {
		const sessionResetsAt = new Date(snap.session.resetsAt);
		const weekResetsAt = new Date(snap.weekAllModels.resetsAt);
		const sessionWindowOpen = input.now < sessionResetsAt;
		const weekWindowOpen = input.now < weekResetsAt;

		const sessionOverThreshold = snap.session.percent >= LIMIT_THRESHOLD_PERCENT;
		const weekOverThreshold = snap.weekAllModels.percent >= LIMIT_THRESHOLD_PERCENT;

		const limitTriggered =
			(sessionOverThreshold && sessionWindowOpen) || (weekOverThreshold && weekWindowOpen);

		if (limitTriggered) {
			// Fresh trigger this turn. Respect the user's opt-out if they disabled fallback.
			return input.autoFallbackOnLimit
				? { mode: 'api', reason: 'limit' }
				: { mode: 'interactive', reason: 'auto' };
		}

		// Sticky-limit: a previous turn fell back. Hold the API choice as long as
		// either reset window remains open. We don't persist which limit fired,
		// so the disjunction is the safest interpretation. Intentionally does
		// NOT re-check `autoFallbackOnLimit` — the user committed to the
		// fallback at trigger time; respect that commitment for the duration
		// of the window.
		if (input.perTabReason === 'limit' && (sessionWindowOpen || weekWindowOpen)) {
			return { mode: 'api', reason: 'limit' };
		}
	}

	// Default: snapshot is missing, both windows have reset, or no limit was ever hit.
	return { mode: 'interactive', reason: 'auto' };
}
