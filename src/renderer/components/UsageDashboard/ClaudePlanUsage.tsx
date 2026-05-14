/**
 * ClaudePlanUsage
 *
 * Usage Dashboard section that renders one row per Claude Max plan account
 * (keyed by `CLAUDE_CONFIG_DIR`) showing the three quota windows the mode
 * selector reads under `headlessMode === 'auto'`:
 *
 *   - Session % used (with reset countdown)
 *   - Week (all models) % used
 *   - Week (Sonnet only) % used
 *
 * Reuses the inline horizontal-bar pattern from `SessionStats.tsx` rather than
 * introducing a charting library — the bars are styled `<div>`s. A small
 * "Refresh" button in the section header re-runs `maestro-p --status` for every
 * known config dir via the `claude:usage:refresh-all` IPC handler, then forces
 * the renderer store to re-read the freshly written snapshots.
 *
 * Caption: tracks the "Interactive = Max plan burndown, API = accumulated
 * stream-json cost" framing from phase 3 task 4. The two figures are
 * orthogonal — interactive turns spend quota windows, api turns spend dollars
 * — so the section keeps them visually paired but logically distinct.
 */

import React, { memo, useCallback, useMemo, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { useClaudeUsageStore, type ClaudeUsageSnapshot } from '../../stores/claudeUsageStore';
import { formatRelativeTime } from '../../../shared/formatters';
import type { Theme } from '../../types';

interface ClaudePlanUsageProps {
	theme: Theme;
}

/**
 * Derive a short account label from the canonical `configDirKey`.
 *
 * Mirrors the same rules used by `ClaudeModeBadge` so the dashboard row label
 * and the tab badge tooltip stay aligned: `.claude` → `default`, `.claude-foo`
 * → `foo`, otherwise the basename verbatim.
 */
function accountShortName(configDirKey: string): string {
	const base = configDirKey.split('/').filter(Boolean).pop() ?? '';
	if (!base || base === '.claude') return 'default';
	if (base.startsWith('.claude-')) return base.slice('.claude-'.length) || 'default';
	if (base.startsWith('.claude')) return base.slice('.claude'.length) || 'default';
	return base;
}

interface UsageBarProps {
	label: string;
	percent: number;
	resetsAt?: string;
	theme: Theme;
}

/**
 * One horizontal bar showing a quota window's % used. Matches the visual
 * grammar of the agent-type breakdown bars in `SessionStats.tsx`: a 24px tall
 * track with a fill segment that shows the percentage label when there's
 * enough room. The reset countdown lives in the right-hand column so the
 * three bars line up cleanly even when one is near-empty.
 */
function UsageBar({ label, percent, resetsAt, theme }: UsageBarProps) {
	const clamped = Math.max(0, Math.min(100, percent));
	// Mirrors the limit-fallback rule (>=95% triggers api). Visually warning
	// the user when they're inside the danger band — the same color the badge
	// uses for the limit-hit fallback case.
	const isCritical = clamped >= 95;
	const fillColor = isCritical
		? theme.colors.warning
		: clamped >= 75
			? theme.colors.accent
			: theme.colors.success;
	const labelText = `${clamped.toFixed(0)}%`;
	return (
		<div className="flex items-center gap-3">
			<div className="w-36 text-xs flex-shrink-0" style={{ color: theme.colors.textDim }}>
				{label}
			</div>
			<div
				className="flex-1 h-6 rounded overflow-hidden"
				style={{ backgroundColor: `${theme.colors.border}30` }}
			>
				<div
					className="h-full rounded flex items-center"
					style={{
						width: `${Math.max(clamped, 2)}%`,
						backgroundColor: fillColor,
						opacity: 0.85,
						transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
					}}
				>
					{clamped >= 20 && (
						<span
							className="text-xs font-medium px-2 text-white"
							style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
						>
							{labelText}
						</span>
					)}
				</div>
			</div>
			<div
				className="w-32 text-xs text-right flex-shrink-0"
				style={{ color: theme.colors.textDim }}
				title={resetsAt ? `Resets at ${new Date(resetsAt).toLocaleString()}` : undefined}
			>
				{clamped < 20 ? `${labelText} · ` : ''}
				{resetsAt ? `resets ${formatRelativeTime(resetsAt)}` : '—'}
			</div>
		</div>
	);
}

interface AccountRowProps {
	configDirKey: string;
	snapshot: ClaudeUsageSnapshot;
	theme: Theme;
}

function AccountRow({ configDirKey, snapshot, theme }: AccountRowProps) {
	const short = accountShortName(configDirKey);
	return (
		<div
			data-testid={`claude-plan-row-${configDirKey}`}
			className="p-3 rounded-lg space-y-2"
			style={{ backgroundColor: theme.colors.bgActivity }}
		>
			<div className="flex items-baseline justify-between gap-3">
				<div
					className="text-sm font-medium flex items-center gap-2 truncate"
					style={{ color: theme.colors.textMain }}
					title={configDirKey}
				>
					<Activity className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
					{short}
				</div>
				<div
					className="text-[10px] uppercase tracking-wider flex-shrink-0"
					style={{ color: theme.colors.textDim }}
				>
					sampled {formatRelativeTime(snapshot.sampledAt)}
				</div>
			</div>
			<UsageBar
				label="Session"
				percent={snapshot.session.percent}
				resetsAt={snapshot.session.resetsAt}
				theme={theme}
			/>
			<UsageBar
				label="Week (all models)"
				percent={snapshot.weekAllModels.percent}
				resetsAt={snapshot.weekAllModels.resetsAt}
				theme={theme}
			/>
			<UsageBar
				label="Week (Sonnet only)"
				percent={snapshot.weekSonnetOnly.percent}
				resetsAt={snapshot.weekSonnetOnly.resetsAt}
				theme={theme}
			/>
		</div>
	);
}

export const ClaudePlanUsage = memo(function ClaudePlanUsage({ theme }: ClaudePlanUsageProps) {
	const snapshots = useClaudeUsageStore((s) => s.snapshots);
	const ensureLoaded = useClaudeUsageStore((s) => s.ensureLoaded);
	const refresh = useClaudeUsageStore((s) => s.refresh);
	const [isRefreshing, setIsRefreshing] = useState(false);

	// Lazy-load on first mount so the section works even if no other consumer
	// has primed the store yet. The store guards against duplicate inflight
	// fetches, so calling this is cheap.
	React.useEffect(() => {
		void ensureLoaded();
	}, [ensureLoaded]);

	const handleRefresh = useCallback(async () => {
		if (isRefreshing) return;
		setIsRefreshing(true);
		try {
			// 1. Trigger main-process resample for every known config dir.
			// 2. Pull the fresh snapshot map into the renderer store.
			// The IPC handler is never-throw on the underlying sampler errors
			// (Sentry captures them), so we don't need to swallow anything here.
			await window.maestro.agents.refreshClaudeUsageSnapshots();
			await refresh();
		} finally {
			setIsRefreshing(false);
		}
	}, [isRefreshing, refresh]);

	const rows = useMemo(() => {
		// Sort by configDirKey so the order is stable across renders.
		return Object.entries(snapshots).sort(([a], [b]) => a.localeCompare(b));
	}, [snapshots]);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="claude-plan-usage"
		>
			<div className="flex items-center justify-between mb-3">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Claude Plan Usage
				</h3>
				<button
					type="button"
					onClick={handleRefresh}
					disabled={isRefreshing}
					className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors"
					style={{
						color: theme.colors.textMain,
						backgroundColor: `${theme.colors.accent}15`,
						opacity: isRefreshing ? 0.6 : 1,
						cursor: isRefreshing ? 'wait' : 'pointer',
					}}
					data-testid="claude-plan-usage-refresh"
					aria-label="Refresh Claude usage snapshots"
				>
					<RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
					{isRefreshing ? 'Refreshing…' : 'Refresh'}
				</button>
			</div>
			<p className="text-xs mb-4 leading-relaxed" style={{ color: theme.colors.textDim }}>
				Interactive usage = your Claude Max plan quota burndown. API usage shows accumulated
				stream-json cost separately (see Claude API row above for that figure).
			</p>
			{rows.length === 0 ? (
				<div
					className="flex items-center justify-center h-24 text-sm"
					style={{ color: theme.colors.textDim }}
					data-testid="claude-plan-usage-empty"
				>
					No Claude usage snapshots yet. Click Refresh to sample your accounts.
				</div>
			) : (
				<div className="space-y-3">
					{rows.map(([key, snap]) => (
						<AccountRow key={key} configDirKey={key} snapshot={snap} theme={theme} />
					))}
				</div>
			)}
		</div>
	);
});

export default ClaudePlanUsage;
