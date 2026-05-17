/**
 * ClaudePlanUsage
 *
 * Per-account Claude Max-plan quota burndown for the Agent Overview tab.
 * One row per canonical `CLAUDE_CONFIG_DIR` account, three stacked horizontal
 * bars per row (session window, week all-models, week Sonnet-only). Bar fill
 * color tracks the same `LIMIT_THRESHOLD_PERCENT` the spawner consults, so
 * what the dashboard shows in orange / yellow is exactly what would trip the
 * auto-fallback on the next turn.
 *
 * Snapshot data is read live from `claudeUsageStore` (the renderer mirror of
 * the on-disk map main writes). The "Refresh" button triggers a fresh
 * `runStartupUsageSampling()` on main, then pulls the updated map back into
 * the store in a single click.
 */

import { memo, useCallback, useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Theme } from '../../types';
import { useClaudeUsageStore, type ClaudeUsageSnapshot } from '../../stores/claudeUsageStore';
import { formatRelativeTime } from '../../../shared/formatters';

function deriveAccountShortName(configDirKey: string | undefined): string {
	if (!configDirKey) return 'default';
	const trimmed = configDirKey.replace(/\/+$/, '');
	const basename = trimmed.slice(trimmed.lastIndexOf('/') + 1);
	if (!basename || basename === '.claude') return 'default';
	if (basename.startsWith('.claude-')) return basename.slice('.claude-'.length);
	if (basename.startsWith('.claude')) return basename.slice('.claude'.length) || 'default';
	return basename;
}

interface ClaudePlanUsageProps {
	theme: Theme;
}

interface BarRowProps {
	label: string;
	percent: number;
	resetsAt: string;
	theme: Theme;
}

// Mirrors `LIMIT_THRESHOLD_PERCENT` in `src/main/agents/claude-mode-selector.ts`.
// Duplicated here to keep the renderer bundle free of main-process imports — same
// rationale as the snapshot shape in `claudeUsageStore.ts`.
const WARNING_THRESHOLD = 99;
const ACCENT_THRESHOLD = 75;

/**
 * Resolve the fill color for a usage bar. Mirrors the limit selector's
 * thresholds so the dashboard surfaces the exact same trigger points the
 * spawner consults on the next turn — at-or-above 99% turns warning, 75-98%
 * turns accent, anything lower stays success.
 */
function resolveFillColor(percent: number, theme: Theme): string {
	if (percent >= WARNING_THRESHOLD) return theme.colors.warning;
	if (percent >= ACCENT_THRESHOLD) return theme.colors.accent;
	return theme.colors.success;
}

const BarRow = memo(function BarRow({ label, percent, resetsAt, theme }: BarRowProps) {
	const clampedPercent = Math.min(100, Math.max(0, percent));
	const fillColor = resolveFillColor(clampedPercent, theme);
	const showInsideLabel = clampedPercent >= 20;
	const displayPercent = Math.round(clampedPercent);

	return (
		<div className="flex items-center gap-3">
			<div className="w-32 text-xs truncate flex-shrink-0" style={{ color: theme.colors.textDim }}>
				{label}
			</div>
			<div
				className="flex-1 h-6 rounded overflow-hidden"
				style={{ backgroundColor: `${theme.colors.border}30` }}
				role="progressbar"
				aria-label={`${label}: ${displayPercent}%`}
				aria-valuenow={displayPercent}
				aria-valuemin={0}
				aria-valuemax={100}
			>
				<div
					className="h-full rounded flex items-center"
					style={{
						width: `${Math.max(clampedPercent, 2)}%`,
						backgroundColor: fillColor,
						opacity: 0.85,
						transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
					}}
				>
					{showInsideLabel && (
						<span
							className="text-xs font-medium px-2 text-white"
							style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
						>
							{displayPercent}%
						</span>
					)}
				</div>
			</div>
			<div
				className="w-24 text-xs text-right flex-shrink-0"
				style={{ color: theme.colors.textDim }}
				title={`Resets ${resetsAt}`}
			>
				resets {formatRelativeTime(resetsAt)}
			</div>
		</div>
	);
});

interface AccountRowProps {
	configDirKey: string;
	snapshot: ClaudeUsageSnapshot;
	theme: Theme;
}

