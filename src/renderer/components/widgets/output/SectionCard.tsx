/**
 * SectionCard
 *
 * Part of the shared output-widget library: theme-aware, presentational-only
 * (no IPC, no store reads), independent of any Encore flag. A titled content
 * card used to frame a widget block (and, later, narrative sections): a title
 * row with an optional lucide icon and accent color, an optional right-aligned
 * action slot, and a body provided via `children`.
 */

import { memo, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { WidgetProps } from '../types';

interface SectionCardProps extends WidgetProps {
	/** Card title shown in the header row. */
	title: string;
	/** Optional lucide icon rendered before the title. */
	icon?: LucideIcon;
	/** Optional accent color for the icon. Defaults to the theme accent. */
	accent?: string;
	/** Optional right-aligned content in the title row (e.g. a count badge). */
	action?: ReactNode;
	/** Card body. */
	children: ReactNode;
	/** Optional extra classes for the outer card. */
	className?: string;
}

export const SectionCard = memo(function SectionCard({
	theme,
	title,
	icon: Icon,
	accent,
	action,
	children,
	className,
}: SectionCardProps) {
	const accentColor = accent ?? theme.colors.accent;
	return (
		<section
			className={`rounded-lg border overflow-hidden ${className ?? ''}`}
			style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
		>
			<div
				className="flex items-center gap-2 px-4 py-2.5 border-b"
				style={{ borderColor: theme.colors.border }}
			>
				{Icon && (
					<Icon className="w-4 h-4 shrink-0" style={{ color: accentColor }} aria-hidden="true" />
				)}
				<h3
					className="text-xs font-bold uppercase tracking-wide truncate"
					style={{ color: theme.colors.textMain }}
				>
					{title}
				</h3>
				{action && <div className="ml-auto shrink-0">{action}</div>}
			</div>
			<div className="p-4">{children}</div>
		</section>
	);
});

export default SectionCard;
