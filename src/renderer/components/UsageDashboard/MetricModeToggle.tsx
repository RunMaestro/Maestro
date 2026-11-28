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
import { Spinner } from '../ui/Spinner';
import { formatDurationHuman, formatNumber, formatTokensCompact } from '../../../shared/formatters';

/** Measures a dashboard chart can plot. Not every chart supports every mode. */
export type ChartMetricMode = 'count' | 'duration' | 'tokens';

/**
 * Every mode the toggle can offer. `average` (mean time per query) is kept out
 * of {@link ChartMetricMode} because only a per-entity comparison can plot it:
 * a day or hour series has no meaningful "average" to stack.
 */
export type MetricToggleMode = ChartMetricMode | 'average';

/** Default button labels. Charts that read better with other wording override these. */
const DEFAULT_LABELS: Record<MetricToggleMode, string> = {
	count: 'Count',
	duration: 'Duration',
	tokens: 'Tokens',
	average: 'Avg',
};

/** The labels the Overview's charts share, so one tab never words a mode two ways. */
export const OVERVIEW_METRIC_LABELS: Partial<Record<MetricToggleMode, string>> = {
	count: 'Queries',
	duration: 'Time',
	tokens: 'Tokens',
	average: 'Avg Time',
};

/**
 * Accessible names, kept independent of the visible label so a two-character
 * button ("Time") still announces what it does. These match the names the
 * hand-rolled toggles used before they were consolidated here.
 */
const ARIA_LABELS: Record<MetricToggleMode, string> = {
	count: 'Show query count',
	duration: 'Show total duration',
	tokens: 'Show token usage',
	average: 'Show average time per query',
};

const DEFAULT_MODES: MetricToggleMode[] = ['count', 'duration', 'tokens'];

interface MetricModeToggleProps<M extends MetricToggleMode> {
	mode: M;
	onChange: (mode: M) => void;
	theme: Theme;
	/** Modes to offer, in order. Defaults to count + duration + tokens. */
	modes?: M[];
	/** Per-mode label overrides (e.g. `{ count: 'Queries', duration: 'Time' }`). */
	labels?: Partial<Record<MetricToggleMode, string>>;
	/** Show a loading hint on the Tokens button while the series is being derived. */
	tokensLoading?: boolean;
	/**
	 * Two selected-state treatments already existed across the dashboard: the
	 * trend charts fill the active segment with the accent color (`solid`), while
	 * the heatmap and delegation trend charts tint it (`subtle`). Both are
	 * kept so adopting this component doesn't restyle existing charts.
	 */
	variant?: 'solid' | 'subtle';
}

function MetricModeToggleInner<M extends MetricToggleMode>({
	mode,
	onChange,
	theme,
	modes = DEFAULT_MODES as M[],
	labels,
	tokensLoading = false,
	variant = 'solid',
}: MetricModeToggleProps<M>) {
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
							{busy ? (
								<span className="inline-flex items-center gap-1">
									<Spinner size={10} color={activeFg} ariaLabel="Deriving token usage" />
									{label}
								</span>
							) : (
								label
							)}
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** Generic over the modes a chart offers, so `onChange` hands back the chart's own mode type. */
export const MetricModeToggle = memo(MetricModeToggleInner) as typeof MetricModeToggleInner;

/**
 * Format a value for the given metric mode - used for axis ticks, tooltips, and
 * summary figures so a chart never shows raw milliseconds or an unabbreviated
 * nine-digit token count.
 */
export function formatMetricValue(mode: MetricToggleMode, value: number): string {
	if (mode === 'duration' || mode === 'average') return formatDurationHuman(value);
	if (mode === 'tokens') return formatTokensCompact(value);
	return formatNumber(value);
}

/** Human noun for a metric mode, for aria-labels and tooltip rows. */
export function metricModeNoun(mode: MetricToggleMode): string {
	if (mode === 'duration') return 'time';
	if (mode === 'average') return 'average time per query';
	if (mode === 'tokens') return 'tokens';
	return 'queries';
}
