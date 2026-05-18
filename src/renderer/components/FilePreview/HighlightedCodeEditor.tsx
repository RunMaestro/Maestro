import React, { forwardRef, useCallback, useEffect, useMemo, useRef } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { getSyntaxStyle } from '../../utils/syntaxTheme';
import type { Theme } from '../../constants/themes';

// Both the overlay and the textarea MUST render identical text metrics or the
// visible caret drifts off the highlighted glyphs. Whitespace + wrap mode is
// the one piece that switches per `wrap` prop — when wrap is on we use
// `pre-wrap` with default word-break so prose wraps at whitespace but tables /
// dense delimited rows aren't split mid-word (that was the regression caused
// by the previous `break-word` setup).
const BASE_STYLE: React.CSSProperties = {
	fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
	fontSize: '13px',
	lineHeight: '1.6',
	tabSize: 4,
	boxSizing: 'border-box',
};

const GUTTER_WIDTH_PX = 44;
const GUTTER_PADDING_RIGHT_PX = 8;

interface HighlightedCodeEditorProps {
	value: string;
	onChange: (value: string) => void;
	language: string;
	theme: Theme;
	onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
	spellCheck?: boolean;
	padding?: string;
	className?: string;
	/** When true, long lines wrap at whitespace; when false, the textarea
	 *  scrolls horizontally. Default: true. */
	wrap?: boolean;
	/** Render a line-number gutter on the left edge. Default: true. */
	showLineNumbers?: boolean;
	/** Right-click handler for the line-number gutter. Receives the 1-based
	 *  line number and the native mouse event so callers can place a menu. */
	onLineNumberContextMenu?: (lineNumber: number, event: React.MouseEvent) => void;
}

