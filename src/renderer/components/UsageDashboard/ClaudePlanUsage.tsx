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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import type { Theme } from '../../types';
import { useClaudeUsageStore, type ClaudeUsageSnapshot } from '../../stores/claudeUsageStore';
import { useSessionStore } from '../../stores/sessionStore';
import { formatFutureTime } from '../../../shared/formatters';
import { getHomeDir, getHomeDirAsync } from '../../utils/homeDir';

function deriveAccountShortName(configDirKey: string | undefined): string {
	if (!configDirKey) return 'default';
	const trimmed = configDirKey.replace(/\/+$/, '');
	const basename = trimmed.slice(trimmed.lastIndexOf('/') + 1);
	if (!basename || basename === '.claude') return 'default';
	if (basename.startsWith('.claude-')) return basename.slice('.claude-'.length);
	if (basename.startsWith('.claude')) return basename.slice('.claude'.length) || 'default';
	return basename;
}

/**
 * Lightweight renderer-side mirror of `resolveConfigDirKey` from the main
 * store. Strips trailing slashes so two spellings of the same path collapse
 * to one tab. Full `path.resolve()` semantics (`..` normalization, separator
 * canonicalization) live on the main side; user-configured CLAUDE_CONFIG_DIR
 * values are clean absolute paths in practice, so a string-level normalize
 * is enough here. If a renderer-derived key ever drifts from a main-side
 * snapshot key the tab simply shows the "Refresh to sample" CTA instead of
 * bars — graceful degradation rather than a crash.
 */
