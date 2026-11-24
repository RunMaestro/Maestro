/**
 * DesignPickChips - the Design Mode picks staged on the composer, one chip each.
 *
 * A pick from a browser tab's Design Mode lands here (`stageDesignPickOnAgent`)
 * instead of as text in the draft: a thumbnail, a short label, and the note.
 * The full element block (selector, styles, HTML) stays on the chip until the
 * message is sent, so four picks read as four chips rather than four screens of
 * selectors. Like the attachment chips in other design tools, the row is
 * compact, one line high, and scrolls sideways when it fills up.
 *
 * Clicking a chip opens a popover above it with the full block (read-only, so
 * the user can check what the agent will get) and the note (editable). The
 * note is saved when the popover closes, however it closes. The X removes the
 * chip.
 *
 * Modeled on StagedImagesStrip: the same tokens, spacing, and remove control.
 */

import {
	memo,
	useCallback,
	useEffect,
	useRef,
	useState,
	type FocusEvent,
	type KeyboardEvent,
	type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { ImageOff } from 'lucide-react';
import type { StagedDesignPick, Theme } from '../../../types';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { useAnchoredMenuPosition } from '../../../hooks/ui/useAnchoredMenuPosition';
import { useClickOutside } from '../../../hooks/ui/useClickOutside';
import { useModalLayer } from '../../../hooks/ui/useModalLayer';
import { usePhoneLayout } from '../../../hooks/ui/useViewportBreakpoint';
import { useFocusOnMount } from '../../../hooks/utils/useFocusAfterRender';
import { elevatedSurfaceStyle } from '../../../utils/elevatedSurface';
import { displayImageSrc } from '../../../utils/sessionImageSrc';
import { EscCloseButton } from '../../ui/EscCloseButton';
import { RemoveBadgeButton } from '../../ui/RemoveBadgeButton';

interface DesignPickChipsProps {
	isVisible: boolean;
	/** The composer tab's staged picks, in pick order. */
	picks: StagedDesignPick[];
	theme: Theme;
	/** Save a chip's note. Called as its popover closes, only when the note changed. */
	onNoteChange: (pickId: string, note: string) => void;
	onRemove: (pickId: string) => void;
}

export const DesignPickChips = memo(function DesignPickChips({
	isVisible,
	picks,
	theme,
	onNoteChange,
	onRemove,
}: DesignPickChipsProps) {
	const [openPickId, setOpenPickId] = useState<string | null>(null);
	const togglePick = useCallback(
		(pickId: string) => setOpenPickId((open) => (open === pickId ? null : pickId)),
		[]
	);
	const closePick = useCallback(() => setOpenPickId(null), []);

	const shown = isVisible && picks.length > 0;
	// Forget the open chip once it is not drawn (removed, sent, another tab's
	// chips on screen, the strip hidden), so its popover does not spring back
	// open when that chip is next on screen.
	if (openPickId !== null && !(shown && picks.some((pick) => pick.id === openPickId))) {
		setOpenPickId(null);
	}
	if (!shown) return null;

	return (
		<div
			className="flex gap-2 pb-2 mb-3 overflow-x-auto scrollbar-thin select-none"
			role="list"
			aria-label="Design Mode picks"
			data-testid="design-pick-chips"
		>
			{picks.map((pick) => (
				<DesignPickChip
					key={pick.id}
					pick={pick}
					theme={theme}
					isOpen={openPickId === pick.id}
					onToggle={togglePick}
					onClose={closePick}
					onNoteChange={onNoteChange}
					onRemove={onRemove}
				/>
			))}
		</div>
	);
});

interface DesignPickChipProps {
	pick: StagedDesignPick;
	theme: Theme;
	isOpen: boolean;
	onToggle: (pickId: string) => void;
	onClose: () => void;
	onNoteChange: (pickId: string, note: string) => void;
	onRemove: (pickId: string) => void;
}

const DesignPickChip = memo(function DesignPickChip({
	pick,
	theme,
	isOpen,
	onToggle,
	onClose,
	onNoteChange,
	onRemove,
}: DesignPickChipProps) {
	// The popover hangs off the whole chip, and a press anywhere on the chip
	// (its X included) is not a click outside the popover: the chip toggles it,
	// the X removes the chip with it.
	const chipRef = useRef<HTMLDivElement>(null);

	return (
		<div
			ref={chipRef}
			role="listitem"
			className="shrink-0 flex items-center gap-1 h-11 max-w-[16rem] rounded-lg border pr-1.5"
			style={{
				borderColor: isOpen ? theme.colors.accent : theme.colors.border,
				backgroundColor: theme.colors.bgMain,
			}}
			data-testid="design-pick-chip"
		>
			<button
				type="button"
				onClick={() => onToggle(pick.id)}
				aria-haspopup="dialog"
				aria-expanded={isOpen}
				aria-label={`Design Mode pick ${pick.label}`}
				title={pick.note ? `${pick.label}\n${pick.note}` : pick.label}
				// The chip's own radius, so the hover wash stays inside its border. Inset
				// ring: the strip scrolls, and a scroller clips what its children draw
				// outside themselves.
				className="row-hover min-w-0 flex flex-1 items-center gap-2 self-stretch rounded-lg pl-1 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
			>
				<DesignPickThumbnail pick={pick} theme={theme} className="w-9 h-9" fit="cover" />
				<span className="min-w-0 flex flex-col leading-tight">
					<span className="text-xs font-mono truncate" style={{ color: theme.colors.textMain }}>
						{pick.label}
					</span>
					{pick.note ? (
						<span className="text-2xs truncate" style={{ color: theme.colors.textDim }}>
							{pick.note}
						</span>
					) : null}
				</span>
			</button>
			<RemoveBadgeButton
				label={`Remove pick ${pick.label}`}
				onRemove={() => onRemove(pick.id)}
				className="shrink-0"
			/>
			{isOpen ? (
				<DesignPickPopover
					anchorRef={chipRef}
					pick={pick}
					theme={theme}
					onClose={onClose}
					onNoteChange={onNoteChange}
				/>
			) : null}
		</div>
	);
});

/** A pick's screenshot, or a placeholder when the element was off screen. */
function DesignPickThumbnail({
	pick,
	theme,
	className,
	fit,
}: {
	pick: StagedDesignPick;
	theme: Theme;
	className: string;
	fit: 'cover' | 'contain';
}) {
	const boxStyle = { borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity };
	if (!pick.screenshot) {
		return (
			<span
				className={`shrink-0 rounded border flex items-center justify-center ${className}`}
				style={boxStyle}
				data-testid="design-pick-no-screenshot"
			>
				<ImageOff className="w-4 h-4" style={{ color: theme.colors.textDim }} aria-hidden />
			</span>
		);
	}
	return (
		<img
			src={displayImageSrc(pick.screenshot)}
			alt=""
			draggable={false}
			className={`shrink-0 rounded border ${className}`}
			style={{ ...boxStyle, objectFit: fit }}
		/>
	);
}

interface DesignPickPopoverProps {
	/** The chip the popover hangs off, and leaves alone on a click outside. */
	anchorRef: RefObject<HTMLElement | null>;
	pick: StagedDesignPick;
	theme: Theme;
	onClose: () => void;
	onNoteChange: (pickId: string, note: string) => void;
}

/**
 * The full block a chip adds to the message, read-only, and its note.
 *
 * Portaled to the body and placed from the chip's rect, above it: the strip
 * scrolls, and a scroller clips anything that hangs outside it.
 */
function DesignPickPopover({
	anchorRef,
	pick,
	theme,
	onClose,
	onNoteChange,
}: DesignPickPopoverProps) {
	const popoverRef = useRef<HTMLDivElement>(null);
	const noteRef = useRef<HTMLTextAreaElement>(null);
	const [note, setNote] = useState(pick.note);
	const phone = usePhoneLayout();
	const { left, top, maxHeight, ready } = useAnchoredMenuPosition(popoverRef, anchorRef, {
		placement: 'above',
	});

	// The note is saved as the popover goes away, however it goes: Enter, Done,
	// Escape, a click outside, or the chip leaving the composer under it (sent,
	// removed elsewhere, the tab switched). Refs, so the save on unmount sees
	// the last keystroke, and saves it once.
	const draftRef = useRef(pick.note);
	draftRef.current = note;
	const savedRef = useRef(pick.note);
	const onNoteChangeRef = useRef(onNoteChange);
	onNoteChangeRef.current = onNoteChange;
	const pickId = pick.id;
	const saveNote = useCallback(() => {
		if (draftRef.current.trim() === savedRef.current.trim()) return;
		savedRef.current = draftRef.current;
		onNoteChangeRef.current(pickId, draftRef.current);
	}, [pickId]);
	useEffect(() => saveNote, [saveNote]);

	const close = useCallback(() => {
		saveNote();
		onClose();
	}, [saveNote, onClose]);

	useModalLayer(MODAL_PRIORITIES.DESIGN_PICK_POPOVER, 'Design Mode pick', close);
	// Mousedown, not click: a drag that selects text in the block and lets go
	// outside the popover is not a click outside it.
	useClickOutside([popoverRef, anchorRef], close);
	// Keyboard first: land in the note. Not on a phone, where focusing a field
	// raises the keyboard over the block the user opened this to read.
	useFocusOnMount(noteRef, undefined, !phone);

	// The first focus puts the caret after the note, to add to it.
	const caretPlacedRef = useRef(false);
	const handleNoteFocus = (event: FocusEvent<HTMLTextAreaElement>) => {
		if (caretPlacedRef.current) return;
		caretPlacedRef.current = true;
		const end = event.currentTarget.value.length;
		event.currentTarget.setSelectionRange(end, end);
	};

	// Enter saves and closes, as Enter adds a pick in Design Mode's own card;
	// Shift+Enter is a newline.
	const handleNoteKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		event.stopPropagation();
		close();
	};

	return createPortal(
		<div
			ref={popoverRef}
			role="dialog"
			aria-label={`Design Mode pick ${pick.label}`}
			className="fixed z-[100] flex flex-col gap-2 p-3 rounded-lg overflow-y-auto w-[min(30rem,calc(100vw-1rem))] select-none"
			style={{
				left,
				top,
				// Unbounded (Infinity) until measured, which is not a CSS length.
				maxHeight: Number.isFinite(maxHeight) ? maxHeight : undefined,
				opacity: ready ? 1 : 0,
				...elevatedSurfaceStyle(theme),
				color: theme.colors.textMain,
			}}
			data-testid="design-pick-popover"
		>
			<div className="flex items-start gap-3 shrink-0">
				<DesignPickThumbnail pick={pick} theme={theme} className="w-20 h-14" fit="contain" />
				<div className="min-w-0 flex-1">
					<div className="text-sm font-mono font-medium truncate" title={pick.label}>
						{pick.label}
					</div>
					<div
						className="text-xs truncate mt-0.5 select-text"
						style={{ color: theme.colors.textDim }}
						title={pick.url}
					>
						{pick.url}
					</div>
				</div>
				<EscCloseButton theme={theme} onClose={close} testId="design-pick-popover-close" />
			</div>

			{/* Exactly what the chip adds to the message ahead of its note. */}
			<pre
				className="min-h-0 max-h-48 overflow-auto rounded border px-2 py-1.5 text-xs font-mono whitespace-pre-wrap break-words select-text scrollbar-thin"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
				// Focusable so the keyboard can scroll it.
				tabIndex={0}
				aria-label="What this pick adds to the message"
				data-testid="design-pick-popover-block"
			>
				{pick.text}
			</pre>

			<textarea
				ref={noteRef}
				value={note}
				onChange={(event) => setNote(event.target.value)}
				onFocus={handleNoteFocus}
				onKeyDown={handleNoteKeyDown}
				rows={2}
				placeholder="Note (optional): what should change?"
				aria-label="Note for the agent"
				className="shrink-0 w-full resize-none rounded border px-2 py-1.5 text-sm outline-none select-text"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
				data-testid="design-pick-popover-note"
			/>

			<div className="flex justify-end shrink-0">
				<button
					type="button"
					onClick={close}
					className="px-2.5 py-1 rounded text-xs font-medium transition-colors hover:opacity-90 outline-none focus-visible:ring-2 focus-visible:ring-accent"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
					title="Save the note (Enter)"
					data-testid="design-pick-popover-done"
				>
					Done
				</button>
			</div>
		</div>,
		document.body
	);
}
