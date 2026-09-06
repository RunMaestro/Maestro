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
import { makeAccountKeyHelpers, resolveLatestSampledAt } from './quota/quotaFormatting';
import {
	QuotaAccountEmail,
	QuotaAccountPill,
	QuotaAccountTabs,
	QuotaAgentCountBadge,
	QuotaBarRow,
	QuotaLastRefreshed,
	QuotaPendingRow,
	QuotaRefreshControls,
	QuotaSharedAccountBadge,
	QuotaShowAllToggle,
	QuotaVisibilityToggle,
	type QuotaTabStatus,
} from './quota/quotaPrimitives';
import { groupAccountKeysByIdentity } from '../../../shared/claudeAccountIdentity';
import { useQuotaAccounts } from './quota/useQuotaAccounts';
import { useQuotaRefresh } from './quota/useQuotaRefresh';
import { buildQuotaSummary } from './footerSummary';
import { usePublishFooterSummary } from './useFooterSummary';

const TEST_ID_PREFIX = 'claude-plan';
/** Provider id used to key this panel's hidden-account set in uiStore. */
const PROVIDER_ID = 'claude-code';
/** Human-readable provider name used in the agent-count badge tooltip. */
const PROVIDER_LABEL = 'Claude';
const { deriveShortName, deriveDisplayName, normalizeKey } = makeAccountKeyHelpers('.claude');
/** Stable identity for "no shared siblings" so `AccountRow`'s memo still holds. */
const EMPTY_SIBLINGS: string[] = [];

interface ClaudePlanUsageProps {
	theme: Theme;
	accountKeys?: string[];
	showAllAccounts?: boolean;
	autoRefresh?: boolean;
	showRefreshButton?: boolean;
	/** Claim Cmd/Ctrl+R for Refresh while this panel is the visible surface. */
	refreshHotkey?: boolean;
}

interface AccountRowProps {
	configDirKey: string;
	snapshot: ClaudeUsageSnapshot;
	/** Agents pointed at this CLAUDE_CONFIG_DIR. */
	agentCount: number;
	/**
	 * Display names of the other config dirs logged into this same Anthropic
	 * account. Empty when this row owns its quota bucket alone.
	 */
	sharedWith: string[];
	theme: Theme;
}

