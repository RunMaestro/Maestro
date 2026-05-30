/**
 * Shared click-to-copy behavior for inline code (markdown backticks).
 *
 * Used across every markdown renderer (MarkdownRenderer, AutoRun, wizard
 * bubbles, release notes, etc.) so a single click on `code` content copies
 * its text and shows the standard "Copied to Clipboard" center flash.
 */

import React from 'react';
import { safeClipboardWrite } from './clipboard';
import { flashCopiedToClipboard } from './flashCopiedToClipboard';

/** Recursively extract the plain text from arbitrary React children. */
export function extractInlineCodeText(children: React.ReactNode): string {
	if (children == null || children === false) return '';
	if (typeof children === 'string' || typeof children === 'number') return String(children);
	if (Array.isArray(children)) return children.map(extractInlineCodeText).join('');
	if (React.isValidElement(children)) {
		return extractInlineCodeText((children.props as { children?: React.ReactNode }).children);
	}
	return '';
}

/** Copy inline code text and surface the standard center flash. */
export async function copyInlineCode(children: React.ReactNode): Promise<void> {
	const text = extractInlineCodeText(children).trim();
	if (!text) return;
	const ok = await safeClipboardWrite(text);
	if (ok) {
		flashCopiedToClipboard(text);
	}
}

/** Visual + a11y props applied to every clickable inline-code element. */
export const INLINE_CODE_CLICK_PROPS = {
	role: 'button' as const,
	tabIndex: 0,
	title: 'Click to copy',
};

/** Cursor style applied to every clickable inline-code element. */
export const INLINE_CODE_CLICK_STYLE: React.CSSProperties = {
	cursor: 'pointer',
};

/** Build the onClick / onKeyDown handlers for an inline-code element. */
export function buildInlineCodeHandlers(children: React.ReactNode) {
	return {
		onClick: (e: React.MouseEvent) => {
			// preventDefault: when <code> is nested inside an <a> (e.g. AI emits
			// `[\`file.md\`](file.md)`), stopPropagation alone keeps the parent
			// link's onClick from firing — but the browser's default link
			// navigation still runs because no preventDefault was called. That
			// can navigate the renderer to a non-existent in-bundle file and
			// unload the app. preventDefault is a no-op for standalone <code>.
			e.preventDefault();
			e.stopPropagation();
			void copyInlineCode(children);
		},
		onKeyDown: (e: React.KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				e.stopPropagation();
				void copyInlineCode(children);
			}
		},
	};
}
