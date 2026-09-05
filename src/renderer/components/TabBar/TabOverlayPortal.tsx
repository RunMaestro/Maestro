/**
 * TabOverlayPortal - the shell every tab chip's action menu is drawn in.
 *
 * One portal, two shapes:
 *
 *   - Desktop (and any viewport wider than a phone): the menu hangs off the
 *     chip like an open folder tab, anchored at the position `useTabHoverOverlay`
 *     measured and faded in once it has been clamped to the viewport. This is
 *     the shell that used to be copy-pasted, byte for byte, into all five chip
 *     components (AI, file, terminal, browser, group).
 *
 *   - Phone (`usePhoneLayout`): a bottom sheet. An anchored popover positioned
 *     off a 40px chip is unusable at 390px - it ran past the bottom of the
 *     screen with no way to scroll it and no way to dismiss it (see the tab menu
 *     screenshot in the mobile pass). The sheet is full width, capped at 80% of
 *     the viewport and scrolls inside, carries its own close button, and goes
 *     away on a swipe down from its grip or a tap on the scrim.
 *
 * The menu CONTENT is unchanged in both shapes; the sheet restyles it through
 * `.maestro-tab-sheet__body` in index.css (full width, finger-sized rows, no
 * shortcut badges), so a menu never has to know which shell it is in.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Theme } from '../../types';
import type { OverlayPosition } from '../../hooks/tabs/useTabHoverOverlay';
import { usePhoneLayout } from '../../hooks/ui/useViewportBreakpoint';
import { useSwipeGestures } from '../../hooks/utils/useSwipeGestures';
import { EscCloseButton } from '../ui/EscCloseButton';

/**
 * How long after the sheet opens a tap on its scrim is ignored. The long-press
 * that opens the sheet ends with the finger lifting off the chip, and the
 * browser can follow that release with synthesized mouse and click events at
 * the finger's position - which is now the scrim, since the sheet covers the
 * chip. Without this the sheet closed the instant the user let go. A real tap
 * on the scrim comes well after the user has read the menu.
 */
export const TAB_SHEET_SCRIM_ARM_MS = 500;

export interface TabOverlayPortalProps {
	/** Whether the menu is open at all. Nothing renders while false. */
	open: boolean;
	/** Anchor measured by `useTabHoverOverlay`; ignored by the phone sheet. */
	position: OverlayPosition | null;
	/** False until the anchored menu has been clamped to the viewport. */
	positionReady: boolean;
	/** `useTabHoverOverlay`'s overlay ref - what click-outside and clamping read. */
	setOverlayRef: (el: HTMLDivElement | null) => void;
	/** Hover bookkeeping for the anchored shape. */
	onMouseEnter: () => void;
	onMouseLeave: () => void;
	/** Close the menu (the sheet's X, scrim, and swipe-down all call this). */
	onClose: () => void;
	theme: Theme;
	children: React.ReactNode;
}

export function TabOverlayPortal({
	open,
	position,
	positionReady,
	setOverlayRef,
	onMouseEnter,
	onMouseLeave,
	onClose,
	theme,
	children,
}: TabOverlayPortalProps) {
	const phone = usePhoneLayout();
	// Swipe-down lives on the grip row only. The body scrolls, and a swipe that
	// starts inside a scrolled list must scroll it, not dismiss the sheet.
	const gripSwipe = useSwipeGestures({ onSwipeDown: onClose, enabled: phone && open });

	const openedAtRef = useRef(0);
	useEffect(() => {
		if (open) openedAtRef.current = Date.now();
	}, [open]);
	const closeFromScrim = useCallback(() => {
		if (Date.now() - openedAtRef.current < TAB_SHEET_SCRIM_ARM_MS) return;
		onClose();
	}, [onClose]);

	if (!open) return null;

	if (phone) {
		// The overlay ref goes on the SCRIM, not the panel: useTabHoverOverlay's
		// click-outside treats anything inside the ref as inside the menu, and the
		// scrim spans the screen, so the sheet owns its own dismissal (scrim tap
		// once armed, the close button, the grip swipe) instead of being closed by
		// the synthesized events that trail the opening long-press.
		return createPortal(
			<div
				ref={setOverlayRef}
				className="maestro-tab-sheet fixed inset-0 z-[100] flex flex-col justify-end"
				onClick={closeFromScrim}
				data-testid="tab-overlay-sheet"
			>
				<div
					role="dialog"
					aria-modal="true"
					aria-label="Tab actions"
					className="maestro-tab-sheet__panel flex flex-col rounded-t-2xl shadow-2xl border-t min-h-0"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.border,
						maxHeight: '80dvh',
					}}
					onClick={(e) => e.stopPropagation()}
				>
					<div
						className="maestro-tab-sheet__grip flex items-center justify-between px-3 pt-2 pb-1 shrink-0"
						data-testid="tab-overlay-sheet-grip"
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
					<div
						className="maestro-tab-sheet__body overflow-y-auto scrollbar-thin min-h-0"
						style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
					>
						{children}
					</div>
				</div>
			</div>,
			document.body
		);
	}

	if (!position) return null;

	return createPortal(
		<div
			ref={setOverlayRef}
			className="fixed z-[100]"
			style={{
				top: position.top,
				left: position.left,
				opacity: positionReady ? 1 : 0,
			}}
			onClick={(e) => e.stopPropagation()}
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
		>
			{children}
		</div>,
		document.body
	);
}
