/**
 * groupLifecycleStore - the Offboarding turns a removal is waiting on right now.
 *
 * One entry per agent being removed. The removal itself holds the promise
 * (`offboardBeforeRemoval` in `services/groupLifecycle.ts`); this store is what
 * the progress dialog draws and what its buttons act on. Nothing here is
 * persisted: a waiting removal does not survive a reload, and the agent it was
 * about to remove is simply still there afterwards.
 */

import { create } from 'zustand';

export interface PendingOffboarding {
	/** The agent being removed. */
	subjectAgentId: string;
	subjectName: string;
	groupName: string;
	/** The agent the Offboarding prompt runs in (the subject, or a steward). */
	runAgentId: string;
	tabId: string;
	tabName: string;
	startedAt: number;
	/** When removal goes ahead whether or not the turn finished. */
	deadline: number;
	/** The person closed the dialog: the wait continues, out of sight. */
	dismissed: boolean;
}

interface GroupLifecycleState {
	offboardings: Record<string, PendingOffboarding>;
	begin: (entry: Omit<PendingOffboarding, 'dismissed'>) => void;
	end: (subjectAgentId: string) => void;
	dismiss: (subjectAgentId: string) => void;
}

export const useGroupLifecycleStore = create<GroupLifecycleState>((set) => ({
	offboardings: {},
	begin: (entry) =>
		set((state) => ({
			offboardings: {
				...state.offboardings,
				[entry.subjectAgentId]: { ...entry, dismissed: false },
			},
		})),
	end: (subjectAgentId) =>
		set((state) => {
			if (!state.offboardings[subjectAgentId]) return state;
			const { [subjectAgentId]: _ended, ...rest } = state.offboardings;
			return { offboardings: rest };
		}),
	dismiss: (subjectAgentId) =>
		set((state) => {
			const entry = state.offboardings[subjectAgentId];
			if (!entry) return state;
			return {
				offboardings: { ...state.offboardings, [subjectAgentId]: { ...entry, dismissed: true } },
			};
		}),
}));

/** The Offboarding the dialog shows: the oldest one nobody has dismissed. */
export function selectVisibleOffboarding(state: GroupLifecycleState): PendingOffboarding | null {
	let visible: PendingOffboarding | null = null;
	for (const entry of Object.values(state.offboardings)) {
		if (entry.dismissed) continue;
		if (!visible || entry.startedAt < visible.startedAt) visible = entry;
	}
	return visible;
}
