/**
 * ClaudePlanUsage
 *
 * Per-account Claude plan quota burndown for the Usage Dashboard.
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
 *
 * The bar/pill/tab/refresh primitives and the account + refresh state machines
 * are shared with `CodexPlanUsage` via `./quota/*` - this file only supplies
 * the Claude-specific account row (three fixed windows + the `/login` CTA) and
 * provider wiring.
 */

import { memo, useCallback, useMemo, useState } from 'react';
import type { Theme } from '../../types';
import { useClaudeUsageStore, type ClaudeUsageSnapshot } from '../../stores/claudeUsageStore';
import { useUIStore } from '../../stores/uiStore';
import { makeAccountKeyHelpers } from './quota/quotaFormatting';
import {
	QuotaAccountPill,
	QuotaAccountTabs,
	QuotaBarRow,
	QuotaPendingRow,
	QuotaRefreshControls,
	QuotaShowAllToggle,
	QuotaVisibilityToggle,
	type QuotaTabStatus,
} from './quota/quotaPrimitives';
import { useQuotaAccounts } from './quota/useQuotaAccounts';
import { useQuotaRefresh } from './quota/useQuotaRefresh';

const TEST_ID_PREFIX = 'claude-plan';
/** Provider id used to key this panel's hidden-account set in uiStore. */
const PROVIDER_ID = 'claude-code';
const { deriveShortName, deriveDisplayName, normalizeKey } = makeAccountKeyHelpers('.claude');

interface ClaudePlanUsageProps {
	theme: Theme;
	accountKeys?: string[];
	showAllAccounts?: boolean;
	autoRefresh?: boolean;
	showRefreshButton?: boolean;
}

interface AccountRowProps {
	configDirKey: string;
	snapshot: ClaudeUsageSnapshot;
	theme: Theme;
}

