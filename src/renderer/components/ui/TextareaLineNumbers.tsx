/**
 * TextareaLineNumbers - a scroll-synced, wrap-aware line-number gutter for a
 * plain `<textarea>`.
 *
 * A textarea has no gutter of its own, so the numbers live in an overlay that
 * has to track two things the naive "one div per line" gutter gets wrong:
 *
 *  1. **Scroll.** The textarea scrolls its own content, so the gutter must be
 *     translated by the same `scrollTop` or the numbers drift the moment the
 *     document is taller than the box.
 *  2. **Soft wrap.** A prose line that wraps onto three visual rows is three
 *     rows tall in the textarea but one entry in the gutter. Each row is
 *     measured against a hidden mirror that copies the textarea's font, wrap
 *     width, and wrapping rules, so number N always sits on the first visual
 *     row of logical line N.
 *
 * Render it inside a `position: relative` wrapper that also holds the textarea,
 * and push the text clear of the gutter with the padding derived from the same
 * line count:
 *
 * ```tsx
 * const metrics = lineNumberGutterMetrics(value);
 * <div className="relative w-full h-full">
 *   <TextareaLineNumbers textareaRef={ref} value={value} theme={theme} />
 *   <textarea ref={ref} value={value} style={{ paddingLeft: metrics.textPaddingLeft }} />
 * </div>
 * ```
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Theme } from '../../types';

/** Gap in px between the left edge of the box and the digits. */
const GUTTER_LEFT_PAD = 8;
/** Gap in px between the digits and the start of the text. */
const GUTTER_RIGHT_PAD = 10;

export interface LineNumberGutterMetrics {
	/** Widest line number, in characters - what the gutter has to fit. */
	digits: number;
	/** CSS width for the gutter itself. */
	gutterWidth: string;
	/** CSS `padding-left` for the textarea so its text clears the gutter. */
	textPaddingLeft: string;
}

/**
 * Gutter and text metrics for a document, in `ch` units so they scale with the
 * editor's monospace font instead of a hard-coded pixel guess.
 */
export function lineNumberGutterMetrics(value: string): LineNumberGutterMetrics {
	const lineCount = value.split('\n').length;
	const digits = Math.max(2, String(lineCount).length);
	return {
		digits,
		gutterWidth: `calc(${digits}ch + ${GUTTER_LEFT_PAD + GUTTER_RIGHT_PAD}px)`,
		textPaddingLeft: `calc(${digits}ch + ${GUTTER_LEFT_PAD + GUTTER_RIGHT_PAD + 6}px)`,
	};
}

export interface TextareaLineNumbersProps {
	/** The textarea being numbered. Read for scroll position, font, and width. */
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	/** Current textarea value - the gutter re-measures whenever it changes. */
	value: string;
	theme: Theme;
	/**
	 * Any value that changes the textarea's typography without changing its box.
	 * A font-size change leaves the border box the same size, so the internal
	 * ResizeObserver never fires and the numbers keep the row heights of the old
	 * font until the next keystroke. Pass the font scale (or whatever drives it)
	 * to re-measure on the spot.
	 */
	remeasureKey?: string | number;
	/** Test id on the gutter element. Defaults to `line-numbers`. */
	testId?: string;
}

