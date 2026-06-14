/**
 * InlineCode - the shared inline `<code>` renderer used by every markdown
 * surface. Renders a hex color swatch when the content is a hex color and wires
 * up click-to-copy (via the shared inlineCodeCopy handlers). Block code is
 * handled separately by the code-fence renderers.
 *
 * Styling is intentionally left to the caller: chat/doc rely on scoped `.prose
 * code` CSS, while wizard-bubble/release-notes pass an explicit className/style.
 */

import React from 'react';
import { extractHexColor } from '../../../../shared/hexColor';
import {
	INLINE_CODE_CLICK_PROPS,
	INLINE_CODE_CLICK_STYLE,
	buildInlineCodeHandlers,
} from '../../../utils/inlineCodeCopy';
import { HexSwatch } from './HexSwatch';

export interface InlineCodeProps {
	children: React.ReactNode;
	className?: string;
	/** Style merged before the click-cursor style (which always wins). */
	style?: React.CSSProperties;
	/** Passthrough props from react-markdown (data-* attributes, etc.). */
	passthrough?: Record<string, unknown>;
}

export function InlineCode({ children, className, style, passthrough }: InlineCodeProps) {
	const hexColor = extractHexColor(children);
	const handlers = buildInlineCodeHandlers(children);
	return (
		<code
			className={className}
			{...passthrough}
			{...INLINE_CODE_CLICK_PROPS}
			{...handlers}
			style={{ ...(style ?? {}), ...INLINE_CODE_CLICK_STYLE }}
		>
			{hexColor && <HexSwatch color={hexColor} />}
			{children}
		</code>
	);
}
