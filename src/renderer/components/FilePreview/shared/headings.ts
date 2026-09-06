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

/**
 * Tier-specific active-heading read, mirroring `HeadingScrollOverride`.
 *
 * The Fast tier virtualizes its blocks, so the heading the reader is under is
 * usually NOT mounted and the DOM walk below cannot see it. It answers from its
 * parsed block array instead. Return `undefined` to fall back to the DOM walk.
 */
export type ActiveHeadingOverride = () => string | null | undefined;

/** Heading elements carry ids from rehypeSlug, matching `extractHeadings` slugs. */
const HEADING_SELECTOR = 'h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]';

/**
 * Pixels below the top of the viewport that count as "the fold". A heading
 * scrolled a hair off the top still reads as the section you are in.
 */
export const ACTIVE_HEADING_FOLD_PX = 8;

/**
 * Slug of the heading the reader is currently under, or `null` when the view
 * sits above the first heading.
 *
 * `scroller` is the element that actually scrolls; `container` is the rendered
 * document inside it.
 */
export function findActiveHeadingSlug(
	scroller: HTMLElement | null | undefined,
	container: HTMLElement | null | undefined,
	onReadActive?: ActiveHeadingOverride
): string | null {
	const override = onReadActive?.();
	if (override !== undefined) return override;
	if (!scroller || !container) return null;
	const nodes = container.querySelectorAll<HTMLElement>(HEADING_SELECTOR);
	if (nodes.length === 0) return null;
	const fold = scroller.getBoundingClientRect().top + ACTIVE_HEADING_FOLD_PX;
	// Headings sit in document order, so their tops increase monotonically:
	// binary search for the last one at or above the fold rather than measuring
	// every heading in the document on every scroll frame.
	let lo = 0;
	let hi = nodes.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (nodes[mid].getBoundingClientRect().top <= fold) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return found === -1 ? null : nodes[found].id || null;
}
