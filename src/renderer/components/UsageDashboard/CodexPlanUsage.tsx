/**
 * CodexPlanUsage
 *
 * Per-account Codex quota burndown for the Usage Dashboard. Mirrors
 * ClaudePlanUsage's account-tab + horizontal-bar pattern (shared via
 * `./quota/*`), but reads sanitized ChatGPT/Codex quota snapshots from
 * `codexUsageStore`. This file supplies only the Codex-specific account row
 * (session/weekly/additional windows + email/plan chips + auth CTA) and
 * provider wiring.
 */

import { memo, useCallback, useMemo, useState } from 'react';
import type { Theme } from '../../types';
import { useCodexUsageStore, type CodexUsageSnapshot } from '../../stores/codexUsageStore';
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

const TEST_ID_PREFIX = 'codex-plan';
/** Provider id used to key this panel's hidden-account set in uiStore. */
const PROVIDER_ID = 'codex';
const { deriveShortName, deriveDisplayName, normalizeKey } = makeAccountKeyHelpers('.codex');

interface CodexPlanUsageProps {
	theme: Theme;
	accountKeys?: string[];
	showAllAccounts?: boolean;
	autoRefresh?: boolean;
	showRefreshButton?: boolean;
}

interface AccountRowProps {
	codexHomeKey: string;
	snapshot: CodexUsageSnapshot;
	theme: Theme;
}

const AccountRow = memo(function AccountRow({ codexHomeKey, snapshot, theme }: AccountRowProps) {
	const shortName = deriveShortName(codexHomeKey);
	const hasBars =
		snapshot.session || snapshot.weekly || (snapshot.additionalLimits?.length ?? 0) > 0;

	return (
		<div className="space-y-2" data-testid={`${TEST_ID_PREFIX}-row-${shortName}`}>
			<div className="flex items-center gap-2">
				<QuotaAccountPill
					accountKey={codexHomeKey}
					displayName={deriveDisplayName(codexHomeKey)}
					theme={theme}
				/>
				{snapshot.email && (
					<div className="text-xs" style={{ color: theme.colors.textDim, opacity: 0.7 }}>
						{snapshot.email}
					</div>
				)}
				{snapshot.planType && (
					<div
						className="text-xs px-1.5 py-0.5 rounded"
						style={{
							color: theme.colors.accent,
							backgroundColor: `${theme.colors.accent}15`,
						}}
					>
						{snapshot.planType}
					</div>
				)}
			</div>

			{snapshot.authState !== 'authenticated' ? (
				<div
					className="flex items-center gap-2 px-3 py-2 rounded text-xs"
					style={{
						backgroundColor: `${theme.colors.warning ?? theme.colors.accent}15`,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.warning ?? theme.colors.accent}40`,
					}}
					data-testid={`${TEST_ID_PREFIX}-row-${shortName}-${snapshot.authState}`}
				>
					<span style={{ color: theme.colors.warning ?? theme.colors.accent }}>●</span>
					<span>{snapshot.error ?? 'Codex quota is unavailable for this account.'}</span>
				</div>
			) : hasBars ? (
				<>
					{snapshot.session && (
						<QuotaBarRow
							label="Session (5h)"
							percent={snapshot.session.percent}
							resetsAt={snapshot.session.resetsAt}
							theme={theme}
						/>
					)}
					{snapshot.weekly && (
						<QuotaBarRow
							label="Weekly"
							percent={snapshot.weekly.percent}
							resetsAt={snapshot.weekly.resetsAt}
							theme={theme}
						/>
					)}
					{(snapshot.additionalLimits ?? []).map((limit) => (
						<QuotaBarRow
							key={limit.name}
							label={limit.name}
							percent={limit.percent}
							resetsAt={limit.resetsAt}
							theme={theme}
						/>
					))}
				</>
			) : (
				<div
					className="flex items-center gap-2 px-3 py-2 rounded text-xs"
					style={{
						backgroundColor: `${theme.colors.accent}10`,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.accent}30`,
					}}
				>
					<span style={{ color: theme.colors.accent }}>○</span>
					<span>Quota endpoint returned no rate-limit windows for this account.</span>
				</div>
			)}
		</div>
	);
});

