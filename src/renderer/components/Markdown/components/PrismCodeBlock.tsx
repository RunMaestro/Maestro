/**
 * PrismCodeBlock - the document surface's block-code renderer. Uses
 * react-syntax-highlighter (Prism) wrapped in SyntaxHighlightBoundary, with
 * optional per-language custom renderers (e.g. mermaid) and caller style
 * overrides. Extracted verbatim from createMarkdownComponents so the chat and
 * document paths share a single set of leaf renderers.
 */

import React from 'react';
import type { ExtraProps } from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import type { Theme } from '../../../types';
import { getSyntaxStyle } from '../../../utils/syntaxTheme';
import { SyntaxHighlightBoundary } from '../../SyntaxHighlightBoundary';

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

export function createPrismCodeBlock(options: PrismCodeBlockOptions) {
	const { theme, customLanguageRenderers = {}, codeBlockStyle } = options;

	return function PrismCodeBlock({ children }: JSX.IntrinsicElements['pre'] & ExtraProps) {
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

			// Check for custom language renderer (e.g., mermaid)
			if (customLanguageRenderers[language]) {
				const CustomRenderer = customLanguageRenderers[language];
				return React.createElement(CustomRenderer, { code: codeContent, theme });
			}

			// Standard syntax-highlighted code block. Use light/dark base style
			// depending on theme mode, then override text color & background so
			// plain-text / unknown-language code blocks match inline code across all
			// themes.
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
			return React.createElement(SyntaxHighlightBoundary, {
				code: codeContent,
				theme,
				children: React.createElement(SyntaxHighlighter, {
					language,
					style: themedStyle,
					customStyle: {
						margin: codeBlockStyle?.margin ?? '0.5em 0',
						padding: codeBlockStyle?.padding ?? '1em',
						background: codeBlockStyle?.backgroundColor ?? theme.colors.bgActivity,
						fontSize: codeBlockStyle?.fontSize ?? '0.9em',
						borderRadius: codeBlockStyle?.borderRadius ?? '6px',
					},
					PreTag: 'div',
					translate: 'no',
					children: codeContent,
				}),
			});
		}

		// Fallback: render as-is
		return React.createElement('pre', { translate: 'no' }, children);
	};
}
