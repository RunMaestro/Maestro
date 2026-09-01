/**
 * Delegation model - interactive vs autonomous Maestro usage.
 *
 * Maestro tracks AI work in two places that never meet: `query_events` in the
 * stats DB (one row per turn, tagged `user` for a prompt you typed and `auto`
 * for an Auto Run task) and `cue_events` in the Cue DB (one row per unattended
 * Cue run). Neither half answers "how much of my AI work runs without me", so
 * the main process merges them into a `DelegationTotals` and every delegation
 * surface reads that one shape.
 *
 * The vocabulary, fixed here so the dashboard can't drift:
 *
 *   - INTERACTIVE - a turn you typed and waited on (`source: 'user'`).
 *   - DELEGATED   - Auto Run tasks plus Cue runs. Work that happened whether or
 *                   not you were at the keyboard.
 *
 * The score is a share of TIME, not of turn count, because those answer
 * different questions: an Auto Run batch is a handful of long turns while an
 * afternoon of chat is hundreds of short ones, so a count-based share would
 * report a heavily delegated day as barely delegated at all.
 *
 * Both source tables are pruned on their own retention windows, so every total
 * here means "of the history still retained", not "since the day you installed
 * Maestro". Surfaces say so rather than implying a lifetime figure.
 *
 * No Electron imports: the CLI and tests bundle this.
 */

/**
 * One contributor to the delegation split.
 *
 * `count` is turns for the interactive and Auto Run slices and whole runs for
 * the Cue slice - the two systems count different units, which is exactly why
 * the score is computed from `durationMs`.
 */
export interface DelegationSlice {
	count: number;
	durationMs: number;
}

/** Interactive / Auto Run / Cue totals for a window (or for all retained history). */
export interface DelegationTotals {
	interactive: DelegationSlice;
	autoRun: DelegationSlice;
	cue: DelegationSlice;
}

/** One local-time day of the delegation split, for the Activity trend chart. */
export interface DelegationDay {
	/** Local-time YYYY-MM-DD bucket, matching every other per-day series. */
	date: string;
	interactive: DelegationSlice;
	autoRun: DelegationSlice;
	cue: DelegationSlice;
}

/** Milestones on the delegation track, ascending. */
export const DELEGATION_MILESTONES = [25, 50, 75, 100] as const;

export type DelegationMilestone = (typeof DELEGATION_MILESTONES)[number];

/** Short names for each milestone, used in the tooltip and the unlock line. */
export const DELEGATION_MILESTONE_LABELS: Record<DelegationMilestone, string> = {
	25: 'Delegating',
	50: 'Half Autonomous',
	75: 'Mostly Autonomous',
	100: 'Fully Autonomous',
};

/** An empty split, for loading and error states. */
export function emptyDelegationTotals(): DelegationTotals {
	return {
		interactive: { count: 0, durationMs: 0 },
		autoRun: { count: 0, durationMs: 0 },
		cue: { count: 0, durationMs: 0 },
	};
}

/** Time that ran without you: Auto Run plus Cue. */
export function delegatedMs(totals: DelegationTotals): number {
	return totals.autoRun.durationMs + totals.cue.durationMs;
}

/** Time you typed a prompt for and waited on. */
export function interactiveMs(totals: DelegationTotals): number {
	return totals.interactive.durationMs;
}

/** Delegated plus interactive. Zero means nothing is tracked yet. */
export function trackedMs(totals: DelegationTotals): number {
	return interactiveMs(totals) + delegatedMs(totals);
}

/** Delegated turns/runs plus interactive turns. */
export function trackedCount(totals: DelegationTotals): number {
	return totals.interactive.count + totals.autoRun.count + totals.cue.count;
}

/**
 * Share of tracked time that ran without you, 0-100.
 *
 * Returns 0 when nothing is tracked rather than NaN, so a fresh install renders
 * an honest empty track instead of a broken one.
 */
export function delegationPercent(totals: DelegationTotals): number {
	const total = trackedMs(totals);
	if (total <= 0) return 0;
	return (delegatedMs(totals) / total) * 100;
}

/**
 * Share of tracked turns that ran without you, 0-100. Only for the Queries
 * mode of the trend chart - the headline score is always time-based.
 */
export function delegationPercentByCount(totals: DelegationTotals): number {
	const total = trackedCount(totals);
	if (total <= 0) return 0;
	return ((totals.autoRun.count + totals.cue.count) / total) * 100;
}

/** Sum a per-day series back into a single split. */
export function sumDelegationDays(days: DelegationDay[]): DelegationTotals {
	const totals = emptyDelegationTotals();
	for (const day of days) {
		totals.interactive.count += day.interactive.count;
		totals.interactive.durationMs += day.interactive.durationMs;
		totals.autoRun.count += day.autoRun.count;
		totals.autoRun.durationMs += day.autoRun.durationMs;
		totals.cue.count += day.cue.count;
		totals.cue.durationMs += day.cue.durationMs;
	}
	return totals;
}

/**
 * Highest milestone the given percentage has reached, or 0 for none.
 *
 * Comparison is on the raw percentage, not a rounded one: 74.6% displays as
 * "75%" but has not reached the milestone, and unlocking on the rounded value
 * would fill the bar to a mark the number behind it never hit.
 */
export function highestMilestoneReached(percent: number): number {
	let reached = 0;
	for (const milestone of DELEGATION_MILESTONES) {
		if (percent >= milestone) reached = milestone;
	}
	return reached;
}

/** Next milestone above `percent`, or null once 100% is reached. */
export function nextMilestone(percent: number): DelegationMilestone | null {
	for (const milestone of DELEGATION_MILESTONES) {
		if (percent < milestone) return milestone;
	}
	return null;
}

/**
 * Normalize a persisted milestone high-water mark.
 *
 * The stored value is the highest milestone ever unlocked, which is why the
 * bar can stay filled past a score that has since fallen. Anything that is not
 * one of the milestones (a value from a future build, a hand-edited settings
 * file) rounds DOWN to the nearest real milestone rather than being trusted, so
 * the fill can never claim a mark that does not exist on the track.
 */
export function normalizeUnlockedMilestone(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
	return highestMilestoneReached(value);
}

/**
 * How much more delegated time would reach `target`, holding interactive time
 * fixed. Returns 0 once the target is already met.
 *
 * Solves `(d + x) / (i + d + x) = target/100` for x, which is the honest
 * answer to "how far away am I": adding delegated time grows both the
 * numerator and the denominator, so the gap is never just `target% * total`.
 * A 100% target is unreachable while any interactive time is retained, and
 * reports Infinity rather than a number the user could chase.
 */
export function delegatedMsToReach(totals: DelegationTotals, target: number): number {
	const delegated = delegatedMs(totals);
	const interactive = interactiveMs(totals);
	const total = interactive + delegated;
	if (total > 0 && (delegated / total) * 100 >= target) return 0;
	if (target >= 100) return interactive > 0 ? Infinity : 0;
	const fraction = target / 100;
	// x = (target * interactive - (1 - target) * delegated) / (1 - target)
	const needed = (fraction * interactive - (1 - fraction) * delegated) / (1 - fraction);
	return Math.max(0, needed);
}
