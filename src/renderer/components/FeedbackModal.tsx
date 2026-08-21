import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Minimize2, Trash2, X } from 'lucide-react';
import type { Session, Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { GhostIconButton } from './ui/GhostIconButton';
import { ConfirmModal } from './ConfirmModal';
import { FeedbackChatView } from './FeedbackChatView';
import { useFeedbackDraftStore } from '../stores/feedbackDraftStore';
import { useUIStore } from '../stores/uiStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';

interface FeedbackModalProps {
	theme: Theme;
	sessions: Session[];
	onClose: () => void;
	onSwitchToSession: (sessionId: string) => void;
}

const FEEDBACK_BUTTON_SELECTOR = '[data-feedback-button]';
const ANIMATION_MS = 260;

/**
 * Tell the user their conversation survived. Parking is silent otherwise, and a
 * modal that vanishes without a word reads exactly like the discard it replaced.
 */
function flashDraftKept(): void {
	notifyCenterFlash({
		message: 'Feedback kept',
		detail: 'Still running - reopen it from the Feedback button',
	});
}

type AnimPhase = 'open' | 'minimizing' | 'minimized' | 'restoring';

interface MinimizeAnchor {
	dx: number;
	dy: number;
	scale: number;
}

function readMinimizeAnchor(card: HTMLDivElement | null): MinimizeAnchor | null {
	if (!card) return null;
	const button = document.querySelector<HTMLElement>(FEEDBACK_BUTTON_SELECTOR);
	if (!button) return null;
	const cardRect = card.getBoundingClientRect();
	const btnRect = button.getBoundingClientRect();
	if (cardRect.width === 0 || btnRect.width === 0) return null;
	const dx = btnRect.left + btnRect.width / 2 - (cardRect.left + cardRect.width / 2);
	const dy = btnRect.top + btnRect.height / 2 - (cardRect.top + cardRect.height / 2);
	const scale = Math.max(0.04, btnRect.width / cardRect.width);
	return { dx, dy, scale };
}

export function FeedbackModal({ theme, sessions, onClose, onSwitchToSession }: FeedbackModalProps) {
	const [width, setWidth] = useState(462);
	const [phase, setPhase] = useState<AnimPhase>('open');
	const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
	const cardRef = useRef<HTMLDivElement>(null);

	const isMinimized = useFeedbackDraftStore((s) => s.isMinimized);
	const hasDraft = useFeedbackDraftStore((s) => s.hasDraft);
	const setMinimized = useFeedbackDraftStore((s) => s.setMinimized);
	const setLeftSidebarOpen = useUIStore((s) => s.setLeftSidebarOpen);

	// --- Apply / clear animation transforms on the card ---
	const applyTransform = useCallback((anchor: MinimizeAnchor | null, animate: boolean) => {
		const card = cardRef.current;
		const overlay = card?.parentElement as HTMLElement | null;
		if (!card) return;
		const transition = animate
			? `transform ${ANIMATION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${ANIMATION_MS}ms ease`
			: 'none';
		card.style.transition = transition;
		card.style.transformOrigin = 'center center';
		card.style.willChange = 'transform, opacity';
		if (anchor) {
			card.style.transform = `translate(${anchor.dx}px, ${anchor.dy}px) scale(${anchor.scale})`;
			card.style.opacity = '0';
		} else {
			card.style.transform = '';
			card.style.opacity = '';
		}
		if (overlay) {
			overlay.style.transition = animate ? `opacity ${ANIMATION_MS}ms ease` : 'none';
			overlay.style.background = anchor ? 'transparent' : '';
		}
	}, []);

	// --- Minimize handler ---
	const handleMinimize = useCallback(() => {
		// Make sure the Feedback button is in the DOM so we have a target.
		setLeftSidebarOpen(true);

		// Defer to next frame to give the sidebar a chance to render before we
		// measure the button's position.
		requestAnimationFrame(() => {
			const anchor = readMinimizeAnchor(cardRef.current);
			if (!anchor) {
				// No button to anchor to - fall back to instant minimize.
				setMinimized(true);
				return;
			}
			// Drop focus before animating so the (now-disabled) layer doesn't
			// hold focus inside an invisible modal.
			(document.activeElement as HTMLElement | null)?.blur?.();
			setPhase('minimizing');
			// Force layout, then transition.
			applyTransform(null, false);
			requestAnimationFrame(() => {
				applyTransform(anchor, true);
				window.setTimeout(() => {
					setPhase('minimized');
					setMinimized(true);
					applyTransform(null, false);
				}, ANIMATION_MS);
			});
		});
	}, [applyTransform, setLeftSidebarOpen, setMinimized]);

	// --- Restore animation when store flips isMinimized → false while we're
	//     still mounted (e.g. user clicked the sidebar Feedback button) ---
	useEffect(() => {
		if (isMinimized) return;
		if (phase !== 'minimized') return;
		// Make sure the sidebar is visible so the animation has somewhere to
		// originate from.
		setLeftSidebarOpen(true);
		requestAnimationFrame(() => {
			const anchor = readMinimizeAnchor(cardRef.current);
			setPhase('restoring');
			// Jump to button position without animation, then transition back.
			applyTransform(anchor, false);
			requestAnimationFrame(() => {
				applyTransform(null, true);
				window.setTimeout(() => {
					applyTransform(null, false);
					setPhase('open');
				}, ANIMATION_MS);
			});
		});
	}, [isMinimized, phase, applyTransform, setLeftSidebarOpen]);

	// --- Reset card styles whenever we land in a stable phase ---
	useLayoutEffect(() => {
		if (phase === 'open') {
			applyTransform(null, false);
		}
	}, [phase, applyTransform]);

	// --- Close handler ---
	//
	// Closing NEVER discards a conversation. The agent turn lives on this
	// component's mount: unmounting kills the process and drops the reply, so a
	// user who clicked away mid-answer used to lose it. When there is work in
	// progress, X / Escape / backdrop-click all park the modal exactly like
	// Minimize does - the conversation keeps running in the background and the
	// sidebar Feedback button carries the draft indicator. Discarding is now its
	// own explicit action (the trash button below), never a side effect of
	// wanting to look at something else.
	const handleCloseRequest = useCallback(() => {
		if (hasDraft) {
			handleMinimize();
			flashDraftKept();
			return;
		}
		onClose();
	}, [hasDraft, handleMinimize, onClose]);

	const handleDiscardRequest = useCallback(() => {
		setConfirmCloseOpen(true);
	}, []);

	const handleConfirmDiscard = useCallback(() => {
		setConfirmCloseOpen(false);
		onClose();
	}, [onClose]);

	const isHidden = phase === 'minimized';

	return (
		<>
			<div
				style={{
					opacity: isHidden ? 0 : 1,
					pointerEvents: isHidden ? 'none' : 'auto',
					transition: isHidden ? 'none' : undefined,
				}}
				aria-hidden={isHidden}
			>
				<Modal
					theme={theme}
					title="Send Feedback"
					priority={MODAL_PRIORITIES.FEEDBACK}
					onClose={handleCloseRequest}
					width={width}
					maxHeight="85vh"
					allowOverflow
					// Clicking outside is the gesture users reach for when they want to
					// go look at something else. It used to be a dead click; now it
					// parks the conversation like every other exit.
					closeOnBackdropClick
					contentClassName="flex-1 flex flex-col min-h-0 p-0"
					cardRef={cardRef}
					layerOptions={{ enabled: !isHidden }}
					customHeader={
						<div
							className="p-4 border-b flex items-center justify-between shrink-0"
							style={{ borderColor: theme.colors.border }}
						>
							<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
								Send Feedback
							</h2>
							<div className="flex items-center gap-1">
								{hasDraft && (
									<GhostIconButton
										onClick={handleDiscardRequest}
										ariaLabel="Discard feedback"
										color={theme.colors.textDim}
										title="Discard this feedback"
									>
										<Trash2 className="w-4 h-4" />
									</GhostIconButton>
								)}
								<GhostIconButton
									onClick={handleMinimize}
									ariaLabel="Minimize feedback"
									color={theme.colors.textDim}
									title="Minimize (keeps your draft)"
								>
									<Minimize2 className="w-4 h-4" />
								</GhostIconButton>
								<GhostIconButton
									onClick={handleCloseRequest}
									ariaLabel="Close modal"
									color={theme.colors.textDim}
									title={hasDraft ? 'Close (keeps your draft running)' : 'Close'}
								>
									<X className="w-4 h-4" />
								</GhostIconButton>
							</div>
						</div>
					}
				>
					<FeedbackChatView
						theme={theme}
						sessions={sessions}
						onCancel={handleCloseRequest}
						onWidthChange={setWidth}
						onSubmitSuccess={(sessionId) => {
							onSwitchToSession(sessionId);
							onClose();
						}}
					/>
				</Modal>
			</div>
			{confirmCloseOpen && (
				<ConfirmModal
					theme={theme}
					title="Discard Feedback?"
					message="This deletes your in-progress feedback and stops the agent working on it. Closing the window instead keeps everything running in the background."
					confirmLabel="Discard"
					destructive
					onConfirm={handleConfirmDiscard}
					onClose={() => setConfirmCloseOpen(false)}
				/>
			)}
		</>
	);
}