export const HighlightedCodeEditor = forwardRef<HTMLTextAreaElement, HighlightedCodeEditorProps>(
	function HighlightedCodeEditor(
		{
			value,
			onChange,
			language,
			theme,
			onKeyDown,
			spellCheck = false,
			padding = '0',
			className,
			wrap = true,
			showLineNumbers = true,
			onLineNumberContextMenu,
		},
		forwardedRef
	) {
		const localTextareaRef = useRef<HTMLTextAreaElement | null>(null);
		const overlayRef = useRef<HTMLDivElement | null>(null);
		const gutterRef = useRef<HTMLDivElement | null>(null);

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

		const sharedStyle = useMemo<React.CSSProperties>(
			() => ({
				...BASE_STYLE,
				whiteSpace: wrap ? 'pre-wrap' : 'pre',
				// Native default. Explicit so it's clear we're not relying on browser quirks.
				wordBreak: 'normal',
				overflowWrap: 'normal',
			}),
			[wrap]
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
			const gutter = gutterRef.current;
			const { scrollTop, scrollLeft } = e.currentTarget;
			if (overlay) {
				overlay.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
			}
			// Gutter scrolls vertically with the textarea but stays pinned
			// horizontally so line numbers never disappear off-screen.
			if (gutter) {
				gutter.style.transform = `translateY(${-scrollTop}px)`;
			}
		}, []);

		// Trailing newline wouldn't produce a blank line in the highlighted <pre>,
		// leaving the caret hovering over empty space. A trailing space forces one.
		const highlightValue = value.endsWith('\n') ? value + ' ' : value;

		// Line count — when wrap is off this is simply newline count; when wrap
		// is on, visual lines drift from logical lines because of soft wrapping.
		// We render numbers for logical (source) lines either way; soft-wrapped
		// rows just won't be numbered, which matches how most editors behave
		// (numbers correspond to "real" lines you can deep-link to).
		const lineCount = useMemo(() => {
			if (!value) return 1;
			let count = 1;
			for (let i = 0; i < value.length; i++) {
				if (value.charCodeAt(i) === 10) count++;
			}
			// Trailing newline produces an empty trailing line that the textarea
			// renders — count it so the gutter doesn't come up short.
			if (value.endsWith('\n')) count--;
			return Math.max(1, count);
		}, [value]);

		const lineNumbers = useMemo(() => {
			if (!showLineNumbers) return null;
			const items: number[] = [];
			for (let i = 1; i <= lineCount; i++) items.push(i);
			return items;
		}, [lineCount, showLineNumbers]);

		const handleGutterContextMenu = useCallback(
			(event: React.MouseEvent) => {
				if (!onLineNumberContextMenu) return;
				const target = event.target as HTMLElement;
				const lineEl = target.closest('[data-line-number]') as HTMLElement | null;
				if (!lineEl) return;
				const lineNumber = Number(lineEl.dataset.lineNumber);
				if (!Number.isFinite(lineNumber) || lineNumber < 1) return;
				event.preventDefault();
				onLineNumberContextMenu(lineNumber, event);
			},
			[onLineNumberContextMenu]
		);

		const textPaddingLeft = showLineNumbers
			? `${GUTTER_WIDTH_PX + GUTTER_PADDING_RIGHT_PX}px`
			: padding;
		const textPaddingRight = padding;

		// Vertical scroll is always on — even when wrap is on, files taller than
		// the viewport must scroll. Horizontal scroll switches with `wrap`:
		// off → textarea's native horizontal scrollbar reveals long lines and
		// the overlay rides along via transform; on → no horizontal overflow,
		// content wraps at whitespace.
		const overflowMode: React.CSSProperties = {
			overflowX: wrap ? 'hidden' : 'auto',
			overflowY: 'auto',
		};

		return (
			<div className={`relative w-full h-full ${className ?? ''}`} style={{ overflow: 'hidden' }}>
				{showLineNumbers && (
					<div
						aria-hidden="true"
						className="pointer-events-none absolute top-0 left-0 select-none"
						style={{
							width: GUTTER_WIDTH_PX,
							height: '100%',
							borderRight: `1px solid ${theme.colors.border}`,
							backgroundColor: theme.colors.bgSidebar,
							zIndex: 1,
						}}
					>
						{/* Inner container is the part that scrolls vertically with
						    the textarea. pointer-events-auto so right-click works on
						    individual line rows. */}
						<div
							ref={gutterRef}
							className="pointer-events-auto"
							style={{
								willChange: 'transform',
								paddingTop: padding,
							}}
							onContextMenu={handleGutterContextMenu}
						>
							{lineNumbers?.map((n) => (
								<div
									key={n}
									data-line-number={n}
									data-testid={`editor-line-number-${n}`}
									style={{
										...BASE_STYLE,
										color: theme.colors.textDim,
										textAlign: 'right',
										paddingRight: GUTTER_PADDING_RIGHT_PX,
										cursor: onLineNumberContextMenu ? 'context-menu' : 'default',
										userSelect: 'none',
									}}
								>
									{n}
								</div>
							))}
						</div>
					</div>
				)}
				{/* Overlay anchors at left:0 (matching the textarea wrapper) and
				    mirrors the textarea's padding inside the SyntaxHighlighter so
				    glyph positions line up exactly with the (transparent) textarea
				    text below. Anchoring at the gutter's right edge instead would
				    introduce an 8px misalignment between caret and colored glyph. */}
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
							padding: 0,
							paddingTop: padding,
							paddingBottom: padding,
							paddingLeft: textPaddingLeft,
							paddingRight: textPaddingRight,
							background: 'transparent',
							...sharedStyle,
						}}
						codeTagProps={{ style: { ...sharedStyle, background: 'transparent' } }}
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
					wrap={wrap ? 'soft' : 'off'}
					className="w-full h-full resize-none outline-none"
					style={{
						...sharedStyle,
						position: 'relative',
						paddingTop: padding,
						paddingBottom: padding,
						paddingLeft: textPaddingLeft,
						paddingRight: textPaddingRight,
						color: 'transparent',
						caretColor: theme.colors.accent,
						background: 'transparent',
						border: 'none',
						display: 'block',
						...overflowMode,
					}}
				/>
			</div>
		);
	}
);
