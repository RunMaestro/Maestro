/**
 * Codex rate-limit reset credits: the shape of the thing, and the rules for
 * spending one.
 *
 * ChatGPT grants Codex accounts a small number of "Full reset" credits. Redeem
 * one and the account's 5-hour and weekly usage windows reopen immediately
 * instead of at their scheduled `resetsAt`. Until now the only way to spend one
 * was the Codex TUI, so a Maestro user who hit a wall had to leave the app,
 * start the CLI, and find the menu - exactly the trip the wrapped login flow
 * exists to avoid.
 *
 * Two primitives back the whole feature, both in
 * `src/main/agents/codex-reset-credits.ts`:
 *
 *   READ   GET  /backend-api/wham/rate-limit-reset-credits
 *   WRITE  POST /backend-api/wham/rate-limit-reset-credits/consume
 *
 * This module is pure and import-free so both processes can share the types and
 * the spend rules. The auth-bearing HTTP lives in main and never crosses IPC.
 *
 * THE ONE TRAP, and the reason `describeCreditSpend()` exists rather than each
 * surface deciding for itself: a credit resets the windows that are currently
 * consumed, and it is GONE afterwards whether or not anything needed resetting.
 * Spending one at 4% usage buys nothing and cannot be undone. That is why the
 * usage payload reports TWO counts - `available_count` (what the account owns)
 * and `applicable_available_count` (what would actually do something right
 * now) - and why every surface has to combine them rather than rendering
 * `available_count` beside an unconditional button.
 */

/** A credit's lifecycle state as the API reports it. */
export type CodexResetCreditStatus = 'available' | 'redeeming' | 'redeemed' | 'expired' | 'unknown';

/** One granted reset credit. */
export interface CodexResetCredit {
	/** Opaque id, the `credit_id` the consume call takes. */
	id: string;
	/** What the credit resets, e.g. `codex_rate_limits`. */
	resetType?: string;
	/** Whether this account's plan can redeem it at all. */
	supportedByPlan: boolean;
	status: CodexResetCreditStatus;
	/** ISO timestamp the credit was granted. */
	grantedAt?: string;
	/** ISO timestamp the credit expires. Absent means it does not expire. */
	expiresAt?: string;
	/** Display title, e.g. `Full reset (Weekly + 5 hr)`. */
	title?: string;
	/** Display blurb from the grantor. */
	description?: string;
	/** Who granted it, e.g. `Codex Team`. */
	grantedBy?: string;
}

/**
 * The two counts, which answer different questions and must never be collapsed.
 *
 * `available` is inventory. `applicable` is usefulness right now: the API
 * returns 0 there when no window is consumed enough for a reset to change
 * anything, even while `available` is 2.
 */
export interface CodexResetCreditCounts {
	available: number;
	/**
	 * Credits that would take effect if redeemed this second. `undefined` when
	 * the payload omitted it (older API), which callers must treat as UNKNOWN
	 * rather than as zero - reporting "0 useful" for an account holding credits
	 * is the worse lie of the two.
	 */
	applicable?: number;
}

/** The full read: every credit plus the counts. */
export interface CodexResetCreditsDetail extends CodexResetCreditCounts {
	credits: CodexResetCredit[];
	/** True when this account may buy an immediate reset (upsell path). */
	purchaseEligible?: boolean;
}

/** Outcome of a consume attempt. */
export interface CodexResetCreditConsumeResult {
	/** True only when the API confirms at least one window actually reopened. */
	ok: boolean;
	/** How many usage windows the redemption reset. 0 means nothing happened. */
	windowsReset: number;
	/** The API's own result code, e.g. `no_credit`. Present on failure. */
	code?: string;
	/** Human-readable reason, ready to render. */
	message?: string;
}

/**
 * Whether a credit can be spent at all.
 *
 * A credit mid-redemption (`redeeming`) is deliberately excluded: a second
 * consume for the same id while the first is in flight is the one way to lose
 * two credits for one reset.
 */
export function isSpendableCredit(credit: CodexResetCredit): boolean {
	return credit.status === 'available' && credit.supportedByPlan;
}

/** Spendable credits, soonest-to-expire first so the perishable one goes first. */
export function spendableCredits(credits: readonly CodexResetCredit[]): CodexResetCredit[] {
	return credits.filter(isSpendableCredit).sort(compareByExpiry);
}

/**
 * Which credit to spend when the user (or the automation) did not name one.
 *
 * Soonest expiry wins. Credits expire roughly a month after being granted and
 * nothing carries over, so burning the longest-lived one first is how an
 * account ends up letting a credit lapse while still holding others.
 */
