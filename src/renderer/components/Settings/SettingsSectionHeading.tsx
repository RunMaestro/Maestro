import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface SettingsSectionHeadingProps {
	/** Lucide icon component rendered before the label. Required to enforce consistency. */
	icon: LucideIcon;
	/** Heading label content. */
	children: ReactNode;
}

/**
 * Canonical section heading for panels inside the Settings modal.
 *
 * All section headings use the same typography (uppercase, bold, dim via opacity)
 * and inherit `theme.colors.textMain` — do not override with `textDim` or any
 * other color. Pair every heading with a Lucide icon.
 */
export function SettingsSectionHeading({ icon: Icon, children }: SettingsSectionHeadingProps) {
	return (
		<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
			<Icon className="w-3 h-3" />
			{children}
		</div>
	);
}
