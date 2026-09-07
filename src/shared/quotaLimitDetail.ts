/**
 * Quota-limit evidence: turning Claude Code's structured plan-limit payload into
 * something a user can read.
 *
 * When a plan limit is hit, Claude Code emits a synthetic assistant message
 * whose text is a single collapsed sentence:
 *
 *   "You've hit your session limit · resets 7pm (America/Chicago)"
 *
 * That sentence is a VERDICT WITH NO EVIDENCE. It cannot distinguish the 5-hour
 * window from the weekly one (both print "limit"), it does not say whether paid
 * extra usage is covering the overflow, and it does not say whether anything can
 * be done. The same envelope carries all three answers alongside the text:
 *
 *   quotaLimits: {
 *     status: 'rejected',
 *     resetsAt: 1787416800,          // epoch SECONDS
 *     rateLimitType: 'five_hour',
 *     overageStatus: 'rejected',
 *     overageDisabledReason: 'out_of_credits',
 *   }
 *
 * Maestro already carries this object through to the renderer on
 * `AgentError.parsedJson`, but until now read exactly one field out of it
 * (`resetsAt`, so the retry lands on the right second) and threw the rest away.
 * This module reads the rest.
 *
 * Pure and dependency-free so both processes can use it.
 *
 * THE ONE TRAP, and the reason `describeQuotaRemedy` exists rather than each
 * surface formatting these fields itself: `overageStatus` is NOT safe to read
 * alone. `allowed` / `allowed_warning` means paid extra usage covers the
 * overflow, and it STAYS `allowed` after hard exhaustion, when `status` has
 * already flipped to `rejected`. A surface that rendered `overageStatus` by
 * itself would tell a hard-stopped user they are covered. Always combine it with
 * `status`, which is what the one function here does.
 */

/** Which plan window a limit belongs to. `unknown` = the payload didn't say. */
export type QuotaWindow = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'unknown';

/** The readable form of Claude Code's `quotaLimits` object. */
export interface QuotaLimitDetail {
	/** Recognized window, or `'unknown'` when absent/unrecognized. */
	window: QuotaWindow;
	/** The provider's own `rateLimitType` string, kept for unrecognized values. */
	windowRaw?: string;
	/** Request disposition: `'rejected'` means this turn was actually cut off. */
	status?: string;
	/** Epoch MILLISECONDS the window reopens (the payload sends seconds). */
	resetsAt?: number;
	/** Whether paid extra usage would cover overflow. Never read this alone. */
	overageStatus?: string;
	/** Whether paid extra usage is actively being consumed right now. */
	overageInUse?: boolean;
	/** Why extra usage is unavailable, e.g. `'out_of_credits'`. */
	overageDisabledReason?: string;
}

/** Windows we can name confidently. Anything else stays `unknown` rather than guessing. */
const KNOWN_WINDOWS: ReadonlySet<string> = new Set(['five_hour', 'seven_day', 'seven_day_opus']);

/**
 * Containers the quota object can arrive under. `quotaLimits` is what Claude
 * Code actually sends; the snake/rate-limit spellings mirror
 * `RESET_JSON_CONTAINERS` in `retryClassification.ts` so the two modules agree
 * about where to look.
 */
const QUOTA_CONTAINERS = ['quotaLimits', 'quota_limits', 'rateLimit', 'rate_limit'] as const;

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim() !== '') return value.trim();
	}
	return undefined;
}

function readBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'boolean') return value;
	}
	return undefined;
}

/**
 * Epoch ms from a `resetsAt` that may be seconds or milliseconds. Same split
 * point as `coerceResetNumber` in `retryClassification.ts`: current-era epoch
 * seconds are ~1.7e9, so >= 1e12 is unambiguously already milliseconds.
 */
function readResetMs(record: Record<string, unknown>): number | undefined {
	for (const key of ['resetsAt', 'resets_at', 'resetAt', 'reset_at']) {
		const raw = record[key];
		const value = typeof raw === 'string' ? Number(raw) : raw;
		if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
		return value >= 1e12 ? value : value * 1000;
	}
	return undefined;
}

