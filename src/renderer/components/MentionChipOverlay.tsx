/**
 * MentionChipOverlay - the live `@mention` pill decoration drawn behind a
 * composer `<textarea>`.
 *
 * Rendered by `ChatComposer/ComposerTextarea`, which both the AI composer and
 * the Group Chat composer use, so a mention lights up the same way on both
 * surfaces. The textarea stays the sole source of visible glyphs, caret, and
 * selection; this layer paints only the chip fill and border behind the raw
 * `@token`.
 *
 * Wiring (done once, in ComposerTextarea): call {@link useMentionChipOverlay} in the composer, render
 * `<MentionChipOverlay overlay={...} />` as a sibling BEFORE the textarea inside
 * a `relative` container, spread {@link MENTION_OVERLAY_TYPOGRAPHY} into the
 * textarea style, and route the textarea's select / scroll / blur / change
 * events through the hook's handlers.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Theme } from '../types';
import { useSettingsStore } from '../stores/settingsStore';
import { tokenizeMentions, type MentionSegment } from '../../shared/mentionPatterns';
import { getMentionChipColors } from './MentionChip';
import { resolveAgentMention, resolveFileMentionIconColor } from '../utils/mentionChipResolve';
import { useEventListener } from '../hooks/utils/useEventListener';

/**
 * Typography the native textarea and the decorative overlay MUST share
 * exactly, or the mention highlights drift away from the caret. Both layers
 * spread this one constant so they can never disagree (font size / line height
 * / family / letter spacing). Padding is passed to the overlay separately and
 * must mirror the textarea's padding classes.
 */
export const MENTION_OVERLAY_TYPOGRAPHY: React.CSSProperties = {
	fontSize: '0.875rem',
	lineHeight: '1.25rem',
	fontFamily: 'inherit',
	letterSpacing: 'normal',
	// Must be shared: Chrome does not auto-apply break-word to a <textarea>, so a
	// long unbroken token (e.g. `@src/a/really/long/path.ts`) would wrap in the
	// decorative overlay but overflow-scroll in the textarea, drifting the chips
	// off the caret. Keeping it here syncs both layers.
	wordBreak: 'break-word',
};

interface UseMentionChipOverlayOptions {
	inputRef: React.RefObject<HTMLTextAreaElement>;
	value: string;
	/** False turns the overlay off entirely (e.g. terminal mode). */
	enabled: boolean;
	/** Lowercased mentionable agent/group names; bare `@words` chip only when known. */
	knownMentionNames: ReadonlySet<string> | undefined;
}

export interface MentionChipOverlayState {
	overlayRef: React.RefObject<HTMLDivElement>;
	value: string;
	segments: MentionSegment[];
	/** True while the overlay is mounted (the draft holds at least one mention). */
	overlayRendered: boolean;
	/** False while the textarea holds a range selection (chip hides under it). */
	overlayVisible: boolean;
	/** Textarea `onChange` / `onSelect`: track whether a range is selected. */
	onSelectionChange: (target: HTMLTextAreaElement) => void;
	/** Textarea `onScroll`, or undefined when no overlay is rendered. */
	onScroll: ((e: React.UIEvent<HTMLTextAreaElement>) => void) | undefined;
	/** Textarea `onBlur`: bring the chip back once the native selection stops painting. */
	onBlur: () => void;
}

export function useMentionChipOverlay({
	inputRef,
	value,
	enabled,
	knownMentionNames,
}: UseMentionChipOverlayOptions): MentionChipOverlayState {
	const overlayRef = useRef<HTMLDivElement>(null);
	const [hasSelection, setHasSelection] = useState(false);

	// Tokenize the raw input into text / file / agent segments. Same source of
	// truth as the picker + dispatch scanner, so the overlay can never disagree
	// about what counts as a mention.
	const segments = useMemo(
		() => (enabled ? tokenizeMentions(value, knownMentionNames) : []),
		[enabled, value, knownMentionNames]
	);
	const overlayRendered = enabled && segments.some((segment) => segment.kind !== 'text');
	const overlayVisible = overlayRendered && !hasSelection;

	const onSelectionChange = useCallback((target: HTMLTextAreaElement) => {
		const nextHasSelection = target.selectionStart !== target.selectionEnd;
		setHasSelection((current) => (current === nextHasSelection ? current : nextHasSelection));
	}, []);

	// `hasSelection` is only ever cleared by an event fired ON the focused
	// textarea, so it would stay stuck `true` whenever the overlay stops
	// listening while a range is selected: switching to terminal mode, or
	// deleting the last mention out of the draft. The chip would then come back
	// invisible on the next render. Clear the flag whenever the decorative layer
	// is not rendered (blur is handled by `onBlur`).
	useEffect(() => {
		if (!overlayRendered) setHasSelection(false);
	}, [overlayRendered]);

	// React's textarea onSelect fires on mouseup, after a drag selection has
	// already become visible. Track the document selectionchange event so the
	// decorative layer disappears during the drag itself.
	useEventListener(
		'selectionchange',
		() => {
			const textarea = inputRef.current;
			if (!textarea || document.activeElement !== textarea) return;
			onSelectionChange(textarea);
		},
		{
			target: typeof document !== 'undefined' ? document : null,
			enabled: overlayRendered,
		}
	);

	// Keep the decorative overlay pinned to the textarea's scroll position so the
	// mention highlights track the text as the input grows past one line.
	const syncOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
		const el = overlayRef.current;
		if (!el) return;
		el.scrollTop = target.scrollTop;
		el.scrollLeft = target.scrollLeft;
	}, []);

	// Re-sync AFTER the taller overlay has been committed. A keystroke that wraps a
	// new line makes the browser natively scroll the textarea BEFORE React commits
	// the grown overlay content, so the `onScroll` sync assigns a scrollTop the
	// overlay cannot reach yet and the browser clamps it one row short - leaving the
	// glyphs above the caret and the newest line clipped, with no later event to
	// repair it. Running the copy in a layout effect keyed on the rendered segments
	// means the overlay already has its full scrollHeight, so the same scrollTop now
	// lands unclamped. `onScroll` still owns user-driven scrolling.
	useLayoutEffect(() => {
		if (!enabled) return;
		const textarea = inputRef.current;
		if (!textarea || !overlayRef.current) return;
		syncOverlayScroll(textarea);
	}, [segments, enabled, inputRef, syncOverlayScroll]);

	const onScroll = useCallback(
		(e: React.UIEvent<HTMLTextAreaElement>) => syncOverlayScroll(e.currentTarget),
		[syncOverlayScroll]
	);

	// Chromium stops painting the selection once the textarea loses focus, so the
	// decoration has to come back with it. Without this the chip stays hidden
	// until the user clicks back in and collapses the caret.
	const onBlur = useCallback(() => setHasSelection(false), []);

	return {
		overlayRef,
		value,
		segments,
		overlayRendered,
		overlayVisible,
		onSelectionChange,
		onScroll: overlayRendered ? onScroll : undefined,
		onBlur,
	};
}

