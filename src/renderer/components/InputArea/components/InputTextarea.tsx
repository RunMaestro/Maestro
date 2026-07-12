import React, { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Session, Group, Theme } from '../../../types';
import { getProviderDisplayName } from '../../../utils/sessionValidation';
import { useSettingsStore } from '../../../stores/settingsStore';
import { tokenizeMentions } from '../../../../shared/mentionPatterns';
import { getMentionChipColors } from '../../MentionChip';
import {
	resolveAgentMention,
	resolveFileMentionIconColor,
} from '../../../utils/mentionChipResolve';
import { useSessionStore } from '../../../stores/sessionStore';
import { buildKnownMentionNameSet } from '../../../hooks/input/useAgentMentionCompletion';
import { useEventListener } from '../../../hooks/utils/useEventListener';

interface InputTextareaProps {
	session: Session;
	theme: Theme;
	isTerminalMode: boolean;
	inputValue: string;
	spellCheckEnabled: boolean;
	inputRef: React.RefObject<HTMLTextAreaElement>;
	onInputFocus: () => void;
	onInputBlur?: () => void;
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
	handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	handleDrop: (e: React.DragEvent<HTMLElement>) => void;
}

/**
 * Typography the native textarea and the decorative overlay MUST share
 * exactly, or the mention highlights drift away from the caret. Pulled into one
 * constant so the two layers can never disagree (font size / line height /
 * family / letter spacing). Padding is kept in sync separately: the textarea
 * uses `pt-3 pl-3 pr-3` classes; the overlay mirrors them as `0.75rem` below.
 */
