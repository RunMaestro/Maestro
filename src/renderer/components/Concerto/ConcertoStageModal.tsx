/**
 * ConcertoStageModal - the window the Concerto stage lives in.
 *
 * Concerto used to squeeze the chat into a side rail and take over the rest of
 * the app; now it is an ordinary centered modal that the user can resize (the
 * size is remembered) and dismiss the way every other Maestro surface is
 * dismissed: Escape, the ESC pill in the header, the hotkey, the command
 * palette, or the hamburger menu.
 *
 * The modal is MOUNTED for as long as Concerto is enabled and merely hidden
 * while closed. That is load-bearing, not an optimization: a panel can be an
 * interactive HTML document (a game mid-move, a form half-filled), and
 * unmounting the stage would tear those iframes down. Closing the stage must
 * park it, never destroy it - reopening brings back exactly what was there.
 */

import { useCallback } from 'react';
import { Music2 } from 'lucide-react';
import type { Theme } from '../../types';
import { Modal } from '../ui/Modal';
import { EscCloseButton } from '../ui/EscCloseButton';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { getModalActions, selectModalOpen, useModalStore } from '../../stores/modalStore';
import { MovementStage } from '../Movement';

/** Remembered-size key for the stage window (settings: `modalSizes`). */
export const CONCERTO_STAGE_RESIZE_KEY = 'concerto-stage';

interface ConcertoStageModalProps {
	theme: Theme;
}

export function ConcertoStageModal({ theme }: ConcertoStageModalProps) {
	const open = useModalStore(selectModalOpen('concertoStage'));
	const close = useCallback(() => getModalActions().setConcertoStageOpen(false), []);

	return (
		<Modal
			theme={theme}
			title="Concerto"
			priority={MODAL_PRIORITIES.CONCERTO_STAGE}
			onClose={close}
			hidden={!open}
			headerIcon={<Music2 className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			// The ESC pill replaces the default X: it is the same real button, and
			// it also teaches the key for next time.
			showCloseButton={false}
			headerActions={<EscCloseButton theme={theme} onClose={close} testId="concerto-stage-esc" />}
			// Below the standard modal layer (9999) on purpose. The stage is a
			// workspace surface, not a dialog: Settings, Cue, or a confirm opened on
			// top of it must paint over it, and the stage is mounted from app start
			// so DOM order alone would put it in front at an equal z-index.
			zIndex={9000}
			resizeKey={CONCERTO_STAGE_RESIZE_KEY}
			defaultSize={{ width: 1120, height: 760 }}
			minSize={{ width: 520, height: 360 }}
			contentClassName="flex-1 min-h-0 overflow-hidden"
			testId="concerto-stage-modal"
			portal
		>
			<MovementStage theme={theme} />
		</Modal>
	);
}
