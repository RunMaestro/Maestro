/**
 * Slider
 *
 * Starter input primitive for the shared widget library: a themed, controlled
 * wrapper around a native `<input type="range">`. Minimal but real - it is the
 * proof that the `InputWidgetProps<T>` contract works end to end and the seed
 * for the upcoming dynamic-interface input family.
 *
 * Theme-aware (accent-colored track via the `accent-*` utility plus an inline
 * accent color), accessible (label wired to the input, live value read out), and
 * fully controlled (the parent owns the value and re-renders on change).
 */

import { memo, useId } from 'react';
import type { InputWidgetProps, SliderValue } from './types';

interface SliderProps extends InputWidgetProps<SliderValue> {
	/** Minimum value (default 0). */
	min?: number;
	/** Maximum value (default 100). */
	max?: number;
	/** Step increment (default 1). */
	step?: number;
	/** Optional formatter for the value read-out (defaults to the raw number). */
	formatValue?: (value: SliderValue) => string;
}

export const Slider = memo(function Slider({
	theme,
	value,
	onChange,
	disabled = false,
	label,
	min = 0,
	max = 100,
	step = 1,
	formatValue,
}: SliderProps) {
	const inputId = useId();
	const display = formatValue ? formatValue(value) : String(value);

	return (
		<div className="flex flex-col gap-1.5" style={{ opacity: disabled ? 0.5 : 1 }}>
			{label && (
				<div className="flex items-center justify-between gap-2">
					<label
						htmlFor={inputId}
						className="text-[11px] font-medium uppercase tracking-wide"
						style={{ color: theme.colors.textDim }}
					>
						{label}
					</label>
					<span
						className="text-xs font-semibold tabular-nums"
						style={{ color: theme.colors.textMain }}
						aria-live="polite"
					>
						{display}
					</span>
				</div>
			)}
			<input
				id={inputId}
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(Number(e.target.value))}
				className="focus-ring rounded w-full cursor-pointer disabled:cursor-not-allowed"
				style={{ accentColor: theme.colors.accent }}
				aria-label={label}
				aria-valuetext={display}
			/>
		</div>
	);
});

export default Slider;
