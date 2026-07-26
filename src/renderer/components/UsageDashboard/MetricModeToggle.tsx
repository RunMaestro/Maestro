/**
 * MetricModeToggle
 *
 * The shared "Show: Queries | Time | Tokens" segmented control used by every
 * Usage Dashboard chart that can plot more than one measure. Charts previously
 * hand-rolled this two-button markup individually; centralizing it keeps the
 * labels, colors, and a11y wiring identical across the dashboard and means a new
 * mode only has to be added in one place.
 */

import { memo } from 'react';
import type { Theme } from '../../types';
import { formatDurationHuman, formatNumber, formatTokensCompact } from '../../../shared/formatters';

/** Measures a dashboard chart can plot. Not every chart supports every mode. */
export type ChartMetricMode = 'count' | 'duration' | 'tokens';

/** Default button labels. Charts that read better with other wording override these. */
const DEFAULT_LABELS: Record<ChartMetricMode, string> = {
	count: 'Count',
	duration: 'Duration',
	tokens: 'Tokens',
};

/**
 * Accessible names, kept independent of the visible label so a two-character
 * button ("Time") still announces what it does. These match the names the
 * hand-rolled toggles used before they were consolidated here.
 */
const ARIA_LABELS: Record<ChartMetricMode, string> = {
	count: 'Show query count',
	duration: 'Show total duration',
	tokens: 'Show token usage',
};

interface MetricModeToggleProps {
	mode: ChartMetricMode;
	onChange: (mode: ChartMetricMode) => void;
	theme: Theme;
	/** Modes to offer, in order. Defaults to count + duration + tokens. */
	modes?: ChartMetricMode[];
	/** Per-mode label overrides (e.g. `{ count: 'Queries', duration: 'Time' }`). */
	labels?: Partial<Record<ChartMetricMode, string>>;
	/** Show a loading hint on the Tokens button while the series is being derived. */
	tokensLoading?: boolean;
	/**
	 * Two selected-state treatments already existed across the dashboard: the
	 * trend charts fill the active segment with the accent color (`solid`), while
	 * the heatmap / distribution / peak-hours charts tint it (`subtle`). Both are
	 * kept so adopting this component doesn't restyle existing charts.
	 */
	variant?: 'solid' | 'subtle';
}

export const MetricModeToggle = memo(function MetricModeToggle({
	mode,
	onChange,
	theme,
	modes = ['count', 'duration', 'tokens'],
	labels,
	tokensLoading = false,
	variant = 'solid',
}: MetricModeToggleProps) {
	return (
		<div className="flex items-center gap-2">
			<span className="text-xs" style={{ color: theme.colors.textDim }}>
				Show:
			</span>
			<div
				className="flex rounded overflow-hidden border"
				style={{ borderColor: theme.colors.border }}
				role="group"
				aria-label="Chart metric"
			>
				{modes.map((m, i) => {
					const active = mode === m;
					const label = labels?.[m] ?? DEFAULT_LABELS[m];
					const activeBg = variant === 'solid' ? theme.colors.accent : `${theme.colors.accent}20`;
					const activeFg = variant === 'solid' ? theme.colors.bgMain : theme.colors.accent;
					// The token series is derived lazily on first request, so the button
					// reports that work instead of looking inert.
					const busy = m === 'tokens' && active && tokensLoading;
					return (
						<button
							key={m}
							type="button"
							onClick={() => onChange(m)}
							className="px-2 py-1 text-xs transition-colors"
							style={{
								backgroundColor: active ? activeBg : 'transparent',
								color: active ? activeFg : theme.colors.textDim,
								// The subtle variant relies on dividers to read as a segmented
								// control, since its inactive segments have no fill.
								borderLeft:
									variant === 'subtle' && i > 0 ? `1px solid ${theme.colors.border}` : undefined,
							}}
							aria-pressed={active}
							aria-label={ARIA_LABELS[m]}
							data-testid={`metric-mode-${m}`}
						>
							{busy ? `${label}…` : label}
						</button>
					);
				})}
			</div>
		</div>
	);
});

/**
 * Format a value for the given metric mode - used for axis ticks, tooltips, and
 * summary figures so a chart never shows raw milliseconds or an unabbreviated
 * nine-digit token count.
 */
export function formatMetricValue(mode: ChartMetricMode, value: number): string {
	if (mode === 'duration') return formatDurationHuman(value);
	if (mode === 'tokens') return formatTokensCompact(value);
	return formatNumber(value);
}

/** Human noun for a metric mode, for aria-labels and tooltip rows. */
export function metricModeNoun(mode: ChartMetricMode): string {
	if (mode === 'duration') return 'time';
	if (mode === 'tokens') return 'tokens';
	return 'queries';
}
