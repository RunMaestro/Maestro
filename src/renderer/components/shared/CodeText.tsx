/**
 * CodeText — Wraps technical/English text with `lang="en"` for screen readers.
 *
 * When the UI is displayed in a non-English language, code snippets, file paths,
 * agent names, and keyboard shortcuts remain in English. Without a `lang="en"`
 * attribute, screen readers may attempt to pronounce them using the active
 * language's phonetic rules, producing garbled output.
 *
 * Required by WCAG 2.1 SC 3.1.2 (Language of Parts).
 *
 * Usage:
 *   <CodeText>src/index.ts</CodeText>
 *   <CodeText as="code">npm install</CodeText>
 *   <CodeText className="font-mono text-xs">Ctrl+Shift+K</CodeText>
 */

import React from 'react';

export interface CodeTextProps {
	children: React.ReactNode;
	/** HTML element to render. Defaults to "span". */
	as?: 'span' | 'code' | 'kbd';
	/** Additional class names. */
	className?: string;
	/** Additional inline styles. */
	style?: React.CSSProperties;
	/** Override the language attribute. Defaults to "en". */
	lang?: string;
	/** Title/tooltip text. */
	title?: string;
}

/**
 * Renders children inside a `<span lang="en">` (or `<code>` / `<kbd>`)
 * so screen readers switch to English pronunciation for technical text.
 */
export function CodeText({
	children,
	as: Element = 'span',
	className,
	style,
	lang = 'en',
	title,
}: CodeTextProps): React.ReactElement {
	return (
		<Element lang={lang} className={className} style={style} title={title}>
			{children}
		</Element>
	);
}
