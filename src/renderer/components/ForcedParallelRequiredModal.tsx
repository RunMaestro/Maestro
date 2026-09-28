import { useRef } from 'react';
import { Hammer } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { getModalActions } from '../stores/modalStore';
import { Modal, ModalFooter } from './ui/Modal';

/** `data-setting-id` of the Forced Parallel Execution toggle in Settings > General. */
const FORCED_PARALLEL_SETTING_ID = 'general-forced-parallel';

interface ForcedParallelRequiredModalProps {
	theme: Theme;
	onClose: () => void;
	/**
	 * Runs before Settings opens. A host that sits above Settings in the layer
	 * stack (the Execution Queue browser) closes itself here so Settings is not
	 * opened underneath it.
	 */
	onBeforeOpenSetting?: () => void;
}

/**
 * Shown when the user clicks a dimmed Force Send / Send Now control that is
 * blocked only by Forced Parallel Execution being off. Explains the block and
 * deep-links to the exact setting, so the ghosted button is a way in rather
 * than a dead control.
 */
export function ForcedParallelRequiredModal({
	theme,
	onClose,
	onBeforeOpenSetting,
}: ForcedParallelRequiredModalProps) {
	const confirmButtonRef = useRef<HTMLButtonElement>(null);

	const openSetting = () => {
		onClose();
		onBeforeOpenSetting?.();
		getModalActions().openSettings('general', FORCED_PARALLEL_SETTING_ID);
	};

	return (
		<Modal
			theme={theme}
			title="Force Send Is Off"
			headerIcon={<Hammer className="w-5 h-5" style={{ color: theme.colors.warning }} />}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={onClose}
			width={448}
			initialFocusRef={confirmButtonRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					cancelLabel="Close"
					onConfirm={openSetting}
					confirmLabel="Open Setting"
					confirmButtonRef={confirmButtonRef}
				/>
			}
		>
			<p className="text-sm mb-3" style={{ color: theme.colors.textDim }}>
				Another tab in this agent is working. Sending this message now would run it in parallel with
				that tab, which needs Forced Parallel Execution.
			</p>
			<p className="text-sm" style={{ color: theme.colors.textDim }}>
				To enable Force Send, turn it on under{' '}
				<button
					type="button"
					onClick={openSetting}
					className="underline hover:opacity-80"
					style={{ color: theme.colors.accent }}
				>
					Settings &gt; General &gt; Forced Parallel Execution
				</button>
				.
			</p>
		</Modal>
	);
}
