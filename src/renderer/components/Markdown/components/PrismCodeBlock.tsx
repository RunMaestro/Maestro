/**
 * PrismCodeBlock - the document surface's block-code renderer. Uses
 * react-syntax-highlighter (Prism) wrapped in SyntaxHighlightBoundary, with
 * optional per-language custom renderers (e.g. mermaid) and caller style
 * overrides. Extracted verbatim from createMarkdownComponents so the chat and
 * document paths share a single set of leaf renderers. Every block carries
 * the shared CodeCopyButton.
 */

import React from 'react';
import type { ExtraProps } from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import type { Theme } from '../../../types';
import { getSyntaxStyle } from '../../../utils/syntaxTheme';
import { SyntaxHighlightBoundary } from '../../SyntaxHighlightBoundary';
import { CodeCopyButton } from '../../CodeFence/CodeCopyButton';

export interface PrismCodeBlockOptions {
	theme: Theme;
	/** Custom code-block renderer for specific languages (e.g. mermaid). */
	customLanguageRenderers?: Record<string, React.ComponentType<{ code: string; theme: Theme }>>;
	/** Optional style overrides for the syntax-highlighted block. */
	codeBlockStyle?: {
		margin?: string;
		padding?: string;
		fontSize?: string;
		borderRadius?: string;
		backgroundColor?: string;
	};
}

export interface PrismHighlightedCodeProps {
	code: string;
	language: string;
	theme: Theme;
	codeBlockStyle?: PrismCodeBlockOptions['codeBlockStyle'];
	/**
	 * The fence's `data-source-line` (stamped on its `pre` by `rehypeSourceLine`),
	 * carried on the block's outer element so preview/edit line sync can anchor
	 * on code blocks too.
	 */
	sourceLine?: string | number;
}

/**
 * The standard highlighted block (Prism, theme colors, copy button). Exported so
 * a custom language renderer that declines to render (Dataview outside its
 * surfaces) can show the fence exactly as an ordinary code block.
 */
export function PrismHighlightedCode({
	code,
	language,
	theme,
	codeBlockStyle,
	sourceLine,
}: PrismHighlightedCodeProps) {
	// Use light/dark base style depending on theme mode, then override text
	// color & background so plain-text / unknown-language code blocks match
	// inline code across all themes.
	const baseStyle = getSyntaxStyle(theme.mode);
	const themedStyle = {
		...baseStyle,
		'pre[class*="language-"]': {
			...(baseStyle as any)['pre[class*="language-"]'],
			color: theme.colors.textMain,
			background: theme.colors.bgActivity,
		},
		'code[class*="language-"]': {
			...(baseStyle as any)['code[class*="language-"]'],
			color: theme.colors.textMain,
		},
	};
	// The margin lives on the wrapper so the copy button's top-right anchor
	// is the block's visible corner, not the margin box.
	return React.createElement(
		'div',
		{
			className: 'relative',
			style: { margin: codeBlockStyle?.margin ?? '0.5em 0' },
			...(sourceLine !== undefined ? { 'data-source-line': sourceLine } : null),
		},
		React.createElement(SyntaxHighlightBoundary, {
			code,
			theme,
			children: React.createElement(SyntaxHighlighter, {
				language,
				style: themedStyle,
				customStyle: {
					margin: 0,
					padding: codeBlockStyle?.padding ?? '1em',
					background: codeBlockStyle?.backgroundColor ?? theme.colors.bgActivity,
					fontSize: codeBlockStyle?.fontSize ?? '0.9em',
					borderRadius: codeBlockStyle?.borderRadius ?? '6px',
				},
				PreTag: 'div',
				translate: 'no',
				children: code,
			}),
		}),
		React.createElement(CodeCopyButton, { code, theme })
	);
}

export function createPrismCodeBlock(options: PrismCodeBlockOptions) {
	const { theme, customLanguageRenderers = {}, codeBlockStyle } = options;

	return function PrismCodeBlock({
		children,
		'data-source-line': sourceLine,
	}: JSX.IntrinsicElements['pre'] & ExtraProps & { 'data-source-line'?: string | number }) {
		const codeElement = React.Children.toArray(children).find(
			(child: any) => child?.type === 'code' || child?.props?.node?.tagName === 'code'
		) as React.ReactElement<any> | undefined;

		if (codeElement?.props) {
			const { className, children: codeChildren } = codeElement.props;
			// `\w+` (narrower than ShikiCodeBlock's `[\w+\-#]+`) is intentional: Prism's
			// registered grammars are all word-chars (cpp, csharp, objectivec), so a
			// `c++` fence matches `c` and still highlights, whereas capturing `c++`
			// would pass an unknown language and lose highlighting.
			const match = (className || '').match(/language-(\w+)/);
			const language = match ? match[1] : 'text';
			const codeContent = String(codeChildren).replace(/\n$/, '');

			// Check for custom language renderer (e.g., mermaid). Own keys only: a
			// `constructor` or `toString` fence must not reach Object.prototype.
			if (Object.prototype.hasOwnProperty.call(customLanguageRenderers, language)) {
				const CustomRenderer = customLanguageRenderers[language];
				const rendered = React.createElement(CustomRenderer, { code: codeContent, theme });
				// The custom element replaces the `pre`, so its line tag would be lost.
				// A plain block wrapper keeps it for line sync; the renderer's own
				// output never carries one (rows from other files would break the
				// ascending line walk).
				return sourceLine === undefined
					? rendered
					: React.createElement('div', { 'data-source-line': sourceLine }, rendered);
			}

			return React.createElement(PrismHighlightedCode, {
				code: codeContent,
				language,
				theme,
				codeBlockStyle,
				sourceLine,
			});
		}

		// Fallback: render as-is
		return React.createElement(
			'pre',
			{
				translate: 'no',
				...(sourceLine !== undefined ? { 'data-source-line': sourceLine } : null),
			},
			children
		);
	};
}
