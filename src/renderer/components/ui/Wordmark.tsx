import type { CSSProperties, ReactNode } from 'react';
import { WORDMARK_FONT_STACK } from '../../../shared/fontStack';

export interface WordmarkProps {
	/** Size and any other layout classes. The brand's own type is not overridable. */
	className?: string;
	/** Colour and layout only - `fontFamily` here is ignored on purpose. */
	style?: Omit<CSSProperties, 'fontFamily'>;
	/** Defaults to the wordmark itself; pass children only for a variant lockup. */
	children?: ReactNode;
	/** Rendered element. `h1` for a page's own heading, `span` inside chrome. */
	as?: 'h1' | 'h2' | 'span' | 'div';
	testId?: string;
}

/**
 * The MAESTRO wordmark.
 *
 * Exists so the brand mark is rendered from ONE place. It was previously four
 * copies of `font-bold tracking-widest` with no font-family, which meant the
 * logo inherited whatever the user had picked as their interface font - so
 * changing a reading preference changed the brand, and the boot splash (which
 * hard-codes its own stack) disagreed with the running app.
 *
 * `fontFamily` is excluded from the style prop rather than merely defaulted:
 * this is the one string in the app that must never be re-typed, and an
 * escape hatch is how it would drift back.
 *
 * Weight and tracking stay here too, since they are as much a part of the mark
 * as the face. Size does not - a header and an About screen legitimately draw
 * the same mark at different scales, so that arrives via `className`.
 */
export function Wordmark({
	className = '',
	style,
	children = 'MAESTRO',
	as: Tag = 'span',
	testId,
}: WordmarkProps) {
	return (
		<Tag
			className={`font-bold tracking-widest ${className}`.trim()}
			data-testid={testId}
			style={{ ...style, fontFamily: WORDMARK_FONT_STACK }}
		>
			{children}
		</Tag>
	);
}

export default Wordmark;