const AccountRow = memo(function AccountRow({ configDirKey, snapshot, theme }: AccountRowProps) {
	const shortName = deriveShortName(configDirKey);
	const isUnauthenticated = snapshot.authState === 'unauthenticated';

	return (
		<div className="space-y-2" data-testid={`${TEST_ID_PREFIX}-row-${shortName}`}>
			<div className="flex items-center gap-2">
				<QuotaAccountPill
					accountKey={configDirKey}
					displayName={deriveDisplayName(configDirKey)}
					theme={theme}
				/>
				<div className="text-xs" style={{ color: theme.colors.textDim, opacity: 0.7 }}>
					{configDirKey}
				</div>
			</div>
			{isUnauthenticated ? (
				// Claude's /usage panel for this CLAUDE_CONFIG_DIR rendered
				// "Not logged in · Run /login". Surface that as a CTA instead
				// of bars - the percentages would all be 0 and meaningless.
				<div
					className="flex items-center gap-2 px-3 py-2 rounded text-xs"
					style={{
						backgroundColor: `${theme.colors.warning ?? theme.colors.accent}15`,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.warning ?? theme.colors.accent}40`,
					}}
					data-testid={`${TEST_ID_PREFIX}-row-${shortName}-unauthenticated`}
				>
					<span style={{ color: theme.colors.warning ?? theme.colors.accent }}>●</span>
					<span>
						Not logged in. Run <code style={{ color: theme.colors.accent }}>/login</code> in a
						Claude session that uses this account.
					</span>
				</div>
			) : (
				<>
					<QuotaBarRow
						label="Session window"
						percent={snapshot.session.percent}
						resetsAt={snapshot.session.resetsAt}
						theme={theme}
					/>
					<QuotaBarRow
						label="Week (all models)"
						percent={snapshot.weekAllModels.percent}
						resetsAt={snapshot.weekAllModels.resetsAt}
						theme={theme}
					/>
					<QuotaBarRow
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

export const ClaudePlanUsage = memo(function ClaudePlanUsage({
	theme,
	accountKeys = [],
	showAllAccounts = false,
	autoRefresh = true,
	showRefreshButton = true,
}: ClaudePlanUsageProps) {
	const snapshots = useClaudeUsageStore((s) => s.snapshots);
	const refreshing = useClaudeUsageStore((s) => s.refreshing);

	const { configuredAccountKeys, setSelectedKey, effectiveSelectedKey } = useQuotaAccounts({
		toolType: 'claude-code',
		envVarName: 'CLAUDE_CONFIG_DIR',
		defaultSubdir: '.claude',
		accountKeys,
		snapshots,
		normalizeKey,
		deriveShortName,
		fetchAgentEnvVars: () => window.maestro.agents.getCustomEnvVars('claude-code'),
		fetchAccountKeys: () => {
			const fn = window.maestro.agents.getClaudeUsageAccountKeys;
			return typeof fn === 'function' ? fn() : undefined;
		},
	});

	const selectedSnapshot: ClaudeUsageSnapshot | null = effectiveSelectedKey
		? (snapshots[effectiveSelectedKey] ?? null)
		: null;
	const snapshotCount = Object.keys(snapshots).length;

	// Hidden-account state (only meaningful in the showAllAccounts list view).
	const hiddenKeys = useUIStore((s) => s.hiddenQuotaAccounts[PROVIDER_ID]);
	const toggleHidden = useUIStore((s) => s.toggleHiddenQuotaAccount);
	const hiddenSet = useMemo(() => new Set(hiddenKeys ?? []), [hiddenKeys]);
	const [revealHidden, setRevealHidden] = useState(false);
	// Count only hidden keys still present in the configured set so a stale key
	// for a removed account never shows a phantom "Show all" badge.
	const hiddenVisibleCount = configuredAccountKeys.filter((k) => hiddenSet.has(k)).length;
	const accountsToRender =
		revealHidden || hiddenVisibleCount === 0
			? configuredAccountKeys
			: configuredAccountKeys.filter((k) => !hiddenSet.has(k));

	// Trigger the main re-sample, then re-pull the store. The store re-pull runs
	// even when the sampler IPC throws so the dashboard reflects the latest cache.
	const doRefresh = useCallback(async () => {
		try {
			await window.maestro.agents.refreshClaudeUsageSnapshots();
		} catch {
			// Main-side errors surface in main logs.
		}
		await useClaudeUsageStore.getState().refresh();
	}, []);

	const { isBusy, refreshIntervalMs, setRefreshIntervalMs, handleRefresh } = useQuotaRefresh({
		refreshing,
		autoRefresh,
		showRefreshButton,
		accountCount: configuredAccountKeys.length,
		snapshotCount,
		doRefresh,
	});

	const renderAccount = useCallback(
		(configDirKey: string) => {
			const shortName = deriveShortName(configDirKey);
			const snapshot = snapshots[configDirKey];
			const isHidden = hiddenSet.has(configDirKey);
			const body = snapshot ? (
				<AccountRow configDirKey={configDirKey} snapshot={snapshot} theme={theme} />
			) : (
				<QuotaPendingRow
					accountKey={configDirKey}
					shortName={shortName}
					displayName={deriveDisplayName(configDirKey)}
					testIdPrefix={TEST_ID_PREFIX}
					theme={theme}
				/>
			);
			// pr-8 reserves a gutter for the absolutely-positioned toggle so it never
			// overlaps the account header text or the first bar's reset caption.
			return (
				<div
					key={configDirKey}
					className="relative pr-8"
					data-testid={`${TEST_ID_PREFIX}-account-${shortName}${isHidden ? '-hidden' : ''}`}
				>
					<div className="absolute top-0 right-0 z-10">
						<QuotaVisibilityToggle
							theme={theme}
							hidden={isHidden}
							shortName={shortName}
							testIdPrefix={TEST_ID_PREFIX}
							onToggle={() => toggleHidden(PROVIDER_ID, configDirKey)}
						/>
					</div>
					<div style={{ opacity: isHidden ? 0.45 : 1, transition: 'opacity 0.2s' }}>{body}</div>
				</div>
			);
		},
		[snapshots, theme, hiddenSet, toggleHidden]
	);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="claude-plan-usage"
		>
			<div className="flex flex-wrap items-center justify-between gap-3 mb-4">
				<div className="flex items-center gap-2">
					<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Claude Plan Usage
					</h3>
					<span
						className="rounded-full px-2 py-0.5 text-xs"
						style={{
							color: theme.colors.textDim,
							backgroundColor: `${theme.colors.border}55`,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						Claude Code
					</span>
				</div>
				<div className="flex flex-wrap items-center justify-end gap-2">
					{showAllAccounts && hiddenVisibleCount > 0 && (
						<QuotaShowAllToggle
							theme={theme}
							hiddenCount={hiddenVisibleCount}
							revealing={revealHidden}
							testIdPrefix={TEST_ID_PREFIX}
							onToggle={() => setRevealHidden((v) => !v)}
						/>
					)}
					{showRefreshButton && (
						<QuotaRefreshControls
							theme={theme}
							refreshIntervalMs={refreshIntervalMs}
							onChangeInterval={setRefreshIntervalMs}
							onRefresh={handleRefresh}
							isBusy={isBusy}
							testIdPrefix={TEST_ID_PREFIX}
							sweepClassName="claude-plan-refresh-sweep"
							intervalAriaLabel="Claude usage auto refresh interval"
							buttonAriaLabel="Refresh Claude usage snapshots"
						/>
					)}
				</div>
			</div>

			{showAllAccounts && configuredAccountKeys.length > 0 && (
				<div className="space-y-4">
					{accountsToRender.length > 0 ? (
						accountsToRender.map(renderAccount)
					) : (
						<div
							className="flex items-center justify-center h-16 text-sm text-center px-4"
							style={{ color: theme.colors.textDim }}
							data-testid={`${TEST_ID_PREFIX}-all-hidden`}
						>
							All accounts hidden. Use <strong className="mx-1">Show all</strong> to bring them
							back.
						</div>
					)}
				</div>
			)}

			{/* Account tab bar - renders whenever at least one account is
			    configured so the structure stays consistent when accounts are
			    added/removed. A bare empty state still hides the bar. */}
			{!showAllAccounts && configuredAccountKeys.length >= 1 && (
				<QuotaAccountTabs
					theme={theme}
					accountKeys={configuredAccountKeys}
					effectiveSelectedKey={effectiveSelectedKey}
					onSelect={setSelectedKey}
					testIdPrefix={TEST_ID_PREFIX}
					ariaLabel="Claude account selector"
					warningTitle="Not logged in"
					deriveShortName={deriveShortName}
					deriveDisplayName={deriveDisplayName}
					getTabStatus={(configDirKey): QuotaTabStatus => {
						const snap = snapshots[configDirKey];
						if (snap?.authState === 'unauthenticated') return 'warning';
						if (!snap) return 'pending';
						return 'none';
					}}
				/>
			)}

			{configuredAccountKeys.length === 0 ? (
				<div
					className="flex items-center justify-center h-24 text-sm text-center px-4"
					style={{ color: theme.colors.textDim }}
					data-testid="claude-plan-empty"
				>
					No Claude accounts configured. Set CLAUDE_CONFIG_DIR on a Claude Code session (or the
					agent) - we sample only explicitly-configured accounts so we never trigger a browser OAuth
					prompt.
				</div>
			) : showAllAccounts ? null : effectiveSelectedKey && selectedSnapshot ? (
				<AccountRow
					key={effectiveSelectedKey}
					configDirKey={effectiveSelectedKey}
					snapshot={selectedSnapshot}
					theme={theme}
				/>
			) : effectiveSelectedKey ? (
				// Account is configured but no snapshot in the store yet - guide
				// the user to hit Refresh rather than silently rendering nothing.
				<QuotaPendingRow
					accountKey={effectiveSelectedKey}
					shortName={deriveShortName(effectiveSelectedKey)}
					displayName={deriveDisplayName(effectiveSelectedKey)}
					testIdPrefix={TEST_ID_PREFIX}
					theme={theme}
				/>
			) : null}
		</div>
	);
});

export default ClaudePlanUsage;