const AccountRow = memo(function AccountRow({ configDirKey, snapshot, theme }: AccountRowProps) {
	const shortName = deriveAccountShortName(configDirKey);
	const isUnauthenticated = snapshot.authState === 'unauthenticated';

	return (
		<div className="space-y-2" data-testid={`claude-plan-row-${shortName}`}>
			<div className="flex items-center gap-2">
				<div
					className="text-sm font-medium"
					style={{ color: theme.colors.textMain }}
					title={configDirKey}
				>
					{shortName}
				</div>
				<div className="text-xs" style={{ color: theme.colors.textDim, opacity: 0.7 }}>
					{configDirKey}
				</div>
			</div>
			{isUnauthenticated ? (
				// Claude's /usage panel for this CLAUDE_CONFIG_DIR rendered
				// "Not logged in · Run /login". Surface that as a CTA instead
				// of bars — the percentages would all be 0 and meaningless.
				<div
					className="flex items-center gap-2 px-3 py-2 rounded text-xs"
					style={{
						backgroundColor: `${theme.colors.warning ?? theme.colors.accent}15`,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.warning ?? theme.colors.accent}40`,
					}}
					data-testid={`claude-plan-row-${shortName}-unauthenticated`}
				>
					<span style={{ color: theme.colors.warning ?? theme.colors.accent }}>●</span>
					<span>
						Not logged in. Run <code style={{ color: theme.colors.accent }}>/login</code> in a
						Claude session that uses this account.
					</span>
				</div>
			) : (
				<>
					<BarRow
						label="Session window"
						percent={snapshot.session.percent}
						resetsAt={snapshot.session.resetsAt}
						theme={theme}
					/>
					<BarRow
						label="Week (all models)"
						percent={snapshot.weekAllModels.percent}
						resetsAt={snapshot.weekAllModels.resetsAt}
						theme={theme}
					/>
					<BarRow
						label="Week (Sonnet only)"
						percent={snapshot.weekSonnetOnly.percent}
						resetsAt={snapshot.weekSonnetOnly.resetsAt}
						theme={theme}
					/>
				</>
			)}
		</div>
	);
});

export const ClaudePlanUsage = memo(function ClaudePlanUsage({ theme }: ClaudePlanUsageProps) {
	const snapshots = useClaudeUsageStore((s) => s.snapshots);
	const refreshing = useClaudeUsageStore((s) => s.refreshing);

	const entries = useMemo(
		() =>
			Object.entries(snapshots).sort(([a], [b]) =>
				deriveAccountShortName(a).localeCompare(deriveAccountShortName(b))
			),
		[snapshots]
	);

	const handleRefresh = useCallback(async () => {
		if (refreshing) return;
		try {
			await window.maestro.agents.refreshClaudeUsageSnapshots();
		} catch {
			// Main-side errors surface in main logs; the store keeps the last good
			// map rather than blowing up the dashboard.
		}
		await useClaudeUsageStore.getState().refresh();
	}, [refreshing]);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="claude-plan-usage"
		>
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Claude Max Plan Usage
				</h3>
				<button
					type="button"
					onClick={handleRefresh}
					disabled={refreshing}
					className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					style={{
						color: theme.colors.textMain,
						backgroundColor: `${theme.colors.accent}15`,
					}}
					data-testid="claude-plan-refresh"
					aria-label="Refresh Claude usage snapshots"
				>
					<RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
					{refreshing ? 'Refreshing…' : 'Refresh'}
				</button>
			</div>

			{entries.length === 0 ? (
				<div
					className="flex items-center justify-center h-24 text-sm"
					style={{ color: theme.colors.textDim }}
					data-testid="claude-plan-empty"
				>
					No Claude Max plan snapshots yet. Set CLAUDE_CONFIG_DIR on a Claude Code session (or the
					agent) and hit Refresh — we sample only explicitly-configured accounts so we never trigger
					a browser OAuth prompt.
				</div>
			) : (
				<div className="space-y-5">
					{entries.map(([configDirKey, snapshot]) => (
						<AccountRow
							key={configDirKey}
							configDirKey={configDirKey}
							snapshot={snapshot}
							theme={theme}
						/>
					))}
				</div>
			)}

			<p
				className="mt-4 text-xs"
				style={{ color: theme.colors.textDim, opacity: 0.8 }}
				data-testid="claude-plan-caption"
			>
				Interactive usage = your Claude Max plan quota burndown. API usage shows accumulated
				stream-json cost separately (see Claude API row above for that figure).
			</p>
		</div>
	);
});

export default ClaudePlanUsage;
