/**
 * sidebarNavStore - Left Bar sort/nav/starred projections shared by SessionList
 * and keyboard cycle/nav.
 *
 * A sync host (`SidebarNavSync`) owns the subscriptions and writes here so
 * MaestroConsoleInner does not re-run useSortedSessions / useStarredItems on
 * every shell wake. Consumers subscribe narrowly or read getState() at event time.
 */

import { create } from 'zustand';
import type { Session } from '../types';
import type { StarredItem } from '../hooks/session/useStarredItems';
import { useGroupChatStore } from './groupChatStore';
import { useSessionStore, updateSessionWith } from './sessionStore';
import { notifyStarredSessionsChanged } from '../utils/starredSessions';

export type JumpToStarredSessionFn = (
	agentId: string,
	projectPath: string,
	agentSessionId: string,
	sessionName: string,
	parentSessionId: string
) => Promise<boolean>;

export type ShowConfirmationFn = (message: string, onConfirm: () => void | Promise<void>) => void;

export interface SidebarNavStoreState {
	sortedSessions: Session[];
	visibleSessions: Session[];
	navSessions: Session[];
	bookmarkNavSize: number;
	navIndexMap: Map<string, number>;
	starredItems: StarredItem[];
	/** Injected by App once jump/confirm handlers exist. */
	onJumpToStarredSession: JumpToStarredSessionFn | null;
	showConfirmation: ShowConfirmationFn | null;
}

export interface SidebarNavStoreActions {
	setSortedProjection: (projection: {
		sortedSessions: Session[];
		visibleSessions: Session[];
		navSessions: Session[];
		bookmarkNavSize: number;
		navIndexMap: Map<string, number>;
	}) => void;
	setStarredItems: (items: StarredItem[]) => void;
	registerStarredHandlers: (handlers: {
		onJumpToStarredSession?: JumpToStarredSessionFn;
		showConfirmation?: ShowConfirmationFn;
	}) => void;
	activateStarredItem: (item: StarredItem) => Promise<void>;
}

export type SidebarNavStore = SidebarNavStoreState & SidebarNavStoreActions;

const EMPTY_MAP = new Map<string, number>();

export const useSidebarNavStore = create<SidebarNavStore>()((set, get) => ({
	sortedSessions: [],
	visibleSessions: [],
	navSessions: [],
	bookmarkNavSize: 0,
	navIndexMap: EMPTY_MAP,
	starredItems: [],
	onJumpToStarredSession: null,
	showConfirmation: null,

	setSortedProjection: (projection) => set(projection),

	setStarredItems: (items) => set({ starredItems: items }),

	registerStarredHandlers: (handlers) =>
		set({
			onJumpToStarredSession: handlers.onJumpToStarredSession ?? get().onJumpToStarredSession,
			showConfirmation: handlers.showConfirmation ?? get().showConfirmation,
		}),

	activateStarredItem: async (item) => {
		// Same activation path as useStarredItems so cycle/nav can call
		// getState().activateStarredItem without holding a React callback.
		useGroupChatStore.getState().setActiveGroupChatId(null);
		useSessionStore.getState().setActiveSessionId(item.parentSessionId);
		if (item.kind === 'open') {
			updateSessionWith(item.parentSessionId, (s) => ({
				...s,
				activeTabId: item.tabId,
				activeFileTabId: null,
				activeTerminalTabId: null,
				activeBrowserTabId: null,
				inputMode: 'ai',
			}));
			return;
		}

		const { onJumpToStarredSession, showConfirmation } = get();
		const opened = await onJumpToStarredSession?.(
			item.agentId,
			item.projectPath,
			item.agentSessionId,
			item.sessionName,
			item.parentSessionId
		);
		if (opened === false) {
			showConfirmation?.(
				`"${item.sessionName}" is no longer available. It has aged out and its conversation could not be loaded. Remove the star?`,
				async () => {
					await window.maestro.agentSessions.setSessionStarred(
						item.agentId,
						item.projectPath,
						item.agentSessionId,
						false
					);
					set({
						starredItems: get().starredItems.filter(
							(s) =>
								!(
									s.kind === 'closed' &&
									s.agentId === item.agentId &&
									s.agentSessionId === item.agentSessionId &&
									s.projectPath === item.projectPath
								)
						),
					});
					notifyStarredSessionsChanged();
				}
			);
		}
	},
}));
