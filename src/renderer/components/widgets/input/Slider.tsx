/**
 * Slider
 *
 * Themed, controlled wrapper around a native `<input type="range">`, and the
 * proof that the `InputWidgetProps<T>` contract works end to end.
 *
 * Two shapes, one component:
 *
 * - **Continuous.** Pass `min` / `max` / `step` and optionally `formatValue`.
 *   The read-out shows the formatted number.
 * - **Discrete, with named stops.** Pass `tickLabels`. The track then runs from
 *   0 to `tickLabels.length - 1` in whole steps, the read-out shows the current
 *   stop's name, and the names are drawn beneath the track so the user can see
 *   what they are sliding between before they slide. Reach for this whenever
 *   the underlying value is an ordered vocabulary rather than a quantity; the
 *   ladder is the reason it is a slider and not a row of buttons, and the
 *   labels are what stop it reading as a meaningless 0-3.
 *
 * Theme-aware (accent-colored track), accessible (label wired to the input, the
 * value announced via `aria-valuetext`), and fully controlled.
 */

import { memo, useId } from 'react';
import type { InputWidgetProps, SliderValue } from './types';

interface SliderProps extends InputWidgetProps<SliderValue> {
	/** Minimum value. Defaults to 0. */
	min?: number;
	/**
	 * Maximum value. Defaults to `tickLabels.length - 1` when `tickLabels` is
	 * given, otherwise 100, so a labelled slider cannot end up with more stops
	 * than names.
	 */
	max?: number;
	/** Step increment (default 1). */
	step?: number;
	/**
	 * Names for each stop, in ladder order. Turns the slider discrete: it also
	 * supplies the default `max` and the default read-out.
	 */
	tickLabels?: string[];
	/** Formatter for the value read-out. Defaults to the stop's name when `tickLabels` is set, otherwise the raw number. */
	formatValue?: (value: SliderValue) => string;
}

export const Slider = memo(function Slider({
	theme,
	value,
	onChange,
	disabled = false,
	label,
	min = 0,
	max,
	step = 1,
	tickLabels,
	formatValue,
}: SliderProps) {
	const inputId = useId();
	const hasTicks = Array.isArray(tickLabels) && tickLabels.length > 1;
	const resolvedMax = max ?? (hasTicks ? tickLabels.length - 1 : 100);

	const display = formatValue
		? formatValue(value)
		: hasTicks
			? (tickLabels[value] ?? String(value))
			: String(value);

	return (
		<div className="flex flex-col gap-1.5" style={{ opacity: disabled ? 0.5 : 1 }}>
			{label && (
				<div className="flex items-center justify-between gap-2">
					<label
						htmlFor={inputId}
						className="text-xs-plus font-medium uppercase tracking-wide"
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
				max={resolvedMax}
				step={step}
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(Number(e.target.value))}
				className="focus-ring rounded w-full cursor-pointer disabled:cursor-not-allowed"
				style={{ accentColor: theme.colors.accent }}
				aria-label={label}
				aria-valuetext={display}
			/>
			{hasTicks && (
				/* Presentational only. The stops are already reachable through the
				   input itself, so these carry aria-hidden rather than becoming a
				   second, silent set of controls in the tab order. */
				<div className="flex justify-between text-2xs" aria-hidden="true">
					{tickLabels.map((tick, index) => (
						<span
							key={tick}
							className={index === value ? 'font-semibold' : 'opacity-55'}
							style={index === value ? { color: theme.colors.accent } : undefined}
						>
							{tick}
						</span>
					))}
				</div>
			)}
		</div>
	);
});

export default Slider;
