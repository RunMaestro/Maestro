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
						This lets you queue messages that skip the cross-tab wait. Your message still waits for
						the current tab to finish, but dispatches immediately afterward — without waiting for
						other tabs to clear.
					</p>
					<p className="text-xs leading-relaxed" style={{ color: theme.colors.textDim }}>
						Use the assigned shortcut key to force-send while the agent is busy. Regular send keys
						will continue to queue normally.
					</p>
				</div>
			</div>
		</Modal>
	);
}
