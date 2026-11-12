/**
 * LaunchCheckbox - a labeled checkbox row for the launch dialog.
 *
 * The confirmation a security-sensitive playbook asks for, and "Save as a reusable playbook".
 * A native checkbox in the theme's accent color, so keyboard and screen reader behavior come
 * from the browser; the label (and the optional help under it) is the click target.
 */

import { useId } from 'react';
import type { Theme } from '../../../types';

export interface LaunchCheckboxProps {
	theme: Theme;
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
	/** A line under the label that says what ticking it does. */
	help?: string;
	disabled?: boolean;
	testId?: string;
}

export function LaunchCheckbox({
	theme,
	checked,
	onChange,
	label,
	help,
	disabled = false,
	testId,
}: LaunchCheckboxProps) {
	const helpId = useId();
	return (
		<label
			className={`flex items-start gap-2 text-xs ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
			style={{ color: theme.colors.textMain }}
			data-testid={testId}
		>
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
				disabled={disabled}
				aria-describedby={help ? helpId : undefined}
				className="mt-0.5 shrink-0"
				style={{ accentColor: theme.colors.accent }}
			/>
			<span className="min-w-0">
				<span className="select-text">{label}</span>
				{help && (
					<span
						id={helpId}
						className="block mt-0.5 select-text"
						style={{ color: theme.colors.textDim }}
					>
						{help}
					</span>
				)}
			</span>
		</label>
	);
}
