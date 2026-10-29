/**
 * ComposerTextarea - the chat composer's `<textarea>` with its live `@mention`
 * chips, shared by the AI composer and the Group Chat composer.
 *
 * It knows nothing about sessions, tabs or rooms. The surface passes the
 * value, the placeholder, the roster the chips match against
 * (`knownMentionNames`), and its own handlers. Surface-only decoration (the AI
 * composer's `$` prefix and fixed-pitch command font) arrives through `prefix`
 * and `fontFamily`; autosize stays with the surface, since the AI composer
 * sizes on its own keystroke path.
 *
 * It reads no store, so it renders exactly when its surface does. A surface
 * that gates its roster reads (the AI composer subscribes to the session list
 * only while the draft holds an `@`) keeps that gate in its own component.
 */

import React, { memo } from 'react';
import type { Theme } from '../../types';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT } from '../../utils/textareaSizing';
import {
	MENTION_OVERLAY_TYPOGRAPHY,
	MentionChipOverlay,
	useMentionChipOverlay,
} from '../MentionChipOverlay';

/**
 * The two composer heights in use. The padding classes and the overlay
 * padding must stay identical, or the chips drift off the caret.
 *
 * - 2 rows (AI chat): `pt-3 pr-3 pb-1`, 3.5rem tall at rest. The 12px top and
 *   4px bottom padding leave exactly 160px of text inside the 176px cap, 8 whole
 *   20px rows, so bottom-snapping never slices a row.
 * - 1 row (Group Chat): `pt-3 pr-3`, 2.5rem tall at rest.
 */
const GEOMETRY = {
	1: { className: 'pt-3 pr-3 min-h-[2.5rem]', overlayPadding: '0.75rem 0.75rem 0 0.75rem' },
	2: {
		className: 'pt-3 pr-3 pb-1 min-h-[3.5rem]',
		overlayPadding: '0.75rem 0.75rem 0.25rem 0.75rem',
	},
} as const;

export interface ComposerTextareaProps {
	theme: Theme;
	value: string;
	inputRef: React.RefObject<HTMLTextAreaElement>;
	placeholder: string;
	spellCheck: boolean;
	/**
	 * The names a bare `@word` chips for. Pass undefined while the draft holds
	 * no `@`, so the surface need not build (or subscribe to) a roster then.
	 */
	knownMentionNames?: ReadonlySet<string>;
	/** Draw mention chips at all. Off for the AI terminal composer. Default true. */
	mentionChips?: boolean;
	/** Rows at rest; picks the geometry above. Default 2. */
	rows?: 1 | 2;
	/** Drawn before the textarea, which then narrows its left padding. */
	prefix?: React.ReactNode;
	/** Overrides the shared composer font on the textarea and the chips alike. */
	fontFamily?: string;
	/** Read-only keeps focus (disabled would not), so keys still reach onKeyDown. */
	readOnly?: boolean;
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
	onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	onDrop: (e: React.DragEvent<HTMLTextAreaElement>) => void;
	onFocus?: () => void;
	onBlur?: () => void;
}

export const ComposerTextarea = memo(function ComposerTextarea({
	theme,
	value,
	inputRef,
	placeholder,
	spellCheck,
	knownMentionNames,
	mentionChips = true,
	rows = 2,
	prefix,
	fontFamily,
	readOnly,
	onChange,
	onKeyDown,
	onPaste,
	onDrop,
	onFocus,
	onBlur,
}: ComposerTextareaProps) {
	const mentionOverlay = useMentionChipOverlay({
		inputRef,
		value,
		enabled: mentionChips,
		knownMentionNames,
	});
	const geometry = GEOMETRY[rows];

	return (
		<div className="relative flex items-start">
			{prefix}
			<MentionChipOverlay
				overlay={mentionOverlay}
				theme={theme}
				padding={geometry.overlayPadding}
				fontFamily={fontFamily}
			/>
			<textarea
				ref={inputRef}
				className={`relative flex-1 bg-transparent text-sm outline-none ${prefix ? 'pl-1.5' : 'pl-3'} ${geometry.className} resize-none scrollbar-thin`}
				style={{
					...MENTION_OVERLAY_TYPOGRAPHY,
					// Native text is always visible. The overlay underneath contributes only
					// the mention chip decoration, never a second copy of the glyphs.
					color: theme.colors.textMain,
					caretColor: theme.colors.textMain,
					// Single source of truth with the resize logic: the CSS cap and
					// resizeTextareaToContent's clamp can never disagree.
					maxHeight: `${KEYSTROKE_TEXTAREA_MAX_HEIGHT}px`,
					// Sit above the decorative overlay so the caret + native selection win.
					zIndex: mentionOverlay.overlayRendered ? 1 : undefined,
					// Set after MENTION_OVERLAY_TYPOGRAPHY so it wins, and left undefined
					// otherwise so the shared value stands.
					fontFamily,
				}}
				placeholder={placeholder}
				value={value}
				readOnly={readOnly}
				spellCheck={spellCheck}
				onFocus={onFocus}
				onBlur={() => {
					mentionOverlay.onBlur();
					onBlur?.();
				}}
				onChange={(e) => {
					mentionOverlay.onSelectionChange(e.currentTarget);
					onChange(e);
				}}
				onSelect={(e) => mentionOverlay.onSelectionChange(e.currentTarget)}
				onScroll={mentionOverlay.onScroll}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
				onDrop={onDrop}
				onDragOver={(e) => e.preventDefault()}
				rows={rows}
			/>
		</div>
	);
});
