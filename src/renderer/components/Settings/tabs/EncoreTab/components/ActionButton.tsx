/**
 * The small bordered action button used inside an extension's Settings body
 * (Computer History, MaestroRun). One copy, so the two tiles cannot drift.
 */

import type { LucideIcon } from 'lucide-react';
import type { Theme } from '../../../../../types';

export function ActionButton({
	theme,
	icon: Icon,
	label,
	onClick,
	destructive,
	disabled,
}: {
	theme: Theme;
	icon?: LucideIcon;
	label: string;
	onClick: () => void;
	destructive?: boolean;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border disabled:opacity-50"
			style={{
				borderColor: destructive ? theme.colors.error : theme.colors.border,
				color: destructive ? theme.colors.error : theme.colors.textMain,
				backgroundColor: theme.colors.bgActivity,
			}}
		>
			{Icon && <Icon className="w-3.5 h-3.5" />}
			{label}
		</button>
	);
}
