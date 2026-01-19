import React, { memo } from 'react';
import type { Theme } from '../types';

export interface ToggleButtonOption<T extends string | number> {
	value: T;
	label?: string;
	/** Custom active background color (defaults to theme.colors.accentDim) */
	activeColor?: string;
	/** Custom ring color when active (defaults to theme.colors.accent or activeColor) */
	ringColor?: string;
	/** Custom text color when active (defaults to theme.colors.textMain) */
	activeTextColor?: string;
}

interface ToggleButtonGroupProps<T extends string | number> {
	/** Array of options - can be simple values or objects with custom styling */
	options: (T | ToggleButtonOption<T>)[];
	/** Currently selected value */
	value: T;
	/** Callback when selection changes */
	onChange: (value: T) => void;
	/** Theme for styling */
	theme: Theme;
	/** Optional custom labels map (alternative to ToggleButtonOption.label) */
	labels?: Record<string, string>;
}

function ToggleButtonGroupInner<T extends string | number>({
	options,
	value,
	onChange,
	theme,
	labels,
}: ToggleButtonGroupProps<T>) {
	return (
		<div className="flex gap-2">
			{options.map((opt) => {
				// Normalize option to object form
				const option: ToggleButtonOption<T> =
					typeof opt === 'object' && opt !== null && 'value' in opt ? opt : { value: opt as T };

				const optValue = option.value;
				const isActive = value === optValue;

				// Determine display label: option.label > labels map > string value
				let displayLabel: string;
				if (option.label) {
					displayLabel = option.label;
				} else if (labels && String(optValue) in labels) {
					displayLabel = labels[String(optValue)];
				} else {
					displayLabel = String(optValue);
				}

				// Determine colors
				const activeColor = option.activeColor ?? theme.colors.accentDim;
				const ringColor = option.ringColor ?? option.activeColor ?? theme.colors.accent;
				const activeTextColor =
					option.activeTextColor ?? (option.activeColor ? 'white' : theme.colors.textMain);

				return (
					<button
						key={String(optValue)}
						onClick={() => onChange(optValue)}
						className={`flex-1 py-2 px-3 rounded border transition-all ${isActive ? 'ring-2' : ''}`}
						style={
							{
								borderColor: theme.colors.border,
								backgroundColor: isActive ? activeColor : 'transparent',
								'--tw-ring-color': ringColor,
								color: isActive ? activeTextColor : theme.colors.textMain,
							} as React.CSSProperties
						}
					>
						{displayLabel}
					</button>
				);
			})}
		</div>
	);
}

export const ToggleButtonGroup = memo(ToggleButtonGroupInner) as typeof ToggleButtonGroupInner;
