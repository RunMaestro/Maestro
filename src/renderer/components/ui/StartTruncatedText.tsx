/**
 * StartTruncatedText - one line of text that, when it does not fit, loses its
 * START rather than its end ("...components/FilePreview/FilePreview.tsx").
 *
 * For a path the end is the part that identifies it: a file name clipped to
 * "src/renderer/components/Dir..." tells the reader nothing. CSS can only put
 * an ellipsis at the end of the inline direction, so the box is laid out
 * right-to-left (which moves the ellipsis to the left edge) and the text is
 * wrapped in `<bdi>` so it is still read left-to-right. Without the `<bdi>`,
 * the bidi algorithm reorders neutral characters at the edges, and a name like
 * `file (1).tsx` or `.env` renders with its punctuation on the wrong side.
 *
 * The trick was hand-rolled per surface before this existed. A path with no
 * spaces has no break opportunity, so a copy that forgets `overflow-hidden` or
 * `whitespace-nowrap` does not wrap or clip - it paints straight across
 * whatever sits beside it (the git changed-files panel did exactly that).
 *
 * The full text goes on `title` by default, since the clipped part is only
 * recoverable on hover.
 */

import type { CSSProperties, ReactNode } from 'react';

export interface StartTruncatedTextProps {
	children: ReactNode;
	/** Hover tooltip. Defaults to `children` when it is a string; pass `null`
	 *  to suppress it. */
	title?: string | null;
	className?: string;
	style?: CSSProperties;
	testId?: string;
}

export function StartTruncatedText({
	children,
	title,
	className = '',
	style,
	testId,
}: StartTruncatedTextProps) {
	const resolvedTitle =
		title === null ? undefined : (title ?? (typeof children === 'string' ? children : undefined));
	return (
		<span
			className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${className}`}
			style={{ direction: 'rtl', textAlign: 'left', ...style }}
			title={resolvedTitle}
			data-testid={testId}
		>
			<bdi>{children}</bdi>
		</span>
	);
}

export default StartTruncatedText;
