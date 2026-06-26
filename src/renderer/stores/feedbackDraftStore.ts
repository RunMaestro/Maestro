/**
 * feedbackDraftStore — Tracks the Feedback modal's minimize/draft state so the
 * sidebar Feedback button can show a "draft in progress" indicator and the
 * modal can preserve work across minimize/restore.
 *
 * The modal stays mounted while minimized so all FeedbackChatView local state
 * (messages, attachments, input, conversation manager) is preserved.
 */

import { create } from 'zustand';
import type { FeedbackMessage, FeedbackParsedResponse } from '../services/feedbackConversation';

export type FeedbackDraftCategory =
	| 'bug_report'
	| 'feature_request'
	| 'improvement'
	| 'general_feedback';

export interface FeedbackDraftAttachment {
	id: string;
	name: string;
	dataUrl: string;
	sizeBytes: number;
}

export interface FeedbackDraft {
	id: string;
	suggestedName: string;
	category: FeedbackDraftCategory;
	summary: string;
	confidence: number;
	agentType: string;
	messages: FeedbackMessage[];
	attachments: FeedbackDraftAttachment[];
	inputDraft: string;
	includeDebugPackage: boolean;
	createdAt: number;
	updatedAt: number;
	/** Parsed submit-ready response, persisted so a resumed draft stays submittable */
	lastResponse?: FeedbackParsedResponse | null;
}

interface FeedbackDraftState {
	/** Modal is minimized to the sidebar Feedback button (still mounted, hidden) */
	isMinimized: boolean;
	/** User has typed, attached, or exchanged at least one message */
	hasDraft: boolean;
	/** Persisted drafts, most-recently-updated first (drafts[0] is most recent) */
	drafts: FeedbackDraft[];
	/** A draft the user asked to resume; consumed by FeedbackChatView on mount */
	resumeDraftId: string | null;
	/** id of the draft the open editor maps to once it has been persisted */
	activeDraftId: string | null;
	/** Live in-memory snapshot of the open editor, published by FeedbackChatView */
	activeDraft: FeedbackDraft | null;
	/** Last draft-save error, surfaced by the editor; null when the last save succeeded */
	saveError: string | null;
	setMinimized: (minimized: boolean) => void;
	setHasDraft: (hasDraft: boolean) => void;
	setActiveDraft: (draft: FeedbackDraft | null) => void;
	/** Refresh the persisted drafts list from disk */
	loadDrafts: () => Promise<void>;
	/** Upsert a draft, refresh the list, and return its persisted id */
	saveDraft: (draft: FeedbackDraft) => Promise<string | null>;
	/** Delete a draft by id and refresh the list */
	deleteDraft: (id: string) => Promise<void>;
	requestResume: (id: string) => void;
	clearResume: () => void;
	/** Clear ephemeral session state; the persisted drafts list is preserved */
	reset: () => void;
}

export const useFeedbackDraftStore = create<FeedbackDraftState>((set, get) => ({
	isMinimized: false,
	hasDraft: false,
	drafts: [],
	resumeDraftId: null,
	activeDraftId: null,
	activeDraft: null,
	saveError: null,
	setMinimized: (minimized) => set({ isMinimized: minimized }),
	setHasDraft: (hasDraft) => set({ hasDraft }),
	setActiveDraft: (draft) => set({ activeDraft: draft }),
	loadDrafts: async () => {
		try {
			const { drafts } = await window.maestro.feedback.drafts.list();
			set({ drafts });
		} catch {
			// Leave the existing list in place if the read fails.
		}
	},
	saveDraft: async (draft) => {
		try {
			const { draft: saved } = await window.maestro.feedback.drafts.save(draft);
			await get().loadDrafts();
			set((state) => ({
				activeDraftId: saved.id,
				// Patch the live snapshot's id too, so a later save/minimize without
				// an intervening edit upserts this draft instead of duplicating it.
				activeDraft: state.activeDraft ? { ...state.activeDraft, id: saved.id } : state.activeDraft,
				saveError: null,
			}));
			return saved.id;
		} catch {
			// Surface the failure so callers do NOT report success or close the
			// modal while the draft only lives in memory.
			set({ saveError: 'Could not save your draft. Your changes are still here; try again.' });
			return null;
		}
	},
	deleteDraft: async (id) => {
		try {
			await window.maestro.feedback.drafts.delete(id);
		} catch {
			// Refresh below regardless so the list reflects reality.
		}
		await get().loadDrafts();
		set((state) => ({
			activeDraftId: state.activeDraftId === id ? null : state.activeDraftId,
		}));
	},
	requestResume: (id) => set({ resumeDraftId: id }),
	clearResume: () => set({ resumeDraftId: null }),
	reset: () =>
		set({
			isMinimized: false,
			hasDraft: false,
			activeDraft: null,
			activeDraftId: null,
			resumeDraftId: null,
			saveError: null,
		}),
}));