export const CodexPlanUsage = memo(function CodexPlanUsage({
	theme,
	accountKeys = [],
	showAllAccounts = false,
	autoRefresh = true,
	showRefreshButton = true,
}: CodexPlanUsageProps) {
	const snapshots = useCodexUsageStore((s) => s.snapshots);
	const refreshing = useCodexUsageStore((s) => s.refreshing);

	const { configuredAccountKeys, setSelectedKey, effectiveSelectedKey } = useQuotaAccounts({
		toolType: 'codex',
		envVarName: 'CODEX_HOME',
		defaultSubdir: '.codex',
		accountKeys,
		snapshots,
		normalizeKey,
		deriveShortName,
		fetchAgentEnvVars: () => window.maestro.agents.getCustomEnvVars('codex'),
		fetchAccountKeys: () => {
			const fn = window.maestro.agents.getCodexUsageAccountKeys;
			return typeof fn === 'function' ? fn() : undefined;
		},
	});

	const selectedSnapshot: CodexUsageSnapshot | null = effectiveSelectedKey
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
			await window.maestro.agents.refreshCodexUsageSnapshots();
		} catch {
			// Main logs carry the detailed failure.
		}
		await useCodexUsageStore.getState().refresh();
	}, []);

	const { isBusy, refreshIntervalMs, setRefreshIntervalMs, handleRefresh } = useQuotaRefresh({
		providerId: PROVIDER_ID,
		refreshing,
		autoRefresh,
		accountCount: configuredAccountKeys.length,
		snapshotCount,
		doRefresh,
	});

	const renderAccount = useCallback(
		(codexHomeKey: string) => {
			const shortName = deriveShortName(codexHomeKey);
			const snapshot = snapshots[codexHomeKey];
			const isHidden = hiddenSet.has(codexHomeKey);
			const body = snapshot ? (
				<AccountRow codexHomeKey={codexHomeKey} snapshot={snapshot} theme={theme} />
			) : (
				<QuotaPendingRow
					accountKey={codexHomeKey}
					shortName={shortName}
					displayName={deriveDisplayName(codexHomeKey)}
					testIdPrefix={TEST_ID_PREFIX}
					theme={theme}
				/>
			);
			// Toggle sits inline to the left of the account pill (items-start keeps
			// it aligned with the header row, not centered against the full row).
			// Only the body dims when hidden so the toggle stays clearly clickable.
			return (
				<div
					key={codexHomeKey}
					className="flex items-start gap-2"
					data-testid={`${TEST_ID_PREFIX}-account-${shortName}${isHidden ? '-hidden' : ''}`}
				>
					<QuotaVisibilityToggle
						theme={theme}
						hidden={isHidden}
						shortName={shortName}
						testIdPrefix={TEST_ID_PREFIX}
						onToggle={() => toggleHidden(PROVIDER_ID, codexHomeKey)}
					/>
					<div
						className="flex-1 min-w-0"
						style={{ opacity: isHidden ? 0.45 : 1, transition: 'opacity 0.2s' }}
					>
						{body}
					</div>
				</div>
			);
		},
		[snapshots, theme, hiddenSet, toggleHidden]
	);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="codex-plan-usage"
		>
			<div className="flex flex-wrap items-center justify-between gap-3 mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Codex Plan Usage
				</h3>
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
							sweepClassName="codex-plan-refresh-sweep"
							intervalAriaLabel="Codex usage auto refresh interval"
							buttonAriaLabel="Refresh Codex usage snapshots"
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

			{!showAllAccounts && configuredAccountKeys.length >= 1 && (
				<QuotaAccountTabs
					theme={theme}
					accountKeys={configuredAccountKeys}
					effectiveSelectedKey={effectiveSelectedKey}
					onSelect={setSelectedKey}
					testIdPrefix={TEST_ID_PREFIX}
					ariaLabel="Codex account selector"
					warningTitle="Needs attention"
					deriveShortName={deriveShortName}
					deriveDisplayName={deriveDisplayName}
					getTabStatus={(codexHomeKey): QuotaTabStatus => {
						const snap = snapshots[codexHomeKey];
						if (snap && snap.authState !== 'authenticated') return 'warning';
						if (!snap) return 'pending';
						return 'none';
					}}
				/>
			)}

			{configuredAccountKeys.length === 0 ? (
				<div
					className="flex items-center justify-center h-24 text-sm text-center px-4"
					style={{ color: theme.colors.textDim }}
					data-testid="codex-plan-empty"
				>
					No Codex accounts configured. Set CODEX_HOME on a Codex session (or the agent), or run{' '}
					<code style={{ color: theme.colors.accent }}>codex login</code> in a <code>~/.codex</code>{' '}
					home - we sample only discoverable accounts so we never trigger a browser OAuth prompt.
				</div>
			) : showAllAccounts ? null : effectiveSelectedKey && selectedSnapshot ? (
				<AccountRow
					key={effectiveSelectedKey}
					codexHomeKey={effectiveSelectedKey}
					snapshot={selectedSnapshot}
					theme={theme}
				/>
			) : effectiveSelectedKey ? (
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

export default CodexPlanUsage;