interface MentionChipOverlayProps {
	overlay: MentionChipOverlayState;
	theme: Theme;
	/** CSS padding that mirrors the textarea's padding classes exactly. */
	padding: string;
	/** Font override the textarea also uses (e.g. command mode's fixed pitch). */
	fontFamily?: string;
}

export function MentionChipOverlay({
	overlay,
	theme,
	padding,
	fontFamily,
}: MentionChipOverlayProps): JSX.Element | null {
	const colorBlindMode = useSettingsStore((state) => state.colorBlindMode);

	// Chip palette shared with the sent-transcript pill (same fill + border), so
	// the mention reads as the same object whether the user is typing it or reading
	// it back in a bubble.
	const chipColors = useMemo(() => getMentionChipColors(theme), [theme]);

	if (!overlay.overlayRendered) return null;

	// Style for a single mention chip in the LIVE overlay. The overlay sits behind
	// the native <textarea>, so it draws only the chip background and border while
	// the textarea remains the sole source of visible glyphs, caret, and selection.
	// The decoration must add ZERO inline advance or it drifts off the native text
	// (measured >200px on a long path). Two tricks keep it width-exact:
	//   1. The border is drawn with `inset box-shadow`, never `border`/`outline`,
	//      because box-shadow does not participate in layout.
	//   2. The horizontal padding is cancelled by an equal negative margin, so the
	//      fill/rounding read as a padded chip while the glyph run advances exactly
	//      as unstyled text.
	// The bleed is kept SMALLER than the transcript pill's 6px (px-1.5) on purpose:
	// because it adds zero advance, the fill overhangs into the single space that
	// follows the token, and a 6px overhang swallowed nearly all of a ~8px
	// monospace space - leaving the chip visually glued to the next word. 3px keeps
	// a padded look while exposing most of the trailing space as real breathing room
	// (the transcript pill has no caret to track, so it uses full real padding).
	// The type color (file-extension / agent color that the sent pill puts on its
	// icon) becomes a 2px inset accent stripe on the left, so files vs agents still
	// read differently without an icon glyph (an icon WOULD change the advance).
	// box-decoration-break keeps the fill/border intact if a long mention wraps.
	const mentionChipStyle = (typeColor: string): React.CSSProperties => ({
		backgroundColor: chipColors.bg,
		color: 'transparent',
		borderRadius: '6px',
		padding: '0 3px',
		margin: '0 -3px',
		boxShadow: `inset 0 0 0 1px ${chipColors.border}, inset 2px 0 0 ${typeColor}`,
		boxDecorationBreak: 'clone',
		WebkitBoxDecorationBreak: 'clone',
	});

	return (
		<div
			ref={overlay.overlayRef}
			aria-hidden="true"
			className="maestro-input-text-overlay pointer-events-none absolute inset-0 overflow-hidden"
			style={{
				// wordBreak comes from MENTION_OVERLAY_TYPOGRAPHY so it stays in sync
				// with the textarea; only overlay-specific props are set here.
				...MENTION_OVERLAY_TYPOGRAPHY,
				// Track the textarea's font override exactly: measured on a different
				// font, every chip lands off the word it belongs to.
				fontFamily,
				zIndex: 0,
				whiteSpace: 'pre-wrap',
				padding,
				// The overlay paints decoration only. Keeping every glyph transparent
				// prevents doubled text during typing and selection.
				color: 'transparent',
				visibility: overlay.overlayVisible ? 'visible' : 'hidden',
			}}
		>
			{overlay.segments.map((seg, i) => {
				if (seg.kind === 'text') {
					return <span key={i}>{seg.value}</span>;
				}
				// Render the mention as a width-EXACT chip behind the raw token
				// (`@path` / `@name`). It keeps the sent pill's fill + border + a
				// type-color accent, but NOT its icon or truncated label: those change
				// the glyph advance and drift from the native caret (see mentionChipStyle).
				// The compact icon+truncation pill still renders in the sent transcript
				// (RenderedMentionChip), where there is no caret to keep aligned.
				const typeColor =
					seg.kind === 'file'
						? resolveFileMentionIconColor(seg.extension, theme, colorBlindMode)
						: resolveAgentMention(seg.name, theme).color;
				return (
					<span key={i} style={mentionChipStyle(typeColor)}>
						{seg.value}
					</span>
				);
			})}
			{overlay.value.endsWith('\n') && (
				<span data-testid="maestro-input-overlay-trailing-line">{'​'}</span>
			)}
		</div>
	);
}
