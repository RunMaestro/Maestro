import type { ReactNode } from 'react';
import type { Theme } from '../../../../../types';
import { ToggleSwitch } from '../../../../ui/ToggleSwitch';

interface ToggleSettingRowProps {
	theme: Theme;
	title: ReactNode;
	description?: ReactNode;
	checked: boolean;
	onChange: (checked: boolean) => void;
	ariaLabel?: string;
	borderTop?: boolean;
	clickableRow?: boolean;
	disabled?: boolean;
	className?: string;
	dataSettingId?: string;
}

export function ToggleSettingRow({
	theme,
	title,
	description,
	checked,
	onChange,
	ariaLabel,
	borderTop = false,
	clickableRow = false,
	disabled = false,
	className = '',
	dataSettingId,
}: ToggleSettingRowProps) {
	const toggle = () => {
		if (!disabled) onChange(!checked);
	};

	return (
		<div
			className={`flex items-center justify-between ${borderTop ? 'pt-3 border-t' : ''} ${
				clickableRow ? 'cursor-pointer' : ''
			} ${className}`}
			style={{ borderColor: theme.colors.border }}
			data-setting-id={dataSettingId}
			onClick={clickableRow ? toggle : undefined}
			role={clickableRow ? 'button' : undefined}
			tabIndex={clickableRow ? 0 : undefined}
			onKeyDown={
				clickableRow
					? (event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								toggle();
							}
						}
					: undefined
			}
		>
			<div className="flex-1 pr-3">
				<div className="text-sm" style={{ color: theme.colors.textMain }}>
					{title}
				</div>
				{description && <p className="text-xs opacity-50 mt-0.5">{description}</p>}
			</div>
			<ToggleSwitch
				checked={checked}
				onChange={onChange}
				theme={theme}
				ariaLabel={ariaLabel}
				disabled={disabled}
			/>
		</div>
	);
}
