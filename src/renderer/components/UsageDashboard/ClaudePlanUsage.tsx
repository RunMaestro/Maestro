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

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Theme } from '../../types';
import { useClaudeUsageStore, type ClaudeUsageSnapshot } from '../../stores/claudeUsageStore';
import { formatFutureTime } from '../../../shared/formatters';

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
const LIMIT_THRESHOLD = 99;
const WARNING_THRESHOLD = 75;

/**
 * Resolve the fill color for a usage bar. The base fill is the theme's
 * accent color so the widget reads as part of the surrounding chrome rather
 * than landing as a bright traffic-light gradient; the threshold cliffs only
 * kick in once usage is genuinely a concern (75% warning, 99% hard limit).
 */
function resolveFillColor(percent: number, theme: Theme): string {
	if (percent >= LIMIT_THRESHOLD) return theme.colors.error ?? theme.colors.warning;
	if (percent >= WARNING_THRESHOLD) return theme.colors.warning;
	return theme.colors.accent;
}

const BarRow = memo(function BarRow({ label, percent, resetsAt, theme }: BarRowProps) {
	const clampedPercent = Math.min(100, Math.max(0, percent));
	const fillColor = resolveFillColor(clampedPercent, theme);
	const showInsideLabel = clampedPercent >= 22;
	const displayPercent = Math.round(clampedPercent);

	return (
		<div className="flex items-center gap-3">
			<div className="w-32 text-sm truncate flex-shrink-0" style={{ color: theme.colors.textMain }}>
				{label}
			</div>
			<div
				className="flex-1 h-7 rounded overflow-hidden relative"
				style={{ backgroundColor: theme.colors.border }}
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
						opacity: 0.9,
						transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
					}}
				>
					{showInsideLabel && (
						<span
							className="text-sm font-semibold px-2"
							style={{
								color: theme.colors.bgMain,
								textShadow: '0 1px 2px rgba(0,0,0,0.15)',
							}}
						>
							{displayPercent}%
						</span>
					)}
				</div>
				{!showInsideLabel && (
					// Low-percent fallback: print the number to the right of the
					// fill at the same baseline so 0-21% rows aren't unreadable.
					<span
						className="absolute top-1/2 -translate-y-1/2 text-sm font-medium"
						style={{
							left: `calc(${Math.max(clampedPercent, 2)}% + 8px)`,
							color: theme.colors.textMain,
						}}
					>
						{displayPercent}%
					</span>
				)}
			</div>
			<div
				className="w-32 text-xs text-right flex-shrink-0"
				style={{ color: theme.colors.textDim }}
				title={`Resets at ${new Date(resetsAt).toLocaleString()}`}
			>
				resets {formatFutureTime(resetsAt)}
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

	// Sub-tab selection by configDirKey. Defaults to the first account on
	// mount; clamps back to the first whenever the selected key disappears
	// from the snapshot map (account removed mid-session).
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	useEffect(() => {
		if (entries.length === 0) {
			if (selectedKey !== null) setSelectedKey(null);
			return;
		}
		if (selectedKey === null || !entries.some(([k]) => k === selectedKey)) {
			setSelectedKey(entries[0][0]);
		}
	}, [entries, selectedKey]);

	const selectedEntry = entries.find(([k]) => k === selectedKey) ?? entries[0];

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
					className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:cursor-not-allowed"
					style={{
						color: refreshing ? theme.colors.bgMain : theme.colors.accent,
						backgroundColor: refreshing ? theme.colors.accent : `${theme.colors.accent}15`,
						border: `1px solid ${theme.colors.accent}40`,
					}}
					data-testid="claude-plan-refresh"
					aria-label="Refresh Claude usage snapshots"
				>
					<RefreshCw
						className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}
						aria-hidden="true"
					/>
					{refreshing ? 'Sampling…' : 'Refresh'}
				</button>
			</div>

			{/* Account tab bar — renders only when 2+ accounts are present.
			    A single account doesn't need tabs; an empty state needs none. */}
			{entries.length > 1 && (
				<div
					className="flex items-center gap-1 mb-4 border-b"
					style={{ borderColor: theme.colors.border }}
					role="tablist"
					aria-label="Claude account selector"
					data-testid="claude-plan-account-tabs"
				>
					{entries.map(([configDirKey, snapshot]) => {
						const shortName = deriveAccountShortName(configDirKey);
						const isActive = selectedEntry?.[0] === configDirKey;
						const isUnauth = snapshot.authState === 'unauthenticated';
						return (
							<button
								key={configDirKey}
								type="button"
								role="tab"
								aria-selected={isActive}
								onClick={() => setSelectedKey(configDirKey)}
								className="px-3 py-1.5 text-sm font-medium transition-colors relative -mb-px"
								style={{
									color: isActive ? theme.colors.accent : theme.colors.textDim,
									borderBottom: `2px solid ${isActive ? theme.colors.accent : 'transparent'}`,
								}}
								title={configDirKey}
								data-testid={`claude-plan-tab-${shortName}`}
							>
								<span className="flex items-center gap-1.5">
									{shortName}
									{isUnauth && (
										<span
											className="text-[10px]"
											style={{ color: theme.colors.warning ?? theme.colors.accent }}
											title="Not logged in"
										>
											●
										</span>
									)}
								</span>
							</button>
						);
					})}
				</div>
			)}

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
			) : selectedEntry ? (
				<AccountRow
					key={selectedEntry[0]}
					configDirKey={selectedEntry[0]}
					snapshot={selectedEntry[1]}
					theme={theme}
				/>
			) : null}

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
