import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface SettingsSectionHeadingProps {
	/** Lucide icon component rendered before the label. Required to enforce consistency. */
	icon: LucideIcon;
	/** Heading label content. */
	children: ReactNode;
	/**
	 * Optional intro paragraph, rendered directly under the label on the standard
	 * description scale (`text-xs opacity-70`).
	 *
	 * Pass it here rather than writing your own `<p>` after the heading. A dozen
	 * sections had hand-rolled that paragraph and they disagreed about the gap
	 * above it, which is why four of them carried a `-mt-1` to claw back the
	 * heading's own bottom margin. Owning both halves lets the component state
	 * the gap once: the label drops to `mb-1` when it has a description, because
	 * the two lines are one block and the `mb-2` belongs below the pair.
	 */
	description?: ReactNode;
}

/**
 * Canonical section heading for panels inside the Settings modal.
 *
 * All section headings use the same typography (uppercase, bold, dim via opacity)
 * and inherit `theme.colors.textMain` - do not override with `textDim` or any
 * other color. Pair every heading with a Lucide icon.
 */
export function SettingsSectionHeading({
	icon: Icon,
	children,
	description,
}: SettingsSectionHeadingProps) {
	return (
		<>
			<div
				className={`text-xs font-bold opacity-70 uppercase flex items-center gap-2 ${
					description ? 'mb-1' : 'mb-2'
				}`}
			>
				<Icon className="w-3 h-3" />
				{children}
			</div>
			{description ? <p className="text-xs opacity-70 mb-2">{description}</p> : null}
		</>
	);
}
