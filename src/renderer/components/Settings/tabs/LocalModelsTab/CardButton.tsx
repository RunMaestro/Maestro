/**
 * CardButton - the small bordered action button the Library's cards share
 * (Look up, Add to Library, Save, Reset). `primary` marks the one action that
 * commits the card.
 */

import type { LucideIcon } from 'lucide-react';

import type { Theme } from '../../../../types';

export interface CardButtonProps {
	theme: Theme;
	icon: LucideIcon;
	label: string;
	onClick: () => void;
	disabled: boolean;
	primary?: boolean;
	testId: string;
}

export function CardButton({
	theme,
	icon: Icon,
	label,
	onClick,
	disabled,
	primary = false,
	testId,
}: CardButtonProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="px-2 py-1 rounded border text-xs flex items-center gap-1.5 disabled:opacity-50"
			style={{
				borderColor: primary ? theme.colors.accent : theme.colors.border,
				backgroundColor: primary ? theme.colors.accentDim : 'transparent',
				color: theme.colors.textMain,
			}}
			data-testid={testId}
		>
			<Icon className="w-3 h-3" />
			{label}
		</button>
	);
}
