/**
 * ContextMenuHeader - the accent title band at the top of a right-click menu.
 *
 * Names the thing the menu acts on (an agent, a group, a file, a folder). A
 * menu pops away from the row that opened it once it is clamped to the
 * viewport, so without a name the destructive entries at the bottom are
 * unattributed.
 *
 * The band is full-bleed: render it as the FIRST child of the menu container,
 * outside any padded item wrapper, and give the container no top padding. The
 * container's own border radius and `overflow` clip the band's top corners.
 *
 * The foreground is the theme's `accentForeground`, nudged until it clears AA
 * contrast on the accent. A theme with a light accent (a yellow, say) therefore
 * gets dark text instead of white-on-yellow.
 */

import { memo, type CSSProperties } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Theme } from '../../types';
import { readableTextOn } from '../../../shared/colorContrast';

export interface ContextMenuHeaderProps {
	theme: Theme;
	/** The name shown in the band. Rendered verbatim (file names keep their case). */
	label: string;
	/** Monochrome icon drawn in the band's foreground (file, folder, agent). */
	icon?: LucideIcon;
	/** Emoji drawn before the label (a group's emoji). Ignored when `icon` is set. */
	emoji?: string;
	/** Hover text. Defaults to `label`, so a truncated name can still be read. */
	title?: string;
}

/**
 * Style for the icon of a right-click menu row: the theme accent, beside a
 * label in the main text color. A destructive row (Delete, Remove) does NOT
 * use it: its icon stays unstyled and takes the row's error color.
 */
export function contextMenuIconStyle(theme: Theme): CSSProperties {
	return { color: theme.colors.accent };
}

/** Foreground for text on the theme accent, guaranteed readable. */
export function contextMenuHeaderForeground(theme: Theme): string {
	return readableTextOn(theme.colors.accentForeground, [theme.colors.accent]);
}

export const ContextMenuHeader = memo(function ContextMenuHeader({
	theme,
	label,
	icon: Icon,
	emoji,
	title,
}: ContextMenuHeaderProps) {
	return (
		<div
			data-testid="context-menu-header"
			className="mb-1 px-3 py-1.5 flex items-center gap-2 text-xs font-semibold select-none"
			style={{
				backgroundColor: theme.colors.accent,
				color: contextMenuHeaderForeground(theme),
			}}
			title={title ?? label}
		>
			{Icon ? (
				<Icon className="w-3.5 h-3.5 shrink-0" aria-hidden />
			) : emoji ? (
				<span className="shrink-0" aria-hidden>
					{emoji}
				</span>
			) : null}
			<span className="block truncate max-w-[16rem]">{label}</span>
		</div>
	);
});