function normalizeConfigDirKey(value: string): string {
	return value.replace(/\/+$/, '');
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
		<div className="flex items-center gap-4">
			<div
				className="w-44 text-sm whitespace-nowrap flex-shrink-0"
				style={{ color: theme.colors.textMain }}
			>
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
				className="text-xs text-left whitespace-nowrap flex-shrink-0 ml-auto"
				style={{ color: theme.colors.textDim, minWidth: '12rem' }}
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
	const sessions = useSessionStore((s) => s.sessions);

	// Agent-level customEnvVars for claude-code. Fetched once on mount via
	// IPC; updates are rare (Settings → Agents) so we don't subscribe to a
	// live channel — the user can hit Refresh to re-pull.
	const [agentLevelEnvVars, setAgentLevelEnvVars] = useState<Record<string, string>>({});
	useEffect(() => {
		let cancelled = false;
		window.maestro.agents
			.getCustomEnvVars('claude-code')
			.then((env) => {
				if (!cancelled && env) setAgentLevelEnvVars(env);
			})
			.catch(() => {
				// Best-effort; agent-level vars are optional context. The
				// session-level fallback below still produces a usable tab list.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Home dir for resolving the implicit default `~/.claude` account. The
	// renderer doesn't have direct fs access; cached IPC fetch via homeDir.ts
	// returns synchronously on subsequent renders.
	const [homeDir, setHomeDir] = useState<string | undefined>(getHomeDir);
	useEffect(() => {
		if (!homeDir) {
			getHomeDirAsync()?.then(setHomeDir);
		}
	}, [homeDir]);
	const defaultConfigDirKey = homeDir ? normalizeConfigDirKey(`${homeDir}/.claude`) : null;

	// Account list derived from configured agents/sessions, NOT from snapshot
	// keys. This way the dashboard shows every account the user has explicitly
	// wired up — including ones that haven't been sampled yet — and the
	// per-tab UI can guide them to hit Refresh.
	//
	// Sourcing rule mirrors the main-side sampler (claude-usage-startup.ts):
	// merge agent-level + session-level customEnvVars (session wins). Sessions
	// without an explicit CLAUDE_CONFIG_DIR fall back to the implicit default
	// (`~/.claude`) so the user can still see that account is in use even when
	// it hasn't been sampled (sampling the default is a deliberate skip on the
	// main side — see `buildTarget` in claude-usage-startup.ts).
	const configuredAccountKeys = useMemo(() => {
		const keys = new Set<string>();
		for (const s of sessions) {
			if (s.toolType !== 'claude-code') continue;
			const sessionEnv = (s.customEnvVars ?? {}) as Record<string, string>;
			const merged = { ...agentLevelEnvVars, ...sessionEnv };
			const dir = merged.CLAUDE_CONFIG_DIR;
			if (typeof dir === 'string' && dir.length > 0) {
				keys.add(normalizeConfigDirKey(dir));
			} else if (defaultConfigDirKey) {
				keys.add(defaultConfigDirKey);
			}
		}
		// Also include any snapshot key that didn't surface in session config —
		// e.g. an account that was sampled in a previous app run but whose
		// session has since been deleted. Keeping the tab lets the user still
		// see the cached data instead of it vanishing.
		for (const key of Object.keys(snapshots)) {
			keys.add(normalizeConfigDirKey(key));
		}
		return Array.from(keys).sort((a, b) =>
			deriveAccountShortName(a).localeCompare(deriveAccountShortName(b))
		);
	}, [sessions, agentLevelEnvVars, snapshots, defaultConfigDirKey]);

	// Sub-tab selection by configDirKey. Defaults to the first account on
	// mount; clamps back to the first whenever the selected key disappears.
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	useEffect(() => {
		if (configuredAccountKeys.length === 0) {
			if (selectedKey !== null) setSelectedKey(null);
			return;
		}
		if (selectedKey === null || !configuredAccountKeys.includes(selectedKey)) {
			setSelectedKey(configuredAccountKeys[0]);
		}
	}, [configuredAccountKeys, selectedKey]);

	const effectiveSelectedKey = selectedKey ?? configuredAccountKeys[0] ?? null;
	const selectedSnapshot: ClaudeUsageSnapshot | null = effectiveSelectedKey
		? (snapshots[effectiveSelectedKey] ?? null)
		: null;

	// Visual gate that keeps the spinning state on-screen long enough for the
	// eye to register it, even when the IPC round-trip returns in <100ms.
	// Independent of `refreshing` so a fast sample still animates the button
	// for a full beat instead of flashing.
	const [visualBusy, setVisualBusy] = useState(false);

	const handleRefresh = useCallback(async () => {
		if (refreshing || visualBusy) return;
		setVisualBusy(true);
		const minVisibleMs = 900;
		const start = Date.now();
		try {
			await window.maestro.agents.refreshClaudeUsageSnapshots();
		} catch {
			// Main-side errors surface in main logs; the store keeps the last good
			// map rather than blowing up the dashboard.
		}
		await useClaudeUsageStore.getState().refresh();
		const elapsed = Date.now() - start;
		if (elapsed < minVisibleMs) {
			await new Promise((r) => setTimeout(r, minVisibleMs - elapsed));
		}
		setVisualBusy(false);
	}, [refreshing, visualBusy]);

	const isBusy = refreshing || visualBusy;

	// Auto-sample on first arrival when the dashboard opens with at least one
	// configured account but no cached snapshots — saves the user a manual
	// Refresh click. The empty-snapshot CTA still acts as a fallback if the
	// auto-sample itself fails. Guarded by a ref so React Strict-Mode's
	// double-mount in dev doesn't fire two samples back-to-back.
	const autoRefreshFiredRef = useRef(false);
	useEffect(() => {
		if (autoRefreshFiredRef.current) return;
		if (configuredAccountKeys.length === 0) return;
		if (Object.keys(snapshots).length > 0) return;
		if (refreshing || visualBusy) return;
		autoRefreshFiredRef.current = true;
		void handleRefresh();
	}, [configuredAccountKeys.length, snapshots, refreshing, visualBusy, handleRefresh]);

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
					disabled={isBusy}
					className="relative flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:cursor-not-allowed overflow-hidden"
					style={{
						color: isBusy ? theme.colors.bgMain : theme.colors.accent,
						backgroundColor: isBusy ? theme.colors.accent : `${theme.colors.accent}15`,
						border: `1px solid ${theme.colors.accent}40`,
						minWidth: '7.25rem',
					}}
					data-testid="claude-plan-refresh"
					aria-label="Refresh Claude usage snapshots"
					aria-busy={isBusy}
				>
					{isBusy ? (
						<>
							{/* Indeterminate progress sweep across the button body —
							    bigger visual change than just a spinning icon, so a sub-second
							    refresh still reads as "the panel is working" instead of a
							    flicker. */}
							<span
								className="absolute inset-0 pointer-events-none claude-plan-refresh-sweep"
								style={{
									backgroundImage: `linear-gradient(90deg, transparent 0%, ${theme.colors.bgMain}66 50%, transparent 100%)`,
								}}
								aria-hidden="true"
							/>
							<Loader2 className="w-3.5 h-3.5 animate-spin relative" aria-hidden="true" />
							<span className="relative">Sampling…</span>
						</>
					) : (
						<>
							<RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
							<span>Refresh</span>
						</>
					)}
				</button>
			</div>

			{/* Account tab bar — renders whenever at least one account is
			    configured so the structure stays consistent when accounts are
			    added/removed. A bare empty state still hides the bar. */}
			{configuredAccountKeys.length >= 1 && (
				<div
					className="flex items-center gap-1 mb-4 border-b"
					style={{ borderColor: theme.colors.border }}
					role="tablist"
					aria-label="Claude account selector"
					data-testid="claude-plan-account-tabs"
				>
					{configuredAccountKeys.map((configDirKey) => {
						const shortName = deriveAccountShortName(configDirKey);
						const isActive = effectiveSelectedKey === configDirKey;
						const tabSnapshot = snapshots[configDirKey];
						const isUnauth = tabSnapshot?.authState === 'unauthenticated';
						const hasSnapshot = !!tabSnapshot;
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
									{/* Status dot:
									    - warning = "not logged in"
									    - dim     = "no snapshot yet, hit Refresh"
									    - none    = snapshot present + authenticated */}
									{isUnauth ? (
										<span
											className="text-[10px]"
											style={{ color: theme.colors.warning ?? theme.colors.accent }}
											title="Not logged in"
										>
											●
										</span>
									) : !hasSnapshot ? (
										<span
											className="text-[10px]"
											style={{ color: theme.colors.textDim, opacity: 0.6 }}
											title="No snapshot yet — hit Refresh"
										>
											○
										</span>
									) : null}
								</span>
							</button>
						);
					})}
				</div>
			)}

			{configuredAccountKeys.length === 0 ? (
				<div
					className="flex items-center justify-center h-24 text-sm text-center px-4"
					style={{ color: theme.colors.textDim }}
					data-testid="claude-plan-empty"
				>
					No Claude accounts configured. Set CLAUDE_CONFIG_DIR on a Claude Code session (or the
					agent) — we sample only explicitly-configured accounts so we never trigger a browser OAuth
					prompt.
				</div>
			) : effectiveSelectedKey && selectedSnapshot ? (
				<AccountRow
					key={effectiveSelectedKey}
					configDirKey={effectiveSelectedKey}
					snapshot={selectedSnapshot}
					theme={theme}
				/>
			) : effectiveSelectedKey ? (
				// Account is configured but no snapshot in the store yet — guide
				// the user to hit Refresh rather than silently rendering nothing.
				<div
					className="space-y-2"
					data-testid={`claude-plan-row-${deriveAccountShortName(effectiveSelectedKey)}-pending`}
				>
					<div className="flex items-center gap-2">
						<div
							className="text-sm font-medium"
							style={{ color: theme.colors.textMain }}
							title={effectiveSelectedKey}
						>
							{deriveAccountShortName(effectiveSelectedKey)}
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim, opacity: 0.7 }}>
							{effectiveSelectedKey}
						</div>
					</div>
					<div
						className="flex items-center gap-2 px-3 py-2 rounded text-xs"
						style={{
							backgroundColor: `${theme.colors.accent}10`,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.accent}30`,
						}}
					>
						<span style={{ color: theme.colors.accent }}>○</span>
						<span>
							No snapshot cached for this account yet. Hit{' '}
							<strong style={{ color: theme.colors.accent }}>Refresh</strong>.
						</span>
					</div>
				</div>
			) : null}
		</div>
	);
});

export default ClaudePlanUsage;
