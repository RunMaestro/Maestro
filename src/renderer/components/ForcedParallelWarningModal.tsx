import { useRef } from 'react';
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

export function ForcedParallelWarningModal({
	isOpen,
	onConfirm,
	onCancel,
	theme,
}: ForcedParallelWarningModalProps) {
	const confirmButtonRef = useRef<HTMLButtonElement>(null);

	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title="Forced Parallel Execution"
			priority={MODAL_PRIORITIES.FORCED_PARALLEL_WARNING}
			onClose={onCancel}
			width={480}
			initialFocusRef={confirmButtonRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onCancel}
					onConfirm={onConfirm}
					confirmLabel="I understand, enable it"
					confirmButtonRef={confirmButtonRef}
				/>
			}
		>
			<div className="flex items-start gap-3">
				<div
					className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center"
					style={{ backgroundColor: theme.colors.warning + '20' }}
				>
					<AlertTriangle className="w-5 h-5" style={{ color: theme.colors.warning }} />
				</div>
				<div>
					<p className="text-sm leading-relaxed mb-3" style={{ color: theme.colors.textMain }}>
						This sends messages immediately, even when the agent is already working. If two
						operations modify the same files simultaneously, one may overwrite the other's changes.
					</p>
					<p className="text-xs leading-relaxed" style={{ color: theme.colors.textDim }}>
						This is intended for advanced users who understand the risks. Use the assigned shortcut
						key to force-send while the agent is busy. Regular send keys will continue to queue
						normally.
					</p>
				</div>
			</div>
		</Modal>
	);
}
