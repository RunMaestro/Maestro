/**
 * PlanUsagePanel - per-account plan quota burndown, one panel for every
 * provider (the Anthropic Usage and OpenAI Usage tabs).
 *
 * One row per account (a `CLAUDE_CONFIG_DIR` or `CODEX_HOME`), each a stack of
 * horizontal bars, one per quota window. Bar fill color tracks the same limit
 * threshold the spawner consults, so a bar drawn orange is exactly what would
 * trip the auto-fallback on the next turn. A window whose reset time has passed
 * draws at 0% ("reset, awaiting sample") rather than at its stale percentage.
 *
 * Everything provider-specific lives in a {@link PlanUsageConfig}: where the
 * snapshots come from, which windows a snapshot has, what a logged-out row
 * says, and the identity chips beside the account pill. The panel itself owns
 * the account list, the hide/show state, the refresh controls (Refresh button,
 * persisted auto-refresh interval, optional Cmd/Ctrl+R), and the footer
 * summary, so the two tabs cannot drift apart in layout or behavior.
 *
 * Snapshots are read live from the provider store. Refresh calls the store's
 * `sample()`, which re-samples on main and pulls the map back; the sample
 * belongs to the store, so it keeps running when the user switches tabs.
 */

import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import type { Theme } from '../../../types';
import { useUIStore } from '../../../stores/uiStore';
import {
	effectiveQuotaPercent,
	makeAccountKeyHelpers,
	resolveLatestSampledAt,
	type QuotaAccountKeyHelpers,
} from './quotaFormatting';
import {
	QuotaAccountPill,
	QuotaAgentCountBadge,
	QuotaAuthNotice,
	QuotaBarRow,
	QuotaPendingRow,
	QuotaRefreshControls,
	QuotaShowAllToggle,
	QuotaStaleSampleBadge,
	QuotaVisibilityToggle,
} from './quotaPrimitives';
import { useQuotaAccounts } from './useQuotaAccounts';
import { useQuotaRefresh } from './useQuotaRefresh';
import { useQuotaAccountLogin } from './useQuotaAccountLogin';
import { buildQuotaSummary } from '../footerSummary';
import { usePublishFooterSummary } from '../useFooterSummary';

/** One bar: a quota window as the panel draws it. */
export interface QuotaWindowRow {
	key: string;
	label: string;
	percent: number;
	resetsAt?: string;
}

/** What an identity or below-the-bars renderer is handed for one row. */
export interface PlanUsageRowContext<TSnapshot, TShared> {
	snapshot: TSnapshot;
	accountKey: string;
	shortName: string;
	displayName: string;
	testIdPrefix: string;
	theme: Theme;
	/** The value `deriveShared` computed over every snapshot (e.g. shared-account groups). */
	shared: TShared;
}

