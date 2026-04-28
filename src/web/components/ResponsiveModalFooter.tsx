/**
 * ResponsiveModalFooter - Standard cancel/confirm footer for `ResponsiveModal`.
 *
 * Mirrors the desktop `ModalFooter` API shape (see
 * `src/renderer/components/ui/Modal.tsx` — Phase 4 Task 4.1 notes) while
 * delegating colors and radii to the web `Button` component (which reads live
 * `--maestro-*` theme tokens via Tailwind).
 *
 * Layout contract:
 * - Tablet+: cancel and confirm render side-by-side. The enclosing
 *   `ResponsiveModal` footer wrapper supplies `flex justify-end gap-2`, so the
 *   buttons are right-aligned with cancel on the left and confirm on the right.
 * - Phone: the parent wrapper switches to `flex flex-col gap-2`, so stacking is
 *   handled upstream; this component responds by widening both buttons to the
 *   full width of the wrapper (`fullWidth`), matching the 44px+ tap-target rule
 *   established in `src/web/index.css`.
 *
 * Desktop parity notes:
 * - Enter on either button stops propagation so an outer `<form>` / parent key
 *   handler doesn't also fire when the modal closes. The browser still
 *   synthesizes a click on Enter for `type="button"`, which drives `onClick`,
 *   so the handler is invoked exactly once. Same defense as desktop
 *   `ModalFooter`.
 * - `destructive` swaps the confirm variant to `danger` (error-red background).
 * - `confirmButtonRef` is forwarded to the confirm button so consumers can
 *   point `initialFocusRef` at it from the `ConfirmModal`-style composition.
 */

import React from 'react';
import { Button } from './Button';
import { useBreakpoint } from '../hooks/useBreakpoint';

export interface ResponsiveModalFooterProps {
	/** Cancel button click handler */
	onCancel: () => void;
	/** Confirm button click handler */
	onConfirm: () => void;
	/** Cancel button label. Defaults to 'Cancel'. */
	cancelLabel?: string;
	/** Confirm button label. Defaults to 'Confirm'. */
	confirmLabel?: string;
	/** When true, confirm renders with the `danger` variant (error red). */
	destructive?: boolean;
	/**
	 * Ref attached to the confirm button — useful as the modal's initial
	 * focus target. Matches Button's `forwardRef<HTMLButtonElement>` slot
	 * (`@types/react` v18, where `useRef<HTMLButtonElement>(null)` returns
	 * `RefObject<HTMLButtonElement>`).
	 */
	confirmButtonRef?: React.RefObject<HTMLButtonElement>;
}

export function ResponsiveModalFooter({
	onCancel,
	onConfirm,
	cancelLabel = 'Cancel',
	confirmLabel = 'Confirm',
	destructive = false,
	confirmButtonRef,
}: ResponsiveModalFooterProps) {
	const { isPhone } = useBreakpoint();

	// Stop Enter from bubbling to a parent <form>/key handler. The browser
	// still synthesizes a click on Enter for `type="button"`, which drives
	// onClick, so we don't invoke the handler here (doing so would
	// double-fire in real browsers).
	const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
		if (e.key === 'Enter') {
			e.stopPropagation();
		}
	};

	return (
		<>
			<Button
				type="button"
				variant="secondary"
				onClick={onCancel}
				onKeyDown={handleKeyDown}
				fullWidth={isPhone}
			>
				{cancelLabel}
			</Button>
			<Button
				ref={confirmButtonRef}
				type="button"
				variant={destructive ? 'danger' : 'primary'}
				onClick={onConfirm}
				onKeyDown={handleKeyDown}
				fullWidth={isPhone}
			>
				{confirmLabel}
			</Button>
		</>
	);
}

export default ResponsiveModalFooter;