/**
 * Pull the quota detail out of an error's `parsedJson`, or `undefined` when the
 * payload carries none (a non-Claude provider, or a transport that forwarded
 * only the message envelope - both happen, so every caller must handle absence
 * by falling back to the plain notice text).
 */
export function parseQuotaLimitDetail(parsedJson: unknown): QuotaLimitDetail | undefined {
	if (!parsedJson || typeof parsedJson !== 'object') return undefined;
	const record = parsedJson as Record<string, unknown>;

	for (const container of QUOTA_CONTAINERS) {
		const nested = record[container];
		if (!nested || typeof nested !== 'object') continue;
		const quota = nested as Record<string, unknown>;

		const windowRaw = readString(quota, 'rateLimitType', 'rate_limit_type', 'limitType');
		const detail: QuotaLimitDetail = {
			window: windowRaw && KNOWN_WINDOWS.has(windowRaw) ? (windowRaw as QuotaWindow) : 'unknown',
			windowRaw,
			status: readString(quota, 'status'),
			resetsAt: readResetMs(quota),
			overageStatus: readString(quota, 'overageStatus', 'overage_status'),
			overageInUse: readBoolean(quota, 'overageInUse', 'overage_in_use'),
			overageDisabledReason: readString(quota, 'overageDisabledReason', 'overage_disabled_reason'),
		};

		// A container that carried none of the fields we care about is noise, not
		// evidence - reporting it would put an empty "Plan limit" row on screen
		// that says less than the notice text already did.
		const hasSignal =
			detail.window !== 'unknown' ||
			detail.status !== undefined ||
			detail.resetsAt !== undefined ||
			detail.overageStatus !== undefined;
		if (hasSignal) return detail;
	}

	return undefined;
}

/**
 * Name the window that was exhausted. "5-hour session limit reached" and
 * "Weekly limit reached" are very different situations - one clears this
 * afternoon, the other can cost days - and the collapsed notice text cannot tell
 * them apart.
 */
export function describeQuotaWindow(detail: QuotaLimitDetail | undefined): string {
	switch (detail?.window) {
		case 'five_hour':
			return '5-hour session limit';
		case 'seven_day':
			return 'Weekly limit';
		case 'seven_day_opus':
			return 'Weekly Opus limit';
		default:
			// Deliberately generic: an unrecognized `rateLimitType` must not be
			// rendered as a window name we invented.
			return 'Plan limit';
	}
}

/**
 * Say whether anything can be done about this limit, or `undefined` when the
 * payload does not support a claim either way (say nothing rather than guess -
 * a wrong reassurance here is worse than silence).
 *
 * `overageStatus` is combined with `status` here and must never be read alone;
 * see the trap described in this module's header.
 */
export function describeQuotaRemedy(detail: QuotaLimitDetail | undefined): string | undefined {
	if (!detail) return undefined;

	const hardStopped = detail.status === 'rejected';
	const overageAvailable =
		detail.overageStatus === 'allowed' || detail.overageStatus === 'allowed_warning';

	if (hardStopped) {
		// The turn was actually cut off. Whatever `overageStatus` says, extra usage
		// did not save it, so the only remedy left is the clock.
		if (detail.overageDisabledReason === 'out_of_credits') {
			return 'Extra usage is out of credits, so nothing can extend this window. It clears at the reset time.';
		}
		if (detail.overageStatus === 'rejected') {
			return 'Extra usage will not cover this either. Nothing to enable - it clears at the reset time.';
		}
		return 'This window is fully exhausted. Nothing in Maestro can extend it - it clears at the reset time.';
	}

	if (detail.overageInUse === true) {
		return 'Paid extra usage is covering the overflow, so this turn should not be cut off.';
	}
	if (overageAvailable) {
		return 'Paid extra usage is available to cover the overflow.';
	}

	return undefined;
}
