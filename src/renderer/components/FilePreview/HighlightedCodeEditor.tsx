import React, { forwardRef, useCallback, useEffect, useRef } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { getSyntaxStyle } from '../../utils/syntaxTheme';
import type { Theme } from '../../constants/themes';

// Both layers MUST render identical text metrics or the visible caret drifts
// off the highlighted glyphs. Changing anything here requires changing both.
const SHARED_STYLE: React.CSSProperties = {
	fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
	fontSize: '13px',
	lineHeight: '1.6',
	tabSize: 4,
	whiteSpace: 'pre-wrap',
	wordBreak: 'break-word',
	overflowWrap: 'break-word',
	boxSizing: 'border-box',
};

interface HighlightedCodeEditorProps {
	value: string;
	onChange: (value: string) => void;
	language: string;
	theme: Theme;
	onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
	spellCheck?: boolean;
	padding?: string;
	className?: string;
}

export const HighlightedCodeEditor = forwardRef<HTMLTextAreaElement, HighlightedCodeEditorProps>(
	function HighlightedCodeEditor(
		{ value, onChange, language, theme, onKeyDown, spellCheck = false, padding = '0', className },
		forwardedRef
	) {
		const localTextareaRef = useRef<HTMLTextAreaElement | null>(null);
		const overlayRef = useRef<HTMLDivElement | null>(null);

		const setTextareaRef = useCallback(
			(node: HTMLTextAreaElement | null) => {
				localTextareaRef.current = node;
				if (typeof forwardedRef === 'function') {
					forwardedRef(node);
				} else if (forwardedRef) {
					forwardedRef.current = node;
				}
			},
			[forwardedRef]
		);

		// Textarea shows a scrollbar when content overflows, which shrinks its
		// content width. The highlight overlay must match that width so line
		// wrapping stays identical between the two layers.
		useEffect(() => {
			const textarea = localTextareaRef.current;
			const overlay = overlayRef.current;
			if (!textarea || !overlay) return;

			const updateWidth = () => {
				overlay.style.width = `${textarea.clientWidth}px`;
			};
			updateWidth();

			const ro = new ResizeObserver(updateWidth);
			ro.observe(textarea);
			return () => ro.disconnect();
		}, []);

		const handleScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
			const overlay = overlayRef.current;
			if (!overlay) return;
			const { scrollTop, scrollLeft } = e.currentTarget;
			overlay.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
		}, []);

		// Trailing newline wouldn't produce a blank line in the highlighted <pre>,
		// leaving the caret hovering over empty space. A trailing space forces one.
		const highlightValue = value.endsWith('\n') ? value + ' ' : value;

		return (
			<div className={`relative w-full h-full ${className ?? ''}`} style={{ overflow: 'hidden' }}>
				<div
					ref={overlayRef}
					aria-hidden="true"
					className="pointer-events-none"
					style={{
						position: 'absolute',
						top: 0,
						left: 0,
						willChange: 'transform',
					}}
				>
					<SyntaxHighlighter
						language={language || 'text'}
						style={getSyntaxStyle(theme.mode)}
						customStyle={{
							margin: 0,
							padding,
							background: 'transparent',
							...SHARED_STYLE,
						}}
						codeTagProps={{ style: { ...SHARED_STYLE, background: 'transparent' } }}
						PreTag="div"
					>
						{highlightValue}
					</SyntaxHighlighter>
				</div>
				<textarea
					ref={setTextareaRef}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onScroll={handleScroll}
					onKeyDown={onKeyDown}
					spellCheck={spellCheck}
					className="w-full h-full resize-none outline-none"
					style={{
						...SHARED_STYLE,
						position: 'relative',
						padding,
						color: 'transparent',
						caretColor: theme.colors.accent,
						background: 'transparent',
						border: 'none',
						display: 'block',
					}}
				/>
			</div>
		);
	}
);
