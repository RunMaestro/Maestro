/**
 * LocationDistributionChart ("Query Location")
 *
 * Donut showing how many of the range's queries ran locally vs on an SSH
 * remote. The Overview draws it only when at least one query ran remotely: for
 * everyone else it would be a permanent 100% Local ring.
 */

import { memo, useMemo } from 'react';
import type { Theme } from '../../types';
import type { StatsAggregation } from '../../hooks/stats/useStats';
import { COLORBLIND_BINARY_PALETTE } from '../../constants/colorblindPalettes';
import { formatNumber } from '../../../shared/formatters';
import { DistributionDonut, type DonutSliceDatum } from './DistributionDonut';
import { accentBrightness } from './delegationColors';

interface LocationDistributionChartProps {
	/** Aggregated stats data from the API */
	data: StatsAggregation;
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
}

/** An emerald that contrasts with the accent (which colors Local). */
function remoteColor(theme: Theme): string {
	const brightness = accentBrightness(theme);
	if (brightness === null) return '#22c55e';
	return brightness > 128 ? '#059669' : '#34d399';
}

export const LocationDistributionChart = memo(function LocationDistributionChart({
	data,
	theme,
	colorBlindMode = false,
}: LocationDistributionChartProps) {
	const slices = useMemo(
		(): DonutSliceDatum[] => [
			{
				key: 'local',
				label: 'Local',
				value: data.byLocation?.local ?? 0,
				color: colorBlindMode ? COLORBLIND_BINARY_PALETTE.primary : theme.colors.accent,
			},
			{
				key: 'remote',
				label: 'SSH Remote',
				value: data.byLocation?.remote ?? 0,
				color: colorBlindMode ? COLORBLIND_BINARY_PALETTE.secondary : remoteColor(theme),
			},
		],
		[data.byLocation, theme, colorBlindMode]
	);
	const total = slices.reduce((sum, slice) => sum + slice.value, 0);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label="Query location chart showing queries run locally and on SSH remotes."
		>
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Query Location
				</h3>
			</div>
			{total === 0 ? (
				<div
					className="flex items-center justify-center h-40 text-sm"
					style={{ color: theme.colors.textDim }}
				>
					No queries in this range
				</div>
			) : (
				<DistributionDonut
					slices={slices}
					theme={theme}
					formatValue={formatNumber}
					centerCaption="queries"
					ariaLabel="Query location"
					testId="location-donut"
				/>
			)}
		</div>
	);
});

export default LocationDistributionChart;
