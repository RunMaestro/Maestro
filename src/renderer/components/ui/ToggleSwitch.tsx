import React from 'react';
import type { Theme } from '../../types';

export interface ToggleSwitchProps {
	/** Whether the toggle is on */
	checked: boolean;
	/** Callback when the toggle state changes */
	onChange: (checked: boolean) => void;
	/** The current theme */
	theme: Theme;
	/** Optional aria-label for accessibility */
	ariaLabel?: string;
	/** Whether the toggle is disabled */
	disabled?: boolean;
}

/**
 * A reusable toggle switch (pill-style) with consistent styling.
 * Matches the design used in SettingsModal and other toggle UIs.
 */
export function ToggleSwitch({
	checked,
	onChange,
	theme,
	ariaLabel,
	disabled = false,
}: ToggleSwitchProps): React.ReactElement {
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				if (!disabled) onChange(!checked);
			}}
			className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
				disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
			}`}
			style={{
				backgroundColor: checked ? theme.colors.accent : theme.colors.bgActivity,
			}}
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabel}
			disabled={disabled}
		>
			<span
				className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
					checked ? 'translate-x-5' : 'translate-x-0.5'
				}`}
			/>
		</button>
	);
}
