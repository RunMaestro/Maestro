/**
 * ToggleSwitch - RTL-aware toggle switch component
 *
 * Uses `inset-inline-start` instead of `translateX` for knob positioning,
 * which automatically mirrors in RTL layouts without manual direction checks.
 *
 * Three size presets match the toggle patterns used across the codebase:
 * - sm (36x20): DurationTrendsChart smoothing toggle
 * - md (40x20): EncoreTab feature toggles
 * - lg (48x24): SshRemoteModal enabled toggle
 *
 * When `onChange` is omitted, renders as a non-interactive `<div>` for use
 * inside a parent clickable element (e.g. EncoreTab's feature toggle button).
 */

import type { Theme } from '../../types';

export interface ToggleSwitchProps {
	/** Whether the toggle is in the "on" state */
	checked: boolean;
	/** Click handler. If omitted, renders as a visual-only div (for use inside a parent button). */
	onChange?: () => void;
	/** Theme object for styling */
	theme: Theme;
	/** Size preset */
	size?: 'sm' | 'md' | 'lg';
	/** Track color when checked. Defaults to theme.colors.accent */
	activeColor?: string;
	/** Track color when unchecked. Defaults to theme.colors.border */
	inactiveColor?: string;
	/** Accessible label for the toggle */
	ariaLabel?: string;
	/** Additional CSS classes for the track element */
	className?: string;
}

const SIZES = {
	sm: {
		track: 'w-9 h-5',
		knobClass: 'top-0.5 w-4 h-4',
		offPos: 2,
		onPos: 18,
	},
	md: {
		track: 'w-10 h-5',
		knobClass: 'top-0.5 w-4 h-4',
		offPos: 2,
		onPos: 22,
	},
	lg: {
		track: 'w-12 h-6',
		knobClass: 'top-1 w-4 h-4',
		offPos: 4,
		onPos: 26,
	},
};

export function ToggleSwitch({
	checked,
	onChange,
	theme,
	size = 'md',
	activeColor,
	inactiveColor,
	ariaLabel,
	className = '',
}: ToggleSwitchProps) {
	const s = SIZES[size];

	const trackBg = checked
		? (activeColor ?? theme.colors.accent)
		: (inactiveColor ?? theme.colors.border);

	const knob = (
		<span
			className={`absolute ${s.knobClass} rounded-full bg-white shadow-sm`}
			style={{
				insetInlineStart: checked ? `${s.onPos}px` : `${s.offPos}px`,
				transition: 'inset-inline-start 150ms cubic-bezier(0.4, 0, 0.2, 1)',
			}}
		/>
	);

	if (!onChange) {
		return (
			<div
				className={`relative ${s.track} rounded-full transition-colors ${className}`}
				style={{ backgroundColor: trackBg }}
			>
				{knob}
			</div>
		);
	}

	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={ariaLabel}
			onClick={onChange}
			className={`relative ${s.track} rounded-full transition-colors ${className}`}
			style={{ backgroundColor: trackBg }}
		>
			{knob}
		</button>
	);
}
