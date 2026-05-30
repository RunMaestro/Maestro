/**
 * feedbackDraftStore — Tracks the Feedback modal's minimize/draft state so the
 * sidebar Feedback button can show a "draft in progress" indicator and the
 * modal can preserve work across minimize/restore.
 *
 * The modal stays mounted while minimized so all FeedbackChatView local state
 * (messages, attachments, input, conversation manager) is preserved.
 */

import { create } from 'zustand';

interface FeedbackDraftState {
	/** Modal is minimized to the sidebar Feedback button (still mounted, hidden) */
	isMinimized: boolean;
	/** User has typed, attached, or exchanged at least one message */
	hasDraft: boolean;
	setMinimized: (minimized: boolean) => void;
	setHasDraft: (hasDraft: boolean) => void;
	reset: () => void;
}

export const useFeedbackDraftStore = create<FeedbackDraftState>((set) => ({
	isMinimized: false,
	hasDraft: false,
	setMinimized: (minimized) => set({ isMinimized: minimized }),
	setHasDraft: (hasDraft) => set({ hasDraft }),
	reset: () => set({ isMinimized: false, hasDraft: false }),
}));
