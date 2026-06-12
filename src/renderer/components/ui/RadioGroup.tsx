import React from 'react';
import type { Theme } from '../../types';

export interface RadioOption<T extends string> {
	value: T;
	label: string;
	/** Optional secondary line shown beneath the label */
	description?: string;
	disabled?: boolean;
}

export interface RadioGroupProps<T extends string> {
	value: T;
	onChange: (value: T) => void;
	options: ReadonlyArray<RadioOption<T>>;
	theme: Theme;
	/** Accessible label for the group */
	ariaLabel?: string;
	/** Override the rendered name attribute (defaults to ariaLabel or 'radio-group') */
	name?: string;
}

/**
 * Reusable single-select radio group rendered as themed list rows.
 * Each row is fully clickable with keyboard activation via Space/Enter.
 */
export function RadioGroup<T extends string>({
	value,
	onChange,
	options,
	theme,
	ariaLabel,
	name,
}: RadioGroupProps<T>): React.ReactElement {
	const groupName = name ?? ariaLabel ?? 'radio-group';

	return (
		<div role="radiogroup" aria-label={ariaLabel} className="flex flex-col gap-1.5">
			{options.map((option) => {
				const selected = option.value === value;
				const disabled = option.disabled ?? false;
				return (
					<label
						key={option.value}
						className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
							disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
						}`}
						style={{
							borderColor: selected ? theme.colors.accent : theme.colors.border,
							backgroundColor: selected ? `${theme.colors.accent}14` : theme.colors.bgMain,
						}}
					>
						<input
							type="radio"
							name={groupName}
							value={option.value}
							checked={selected}
							disabled={disabled}
							onChange={() => {
								if (!disabled) onChange(option.value);
							}}
							className="sr-only"
						/>
						<span
							aria-hidden="true"
							className="relative w-4 h-4 mt-0.5 rounded-full flex-shrink-0 transition-colors"
							style={{
								borderWidth: 2,
								borderStyle: 'solid',
								borderColor: selected ? theme.colors.accent : theme.colors.border,
								backgroundColor: theme.colors.bgMain,
							}}
						>
							{selected && (
								<span
									className="absolute inset-0 m-auto w-1.5 h-1.5 rounded-full"
									style={{ backgroundColor: theme.colors.accent }}
								/>
							)}
						</span>
						<span className="flex flex-col min-w-0">
							<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								{option.label}
							</span>
							{option.description && (
								<span className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
									{option.description}
								</span>
							)}
						</span>
					</label>
				);
			})}
		</div>
	);
}
