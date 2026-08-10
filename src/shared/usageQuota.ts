/**
 * Shared predicates for "does this provider quota snapshot have anything worth
 * showing?".
 *
 * Both processes need the same answer:
 *   - The renderer's Usage Dashboard uses it to decide whether the
 *     "Anthropic Usage" / "OpenAI Usage" tabs exist at all.
 *   - The main-process usage warm-up uses it to decide whether a provider still
 *     needs a sampling pass on boot, so the tabs are already populated the
 *     first time the dashboard opens.
 *
 * The parameter types are structural on purpose: `UsageSnapshot`
 * (`src/main/agents/claude-mode-selector.ts`), the renderer's
 * `ClaudeUsageSnapshot`, and both `CodexUsageSnapshot` copies all satisfy them
 * without either process importing the other's types.
 */

export interface QuotaWindowLike {
	percent: number;
	resetsAt?: string;
}

export interface ClaudeQuotaSnapshotLike {
	authState?: 'authenticated' | 'unauthenticated';
	session?: QuotaWindowLike;
	weekAllModels?: QuotaWindowLike;
	weekSonnetOnly?: QuotaWindowLike;
}

export interface CodexQuotaSnapshotLike {
	authState: string;
	session?: QuotaWindowLike;
	weekly?: QuotaWindowLike;
	additionalLimits?: QuotaWindowLike[];
}

/**
 * A window is renderable when it carries a finite, non-negative percentage AND
 * a reset timestamp. Sampler stubs (auth failures, partial parses) leave one or
 * both missing, and rendering those produces an empty gauge.
 */
export function hasValidQuotaWindow(window: QuotaWindowLike | undefined): boolean {
	if (!window) return false;
	if (!Number.isFinite(window.percent)) return false;
	if (window.percent < 0) return false;
	return typeof window.resetsAt === 'string' && window.resetsAt.length > 0;
}

/**
 * `authState` is optional for back-compat with snapshots persisted before the
 * field existed, so absence counts as authenticated - only an explicit
 * `'unauthenticated'` suppresses the panel.
 */
export function hasUsefulAnthropicQuotaDetails(snapshot: ClaudeQuotaSnapshotLike): boolean {
	if (snapshot.authState === 'unauthenticated') return false;
	return (
		hasValidQuotaWindow(snapshot.session) ||
		hasValidQuotaWindow(snapshot.weekAllModels) ||
		hasValidQuotaWindow(snapshot.weekSonnetOnly)
	);
}

/** Codex states its auth explicitly, so anything but `'authenticated'` is a stub. */
export function hasUsefulCodexQuotaDetails(snapshot: CodexQuotaSnapshotLike): boolean {
	if (snapshot.authState !== 'authenticated') return false;
	return (
		hasValidQuotaWindow(snapshot.session) ||
		hasValidQuotaWindow(snapshot.weekly) ||
		(snapshot.additionalLimits ?? []).some(hasValidQuotaWindow)
	);
}
