/**
 * Shared quota formatting primitives for the provider usage panels
 * (`ClaudePlanUsage`, `CodexPlanUsage`). Pure helpers only - no React, no
 * provider coupling - so both panels render bars with identical thresholds
 * and colors.
 *
 * Account-key naming (`makeAccountKeyHelpers`) lives in
 * `src/shared/providerProfiles.ts` and is re-exported here: the Agents grid
 * needs the same naming to label its provider filter, and one copy is what
 * keeps a badge's account name equal to the filter's.
 */

import type { Theme } from '../../../types';

export {
	makeAccountKeyHelpers,
	type QuotaAccountKeyHelpers,
} from '../../../../shared/providerProfiles';

// Mirrors `LIMIT_THRESHOLD_PERCENT` in `src/main/agents/claude-mode-selector.ts`.
// Kept renderer-local (no main-process import) and shared across every provider
// quota panel so a single edit moves all bar warning/limit cliffs together.
export const LIMIT_THRESHOLD = 99;
export const WARNING_THRESHOLD = 75;

export const QUOTA_REFRESH_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
	{ value: 0, label: 'Off' },
	{ value: 60_000, label: '1 min' },
	{ value: 5 * 60_000, label: '5 min' },
	{ value: 15 * 60_000, label: '15 min' },
	{ value: 30 * 60_000, label: '30 min' },
	{ value: 60 * 60_000, label: '1 hr' },
	{ value: 4 * 60 * 60_000, label: '4 hr' },
	{ value: 6 * 60 * 60_000, label: '6 hr' },
	{ value: 12 * 60 * 60_000, label: '12 hr' },
	{ value: 24 * 60 * 60_000, label: '24 hr' },
];

/**
 * Resolve the fill color for a usage bar. The base fill is the theme's accent
 * color so the widget reads as part of the surrounding chrome rather than a
 * bright traffic-light gradient; the threshold cliffs only kick in once usage
 * is genuinely a concern (75% warning, 99% hard limit).
 */
export function resolveQuotaFillColor(percent: number, theme: Theme): string {
	if (percent >= LIMIT_THRESHOLD) return theme.colors.error ?? theme.colors.warning;
	if (percent >= WARNING_THRESHOLD) return theme.colors.warning;
	return theme.colors.accent;
}

/**
 * Newest `sampledAt` across a provider's snapshot map, in epoch ms.
 *
 * The panel refreshes every configured account in one pass, so the newest
 * sample is when the panel last got fresh data. Returns `null` when nothing has
 * been sampled yet (or every stamp is unparseable), which the footer renders as
 * nothing rather than as a bogus age.
 */
export function resolveLatestSampledAt(
	snapshots: Record<string, { sampledAt?: string } | undefined>
): number | null {
	let latest: number | null = null;
	for (const snapshot of Object.values(snapshots)) {
		if (!snapshot?.sampledAt) continue;
		const ms = new Date(snapshot.sampledAt).getTime();
		if (!Number.isFinite(ms)) continue;
		if (latest === null || ms > latest) latest = ms;
	}
	return latest;
}

/**
 * How far one row's sample may trail the panel's newest sample before the row
 * is flagged. A refresh pass samples every account in parallel, each within the
 * sampler's 30s budget, so a gap this wide means the last pass skipped or failed
 * that account and its bars predate the sample age the dashboard footer prints.
 */
export const STALE_ROW_LAG_MS = 5 * 60_000;

/**
 * True when `sampledAt` trails `latestSampledAtMs` by more than
 * `STALE_ROW_LAG_MS`. Missing or unparseable stamps are never flagged: there is
 * no age to report, and a chip that cannot say when is noise.
 */
export function isSampleBehindLatest(
	sampledAt: string | undefined,
	latestSampledAtMs: number | null
): boolean {
	if (!sampledAt || latestSampledAtMs === null) return false;
	const sampledAtMs = Date.parse(sampledAt);
	if (!Number.isFinite(sampledAtMs)) return false;
	return latestSampledAtMs - sampledAtMs > STALE_ROW_LAG_MS;
}

/**
 * Age past which a sample is no longer trusted anywhere in the app. Mirrors the
 * main-side snapshot TTL (`SNAPSHOT_TTL_MS`): past it the store stops handing
 * the snapshot to the mode selector and keeps it for display only, so the panel
 * must say so.
 */
export const EXPIRED_SAMPLE_AGE_MS = 24 * 60 * 60_000;

/**
 * True when `sampledAt` is older than `EXPIRED_SAMPLE_AGE_MS`. This is the case
 * `isSampleBehindLatest` cannot catch: when EVERY row is a day old, no row
 * trails the newest, yet none of the bars mean anything current. Typically an
 * account nobody runs agents against anymore - its row is kept precisely so the
 * user can watch for the reset, which only works if the age is on screen.
 */
export function isSampleExpired(sampledAt: string | undefined, nowMs = Date.now()): boolean {
	if (!sampledAt) return false;
	const sampledAtMs = Date.parse(sampledAt);
	if (!Number.isFinite(sampledAtMs)) return false;
	return nowMs - sampledAtMs > EXPIRED_SAMPLE_AGE_MS;
}