export interface PlanUsageConfig<TSnapshot extends { sampledAt?: string }, TShared = undefined> {
	/** Agent `toolType` the accounts belong to; keys hidden accounts and the refresh interval. */
	providerId: 'claude-code' | 'codex';
	/** Dashboard tab whose footer this panel feeds. */
	footerTab: 'anthropic-usage' | 'codex-usage';
	/** Prefix for every `data-testid` (`claude-plan`, `codex-plan`). */
	testIdPrefix: string;
	/** Provider name in copy ("3 agents run against this Claude account"). */
	providerLabel: string;
	heading: string;
	/** Account dir prefix the key helpers strip for display (`.claude`, `.codex`). */
	accountDirPrefix: string;
	useSnapshots: () => Record<string, TSnapshot>;
	/** True while the store is pulling or sampling. */
	useBusy: () => boolean;
	/** Re-sample every account on main, then pull (the store's `sample`). */
	sample: () => Promise<void>;
	/** Agent-level env vars for this provider (Settings -> Agents). */
	fetchAgentEnvVars: () => Promise<Record<string, string> | null | undefined> | undefined;
	/** Account dirs main discovered on disk. */
	fetchAccountKeys: () => Promise<string[]> | undefined;
	/** The windows a snapshot carries, in display order. */
	windows: (snapshot: TSnapshot) => QuotaWindowRow[];
	/**
	 * What to show instead of bars when the sample could not read quota (logged
	 * out, missing auth, a server error), or null when it could.
	 */
	authNotice: (snapshot: TSnapshot, theme: Theme) => ReactNode | null;
	/** Suffix for the notice's test id (the snapshot's auth state). */
	authState: (snapshot: TSnapshot) => string;
	/** Whether logging in fixes the row: offers the Log in button and counts toward "needs login". */
	loginFixes: (snapshot: TSnapshot) => boolean;
	/** Computed once per render over every snapshot, handed to each row. */
	deriveShared?: (snapshots: Record<string, TSnapshot>, helpers: QuotaAccountKeyHelpers) => TShared;
	/** Chips after the agent-count badge (email, plan, shared account). */
	renderIdentity?: (ctx: PlanUsageRowContext<TSnapshot, TShared>) => ReactNode;
	/** Content under an authenticated row's bars (Codex reset credits). */
	renderBelowBars?: (ctx: PlanUsageRowContext<TSnapshot, TShared>) => ReactNode;
}

export interface PlanUsagePanelProps {
	theme: Theme;
	/** Claim Cmd/Ctrl+R for Refresh while this panel is the visible surface. */
	refreshHotkey?: boolean;
	/**
	 * Show the agents backed by one account. Given, each row's "N agents" chip
	 * becomes a button that hands the account key back so the dashboard can open
	 * the Agents tab filtered to it. Omitted, the chip stays a label.
	 */
	onShowAccountAgents?: (accountKey: string) => void;
}

interface AccountRowProps<TSnapshot extends { sampledAt?: string }, TShared> {
	config: PlanUsageConfig<TSnapshot, TShared>;
	helpers: QuotaAccountKeyHelpers;
	accountKey: string;
	snapshot: TSnapshot;
	agentCount: number;
	latestSampledAtMs: number | null;
	shared: TShared;
	theme: Theme;
	onShowAgents?: () => void;
	onLogin?: () => void;
}

