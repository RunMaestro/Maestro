import React, { memo, useMemo, useCallback } from 'react';
import { Calendar } from 'lucide-react';
import type { Theme } from '../../types';
import { LOOKBACK_OPTIONS } from './historyConstants';

export interface LookbackSelectorProps {
	/** Current lookback in hours, or null for "all time" */
	lookbackHours: number | null;
	/** Called when the user selects a new lookback period */
	onLookbackChange: (hours: number | null) => void;
	theme: Theme;
	/** Whether the control is disabled */
	disabled?: boolean;
}

/**
 * Compact discrete slider for selecting a lookback period.
 * Snaps to the predefined LOOKBACK_OPTIONS values.
 */
export const LookbackSelector = memo(function LookbackSelector({
	lookbackHours,
	onLookbackChange,
	theme,
	disabled = false,
}: LookbackSelectorProps) {
	// Find the current index in LOOKBACK_OPTIONS
	const currentIndex = useMemo(() => {
		const idx = LOOKBACK_OPTIONS.findIndex((o) => o.hours === lookbackHours);
		return idx >= 0 ? idx : 0;
	}, [lookbackHours]);

	const currentLabel = LOOKBACK_OPTIONS[currentIndex].label;

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const idx = Number(e.target.value);
			const option = LOOKBACK_OPTIONS[idx];
			if (option) {
				onLookbackChange(option.hours);
			}
		},
		[onLookbackChange]
	);

	const fillPercent = (currentIndex / (LOOKBACK_OPTIONS.length - 1)) * 100;

	return (
		<div className="flex items-center gap-2 flex-shrink-0 min-w-[160px]">
			<Calendar className="w-3 h-3 flex-shrink-0" style={{ color: theme.colors.textDim }} />
			<input
				type="range"
				min={0}
				max={LOOKBACK_OPTIONS.length - 1}
				step={1}
				value={currentIndex}
				onChange={handleChange}
				disabled={disabled}
				className="flex-1 h-1.5 rounded-lg appearance-none cursor-pointer"
				style={{
					background: `linear-gradient(to right, ${theme.colors.accent} 0%, ${theme.colors.accent} ${fillPercent}%, ${theme.colors.bgActivity} ${fillPercent}%, ${theme.colors.bgActivity} 100%)`,
					opacity: disabled ? 0.5 : 1,
				}}
			/>
			<span
				className="text-[10px] font-bold whitespace-nowrap min-w-[52px] text-right"
				style={{ color: theme.colors.textMain }}
			>
				{currentLabel}
			</span>
		</div>
	);
});
