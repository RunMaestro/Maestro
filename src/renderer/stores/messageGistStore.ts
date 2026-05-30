/**
 * messageGistStore - In-memory tracker for messages that have been published as GitHub Gists.
 *
 * Keyed by a stable per-message id (log.id for terminal output, timestamp-based key for group
 * chat). Intentionally NOT persisted across app restarts — this is a visual cue for the current
 * session only.
 */

import { create } from 'zustand';
import type { GistInfo } from '../components/GistPublishModal';

interface MessageGistStore {
	published: Record<string, GistInfo>;
	setMessageGist: (messageId: string, info: GistInfo) => void;
	clearMessageGist: (messageId: string) => void;
	clearAll: () => void;
}

export const useMessageGistStore = create<MessageGistStore>()((set) => ({
	published: {},
	setMessageGist: (messageId, info) =>
		set((s) => ({ published: { ...s.published, [messageId]: info } })),
	clearMessageGist: (messageId) =>
		set((s) => {
			const { [messageId]: _, ...rest } = s.published;
			return { published: rest };
		}),
	clearAll: () => set({ published: {} }),
}));
