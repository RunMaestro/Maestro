/**
 * ScrollArea — themed scrollable container.
 *
 * Thin wrapper around a `<div>` that applies the app's themed scrollbar
 * styling (managed by useThemeStyles + global rules in index.css). Use this
 * for any new scrollable region so the intent is documented at the call
 * site and the right CSS class is applied consistently.
 *
 * Two visual variants:
 *
 *   variant="default"  →  10px scrollbar (matches global app default).
 *                         Best for main content areas (panels, lists,
 *                         modals, the right rail).
 *
 *   variant="thin"     →  6px scrollbar with the fade-on-idle animation
 *                         (managed by useThemeStyles via .scrolling /
 *                         .fading classes). Best for tight UI like
 *                         autocomplete dropdowns, sidebars, command
 *                         palettes, the agent config panel's left rail.
 *
 * Both variants pull their colors from CSS variables set on :root by
 * useThemeStyles, so they automatically theme-shift with the active theme.
 *
 * Both axes default to "auto". Pass `axis` to override:
 *   axis="y"     → vertical only (overflowX hidden)
 *   axis="x"     → horizontal only (overflowY hidden)
 *   axis="both"  → both directions (default)
 *   axis="none"  → no scrolling (acts as a styled div; useful for
 *                  conditional scroll containers)
 *
 * Existing components that already use `.scrollbar-thin` directly continue
 * to work — this component is purely additive. Do NOT mass-migrate; reach
 * for it when adding new scrollable regions or when refactoring areas
 * touched for other reasons.
 *
 * @example
 * // Main panel scroll region
 * <ScrollArea className="flex-1 p-4">
 *   {longContent}
 * </ScrollArea>
 *
 * @example
 * // Slim sidebar with fade-on-idle
 * <ScrollArea variant="thin" axis="y" style={{ maxHeight: 300 }}>
 *   {items.map(...)}
 * </ScrollArea>
 */

import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';

export type ScrollAreaVariant = 'default' | 'thin';
export type ScrollAreaAxis = 'both' | 'x' | 'y' | 'none';

export interface ScrollAreaProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
	/** Visual style of the scrollbar. Defaults to "default" (10px). */
	variant?: ScrollAreaVariant;
	/** Which axis can scroll. Defaults to "both". */
	axis?: ScrollAreaAxis;
	/** Hide the scrollbar entirely (still scrollable via wheel/touch). */
	hideScrollbar?: boolean;
	children?: ReactNode;
}

const AXIS_TO_OVERFLOW: Record<ScrollAreaAxis, Pick<CSSProperties, 'overflowX' | 'overflowY'>> = {
	both: { overflowX: 'auto', overflowY: 'auto' },
	x: { overflowX: 'auto', overflowY: 'hidden' },
	y: { overflowX: 'hidden', overflowY: 'auto' },
	none: { overflowX: 'hidden', overflowY: 'hidden' },
};

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
	{
		variant = 'default',
		axis = 'both',
		hideScrollbar = false,
		className,
		style,
		children,
		...rest
	},
	ref
) {
	// Compose classes:
	//   - default variant: rely on the global *::-webkit-scrollbar rules; no
	//     extra class needed.
	//   - thin variant: opt into .scrollbar-thin so the fade-on-idle animation
	//     in useThemeStyles takes effect.
	//   - hideScrollbar: opt into .no-scrollbar (overrides both above).
	const variantClass = hideScrollbar ? 'no-scrollbar' : variant === 'thin' ? 'scrollbar-thin' : '';
	const composedClassName = [variantClass, className].filter(Boolean).join(' ') || undefined;

	return (
		<div
			ref={ref}
			className={composedClassName}
			style={{
				...AXIS_TO_OVERFLOW[axis],
				...style,
			}}
			{...rest}
		>
			{children}
		</div>
	);
});
