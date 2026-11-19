/**
 * ToggleChipGroup - a wrapping row of independent on/off chips: pick any
 * number of options ("Days: [Mon][Tue][Wed]", "Checks: [lint][types][tests]").
 *
 * The multi-select counterpart to `SegmentedControl`, which is one-of-many
 * (`role="radiogroup"`). Each chip here is its own toggle button
 * (`aria-pressed`), so every chip is a tab stop and Space/Enter flips it, the
 * way a set of checkboxes behaves.
 *
 * Usage:
 * ```tsx
 * <ToggleChipGroup
 *   selected={days}
 *   onChange={setDays}
 *   options={[{ value: 'mon', label: 'Mon' }, { value: 'tue', label: 'Tue' }]}
 *   theme={theme}
 *   ariaLabel="Run on days"
 *   testId="schedule-days"
 * />
 * ```
 *
 * `onChange` receives the new selection in OPTION order, not click order, so a
 * value serialized from it is stable no matter which chip was clicked first.
 */

import type { Theme } from '../../types';

export interface ToggleChipOption<T extends string> {
	value: T;
	label: string;
	/** Tooltip text. */
	title?: string;
}

export interface ToggleChipGroupProps<T extends string> {
	/** The chips that are on. Values not in `options` are kept and ignored. */
	selected: ReadonlyArray<T>;
	onChange: (selected: T[]) => void;
	options: ReadonlyArray<ToggleChipOption<T>>;
	theme: Theme;
	/** Accessible label for the group. */
	ariaLabel: string;
	/** Draws the chips in the error color, for a selection that fails validation. */
	invalid?: boolean;
	disabled?: boolean;
	/** Test id for the container. Each chip gets `${testId}-${option.value}`. */
	testId?: string;
}

export function ToggleChipGroup<T extends string>({
	selected,
	onChange,
	options,
	theme,
	ariaLabel,
	invalid = false,
	disabled = false,
	testId,
}: ToggleChipGroupProps<T>) {
	const toggle = (value: T) => {
		const on = new Set<T>(selected);
		if (on.has(value)) on.delete(value);
		else on.add(value);
		const ordered = options.map((option) => option.value).filter((v) => on.has(v));
		// Keep any selected value the options do not list, after the listed ones,
		// so a toggle never silently drops part of a stored answer.
		const unlisted = selected.filter((v) => !options.some((option) => option.value === v));
		onChange([...ordered, ...unlisted]);
	};

	return (
		<div
			className="flex flex-wrap gap-1.5"
			role="group"
			aria-label={ariaLabel}
			aria-invalid={invalid || undefined}
			data-testid={testId}
		>
			{options.map((option) => {
				const isOn = selected.includes(option.value);
				const edge = invalid
					? theme.colors.error
					: isOn
						? theme.colors.accent
						: theme.colors.border;
				return (
					<button
						key={option.value}
						type="button"
						onClick={() => toggle(option.value)}
						disabled={disabled}
						aria-pressed={isOn}
						title={option.title}
						className={`px-2 py-1 rounded text-xs transition-colors ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'}`}
						style={{
							border: `1px solid ${edge}`,
							backgroundColor: isOn ? `${theme.colors.accent}22` : 'transparent',
							color: isOn ? theme.colors.textMain : theme.colors.textDim,
						}}
						data-testid={testId ? `${testId}-${option.value}` : undefined}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

export default ToggleChipGroup;
