import React from 'react';
import type { Theme } from '../types';
import type { LucideIcon } from 'lucide-react';
import { ToggleSwitch } from './ui/ToggleSwitch';

export interface SettingCheckboxProps {
	/** The icon to display next to the section label */
	icon: LucideIcon;
	/** The section label shown above the checkbox */
	sectionLabel: string;
	/** The main title text shown next to the checkbox */
	title: string;
	/** Optional description text shown below the title */
	description?: string;
	/** Whether the checkbox is checked */
	checked: boolean;
	/** Callback when the checkbox state changes */
	onChange: (checked: boolean) => void;
	/** The current theme */
	theme: Theme;
}

/**
 * A reusable toggle component for settings with a consistent layout:
 * - Section label with icon
 * - Clickable container with title, description, and toggle switch on the right
 */
export function SettingCheckbox({
	icon: Icon,
	sectionLabel,
	title,
	description,
	checked,
	onChange,
	theme,
}: SettingCheckboxProps): React.ReactElement {
	return (
		<div>
			<label className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
				<Icon className="w-3 h-3" />
				{sectionLabel}
			</label>
			<div
				className="flex items-center justify-between p-3 rounded border cursor-pointer hover:bg-opacity-10"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				onClick={() => onChange(!checked)}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						onChange(!checked);
					}
				}}
			>
				<div className="flex-1 pr-3">
					<div className="font-medium" style={{ color: theme.colors.textMain }}>
						{title}
					</div>
					{description && (
						<div className="text-xs opacity-50 mt-0.5" style={{ color: theme.colors.textDim }}>
							{description}
						</div>
					)}
				</div>
				<ToggleSwitch checked={checked} onChange={onChange} theme={theme} ariaLabel={title} />
			</div>
		</div>
	);
}
