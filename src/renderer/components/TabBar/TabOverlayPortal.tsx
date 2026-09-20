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
 *   - Phone (`usePhoneLayout`): a bottom sheet, drawn by the shared
 *     `<PhoneBottomSheet>`. An anchored popover positioned off a 40px chip is
 *     unusable at 390px - it ran past the bottom of the screen with no way to
 *     scroll it and no way to dismiss it (see the tab menu screenshot in the
 *     mobile pass).
 *
 * The menu CONTENT is unchanged in both shapes; the sheet restyles it through
 * `.maestro-tab-sheet__body` in index.css (full width, finger-sized rows, no
 * shortcut badges), so a menu never has to know which shell it is in.
 */

import React from 'react';
import { createPortal } from 'react-dom';
import type { Theme } from '../../types';
import type { OverlayPosition } from '../../hooks/tabs/useTabHoverOverlay';
import { usePhoneLayout } from '../../hooks/ui/useViewportBreakpoint';
import { PhoneBottomSheet, PHONE_SHEET_SCRIM_ARM_MS } from '../ui/PhoneBottomSheet';

/**
 * Re-exported under its original name: the scrim arm delay was written for this
 * menu's long-press gesture and its tests still name it that way.
 */
export const TAB_SHEET_SCRIM_ARM_MS = PHONE_SHEET_SCRIM_ARM_MS;

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

	if (!open) return null;

	if (phone) {
		// The overlay ref goes on the SCRIM, not the panel: useTabHoverOverlay's
		// click-outside treats anything inside the ref as inside the menu, and the
		// scrim spans the screen, so the sheet owns its own dismissal (scrim tap
		// once armed, the close button, the grip swipe) instead of being closed by
		// the synthesized events that trail the opening long-press.
		return (
			<PhoneBottomSheet
				open
				onClose={onClose}
				theme={theme}
				ariaLabel="Tab actions"
				scrimRef={setOverlayRef}
				scrimClassName="maestro-tab-sheet"
				bodyClassName="maestro-tab-sheet__body"
				testId="tab-overlay-sheet"
			>
				{children}
			</PhoneBottomSheet>
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
