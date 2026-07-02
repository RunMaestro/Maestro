import type { ClaudeUsageSnapshot } from '../../../stores/claudeUsageStore';
import type { CodexUsageSnapshot } from '../../../stores/codexUsageStore';

function hasValidQuotaWindow(window: { percent: number; resetsAt?: string } | undefined): boolean {
	if (!window) return false;
	if (!Number.isFinite(window.percent)) return false;
	if (window.percent < 0) return false;
	return typeof window.resetsAt === 'string' && window.resetsAt.length > 0;
}

export function hasUsefulAnthropicQuotaDetails(snapshot: ClaudeUsageSnapshot): boolean {
	if (snapshot.authState === 'unauthenticated') return false;
	return (
		hasValidQuotaWindow(snapshot.session) ||
		hasValidQuotaWindow(snapshot.weekAllModels) ||
		hasValidQuotaWindow(snapshot.weekSonnetOnly)
	);
}

export function hasUsefulCodexQuotaDetails(snapshot: CodexUsageSnapshot): boolean {
	if (snapshot.authState !== 'authenticated') return false;
	return (
		hasValidQuotaWindow(snapshot.session) ||
		hasValidQuotaWindow(snapshot.weekly) ||
		(snapshot.additionalLimits ?? []).some(hasValidQuotaWindow)
	);
}