function AccountRow<TSnapshot extends { sampledAt?: string }, TShared>({
	config,
	helpers,
	accountKey,
	snapshot,
	agentCount,
	latestSampledAtMs,
	shared,
	theme,
	onShowAgents,
	onLogin,
}: AccountRowProps<TSnapshot, TShared>) {
	const { testIdPrefix } = config;
	const shortName = helpers.deriveShortName(accountKey);
	const ctx: PlanUsageRowContext<TSnapshot, TShared> = {
		snapshot,
		accountKey,
		shortName,
		displayName: helpers.deriveDisplayName(accountKey),
		testIdPrefix,
		theme,
		shared,
	};
	const notice = config.authNotice(snapshot, theme);
	const windows = notice ? [] : config.windows(snapshot);

	return (
		<div className="space-y-2" data-testid={`${testIdPrefix}-row-${shortName}`}>
			<div className="flex flex-wrap items-center gap-2">
				<QuotaAccountPill accountKey={accountKey} displayName={ctx.displayName} theme={theme} />
				<QuotaAgentCountBadge
					count={agentCount}
					providerLabel={config.providerLabel}
					testId={`${testIdPrefix}-agents-${shortName}`}
					theme={theme}
					onClick={agentCount > 0 ? onShowAgents : undefined}
				/>
				{config.renderIdentity?.(ctx)}
				<QuotaStaleSampleBadge
					sampledAt={snapshot.sampledAt}
					latestSampledAtMs={latestSampledAtMs}
					testId={`${testIdPrefix}-stale-${shortName}`}
					theme={theme}
				/>
				<div
					className="text-xs truncate min-w-0"
					style={{ color: theme.colors.textDim, opacity: 0.7 }}
				>
					{accountKey}
				</div>
			</div>

			{notice ? (
				<QuotaAuthNotice
					theme={theme}
					message={notice}
					testId={`${testIdPrefix}-row-${shortName}-${config.authState(snapshot)}`}
					// A network or server error is not fixed by logging in.
					onLogin={config.loginFixes(snapshot) ? onLogin : undefined}
				/>
			) : windows.length > 0 ? (
				<>
					{windows.map((quotaWindow) => (
						<QuotaBarRow
							key={quotaWindow.key}
							label={quotaWindow.label}
							percent={quotaWindow.percent}
							resetsAt={quotaWindow.resetsAt}
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
					data-testid={`${testIdPrefix}-row-${shortName}-no-windows`}
				>
					<span style={{ color: theme.colors.accent }}>○</span>
					<span>The quota endpoint reported no rate-limit windows for this account.</span>
				</div>
			)}

			{!notice && config.renderBelowBars?.(ctx)}
		</div>
	);
}

function PlanUsagePanelInner<TSnapshot extends { sampledAt?: string }, TShared>({
	config,
	theme,
	refreshHotkey = false,
	onShowAccountAgents,
}: PlanUsagePanelProps & { config: PlanUsageConfig<TSnapshot, TShared> }) {
	const { providerId, testIdPrefix } = config;
	const helpers = useMemo(
		() => makeAccountKeyHelpers(config.accountDirPrefix),
		[config.accountDirPrefix]
	);
	const snapshots = config.useSnapshots();
	// A sample in flight counts as busy even when this panel did not start it
	// (it outlives a tab switch), so a remount shows the spinner, not an idle button.
	const refreshing = config.useBusy();

	const { configuredAccountKeys, agentCountsByAccount } = useQuotaAccounts({
		toolType: providerId,
		accountKeys: [],
		snapshots,
		normalizeKey: helpers.normalizeKey,
		deriveShortName: helpers.deriveShortName,
		fetchAgentEnvVars: config.fetchAgentEnvVars,
		fetchAccountKeys: config.fetchAccountKeys,
	});

	const lastSampledAtMs = useMemo(() => resolveLatestSampledAt(snapshots), [snapshots]);
	const shared = useMemo(
		() => config.deriveShared?.(snapshots, helpers) as TShared,
		[config, snapshots, helpers]
	);

	// Footer readout. The peak is the tightest window across every account: one
	// account pinned at 96% is the fact worth surfacing, and any average would
	// bury it under three idle ones. A window whose reset has passed counts at 0.
	const quotaFooter = useMemo(() => {
		let peak: number | null = null;
		let needsLogin = 0;
		const now = Date.now();
		for (const key of configuredAccountKeys) {
			const snap = snapshots[key];
			if (!snap) continue;
			if (config.loginFixes(snap)) needsLogin++;
			if (config.authNotice(snap, theme)) continue;
			for (const quotaWindow of config.windows(snap)) {
				const percent = effectiveQuotaPercent(quotaWindow, now);
				if (Number.isFinite(percent) && (peak === null || percent > peak)) peak = percent;
			}
		}
		return { peak, needsLogin };
	}, [configuredAccountKeys, snapshots, config, theme]);
	usePublishFooterSummary(
		config.footerTab,
		buildQuotaSummary({
			accounts: configuredAccountKeys.length,
			needsLogin: quotaFooter.needsLogin,
			peakPercent: quotaFooter.peak,
			sampledAtMs: lastSampledAtMs,
		})
	);

	// Hidden accounts persist per provider in uiStore.
	const hiddenKeys = useUIStore((s) => s.hiddenQuotaAccounts[providerId]);
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

	const doRefresh = useCallback(() => config.sample(), [config]);
	const { isBusy, refreshIntervalMs, setRefreshIntervalMs, handleRefresh } = useQuotaRefresh({
		providerId,
		refreshing,
		doRefresh,
		refreshHotkey,
	});

	const startLogin = useQuotaAccountLogin(providerId, () => void handleRefresh());

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid={`${testIdPrefix}-usage`}
		>
			{/* Stacks on a phone: the controls start under the heading, left-aligned. */}
			<div className="flex flex-wrap items-center justify-between gap-3 mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					{config.heading}
				</h3>
				<div className="flex flex-wrap items-center justify-start gap-2 sm:justify-end">
					{hiddenVisibleCount > 0 && (
						<QuotaShowAllToggle
							theme={theme}
							hiddenCount={hiddenVisibleCount}
							revealing={revealHidden}
							testIdPrefix={testIdPrefix}
							onToggle={() => setRevealHidden((v) => !v)}
						/>
					)}
					<QuotaRefreshControls
						theme={theme}
						refreshIntervalMs={refreshIntervalMs}
						onChangeInterval={setRefreshIntervalMs}
						onRefresh={handleRefresh}
						isBusy={isBusy}
						testIdPrefix={testIdPrefix}
						sweepClassName={`${testIdPrefix}-refresh-sweep`}
						intervalAriaLabel={`${config.providerLabel} usage auto refresh interval`}
						buttonAriaLabel={`Refresh ${config.providerLabel} usage snapshots`}
						showHotkeyHint={refreshHotkey}
					/>
				</div>
			</div>

			<div className="space-y-4">
				{accountsToRender.length > 0 ? (
					accountsToRender.map((accountKey) => {
						const shortName = helpers.deriveShortName(accountKey);
						const snapshot = snapshots[accountKey];
						const isHidden = hiddenSet.has(accountKey);
						const agentCount = agentCountsByAccount[accountKey] ?? 0;
						const onShowAgents = onShowAccountAgents
							? () => onShowAccountAgents(accountKey)
							: undefined;
						return (
							<div
								key={accountKey}
								className="flex items-start gap-2"
								data-testid={`${testIdPrefix}-account-${shortName}${isHidden ? '-hidden' : ''}`}
							>
								<QuotaVisibilityToggle
									theme={theme}
									hidden={isHidden}
									shortName={shortName}
									testIdPrefix={testIdPrefix}
									onToggle={() => toggleHidden(providerId, accountKey)}
								/>
								{/* Only the body dims when hidden so the toggle stays clearly clickable. */}
								<div
									className="flex-1 min-w-0"
									style={{ opacity: isHidden ? 0.45 : 1, transition: 'opacity 0.2s' }}
								>
									{snapshot ? (
										<AccountRow
											config={config}
											helpers={helpers}
											accountKey={accountKey}
											snapshot={snapshot}
											agentCount={agentCount}
											latestSampledAtMs={lastSampledAtMs}
											shared={shared}
											theme={theme}
											onShowAgents={onShowAgents}
											onLogin={() => startLogin(accountKey)}
										/>
									) : (
										<QuotaPendingRow
											accountKey={accountKey}
											shortName={shortName}
											displayName={helpers.deriveDisplayName(accountKey)}
											testIdPrefix={testIdPrefix}
											agentCount={agentCount}
											providerLabel={config.providerLabel}
											theme={theme}
											onShowAgents={onShowAgents}
										/>
									)}
								</div>
							</div>
						);
					})
				) : hiddenVisibleCount > 0 ? (
					<div
						className="flex items-center justify-center h-16 text-sm text-center px-4"
						style={{ color: theme.colors.textDim }}
						data-testid={`${testIdPrefix}-all-hidden`}
					>
						All accounts hidden. Use <strong className="mx-1">Show all</strong> to bring them back.
					</div>
				) : null}
			</div>
		</div>
	);
}

/**
 * Generic over the provider's snapshot type. `memo` drops generics, so the
 * cast restores them for callers.
 */
export const PlanUsagePanel = memo(PlanUsagePanelInner) as typeof PlanUsagePanelInner;