const SHARED_TYPOGRAPHY: React.CSSProperties = {
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

// Stable empty references so the gated sessions/groups selectors return the same
// value on every render while the composer has no `@` - no re-render churn from
// unrelated streaming flushes.
const EMPTY_SESSIONS: Session[] = [];
const EMPTY_GROUPS: Group[] = [];

export const InputTextarea = memo(function InputTextarea({
	session,
	theme,
	isTerminalMode,
	inputValue,
	spellCheckEnabled,
	inputRef,
	onInputFocus,
	onInputBlur,
	onChange,
	handleInputKeyDown,
	handlePaste,
	handleDrop,
}: InputTextareaProps) {
	const colorBlindMode = useSettingsStore((state) => state.colorBlindMode);

	// The chip overlay is an AI-mode enhancement. In terminal mode (shell
	// commands) the textarea behaves exactly as before: opaque text, no overlay.
	const overlayEnabled = !isTerminalMode;

	const overlayRef = useRef<HTMLDivElement>(null);
	const [hasSelection, setHasSelection] = useState(false);

	// The mentionable agent/group roster (from this agent's vantage point).
	// A bare `@word` only lights up when it names a known agent/group; unknown
	// words stay plain text. Excludes the current agent (can't @-mention itself).
	//
	// Only subscribe to the roster when the input actually contains an `@`.
	// `sessions` is replaced on every streaming flush from ANY agent, so gating
	// the SELECTORS (not just the derived memo) keeps an `@`-free composer from
	// re-rendering on unrelated output - the stable empty refs compare equal.
	const hasMentionCandidate = overlayEnabled && inputValue.includes('@');
	const sessions = useSessionStore((state) =>
		hasMentionCandidate ? state.sessions : EMPTY_SESSIONS
	);
	const groups = useSessionStore((state) => (hasMentionCandidate ? state.groups : EMPTY_GROUPS));
	const knownMentionNames = useMemo(
		() =>
			hasMentionCandidate ? buildKnownMentionNameSet(sessions, groups, session.id) : undefined,
		[hasMentionCandidate, sessions, groups, session.id]
	);

	// Tokenize the raw input into text / file / agent segments. Same source of
	// truth as the picker + dispatch scanner, so the overlay can never disagree
	// about what counts as a mention.
	const segments = useMemo(
		() => (overlayEnabled ? tokenizeMentions(inputValue, knownMentionNames) : []),
		[overlayEnabled, inputValue, knownMentionNames]
	);
	const overlayRendered = overlayEnabled && segments.some((segment) => segment.kind !== 'text');
	const overlayVisible = overlayRendered && !hasSelection;

	const updateSelectionState = (target: HTMLTextAreaElement) => {
		const nextHasSelection = target.selectionStart !== target.selectionEnd;
		setHasSelection((current) => (current === nextHasSelection ? current : nextHasSelection));
	};

	// React's textarea onSelect fires on mouseup, after a drag selection has
	// already become visible. Track the document selectionchange event so the
	// decorative layer disappears during the drag itself.
	useEventListener(
		'selectionchange',
		() => {
			const textarea = inputRef.current;
			if (!textarea || document.activeElement !== textarea) return;
			updateSelectionState(textarea);
		},
		{
			target: typeof document !== 'undefined' ? document : null,
			enabled: overlayRendered,
		}
	);

	// Keep the decorative overlay pinned to the textarea's scroll position so the
	// mention highlights track the text as the input grows past one line.
	const syncOverlayScroll = (target: HTMLTextAreaElement) => {
		const el = overlayRef.current;
		if (!el) return;
		el.scrollTop = target.scrollTop;
		el.scrollLeft = target.scrollLeft;
	};

	// A newly mounted overlay misses any scroll that happened before the mention
	// became recognizable. Sync after the textarea resize/scroll frame so its
	// first painted position matches the native text.
	useLayoutEffect(() => {
		if (!overlayRendered) return;

		const frameId = requestAnimationFrame(() => {
			const textarea = inputRef.current;
			if (textarea) syncOverlayScroll(textarea);
		});

		return () => cancelAnimationFrame(frameId);
	}, [inputRef, inputValue, overlayRendered]);

	// Chip palette shared with the sent-transcript pill (same fill + border), so
	// the mention reads as the same object whether the user is typing it or reading
	// it back in a bubble.
	const chipColors = useMemo(() => getMentionChipColors(theme), [theme]);

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
		<div className="relative flex items-start">
			{isTerminalMode && (
				<span
					className="text-sm font-mono font-bold select-none pl-3 pt-3"
					style={{ color: theme.colors.accent }}
				>
					$
				</span>
			)}
			{overlayRendered && (
				<div
					ref={overlayRef}
					aria-hidden="true"
					className="maestro-input-text-overlay pointer-events-none absolute inset-0 overflow-hidden"
					style={{
						// wordBreak comes from SHARED_TYPOGRAPHY so it stays in sync with
						// the textarea; only overlay-specific props are set here.
						...SHARED_TYPOGRAPHY,
						zIndex: 0,
						whiteSpace: 'pre-wrap',
						padding: '0.75rem 0.75rem 0 0.75rem',
						// The overlay paints decoration only. Keeping every glyph transparent
						// prevents doubled text during typing and selection.
						color: 'transparent',
						visibility: overlayVisible ? 'visible' : 'hidden',
					}}
				>
					{segments.map((seg, i) => {
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
				</div>
			)}
			<textarea
				ref={inputRef}
				className={`relative flex-1 bg-transparent text-sm outline-none ${isTerminalMode ? 'pl-1.5' : 'pl-3'} pt-3 pr-3 resize-none min-h-[3.5rem] scrollbar-thin`}
				style={{
					...SHARED_TYPOGRAPHY,
					// Native text is always visible. The overlay underneath contributes only
					// the mention chip decoration, never a second copy of the glyphs.
					color: theme.colors.textMain,
					caretColor: theme.colors.textMain,
					maxHeight: '11rem',
					// Sit above the decorative overlay so the caret + native selection win.
					zIndex: overlayRendered ? 1 : undefined,
				}}
				placeholder={
					isTerminalMode
						? 'Run shell command...'
						: `Talking to ${session.name} powered by ${getProviderDisplayName(session.toolType)}`
				}
				value={inputValue}
				spellCheck={spellCheckEnabled}
				onFocus={onInputFocus}
				onBlur={onInputBlur}
				onChange={(e) => {
					updateSelectionState(e.currentTarget);
					onChange(e);
				}}
				onSelect={(e) => updateSelectionState(e.currentTarget)}
				onScroll={overlayRendered ? (e) => syncOverlayScroll(e.currentTarget) : undefined}
				onKeyDown={handleInputKeyDown}
				onPaste={handlePaste}
				onDrop={(e) => {
					e.stopPropagation();
					handleDrop(e);
				}}
				onDragOver={(e) => e.preventDefault()}
				rows={2}
			/>
		</div>
	);
});
