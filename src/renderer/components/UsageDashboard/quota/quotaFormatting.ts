/**
 * Shared quota formatting primitives for the provider usage panels
 * (`ClaudePlanUsage`, `CodexPlanUsage`). Pure helpers only - no React, no
 * provider coupling - so both panels render bars with identical thresholds,
 * colors, and account-key naming.
 */

import type { Theme } from '../../../types';

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

export interface QuotaAccountKeyHelpers {
	/** Short slug used by badges, tabs, and `data-testid`s (`gmail`, `default`). */
	deriveShortName: (key: string | undefined) => string;
	/** Humanized variant of the short name (`default` -> `Default account`). */
	deriveDisplayName: (key: string | undefined) => string;
	/** Strip trailing slashes so two spellings of one path collapse to one key. */
	normalizeKey: (value: string) => string;
}

/**
 * Build the account-key string helpers for a provider whose accounts live in
 * `~/<prefix>` / `~/<prefix>-<name>` directories (`.claude`, `.codex`).
 *
 * Full `path.resolve()` semantics live on the main side; user-configured
 * account dirs are clean absolute paths in practice, so a string-level
 * normalize is enough here. If a renderer-derived key ever drifts from a
 * main-side snapshot key the tab simply shows the "Refresh to sample" CTA
 * instead of bars - graceful degradation rather than a crash.
 */
export function makeAccountKeyHelpers(prefix: string): QuotaAccountKeyHelpers {
	const dashPrefix = `${prefix}-`;

	function deriveShortName(key: string | undefined): string {
		if (!key) return 'default';
		const trimmed = key.replace(/\/+$/, '');
		const basename = trimmed.slice(trimmed.lastIndexOf('/') + 1);
		if (!basename || basename === prefix) return 'default';
		if (basename.startsWith(dashPrefix)) return basename.slice(dashPrefix.length);
		if (basename.startsWith(prefix)) return basename.slice(prefix.length) || 'default';
		return basename;
	}

	function deriveDisplayName(key: string | undefined): string {
		const shortName = deriveShortName(key);
		return shortName === 'default' ? 'Default account' : shortName;
	}

	function normalizeKey(value: string): string {
		return value.replace(/\/+$/, '');
	}

	return { deriveShortName, deriveDisplayName, normalizeKey };
}
