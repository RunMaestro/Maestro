/**
 * ShikiCodeBlock - the chat surface's block-code renderer. react-markdown v10
 * emits block code as `<pre><code>...</code></pre>`; this extracts the inner
 * code element and renders it through CodeFence (Shiki highlighting + copy
 * button + language picker). Falls back to a plain `<pre>` when the structure
 * is unexpected.
 */

import React from 'react';
import type { ExtraProps } from 'react-markdown';
import type { Theme } from '../../../types';
import { CodeFence } from '../../CodeFence/CodeFence';

export function createShikiCodeBlock(theme: Theme, onCopy: (text: string) => void) {
	return function ShikiCodeBlock({ children }: JSX.IntrinsicElements['pre'] & ExtraProps) {
		const codeElement = React.Children.toArray(children).find(
			(child) =>
				React.isValidElement(child) &&
				(child.type === 'code' || (child as React.ReactElement).props?.node?.tagName === 'code')
		) as React.ReactElement<{ className?: string; children?: React.ReactNode }> | undefined;

		if (codeElement?.props) {
			const { className, children: codeChildren } = codeElement.props;
			const match = (className || '').match(/language-([\w+\-#]+)/);
			const language = match ? match[1] : '';
			const codeContent = String(codeChildren).replace(/\n$/, '');

			return <CodeFence language={language} code={codeContent} theme={theme} onCopy={onCopy} />;
		}

		// Fallback: render as-is
		return <pre>{children}</pre>;
	};
}
