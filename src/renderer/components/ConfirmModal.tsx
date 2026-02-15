import React, { memo, useRef, useCallback, useMemo } from 'react';
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
}: ConfirmModalProps) {
	const confirmButtonRef = useRef<HTMLButtonElement>(null);

	const handleConfirm = useCallback(() => {
		if (onConfirm) {
			onConfirm();
		}
		onClose();
	}, [onConfirm, onClose]);

	const iconColor = destructive ? theme.colors.error : theme.colors.warning;

	const iconBgStyle = useMemo(() => ({
		backgroundColor: `${iconColor}20`,
	}), [iconColor]);

	const iconStyle = useMemo(() => ({
		color: iconColor,
	}), [iconColor]);

	const messageStyle = useMemo(() => ({
		color: theme.colors.textMain,
	}), [theme.colors.textMain]);

	return (
		<Modal
			theme={theme}
			title={title}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={onClose}
			headerIcon={headerIcon ?? <Trash2 className="w-4 h-4" style={iconStyle} />}
			width={450}
			zIndex={10000}
			initialFocusRef={confirmButtonRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleConfirm}
					destructive={destructive}
					confirmLabel={confirmLabel}
					confirmButtonRef={confirmButtonRef}
				/>
			}
		>
			<div className="flex gap-4">
				<div
					className="flex-shrink-0 p-2 rounded-full h-fit"
					style={iconBgStyle}
				>
					{icon ?? <AlertTriangle className="w-5 h-5" style={iconStyle} />}
				</div>
				<p className="leading-relaxed" style={messageStyle}>
					{message}
				</p>
			</div>
		</Modal>
	);
});
