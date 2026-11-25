import React, { memo, useRef, useCallback, useLayoutEffect } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';

interface ConfirmModalProps {
	theme: Theme;
	message: string;
	onConfirm: (() => void) | null;
	onClose: () => void;
	title?: string;
	headerIcon?: React.ReactNode;
	icon?: React.ReactNode;
	destructive?: boolean;
	confirmLabel?: string;
	/** Cancel button label. Defaults to 'Cancel'. */
	cancelLabel?: string;
	/** The button that has focus when the dialog opens. Defaults to 'confirm'. */
	initialFocus?: 'confirm' | 'cancel';
	/**
	 * Answer only a key press that began after the dialog mounted (see
	 * `ModalFooter`'s `ignoreHeldKeys`), and take focus in the mount commit
	 * rather than a frame later. When a queued dialog replaces the one just
	 * answered, a held key then neither answers the new one nor lands, for that
	 * frame, in the surface the closing dialog hands focus back to.
	 * Defaults to false.
	 */
	ignoreHeldKeys?: boolean;
	/** Dialog width in pixels. Defaults to 450. */
	width?: number;
	/** Content shown under the message across the full width (a code block). */
	children?: React.ReactNode;
}

export const ConfirmModal = memo(function ConfirmModal({
	theme,
	message,
	onConfirm,
	onClose,
	title = 'Confirm',
	headerIcon,
	icon,
	destructive = true,
	confirmLabel,
	cancelLabel,
	initialFocus = 'confirm',
	ignoreHeldKeys = false,
	width = 450,
	children,
}: ConfirmModalProps) {
	const confirmButtonRef = useRef<HTMLButtonElement>(null);
	const cancelButtonRef = useRef<HTMLButtonElement>(null);
	const initialFocusRef = initialFocus === 'cancel' ? cancelButtonRef : confirmButtonRef;

	// Modal focuses `initialFocusRef` a frame after mount. Claiming the same
	// button in the commit leaves no gap for the layer stack's deferred focus
	// hand-back to put the caret behind the dialog.
	useLayoutEffect(() => {
		if (ignoreHeldKeys) initialFocusRef.current?.focus();
	}, []);

	const handleConfirm = useCallback(() => {
		if (onConfirm) {
			onConfirm();
		}
		onClose();
	}, [onConfirm, onClose]);

	const iconColor = destructive ? theme.colors.error : theme.colors.warning;

	return (
		<Modal
			theme={theme}
			title={title}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={onClose}
			headerIcon={headerIcon ?? <Trash2 className="w-4 h-4" style={{ color: iconColor }} />}
			width={width}
			zIndex={10000}
			initialFocusRef={initialFocusRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleConfirm}
					destructive={destructive}
					confirmLabel={confirmLabel}
					cancelLabel={cancelLabel}
					confirmButtonRef={confirmButtonRef}
					cancelButtonRef={cancelButtonRef}
					ignoreHeldKeys={ignoreHeldKeys}
				/>
			}
		>
			<div className="flex gap-4">
				<div
					className="flex-shrink-0 p-2 rounded-full h-fit"
					style={{ backgroundColor: `${iconColor}20` }}
				>
					{icon ?? <AlertTriangle className="w-5 h-5" style={{ color: iconColor }} />}
				</div>
				<p className="leading-relaxed" style={{ color: theme.colors.textMain }}>
					{message}
				</p>
			</div>
			{children}
		</Modal>
	);
});
