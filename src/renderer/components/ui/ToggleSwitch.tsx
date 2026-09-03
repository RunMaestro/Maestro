import React from 'react';
import { transparentize } from '../../../shared/colorContrast';
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
	/** Optional native tooltip text */
	title?: string;
	/** Whether the toggle is disabled */
	disabled?: boolean;
	/**
	 * The switch is mid-flight: renders a spinner in place of the knob, dims the
	 * track, marks the control aria-busy, and refuses input until it settles.
	 */
	busy?: boolean;
	/**
	 * Overrides the checked-state track color. Defaults to the theme accent; pass
	 * a color only when the surrounding surface gives "on" its own meaning (the
	 * LIVE panel is green because everything else in it is).
	 */
	activeColor?: string;
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
	title,
	disabled = false,
	busy = false,
	activeColor,
}: ToggleSwitchProps): React.ReactElement {
	const isBlocked = disabled || busy;
	const onColor = activeColor ?? theme.colors.accent;
	const trackColor = busy
		? transparentize(onColor, theme.colors.bgActivity, 0.4)
		: checked
			? onColor
			: theme.colors.bgActivity;

	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				if (!isBlocked) onChange(!checked);
			}}
			className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
				busy
					? 'cursor-wait animate-pulse'
					: disabled
						? 'opacity-50 cursor-not-allowed'
						: 'cursor-pointer'
			}`}
			style={{ backgroundColor: trackColor }}
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabel}
			aria-busy={busy || undefined}
			title={title}
			disabled={isBlocked}
		>
			<span
				className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
					checked ? 'translate-x-5' : 'translate-x-0.5'
				} ${busy ? 'opacity-0' : ''}`}
			/>
			{busy && (
				<span className="absolute inset-0 flex items-center justify-center">
					<span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
				</span>
			)}
		</button>
	);
}