const AccountRow = memo(function AccountRow({
	configDirKey,
	snapshot,
	agentCount,
	sharedWith,
	theme,
}: AccountRowProps) {
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
				<QuotaAgentCountBadge
					count={agentCount}
					providerLabel={PROVIDER_LABEL}
					testId={`${TEST_ID_PREFIX}-agents-${shortName}`}
					theme={theme}
				/>
				{/* The pill above is the config dir the user named; this is who
				    that dir is actually logged in as. They drift apart whenever
				    `/login` is re-run inside an existing dir. */}
				{snapshot.accountEmail && (
					<QuotaAccountEmail
						email={snapshot.accountEmail}
						testId={`${TEST_ID_PREFIX}-email-${shortName}`}
						theme={theme}
					/>
				)}
				<QuotaSharedAccountBadge
					siblingNames={sharedWith}
					testId={`${TEST_ID_PREFIX}-shared-${shortName}`}
					theme={theme}
				/>
				<div className="text-xs truncate" style={{ color: theme.colors.textDim, opacity: 0.7 }}>
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
						// Claude names its second weekly window after the model tier it
						// meters separately, and that name moves ("Sonnet only" ->
						// "Opus" -> "Fable"). Print the scraped one; the fallback only
						// applies to snapshots cached before the label was captured.
						label={`Week (${snapshot.weekSonnetOnly.label ?? 'Sonnet only'})`}
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
	refreshHotkey = false,
}: ClaudePlanUsageProps) {
	const snapshots = useClaudeUsageStore((s) => s.snapshots);
	const refreshing = useClaudeUsageStore((s) => s.refreshing);

	const { configuredAccountKeys, agentCountsByAccount, setSelectedKey, effectiveSelectedKey } =
		useQuotaAccounts({
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
	const lastSampledAtMs = useMemo(() => resolveLatestSampledAt(snapshots), [snapshots]);

	// Config dirs that resolve to one Anthropic account share a single quota
	// bucket, so their bars are identical by construction. Resolve the sibling
	// sets here (over every snapshot, not just the rendered ones) and label the
	// rows, so identical percentages read as "same account" rather than as the
	// sampler double-reporting one account under two names.
	const sharedAccountNames = useMemo(() => {
		const identities: Record<string, { accountUuid?: string; email?: string }> = {};
		for (const [key, snapshot] of Object.entries(snapshots)) {
			identities[key] = { accountUuid: snapshot.accountUuid, email: snapshot.accountEmail };
		}
		const grouped = groupAccountKeysByIdentity(identities);
		const named: Record<string, string[]> = {};
		for (const [key, siblings] of Object.entries(grouped)) {
			named[key] = siblings.map(deriveDisplayName);
		}
		return named;
	}, [snapshots]);

	// Footer readout. The peak is the highest of the three windows across every
	// configured account: one account pinned at 96% is the fact worth surfacing,
	// and any average would bury it under three idle ones.
	const quotaFooter = useMemo(() => {
		let peak: number | null = null;
		let needsLogin = 0;
		for (const key of configuredAccountKeys) {
			const snap = snapshots[key];
			if (!snap) continue;
			if (snap.authState === 'unauthenticated') {
				needsLogin++;
				continue;
			}
			for (const window of [snap.session, snap.weekAllModels, snap.weekSonnetOnly]) {
				if (typeof window?.percent === 'number' && (peak === null || window.percent > peak)) {
					peak = window.percent;
				}
			}
		}
		return { peak, needsLogin };
	}, [configuredAccountKeys, snapshots]);
	usePublishFooterSummary(
		'anthropic-usage',
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
			await window.maestro.agents.refreshClaudeUsageSnapshots();
		} catch {
			// Main-side errors surface in main logs.
		}
		await useClaudeUsageStore.getState().refresh();
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
		(configDirKey: string) => {
			const shortName = deriveShortName(configDirKey);
			const snapshot = snapshots[configDirKey];
			const isHidden = hiddenSet.has(configDirKey);
			const agentCount = agentCountsByAccount[configDirKey] ?? 0;
			const body = snapshot ? (
				<AccountRow
					configDirKey={configDirKey}
					snapshot={snapshot}
					agentCount={agentCount}
					sharedWith={sharedAccountNames[configDirKey] ?? EMPTY_SIBLINGS}
					theme={theme}
				/>
			) : (
				<QuotaPendingRow
					accountKey={configDirKey}
					shortName={shortName}
					displayName={deriveDisplayName(configDirKey)}
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
					key={configDirKey}
					className="flex items-start gap-2"
					data-testid={`${TEST_ID_PREFIX}-account-${shortName}${isHidden ? '-hidden' : ''}`}
				>
					<QuotaVisibilityToggle
						theme={theme}
						hidden={isHidden}
						shortName={shortName}
						testIdPrefix={TEST_ID_PREFIX}
						onToggle={() => toggleHidden(PROVIDER_ID, configDirKey)}
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
		[snapshots, theme, hiddenSet, toggleHidden, agentCountsByAccount, sharedAccountNames]
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
					// The tab is labeled with the config dir, which says nothing
					// about which login it holds. Put the account on the hover so
					// two tabs that turn out to be one account are explicable
					// without switching between them and comparing bars.
					getTabTitle={(configDirKey) => {
						const email = snapshots[configDirKey]?.accountEmail;
						const shared = sharedAccountNames[configDirKey];
						const lines = [configDirKey];
						if (email) lines.push(`Logged in as ${email}`);
						if (shared?.length) lines.push(`Shares one quota with ${shared.join(', ')}`);
						return lines.join('\n');
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
					agentCount={agentCountsByAccount[effectiveSelectedKey] ?? 0}
					sharedWith={sharedAccountNames[effectiveSelectedKey] ?? EMPTY_SIBLINGS}
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

export default ClaudePlanUsage;
