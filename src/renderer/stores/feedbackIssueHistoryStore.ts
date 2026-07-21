/**
 * feedbackIssueHistoryStore - Persisted history of GitHub issues the user has
 * submitted through the Send Feedback modal. Records are written in the main
 * process on submit-success; this store reads them for the "Submitted Issues"
 * panel and refreshes their open/closed state opportunistically when it opens.
 */

import { create } from 'zustand';

export type SubmittedIssueState = 'open' | 'closed';

export interface SubmittedIssue {
	number: number;
	url: string;
	title: string;
	category: 'bug_report' | 'feature_request' | 'improvement' | 'general_feedback';
	submittedAt: number;
	state: SubmittedIssueState;
	lastCheckedAt: number;
}

interface FeedbackIssueHistoryState {
	issues: SubmittedIssue[];
	isRefreshing: boolean;
	/** Read persisted history from disk (instant, cached). */
	loadIssues: () => Promise<void>;
	/** Refresh open/closed state from GitHub; no-ops gracefully when gh is unavailable. */
	refreshStates: () => Promise<void>;
	/** Delete one record locally (does not touch GitHub). */
	deleteIssue: (issueNumber: number) => Promise<void>;
}

export const useFeedbackIssueHistoryStore = create<FeedbackIssueHistoryState>((set, get) => ({
	issues: [],
	isRefreshing: false,
	loadIssues: async () => {
		try {
			const { issues } = await window.maestro.feedback.issues.list();
			set({ issues });
		} catch {
			// Leave the existing list in place if the read fails.
		}
	},
	refreshStates: async () => {
		set({ isRefreshing: true });
		try {
			const { issues } = await window.maestro.feedback.issues.refreshStates();
			set({ issues });
		} catch {
			// Keep the cached list; pills stay at last-known state.
		} finally {
			set({ isRefreshing: false });
		}
	},
	deleteIssue: async (issueNumber) => {
		try {
			await window.maestro.feedback.issues.delete(issueNumber);
		} catch {
			// Refresh below regardless so the list reflects reality.
		}
		await get().loadIssues();
	},
}));
