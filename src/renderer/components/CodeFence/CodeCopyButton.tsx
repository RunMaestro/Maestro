/**
 * CodeCopyButton - the clipboard button pinned to the top-right corner of a
 * code fence. Shared by every markdown preset (chat CodeFence, document
 * PrismCodeBlock, wizard bubbles, release notes) so each fence copies the same
 * way and looks the same. The parent must be `position: relative`.
 *
 * CopyablePre wraps a plain `<pre>` (presets without a highlighter) with the
 * button, extracting the fence text from the rendered children.
 */

import React from 'react';
import { Clipboard } from 'lucide-react';
import type { Theme } from '../../types';
import { copyTextWithFlash, extractInlineCodeText } from '../../utils/inlineCodeCopy';

interface CodeCopyButtonProps {
	code: string;
	theme: Theme;
	/** Override the copy action. Defaults to clipboard write + center flash. */
	onCopy?: (text: string) => void;
}

export function CodeCopyButton({ code, theme, onCopy = copyTextWithFlash }: CodeCopyButtonProps) {
	return (
		<button
			type="button"
			onClick={(e) => {
				// Fences can sit inside clickable containers (wizard bubbles, list rows).
				e.stopPropagation();
				onCopy(code);
			}}
			className="absolute top-2 right-2 p-1.5 rounded opacity-70 hover:opacity-100 transition-opacity z-10"
			style={{
				backgroundColor: theme.colors.bgActivity,
				color: theme.colors.textDim,
				border: `1px solid ${theme.colors.border}`,
			}}
			title="Copy code"
			aria-label="Copy code"
			data-testid="code-copy-button"
		>
			<Clipboard className="w-3.5 h-3.5" />
		</button>
	);
}

interface CopyablePreProps extends React.HTMLAttributes<HTMLPreElement> {
	theme: Theme;
}

export function CopyablePre({ theme, children, ...preProps }: CopyablePreProps) {
	const code = extractInlineCodeText(children).replace(/\n$/, '');
	return (
		<div className="relative">
			<pre {...preProps}>{children}</pre>
			<CodeCopyButton code={code} theme={theme} />
		</div>
	);
}
