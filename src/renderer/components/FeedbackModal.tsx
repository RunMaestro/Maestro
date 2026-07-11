import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Minimize2, X, History, ArrowLeft } from 'lucide-react';
import type { Session, Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { GhostIconButton } from './ui/GhostIconButton';
import { FeedbackChatView } from './FeedbackChatView';
import { FeedbackDraftsList } from './FeedbackDraftsList';
import { useFeedbackDraftStore } from '../stores/feedbackDraftStore';
import { useUIStore } from '../stores/uiStore';

interface FeedbackModalProps {
	theme: Theme;
	sessions: Session[];
	onClose: () => void;
	onSwitchToSession: (sessionId: string) => void;
}

const FEEDBACK_BUTTON_SELECTOR = '[data-feedback-button]';
const ANIMATION_MS = 260;

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
	const [showDrafts, setShowDrafts] = useState(false);
	const [resumeNonce, setResumeNonce] = useState(0);

	const isMinimized = useFeedbackDraftStore((s) => s.isMinimized);
	const hasDraft = useFeedbackDraftStore((s) => s.hasDraft);
	const setMinimized = useFeedbackDraftStore((s) => s.setMinimized);
	const setLeftSidebarOpen = useUIStore((s) => s.setLeftSidebarOpen);
	const drafts = useFeedbackDraftStore((s) => s.drafts);
	const resumeDraftId = useFeedbackDraftStore((s) => s.resumeDraftId);

	// Refresh persisted drafts when the modal mounts so the Drafts list is fresh.
	useEffect(() => {
		void useFeedbackDraftStore.getState().loadDrafts();
	}, []);

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
	const handleMinimize = useCallback(async () => {
		// Persist the in-flight draft so it survives an app restart, not just the
		// in-memory minimized state. If the write fails, do NOT minimize (which
		// would hide the failure); keep the modal open so the error surfaces.
		const { activeDraft, saveDraft } = useFeedbackDraftStore.getState();
		if (activeDraft) {
			const savedId = await saveDraft(activeDraft);
			if (savedId === null) return;
		}

		// Make sure the Feedback button is in the DOM so we have a target.
		setLeftSidebarOpen(true);

		// Defer to next frame to give the sidebar a chance to render before we
		// measure the button's position.
		requestAnimationFrame(() => {
			const anchor = readMinimizeAnchor(cardRef.current);
			if (!anchor) {
				// No button to anchor to — fall back to instant minimize.
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

	// --- Close handler with confirmation when there's draft work to lose ---
	const handleCloseRequest = useCallback(() => {
		if (hasDraft) {
			setConfirmCloseOpen(true);
			return;
		}
		onClose();
	}, [hasDraft, onClose]);

	const handleSaveAndClose = useCallback(async () => {
		setConfirmCloseOpen(false);
		const { activeDraft, saveDraft } = useFeedbackDraftStore.getState();
		if (activeDraft) {
			const savedId = await saveDraft(activeDraft);
			// Persist failed: keep the modal open (the editor surfaces the error)
			// instead of closing and losing the in-memory draft.
			if (savedId === null) return;
		}
		onClose();
	}, [onClose]);

	const handleDiscard = useCallback(() => {
		// "Discard" abandons the unsaved in-progress edits and closes. It must NOT
		// delete an already-saved draft: a resumed draft keeps its last saved
		// state, and deletion is an explicit action from the Drafts list.
		setConfirmCloseOpen(false);
		onClose();
	}, [onClose]);

	const handleResume = useCallback(async (id: string) => {
		const { activeDraft, activeDraftId, saveDraft } = useFeedbackDraftStore.getState();
		// Clicking the already-active draft is a no-op: remounting the editor from
		// the persisted copy would silently discard the user's unsaved in-progress
		// edits, so leave the live editor untouched and just close the list.
		if (activeDraftId === id) {
			setShowDrafts(false);
			return;
		}
		// Preserve any unsaved in-progress editor before we unmount it to resume a
		// different draft, so switching drafts never silently discards work.
		if (activeDraft) {
			const savedId = await saveDraft(activeDraft);
			if (savedId === null) {
				// Saving the current draft failed; stay on the editor and surface
				// the error rather than dropping the user's work.
				setShowDrafts(false);
				return;
			}
		}
		setShowDrafts(false);
		useFeedbackDraftStore.getState().requestResume(id);
		setResumeNonce((n) => n + 1);
	}, []);

	const handleDeleteDraft = useCallback((id: string) => {
		void useFeedbackDraftStore.getState().deleteDraft(id);
	}, []);

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
								<GhostIconButton
									onClick={() => setShowDrafts((v) => !v)}
									ariaLabel="View saved drafts"
									color={showDrafts ? theme.colors.accent : theme.colors.textDim}
									title="Saved drafts"
								>
									<span className="relative inline-flex">
										<History className="w-4 h-4" />
										{drafts.length > 0 && (
											<span
												className="absolute -top-2 -right-2 text-[9px] font-bold rounded-full px-1 leading-tight"
												style={{
													backgroundColor: theme.colors.accent,
													color: theme.colors.accentForeground,
												}}
											>
												{drafts.length}
											</span>
										)}
									</span>
								</GhostIconButton>
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
								>
									<X className="w-4 h-4" />
								</GhostIconButton>
							</div>
						</div>
					}
				>
					<div className="relative flex-1 flex flex-col min-h-0">
						<FeedbackChatView
							key={resumeNonce}
							theme={theme}
							sessions={sessions}
							onCancel={handleCloseRequest}
							onWidthChange={setWidth}
							resumeDraftId={resumeDraftId}
							onRequestMinimize={handleMinimize}
							onSubmitSuccess={(sessionId) => {
								onSwitchToSession(sessionId);
								onClose();
							}}
						/>
						{showDrafts && (
							<div
								className="absolute inset-0 z-10 flex flex-col"
								style={{ backgroundColor: theme.colors.bgSidebar }}
							>
								<div
									className="flex items-center gap-2 p-3 border-b shrink-0"
									style={{ borderColor: theme.colors.border }}
								>
									<GhostIconButton
										onClick={() => setShowDrafts(false)}
										ariaLabel="Back to feedback"
										color={theme.colors.textDim}
										title="Back"
									>
										<ArrowLeft className="w-4 h-4" />
									</GhostIconButton>
									<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
										Saved Drafts
									</span>
								</div>
								<div className="flex-1 min-h-0 overflow-y-auto">
									<FeedbackDraftsList
										theme={theme}
										drafts={drafts}
										onResume={handleResume}
										onDelete={handleDeleteDraft}
									/>
								</div>
							</div>
						)}
					</div>
				</Modal>
			</div>
			{confirmCloseOpen && (
				<Modal
					theme={theme}
					title="Save this draft?"
					priority={MODAL_PRIORITIES.CONFIRM}
					onClose={() => setConfirmCloseOpen(false)}
					width={460}
					zIndex={10000}
					footer={
						<>
							<button
								type="button"
								onClick={handleDiscard}
								className="px-4 py-2 rounded border transition-colors hover:bg-white/5"
								style={{ borderColor: theme.colors.border, color: theme.colors.error }}
							>
								Discard
							</button>
							<div className="flex-1" />
							<button
								type="button"
								onClick={() => setConfirmCloseOpen(false)}
								className="px-4 py-2 rounded border transition-colors hover:bg-white/5"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							>
								Keep editing
							</button>
							<button
								type="button"
								onClick={handleSaveAndClose}
								className="px-4 py-2 rounded transition-colors hover:opacity-90"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
								}}
							>
								Save & Close
							</button>
						</>
					}
				>
					<p className="leading-relaxed text-sm" style={{ color: theme.colors.textMain }}>
						Keep your in-progress feedback as a resumable draft, or discard it. Saved drafts can be
						resumed from the Drafts list later.
					</p>
				</Modal>
			)}
		</>
	);
}
