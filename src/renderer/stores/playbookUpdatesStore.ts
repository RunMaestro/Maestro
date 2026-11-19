/**
 * playbookUpdatesStore - the update state of every playbook an agent
 * installed from the Playbook Exchange, by agent.
 *
 * Filled by `checkPlaybookUpdates()` in `src/renderer/services/playbookUpdates.ts`
 * (the Exchange forces a check each time it opens; the Auto Run playbook
 * dropdown checks once per agent per app start) and read by the "Update
 * available" pills on the Exchange detail view and the dropdown.
 *
 * Not persisted: the check is cheap and a stale answer is worse than none.
 */

import { create } from 'zustand';
import type { PlaybookUpdateStatusMap } from '../../shared/playbookUpdates';

interface PlaybookUpdatesState {
	/** Statuses by agent id, then by saved playbook record id. */
	statusesBySession: Record<string, PlaybookUpdateStatusMap>;
	/** Agents whose check has run since the app started. */
	checkedSessionIds: Record<string, true>;
	/** Saved playbook record ids an update is running for right now. */
	updatingPlaybookIds: Record<string, true>;
	setStatuses: (sessionId: string, statuses: PlaybookUpdateStatusMap) => void;
	setUpdating: (playbookId: string, updating: boolean) => void;
}

const EMPTY_STATUSES: PlaybookUpdateStatusMap = {};

export const usePlaybookUpdatesStore = create<PlaybookUpdatesState>()((set) => ({
	statusesBySession: {},
	checkedSessionIds: {},
	updatingPlaybookIds: {},
	setStatuses: (sessionId, statuses) =>
		set((state) => ({
			statusesBySession: { ...state.statusesBySession, [sessionId]: statuses },
			checkedSessionIds: { ...state.checkedSessionIds, [sessionId]: true },
		})),
	setUpdating: (playbookId, updating) =>
		set((state) => {
			const next = { ...state.updatingPlaybookIds };
			if (updating) next[playbookId] = true;
			else delete next[playbookId];
			return { updatingPlaybookIds: next };
		}),
}));

/** The statuses of one agent's installed Exchange playbooks (stable empty map until checked). */
export function usePlaybookUpdateStatuses(sessionId: string): PlaybookUpdateStatusMap {
	return usePlaybookUpdatesStore((state) => state.statusesBySession[sessionId] ?? EMPTY_STATUSES);
}

/** Whether an update is running for the saved playbook record. */
export function useIsPlaybookUpdating(playbookId: string | undefined): boolean {
	return usePlaybookUpdatesStore((state) =>
		playbookId ? state.updatingPlaybookIds[playbookId] === true : false
	);
}
