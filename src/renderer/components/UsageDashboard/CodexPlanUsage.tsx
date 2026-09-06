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
import { makeAccountKeyHelpers, resolveLatestSampledAt } from './quota/quotaFormatting';
import {
	QuotaAccountEmail,
	QuotaAccountPill,
	QuotaAgentCountBadge,
	QuotaAccountTabs,
	QuotaBarRow,
	QuotaPendingRow,
	QuotaLastRefreshed,
	QuotaRefreshControls,
	QuotaShowAllToggle,
	QuotaVisibilityToggle,
	type QuotaTabStatus,
} from './quota/quotaPrimitives';
import { useQuotaAccounts } from './quota/useQuotaAccounts';
import { useQuotaRefresh } from './quota/useQuotaRefresh';
import { buildQuotaSummary } from './footerSummary';
import { usePublishFooterSummary } from './useFooterSummary';

const TEST_ID_PREFIX = 'codex-plan';
/** Provider id used to key this panel's hidden-account set in uiStore. */
const PROVIDER_ID = 'codex';
/** Human-readable provider name used in the agent-count badge tooltip. */
const PROVIDER_LABEL = 'Codex';
const { deriveShortName, deriveDisplayName, normalizeKey } = makeAccountKeyHelpers('.codex');

interface CodexPlanUsageProps {
	theme: Theme;
	accountKeys?: string[];
	showAllAccounts?: boolean;
	autoRefresh?: boolean;
	showRefreshButton?: boolean;
	/** Claim Cmd/Ctrl+R for Refresh while this panel is the visible surface. */
	refreshHotkey?: boolean;
}

interface AccountRowProps {
	codexHomeKey: string;
	snapshot: CodexUsageSnapshot;
	/** Agents pointed at this CODEX_HOME. */
	agentCount: number;
	theme: Theme;
}

const AccountRow = memo(function AccountRow({
	codexHomeKey,
	snapshot,
	agentCount,
	theme,
}: AccountRowProps) {
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
				<QuotaAgentCountBadge
					count={agentCount}
					providerLabel={PROVIDER_LABEL}
					testId={`${TEST_ID_PREFIX}-agents-${shortName}`}
					theme={theme}
				/>
				{snapshot.email && (
					<QuotaAccountEmail
						email={snapshot.email}
						testId={`${TEST_ID_PREFIX}-email-${shortName}`}
						theme={theme}
					/>
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
	refreshHotkey = false,
}: CodexPlanUsageProps) {
	const snapshots = useCodexUsageStore((s) => s.snapshots);
	const refreshing = useCodexUsageStore((s) => s.refreshing);

	const { configuredAccountKeys, agentCountsByAccount, setSelectedKey, effectiveSelectedKey } =
		useQuotaAccounts({
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
	const lastSampledAtMs = useMemo(() => resolveLatestSampledAt(snapshots), [snapshots]);

	// Footer readout, mirroring the Anthropic panel: account count, how many are
	// locked out, and the tightest window across every account. Codex reports
	// extra named limits alongside session/weekly, so those count toward the
	// peak too - a wall is a wall whatever the sampler calls it.
	const quotaFooter = useMemo(() => {
		let peak: number | null = null;
		let needsLogin = 0;
		for (const key of configuredAccountKeys) {
			const snap = snapshots[key];
			if (!snap) continue;
			if (snap.authState === 'unauthenticated' || snap.authState === 'missing_auth') {
				needsLogin++;
				continue;
			}
			const windows = [snap.session, snap.weekly, ...(snap.additionalLimits ?? [])];
			for (const window of windows) {
				if (typeof window?.percent === 'number' && (peak === null || window.percent > peak)) {
					peak = window.percent;
				}
			}
		}
		return { peak, needsLogin };
	}, [configuredAccountKeys, snapshots]);
	usePublishFooterSummary(
		'codex-usage',
		buildQuotaSummary({
			accounts: configuredAccountKeys.length,
			needsLogin: quotaFooter.needsLogin,
			peakPercent: quotaFooter.peak,
			sampledAtMs: lastSampledAtMs,
		})
	);

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
		refreshHotkey,
	});

	const renderAccount = useCallback(
		(codexHomeKey: string) => {
			const shortName = deriveShortName(codexHomeKey);
			const snapshot = snapshots[codexHomeKey];
			const isHidden = hiddenSet.has(codexHomeKey);
			const agentCount = agentCountsByAccount[codexHomeKey] ?? 0;
			const body = snapshot ? (
				<AccountRow
					codexHomeKey={codexHomeKey}
					snapshot={snapshot}
					agentCount={agentCount}
					theme={theme}
				/>
			) : (
				<QuotaPendingRow
					accountKey={codexHomeKey}
					shortName={shortName}
					displayName={deriveDisplayName(codexHomeKey)}
					testIdPrefix={TEST_ID_PREFIX}
					agentCount={agentCount}
					providerLabel={PROVIDER_LABEL}
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
		[snapshots, theme, hiddenSet, toggleHidden, agentCountsByAccount]
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
							showHotkeyHint={refreshHotkey}
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
					agentCount={agentCountsByAccount[effectiveSelectedKey] ?? 0}
					theme={theme}
				/>
			) : effectiveSelectedKey ? (
				<QuotaPendingRow
					accountKey={effectiveSelectedKey}
					shortName={deriveShortName(effectiveSelectedKey)}
					displayName={deriveDisplayName(effectiveSelectedKey)}
					testIdPrefix={TEST_ID_PREFIX}
					agentCount={agentCountsByAccount[effectiveSelectedKey] ?? 0}
					providerLabel={PROVIDER_LABEL}
					theme={theme}
				/>
			) : null}

			<QuotaLastRefreshed
				sampledAtMs={lastSampledAtMs}
				theme={theme}
				testIdPrefix={TEST_ID_PREFIX}
			/>
		</div>
	);
});

export default CodexPlanUsage;
