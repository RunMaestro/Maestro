/**
 * ConcertoStageModal - the window the Concerto stage lives in.
 *
 * Concerto used to squeeze the chat into a side rail and take over the rest of
 * the app; now it is an ordinary window the user opens, resizes (the size is
 * remembered), and dismisses the way every other Maestro surface is dismissed:
 * Escape, the ESC pill in the header, the hotkey, the command palette, or the
 * hamburger menu.
 *
 * It has two presentations, and the user picks:
 *
 *   - DOCKED (default) is a centered modal. It owns the screen, which is right
 *     when the Concerto IS the task - reading a dashboard, playing a game.
 *   - FLOATING pops it out into a free-positioned, non-blocking window, which is
 *     right when the Concerto is something to watch WHILE you keep typing to the
 *     agent. This is the mode the old side-rail layout was reaching for, without
 *     forcing the whole app into a Concerto-shaped layout to get it.
 *
 * Two invariants hold the design together:
 *
 * 1. The modal is MOUNTED for as long as Concerto is enabled and merely hidden
 *    while closed. A panel can be an interactive HTML document (a game mid-move,
 *    a form half-filled), and unmounting the stage would tear those iframes
 *    down. Closing parks the stage, it never destroys it.
 * 2. Docking and floating are the SAME <Modal> with different props, never two
 *    branches. Rendering a different element per mode would remount everything
 *    inside on each toggle, so popping out mid-game would reset the game - which
 *    is exactly what the pop-out is supposed to make possible.
 */

import { useCallback, useEffect, useState } from 'react';
import { Maximize2, Music2, PictureInPicture2 } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Theme } from '../../types';
import { Modal } from '../ui/Modal';
import { EscCloseButton } from '../ui/EscCloseButton';
import { GhostIconButton } from '../ui/GhostIconButton';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { getModalActions, selectModalOpen, useModalStore } from '../../stores/modalStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePointerDrag } from '../../hooks/utils/usePointerDrag';
import { useEventListener } from '../../hooks/utils/useEventListener';
import {
	clampModalPosition,
	defaultModalFloatPosition,
	resolveModalSize,
	type ModalPosition,
} from '../../utils/modalSizing';
import { MovementStage } from '../Movement';

/** Remembered-size key for the stage window (settings: `modalSizes`). */
export const CONCERTO_STAGE_RESIZE_KEY = 'concerto-stage';

const STAGE_DEFAULT_SIZE = { width: 1120, height: 760 };
const STAGE_MIN_SIZE = { width: 520, height: 360 };

interface ConcertoStageModalProps {
	theme: Theme;
}

export function ConcertoStageModal({ theme }: ConcertoStageModalProps) {
	const open = useModalStore(selectModalOpen('concertoStage'));
	const close = useCallback(() => getModalActions().setConcertoStageOpen(false), []);

	const floating = useSettingsStore((s) => s.concertoStageFloating);
	const setFloating = useSettingsStore((s) => s.setConcertoStageFloating);
	const savedPosition = useSettingsStore((s) => s.concertoStagePosition);
	const savedSize = useSettingsStore((s) => s.modalSizes[CONCERTO_STAGE_RESIZE_KEY]);
	const persistPosition = useSettingsStore((s) => s.setConcertoStagePosition);
	const startDrag = usePointerDrag();

	// Live position while floating. Held locally so a drag is one re-render per
	// pointer move and ONE settings write on release, rather than a write per frame.
	const [position, setPosition] = useState<ModalPosition>(() =>
		savedPosition
			? clampModalPosition(savedPosition)
			: defaultModalFloatPosition(
					resolveModalSize({ savedSize, defaultSize: STAGE_DEFAULT_SIZE, minSize: STAGE_MIN_SIZE })
				)
	);

	// Adopt an externally-changed position (another window, a settings reset).
	// Skipped mid-drag would be wrong here: the drag holds the pointer, and the
	// persisted value only changes on release, so there is nothing to fight.
	useEffect(() => {
		if (savedPosition) setPosition(clampModalPosition(savedPosition));
	}, [savedPosition]);

	// A smaller display, or just a narrower window, can leave a floating stage
	// with its title bar - the only drag handle - off screen and unreachable.
	useEventListener('resize', () => setPosition((current) => clampModalPosition(current)), {
		enabled: floating,
	});

	const onMovePointerDown = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			const origin = position;
			let latest = origin;
			startDrag(
				event,
				(dx, dy) => {
					latest = clampModalPosition({ x: origin.x + dx, y: origin.y + dy });
					setPosition(latest);
				},
				// The header carries the ESC pill and the dock toggle; without this a
				// click on either would start a drag instead of pressing the button.
				{ ignoreButtons: true, onEnd: () => persistPosition(latest) }
			);
		},
		[persistPosition, position, startDrag]
	);

	// Popping out for the first time has no remembered corner, so place the
	// window against the current viewport rather than at a stale default.
	const toggleFloating = useCallback(() => {
		if (!floating && !savedPosition) {
			setPosition(
				defaultModalFloatPosition(
					resolveModalSize({ savedSize, defaultSize: STAGE_DEFAULT_SIZE, minSize: STAGE_MIN_SIZE })
				)
			);
		}
		setFloating(!floating);
	}, [floating, savedPosition, savedSize, setFloating]);

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
			headerActions={
				<>
					<GhostIconButton
						onClick={toggleFloating}
						ariaLabel={floating ? 'Dock Concerto stage' : 'Pop Concerto stage out'}
						title={
							floating
								? 'Dock the stage back to the center'
								: 'Pop out into a floating window and keep using the app'
						}
						color={theme.colors.textDim}
						testId="concerto-stage-float-toggle"
					>
						{floating ? (
							<Maximize2 className="w-4 h-4" />
						) : (
							<PictureInPicture2 className="w-4 h-4" />
						)}
					</GhostIconButton>
					<EscCloseButton theme={theme} onClose={close} testId="concerto-stage-esc" />
				</>
			}
			// Below the standard modal layer (9999) on purpose. The stage is a
			// workspace surface, not a dialog: Settings, Cue, or a confirm opened on
			// top of it must paint over it, and the stage is mounted from app start
			// so DOM order alone would put it in front at an equal z-index.
			zIndex={9000}
			resizeKey={CONCERTO_STAGE_RESIZE_KEY}
			defaultSize={STAGE_DEFAULT_SIZE}
			minSize={STAGE_MIN_SIZE}
			contentClassName="flex-1 min-h-0 overflow-hidden"
			testId="concerto-stage-modal"
			floating={floating ? { position, onMovePointerDown } : null}
			portal
		>
			<MovementStage theme={theme} />
		</Modal>
	);
}
