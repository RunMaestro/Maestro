/**
 * headings - shared heading navigation for the markdown preview.
 *
 * The Table of Contents overlay and the `#` heading palette are two doors onto
 * the same list, so they jump the same way and paint levels the same colors.
 * Keep both behaviors here rather than letting the two surfaces drift.
 */

/**
 * Tier-specific jump. Return `true` when the scroll was handled, `false` to let
 * the DOM lookup below run instead.
 *
 * The Rich and Giant tiers render every heading, so a slug lookup in the DOM is
 * enough and they pass nothing. The Fast tier virtualizes its blocks, so most
 * headings are NOT mounted and `querySelector` finds nothing; it passes this
 * callback to scroll by block index instead.
 */
export type HeadingScrollOverride = (slug: string) => boolean;

/**
 * Level colors matching the rendered prose styles, so a heading reads the same
 * in the list as it does in the document.
 */
export function headingLevelColor(theme: any, level: number): string {
	switch (level) {
		case 1:
			return theme.colors.accent;
		case 2:
			return theme.colors.success;
		case 3:
			return theme.colors.warning;
		case 6:
			return theme.colors.textDim;
		default:
			return theme.colors.textMain;
	}
}

export function scrollToHeadingSlug(
	slug: string,
	container: HTMLElement | null | undefined,
	behavior: ScrollBehavior,
	onSelectHeading?: HeadingScrollOverride
): void {
	if (onSelectHeading?.(slug)) return;
	// CSS.escape: slugs come from heading text, so they can start with a digit
	// or carry punctuation that would otherwise break the selector.
	const target = container?.querySelector(`#${CSS.escape(slug)}`);
	target?.scrollIntoView({ behavior, block: 'start' });
}
