import React, { memo, useRef, useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';

interface ForcedParallelWarningModalProps {
	isOpen: boolean;
	onConfirm: () => void;
	onCancel: () => void;
	theme: Theme;
}

export const ForcedParallelWarningModal = memo(function ForcedParallelWarningModal({
	isOpen,
	onConfirm,
	onCancel,
	theme,
}: ForcedParallelWarningModalProps) {
	const confirmButtonRef = useRef<HTMLButtonElement>(null);

	const handleConfirm = useCallback(() => {
		onConfirm();
	}, [onConfirm]);

	if (!isOpen) return null;

	const warningColor = theme.colors.warning;

	return (
		<Modal
			theme={theme}
			title="Forced Parallel Execution"
			priority={MODAL_PRIORITIES.FORCED_PARALLEL_WARNING}
			onClose={onCancel}
			headerIcon={<AlertTriangle className="w-4 h-4" style={{ color: warningColor }} />}
			width={480}
			zIndex={10005}
			initialFocusRef={confirmButtonRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onCancel}
					onConfirm={handleConfirm}
					confirmLabel="I understand, enable it"
					confirmButtonRef={confirmButtonRef}
				/>
			}
		>
			<div className="flex gap-4">
				<div
					className="flex-shrink-0 p-2 rounded-full h-fit"
					style={{ backgroundColor: `${warningColor}20` }}
				>
					<AlertTriangle className="w-5 h-5" style={{ color: warningColor }} />
				</div>
				<div
					className="leading-relaxed space-y-3"
					style={{ color: theme.colors.textMain }}
				>
					<p>
						This sends messages immediately, even when the agent is already
						working. If two operations modify the same files simultaneously, one
						may overwrite the other's changes.
					</p>
					<p>
						This is intended for advanced users who understand the risks. Use the
						assigned shortcut key to force-send while the agent is busy. Regular
						send keys will continue to queue normally.
					</p>
				</div>
			</div>
		</Modal>
	);
});

export default ForcedParallelWarningModal;