export function TextareaLineNumbers({
	textareaRef,
	value,
	theme,
	remeasureKey,
	testId = 'line-numbers',
}: TextareaLineNumbersProps) {
	const rowsRef = useRef<HTMLDivElement>(null);
	const mirrorRef = useRef<HTMLDivElement>(null);
	const [rowHeights, setRowHeights] = useState<number[]>([]);
	// Mirrored from the textarea so the digits share its metrics exactly - a
	// gutter one pixel off in font size drifts a row every few screens.
	const [boxStyle, setBoxStyle] = useState<{
		paddingTop: number;
		fontSize?: string;
		lineHeight?: string;
	}>({ paddingTop: 0 });

	const lines = useMemo(() => value.split('\n'), [value]);
	const metrics = useMemo(() => lineNumberGutterMetrics(value), [value]);

	// Keep the gutter pinned to the textarea's scroll position. Written straight
	// to the DOM rather than through state so a fast scroll can't lag a frame
	// behind the text it labels.
	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		const sync = () => {
			if (rowsRef.current) {
				rowsRef.current.style.transform = `translateY(${-textarea.scrollTop}px)`;
			}
		};
		sync();
		textarea.addEventListener('scroll', sync);
		return () => textarea.removeEventListener('scroll', sync);
	}, [textareaRef, rowHeights]);

	// Measure each logical line's wrapped height against a mirror that shares the
	// textarea's font, wrap width, and wrapping rules.
	useLayoutEffect(() => {
		const textarea = textareaRef.current;
		const mirror = mirrorRef.current;
		if (!textarea || !mirror) return;

		const measure = () => {
			const computed = window.getComputedStyle(textarea);
			const padLeft = parseFloat(computed.paddingLeft) || 0;
			const padRight = parseFloat(computed.paddingRight) || 0;
			const nextBox = {
				paddingTop: parseFloat(computed.paddingTop) || 0,
				fontSize: computed.fontSize || undefined,
				lineHeight: computed.lineHeight || undefined,
			};
			setBoxStyle((prev) =>
				prev.paddingTop === nextBox.paddingTop &&
				prev.fontSize === nextBox.fontSize &&
				prev.lineHeight === nextBox.lineHeight
					? prev
					: nextBox
			);

			mirror.style.fontFamily = computed.fontFamily;
			mirror.style.fontSize = computed.fontSize;
			mirror.style.fontWeight = computed.fontWeight;
			mirror.style.lineHeight = computed.lineHeight;
			mirror.style.letterSpacing = computed.letterSpacing;
			mirror.style.tabSize = computed.tabSize;
			mirror.style.width = `${Math.max(0, textarea.clientWidth - padLeft - padRight)}px`;

			// An empty line still occupies one row - give it a space so it measures
			// as one, without changing how any other line wraps.
			mirror.replaceChildren(
				...lines.map((line) => {
					const row = document.createElement('div');
					row.textContent = line === '' ? ' ' : line;
					return row;
				})
			);

			setRowHeights(Array.from(mirror.children, (row) => (row as HTMLElement).offsetHeight));
		};

		measure();

		// jsdom has no layout engine and no ResizeObserver; the gutter still renders,
		// it just falls back to natural row heights.
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(measure);
		observer.observe(textarea);
		return () => observer.disconnect();
	}, [textareaRef, lines, remeasureKey]);

	return (
		<>
			<div
				aria-hidden="true"
				data-testid={testId}
				className="absolute top-px bottom-px left-px overflow-hidden select-none pointer-events-none font-mono text-sm"
				style={{
					width: metrics.gutterWidth,
					paddingTop: boxStyle.paddingTop,
					fontSize: boxStyle.fontSize,
					lineHeight: boxStyle.lineHeight,
					color: theme.colors.textDim,
					borderRight: `1px solid ${theme.colors.border}`,
					opacity: 0.75,
				}}
			>
				<div ref={rowsRef} className="text-right" style={{ paddingRight: GUTTER_RIGHT_PAD }}>
					{lines.map((_, index) => (
						<div key={index} style={{ height: rowHeights[index] || undefined }}>
							{index + 1}
						</div>
					))}
				</div>
			</div>
			{/* Hidden mirror, used only for wrap measurement. */}
			<div
				ref={mirrorRef}
				aria-hidden="true"
				style={{
					position: 'absolute',
					top: 0,
					left: 0,
					zIndex: -1,
					visibility: 'hidden',
					pointerEvents: 'none',
					whiteSpace: 'pre-wrap',
					overflowWrap: 'break-word',
					height: 'auto',
				}}
			/>
		</>
	);
}