export function nextCreditToSpend(
	credits: readonly CodexResetCredit[]
): CodexResetCredit | undefined {
	return spendableCredits(credits)[0];
}

/** Undated credits sort last: an expiry we know about is more urgent than one we do not. */
function compareByExpiry(a: CodexResetCredit, b: CodexResetCredit): number {
	const aMs = parseIsoMs(a.expiresAt);
	const bMs = parseIsoMs(b.expiresAt);
	if (aMs === null && bMs === null) return 0;
	if (aMs === null) return 1;
	if (bMs === null) return -1;
	return aMs - bMs;
}

function parseIsoMs(iso: string | undefined): number | null {
	if (!iso) return null;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : null;
}

/** How a spend would go, and whether it is worth doing. */
export type CodexCreditSpendVerdict =
	/** No spendable credit exists. */
	| 'no-credits'
	/** A credit exists and at least one window would reopen. */
	| 'effective'
	/** A credit exists but nothing is consumed enough to benefit - it would be burned for nothing. */
	| 'wasteful'
	/** A credit exists and we cannot tell whether it would help (older API, or no fresh sample). */
	| 'unknown';

export interface CodexCreditSpendDescription {
	verdict: CodexCreditSpendVerdict;
	/** True when a surface may offer the control at all. */
	canSpend: boolean;
	/** One sentence naming the outcome or the obstacle. Always present. */
	reason: string;
}

/**
 * The single place the spend rules are decided, so the dashboard button, its
 * confirmation dialog, and the automatic trigger cannot disagree about whether
 * a credit is worth spending.
 *
 * `wasteful` still reports `canSpend: true`: it is the user's credit and they
 * may have a reason (about to start a long run, say). What the verdict buys is
 * an honest confirmation instead of a silent waste. The AUTOMATIC path is the
 * one that must refuse a `wasteful` or `unknown` verdict outright - see
 * `shouldAutoSpendCredit`.
 */
export function describeCreditSpend(
	counts: CodexResetCreditCounts,
	credits: readonly CodexResetCredit[]
): CodexCreditSpendDescription {
	const spendable = spendableCredits(credits);
	// Trust the list when we have one; fall back to the count when the detail
	// read failed but the usage sample still reported inventory.
	const have = credits.length > 0 ? spendable.length > 0 : counts.available > 0;

	if (!have) {
		return {
			verdict: 'no-credits',
			canSpend: false,
			reason: 'No reset credits available on this account.',
		};
	}

	if (counts.applicable === undefined) {
		return {
			verdict: 'unknown',
			canSpend: true,
			reason: 'Cannot tell whether a reset would take effect right now.',
		};
	}

	if (counts.applicable <= 0) {
		return {
			verdict: 'wasteful',
			canSpend: true,
			reason:
				'No usage window is consumed enough for a reset to change anything. The credit would be spent for nothing.',
		};
	}

	return {
		verdict: 'effective',
		canSpend: true,
		reason: 'Redeeming resets this account’s usage windows immediately.',
	};
}

/**
 * Whether the AUTOMATIC trigger may spend a credit without being asked.
 *
 * Strictly narrower than `describeCreditSpend().canSpend`, and deliberately so.
 * A credit is finite, expires, and cannot be refunded, so unattended spending
 * happens only when the API has just confirmed the reset would take effect.
 * `unknown` refuses: a stale or partial sample is not consent.
 */
export function shouldAutoSpendCredit(
	counts: CodexResetCreditCounts,
	credits: readonly CodexResetCredit[]
): boolean {
	return describeCreditSpend(counts, credits).verdict === 'effective';
}

/** Narrow an arbitrary status string from the API. */
export function asResetCreditStatus(value: unknown): CodexResetCreditStatus {
	switch (value) {
		case 'available':
		case 'redeeming':
		case 'redeemed':
		case 'expired':
			return value;
		default:
			return 'unknown';
	}
}

/**
 * `"in 12 days"` / `"tomorrow"` / `"never"`, for the expiry line under a credit.
 *
 * Day-resolution on purpose: these live for about a month, so an hours-and-
 * minutes countdown is noise, and a credit expiring today is the only case
 * worth naming precisely.
 */
export function describeCreditExpiry(credit: CodexResetCredit, nowMs: number): string {
	const expiresMs = parseIsoMs(credit.expiresAt);
	if (expiresMs === null) return 'Does not expire';
	const remaining = expiresMs - nowMs;
	if (remaining <= 0) return 'Expired';
	const days = Math.floor(remaining / 86_400_000);
	if (days === 0) return 'Expires today';
	if (days === 1) return 'Expires tomorrow';
	return `Expires in ${days} days`;
}
