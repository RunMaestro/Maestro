/**
 * Auto Run auto-resume policy: how long to wait before retrying a paused run,
 * and how many times to try before handing it back to the user.
 *
 * ## Why this exists alongside the two resume paths that came first
 *
 * An Auto Run that hits an agent error parks on its error-resolution promise
 * and waits for a human to click Resume. Two mechanisms already un-park it
 * automatically, and BOTH are conditional on what went wrong:
 *
 * - **Agent Resilience** (`retryStore` + `classifyRetryableError`) takes over
 *   only when the message classifies as an upstream availability blip or a
 *   quota wall, and then backs off on its own schedule.
 * - **Auto-Resume on Limit** (`useAutoResumeCoordinator`) takes over only for
 *   limit-paused sessions, probing the provider on an hour-scale interval.
 *
 * Everything else - the ordinary mid-run failure that just needs another go -
 * falls through both and sits there until someone notices. This policy is the
 * blanket fallback for that case: wait a fixed few minutes, resume, and give up
 * after a handful of tries rather than hammering a run that is genuinely stuck.
 *
 * It is deliberately NOT a third `RetryStrategy`. Agent Resilience's strategies
 * carry provider-outage meaning all the way into the transcript card's copy
 * ("waiting for your quota to reset"), the Resilience dashboard, and the
 * `resilience_events` table. A task that failed for an unclassified reason is
 * not an outage, and filing it as one would put a wrong sentence in front of
 * the user and wrong rows in their stats.
 *
 * Pure and dependency-free so the renderer coordinator, the run-config modal,
 * and the tests all agree on one set of bounds.
 */

/** Minutes to wait before the first (and every) automatic resume attempt. */
export const AUTO_RESUME_DEFAULT_MINUTES = 5;

/** Automatic resumes allowed per run before the user has to step in. */
export const AUTO_RESUME_DEFAULT_MAX_ATTEMPTS = 5;

/** A wait shorter than this re-fires into the same failure before it clears. */
export const AUTO_RESUME_MIN_MINUTES = 1;

/** Four hours. Past this the user is not waiting on a retry, they are away. */
export const AUTO_RESUME_MAX_MINUTES = 240;

/** At least one attempt, or the feature is just an off switch with extra steps. */
export const AUTO_RESUME_MIN_ATTEMPTS = 1;

/** Generous ceiling: the point is a guard rail, not a second opinion. */
export const AUTO_RESUME_MAX_ATTEMPTS = 50;

/**
 * The run-config fields that describe the policy, as they travel on
 * `BatchRunConfig`. All three are optional so a run launched before this
 * existed - or from the CLI, or from a saved playbook - still gets the
 * documented defaults rather than silently getting nothing.
 */
export interface AutoResumeConfigFields {
	/**
	 * `undefined` means ON. This mirrors `resilienceEnabled` in
	 * `agentConstants.ts`: a feature that ships on by default cannot use
	 * "absent = off" without a migration touching every stored run config.
	 */
	autoResumeOnError?: boolean;
	/** Minutes between attempts. Absent = `AUTO_RESUME_DEFAULT_MINUTES`. */
	autoResumeAfterMin?: number;
	/** Attempt ceiling. Absent = `AUTO_RESUME_DEFAULT_MAX_ATTEMPTS`. */
	maxAutoResumes?: number;
}

/** A resolved, clamped policy. `null` anywhere means "do not auto-resume". */
export interface AutoResumePolicy {
	delayMs: number;
	maxAttempts: number;
}

/** True unless the run explicitly opted out. See `autoResumeOnError` above. */
export function autoResumeEnabled(value: boolean | undefined): boolean {
	return value !== false;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === 'number' ? Math.round(value) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** Clamp a minutes input, falling back to the default for junk or absence. */
export function clampAutoResumeMinutes(value: unknown): number {
	return clampInt(
		value,
		AUTO_RESUME_MIN_MINUTES,
		AUTO_RESUME_MAX_MINUTES,
		AUTO_RESUME_DEFAULT_MINUTES
	);
}

/** Clamp an attempt-ceiling input, falling back to the default. */
export function clampMaxAutoResumes(value: unknown): number {
	return clampInt(
		value,
		AUTO_RESUME_MIN_ATTEMPTS,
		AUTO_RESUME_MAX_ATTEMPTS,
		AUTO_RESUME_DEFAULT_MAX_ATTEMPTS
	);
}

/**
 * The policy a run should use, or `null` when it opted out.
 *
 * Clamping happens here rather than at the input so a config that arrives from
 * the CLI, a saved playbook, or a remote client cannot schedule a 10ms resume
 * loop; the modal's own inputs are bounded too, but they are not the only door.
 */
export function resolveAutoResumePolicy(
	config?: AutoResumeConfigFields | null
): AutoResumePolicy | null {
	if (!autoResumeEnabled(config?.autoResumeOnError)) return null;
	return {
		delayMs: clampAutoResumeMinutes(config?.autoResumeAfterMin) * 60_000,
		maxAttempts: clampMaxAutoResumes(config?.maxAutoResumes),
	};
}
