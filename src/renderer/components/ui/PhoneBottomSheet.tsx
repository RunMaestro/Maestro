/**
 * PhoneBottomSheet - the bottom-sheet shell every phone surface that is a
 * popover on desktop is drawn in.
 *
 * An anchored popover is unusable at 390px: measured off a 40px control it runs
 * past the bottom of the screen with no way to scroll it and no way to dismiss
 * it. The sheet is full width, capped at a share of the viewport, scrolls
 * inside, carries its own close button, and goes away on a swipe down from its
 * grip or a tap on the scrim.
 *
 * Two callers today - the tab chip action menu (`TabOverlayPortal`) and the
 * composer options sheet (`ComposerOptionsSheet`) - and the shell was written
 * once for the first before the second needed the same thing. What differs
 * between them is CONTENT and the body's styling hook, never the chrome, so
 * everything about how the sheet behaves lives here: the scrim arm delay, the
 * grip-only swipe, the safe-area padding, the animations.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Theme } from '../../types';
import { useSwipeGestures } from '../../hooks/utils/useSwipeGestures';
import { EscCloseButton } from './EscCloseButton';

/**
 * How long after the sheet opens a tap on its scrim is ignored. A sheet opened
 * by a long-press ends with the finger lifting off the control, and the browser
 * can follow that release with synthesized mouse and click events at the
 * finger's position - which is now the scrim, since the sheet covers the
 * control. Without this the sheet closed the instant the user let go. A real
 * tap on the scrim comes well after the user has read the menu.
 */
export const PHONE_SHEET_SCRIM_ARM_MS = 500;

export interface PhoneBottomSheetProps {
	/** Whether the sheet is open. Nothing renders while false. */
	open: boolean;
	/** Close it. The X, the scrim, and the grip swipe all call this. */
	onClose: () => void;
	theme: Theme;
	/** Accessible name for the dialog. */
	ariaLabel: string;
	/**
	 * How tall the panel may grow, as a CSS length. `80dvh` for a menu that
	 * should stay out of the way, `50dvh` for a panel the user works inside.
	 */
	maxHeight?: string;
	/**
	 * Ref for the SCRIM, not the panel. `TabOverlayPortal` hands its hover
	 * overlay's ref here so click-outside treats the whole screen as inside the
	 * menu, leaving the sheet to own its own dismissal.
	 */
	scrimRef?: (el: HTMLDivElement | null) => void;
	/** Extra class on the scrim (its `maestro-tab-sheet` styling hook). */
	scrimClassName?: string;
	/** Extra class on the scrolling body (a caller's own styling hook). */
	bodyClassName?: string;
	/**
	 * How long scrim taps are ignored after opening. Defaults to
	 * {@link PHONE_SHEET_SCRIM_ARM_MS}; pass 0 for a sheet opened by a plain tap,
	 * where no synthesized click trails the gesture.
	 */
	scrimArmMs?: number;
	/** Optional row rendered between the grip and the scrolling body. */
	header?: React.ReactNode;
	testId?: string;
	children: React.ReactNode;
}

export function PhoneBottomSheet({
	open,
	onClose,
	theme,
	ariaLabel,
	maxHeight = '80dvh',
	scrimRef,
	scrimClassName = '',
	bodyClassName = '',
	scrimArmMs = PHONE_SHEET_SCRIM_ARM_MS,
	header,
	testId,
	children,
}: PhoneBottomSheetProps) {
	// Swipe-down lives on the grip row only. The body scrolls, and a swipe that
	// starts inside a scrolled list must scroll it, not dismiss the sheet.
	const gripSwipe = useSwipeGestures({ onSwipeDown: onClose, enabled: open });

	const openedAtRef = useRef(0);
	useEffect(() => {
		if (open) openedAtRef.current = Date.now();
	}, [open]);
	const closeFromScrim = useCallback(() => {
		if (Date.now() - openedAtRef.current < scrimArmMs) return;
		onClose();
	}, [onClose, scrimArmMs]);

	if (!open) return null;

	return createPortal(
		<div
			ref={scrimRef}
			className={`maestro-phone-sheet fixed inset-0 z-[100] flex flex-col justify-end ${scrimClassName}`}
			onClick={closeFromScrim}
			data-testid={testId}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={ariaLabel}
				className="maestro-phone-sheet__panel flex flex-col rounded-t-2xl shadow-2xl border-t min-h-0"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					maxHeight,
				}}
				onClick={(e) => e.stopPropagation()}
			>
				<div
					className="maestro-phone-sheet__grip flex items-center justify-between px-3 pt-2 pb-1 shrink-0"
					data-testid={testId ? `${testId}-grip` : undefined}
					{...gripSwipe.handlers}
				>
					{/* Spacer balances the close button so the grip pill is centered. */}
					<span className="w-8 shrink-0" aria-hidden="true" />
					<span
						className="h-1 w-10 rounded-full"
						style={{ backgroundColor: theme.colors.border }}
						aria-hidden="true"
					/>
					<EscCloseButton theme={theme} onClose={onClose} label="Close" />
				</div>
				{header}
				<div
					className={`overflow-y-auto scrollbar-thin min-h-0 ${bodyClassName}`}
					style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
				>
					{children}
				</div>
			</div>
		</div>,
		document.body
	);
}
