/**
 * Presentational building blocks shared by the provider quota panels
 * (`ClaudePlanUsage`, `CodexPlanUsage`). Each piece is provider-agnostic and
 * parameterized only by labels / `data-testid` prefixes, so the two panels
 * stay pixel-identical without copy-pasting markup.
 */

import { memo } from 'react';
import { ChevronDown, Clock, Eye, EyeOff, Loader2, RefreshCw } from 'lucide-react';
import type { Theme } from '../../../types';
import { formatFutureTime } from '../../../../shared/formatters';
import { QUOTA_REFRESH_OPTIONS, resolveQuotaFillColor } from './quotaFormatting';

interface QuotaBarRowProps {
	label: string;
	percent: number;
	/** Optional - Codex windows can omit a reset time; Claude always supplies one. */
	resetsAt?: string;
	theme: Theme;
}

/**
 * One horizontal usage bar: label, fill (color-coded by threshold), inside or
 * trailing percent text, and a reset-time caption. Percent is clamped 0-100.
 */
export const QuotaBarRow = memo(function QuotaBarRow({
	label,
	percent,
	resetsAt,
	theme,
}: QuotaBarRowProps) {
	const clampedPercent = Math.min(100, Math.max(0, percent));
	const fillColor = resolveQuotaFillColor(clampedPercent, theme);
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
				title={resetsAt ? `Resets at ${new Date(resetsAt).toLocaleString()}` : undefined}
			>
				{resetsAt ? `resets ${formatFutureTime(resetsAt)}` : 'reset unknown'}
			</div>
		</div>
	);
});

/** Rounded account-name chip; `accountKey` becomes the hover title. */
export const QuotaAccountPill = memo(function QuotaAccountPill({
	accountKey,
	displayName,
	theme,
}: {
	accountKey: string;
	displayName: string;
	theme: Theme;
}) {
	return (
		<span
			className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium"
			style={{
				color: theme.colors.accent,
				backgroundColor: `${theme.colors.accent}15`,
				border: `1px solid ${theme.colors.accent}35`,
			}}
			title={accountKey}
		>
			{displayName}
		</span>
	);
});

/**
 * "No snapshot cached yet - hit Refresh" body for a configured-but-unsampled
 * account. `testIdPrefix` keeps each provider's testids distinct
 * (`claude-plan` / `codex-plan`).
 */
export const QuotaPendingRow = memo(function QuotaPendingRow({
	accountKey,
	shortName,
	displayName,
	testIdPrefix,
	theme,
}: {
	accountKey: string;
	shortName: string;
	displayName: string;
	testIdPrefix: string;
	theme: Theme;
}) {
	return (
		<div className="space-y-2" data-testid={`${testIdPrefix}-row-${shortName}-pending`}>
			<div className="flex items-center gap-2">
				<QuotaAccountPill accountKey={accountKey} displayName={displayName} theme={theme} />
				<div className="text-xs" style={{ color: theme.colors.textDim, opacity: 0.7 }}>
					{accountKey}
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
	);
});

/** Auto-refresh interval dropdown + manual Refresh button with sampling sweep. */
export const QuotaRefreshControls = memo(function QuotaRefreshControls({
	theme,
	refreshIntervalMs,
	onChangeInterval,
	onRefresh,
	isBusy,
	testIdPrefix,
	sweepClassName,
	intervalAriaLabel,
	buttonAriaLabel,
}: {
	theme: Theme;
	refreshIntervalMs: number;
	onChangeInterval: (ms: number) => void;
	onRefresh: () => void;
	isBusy: boolean;
	testIdPrefix: string;
	/** CSS animation class for the in-flight sweep (per-provider keyframe alias). */
	sweepClassName: string;
	intervalAriaLabel: string;
	buttonAriaLabel: string;
}) {
	return (
		<div className="flex flex-wrap items-center justify-end gap-2">
			<label className="relative flex items-center">
				<Clock
					className="w-3.5 h-3.5 absolute left-2.5 pointer-events-none"
					style={{ color: theme.colors.textDim }}
				/>
				<select
					value={refreshIntervalMs}
					onChange={(event) => onChangeInterval(Number(event.target.value))}
					className="pl-8 pr-7 py-1.5 rounded text-xs border cursor-pointer outline-none appearance-none"
					style={{
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
					aria-label={intervalAriaLabel}
					data-testid={`${testIdPrefix}-refresh-interval`}
				>
					{QUOTA_REFRESH_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							Auto refresh: {option.label}
						</option>
					))}
				</select>
				<ChevronDown
					className="absolute right-2 w-3 h-3 pointer-events-none"
					style={{ color: theme.colors.textDim }}
					aria-hidden="true"
				/>
			</label>
			<button
				type="button"
				onClick={onRefresh}
				disabled={isBusy}
				className="relative flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:cursor-not-allowed overflow-hidden"
				style={{
					color: isBusy ? theme.colors.bgMain : theme.colors.accent,
					backgroundColor: isBusy ? theme.colors.accent : `${theme.colors.accent}15`,
					border: `1px solid ${theme.colors.accent}40`,
					// Floor just wide enough for the wider "Sampling..." state so the
					// button doesn't resize between states; justify-center keeps the
					// narrower "Refresh" content from drifting against the right edge.
					minWidth: '6.75rem',
				}}
				data-testid={`${testIdPrefix}-refresh`}
				aria-label={buttonAriaLabel}
				aria-busy={isBusy}
			>
				{isBusy ? (
					<>
						<span
							className={`absolute inset-0 pointer-events-none ${sweepClassName}`}
							style={{
								backgroundImage: `linear-gradient(90deg, transparent 0%, ${theme.colors.bgMain}66 50%, transparent 100%)`,
							}}
							aria-hidden="true"
						/>
						<Loader2 className="w-3.5 h-3.5 animate-spin relative" aria-hidden="true" />
						<span className="relative">Sampling...</span>
					</>
				) : (
					<>
						<RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
						<span>Refresh</span>
					</>
				)}
			</button>
		</div>
	);
});

