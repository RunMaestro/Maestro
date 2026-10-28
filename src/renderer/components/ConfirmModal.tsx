import React, { memo, useRef, useCallback } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, MODAL_BUTTON_SECONDARY_CLASS } from './ui/Modal';

/**
 * A third outcome beside Cancel and the confirm button. It is drawn between
 * them and takes the focus when the dialog opens, so it is what Enter chooses:
 * the safe choice of a dialog whose confirm button is a bulk write. Like the
 * confirm button, it closes the dialog after it runs.
 */
export interface ConfirmModalAlternative {
	label: string;
	onSelect: () => void;
}

interface ConfirmModalProps {
	theme: Theme;
	message: React.ReactNode;
	onConfirm: (() => void) | null;
	onClose: () => void;
	title?: string;
	headerIcon?: React.ReactNode;
	icon?: React.ReactNode;
	destructive?: boolean;
	confirmLabel?: string;
	/** Detail drawn under the message: a list of what the confirmation covers. */
	children?: React.ReactNode;
	width?: number;
	/** Raise the dialog over a modal that sits above the default layer. */
	zIndex?: number;
	/** A third outcome, focused by default. See {@link ConfirmModalAlternative}. */
	alternative?: ConfirmModalAlternative;
	testId?: string;
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
	children,
	width = 450,
	zIndex = 10000,
	alternative,
	testId,
}: ConfirmModalProps) {
	const confirmButtonRef = useRef<HTMLButtonElement>(null);
	const alternativeButtonRef = useRef<HTMLButtonElement>(null);

	const handleConfirm = useCallback(() => {
		if (onConfirm) {
			onConfirm();
		}
		onClose();
	}, [onConfirm, onClose]);

	const handleAlternative = useCallback(() => {
		alternative?.onSelect();
		onClose();
	}, [alternative, onClose]);

	const iconColor = destructive ? theme.colors.error : theme.colors.warning;

	return (
		<Modal
			theme={theme}
			title={title}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={onClose}
			headerIcon={headerIcon ?? <Trash2 className="w-4 h-4" style={{ color: iconColor }} />}
			width={width}
			zIndex={zIndex}
			initialFocusRef={alternative ? alternativeButtonRef : confirmButtonRef}
			testId={testId}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleConfirm}
					destructive={destructive}
					confirmLabel={confirmLabel}
					confirmButtonRef={confirmButtonRef}
					between={
						alternative && (
							<button
								ref={alternativeButtonRef}
								type="button"
								onClick={handleAlternative}
								// Enter activates the button itself. Stopping it here keeps a
								// handler under the dialog from acting on the same key.
								onKeyDown={(e) => {
									if (e.key === 'Enter') e.stopPropagation();
								}}
								className={MODAL_BUTTON_SECONDARY_CLASS}
								style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
							>
								{alternative.label}
							</button>
						)
					}
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
				{children ? (
					<div className="min-w-0 flex-1 space-y-3">
						<p className="leading-relaxed" style={{ color: theme.colors.textMain }}>
							{message}
						</p>
						{children}
					</div>
				) : (
					<p className="leading-relaxed" style={{ color: theme.colors.textMain }}>
						{message}
					</p>
				)}
			</div>
		</Modal>
	);
});