/**
 * Per-account hide/show toggle shown in the top-right of each row when the panel
 * lists every account (`showAllAccounts`). Eye-off = currently visible (click to
 * hide); Eye = currently hidden (click to bring back). The hidden set persists
 * across sessions via `uiStore.toggleHiddenQuotaAccount`.
 */
export const QuotaVisibilityToggle = memo(function QuotaVisibilityToggle({
	theme,
	hidden,
	shortName,
	testIdPrefix,
	onToggle,
}: {
	theme: Theme;
	hidden: boolean;
	shortName: string;
	testIdPrefix: string;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			className="flex items-center justify-center w-6 h-6 rounded transition-colors flex-shrink-0"
			style={{
				color: theme.colors.textDim,
				backgroundColor: `${theme.colors.border}55`,
				border: `1px solid ${theme.colors.border}`,
			}}
			data-testid={`${testIdPrefix}-visibility-${shortName}`}
			aria-pressed={hidden}
			title={hidden ? 'Show this account' : 'Hide this account'}
			aria-label={hidden ? `Show account ${shortName}` : `Hide account ${shortName}`}
		>
			{hidden ? (
				<Eye className="w-3.5 h-3.5" aria-hidden="true" />
			) : (
				<EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
			)}
		</button>
	);
});

/**
 * Header "Show All" toggle. Only mounts when at least one account is hidden;
 * pressing it reveals the hidden rows (dimmed, with their own Eye toggle) so the
 * user can bring any back. Pressing again re-collapses to visible-only.
 */
export const QuotaShowAllToggle = memo(function QuotaShowAllToggle({
	theme,
	hiddenCount,
	revealing,
	testIdPrefix,
	onToggle,
}: {
	theme: Theme;
	hiddenCount: number;
	revealing: boolean;
	testIdPrefix: string;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors"
			style={{
				color: revealing ? theme.colors.bgMain : theme.colors.textDim,
				backgroundColor: revealing ? theme.colors.accent : `${theme.colors.border}55`,
				border: `1px solid ${revealing ? `${theme.colors.accent}40` : theme.colors.border}`,
			}}
			data-testid={`${testIdPrefix}-show-all`}
			aria-pressed={revealing}
			title={
				revealing ? 'Collapse back to visible accounts' : 'Reveal hidden accounts to unhide them'
			}
		>
			{revealing ? (
				<EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
			) : (
				<Eye className="w-3.5 h-3.5" aria-hidden="true" />
			)}
			<span>{revealing ? 'Hide hidden' : `Show all (${hiddenCount})`}</span>
		</button>
	);
});

/** Per-tab status dot state. `warning` = needs attention, `pending` = unsampled. */
export type QuotaTabStatus = 'warning' | 'pending' | 'none';

/**
 * Horizontal account selector tab bar. The status dot logic is provider-specific
 * (what counts as a "warning" differs), so the panel supplies `getTabStatus`
 * and the `warningTitle` tooltip.
 */
export const QuotaAccountTabs = memo(function QuotaAccountTabs({
	theme,
	accountKeys,
	effectiveSelectedKey,
	onSelect,
	testIdPrefix,
	ariaLabel,
	warningTitle,
	deriveShortName,
	deriveDisplayName,
	getTabStatus,
}: {
	theme: Theme;
	accountKeys: string[];
	effectiveSelectedKey: string | null;
	onSelect: (key: string) => void;
	testIdPrefix: string;
	ariaLabel: string;
	warningTitle: string;
	deriveShortName: (key: string | undefined) => string;
	deriveDisplayName: (key: string | undefined) => string;
	getTabStatus: (key: string) => QuotaTabStatus;
}) {
	return (
		<div
			className="flex items-center gap-1 mb-4 border-b"
			style={{ borderColor: theme.colors.border }}
			role="tablist"
			aria-label={ariaLabel}
			data-testid={`${testIdPrefix}-account-tabs`}
		>
			{accountKeys.map((key) => {
				const shortName = deriveShortName(key);
				const isActive = effectiveSelectedKey === key;
				const status = getTabStatus(key);
				return (
					<button
						key={key}
						type="button"
						role="tab"
						aria-selected={isActive}
						onClick={() => onSelect(key)}
						className="px-3 py-1.5 text-sm font-medium transition-colors relative -mb-px"
						style={{
							color: isActive ? theme.colors.accent : theme.colors.textDim,
							borderBottom: `2px solid ${isActive ? theme.colors.accent : 'transparent'}`,
						}}
						title={key}
						data-testid={`${testIdPrefix}-tab-${shortName}`}
					>
						<span className="flex items-center gap-1.5">
							{deriveDisplayName(key)}
							{/* Status dot:
							    - warning = provider-specific "needs attention"
							    - pending = no snapshot yet, hit Refresh
							    - none    = snapshot present + healthy */}
							{status === 'warning' ? (
								<span
									className="text-[10px]"
									style={{ color: theme.colors.warning ?? theme.colors.accent }}
									title={warningTitle}
								>
									●
								</span>
							) : status === 'pending' ? (
								<span
									className="text-[10px]"
									style={{ color: theme.colors.textDim, opacity: 0.6 }}
									title="No snapshot yet - hit Refresh"
								>
									○
								</span>
							) : null}
						</span>
					</button>
				);
			})}
		</div>
	);
});
