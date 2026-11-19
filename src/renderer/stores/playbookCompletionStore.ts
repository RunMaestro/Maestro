/**
 * playbookCompletionStore - the reports of finished playbook runs waiting to
 * be read, first in first out.
 *
 * Every run of a saved playbook ends with a report (`BatchCompleteInfo.report`),
 * and `useBatchHandlers` enqueues it here whatever started the run: the
 * Playbook Exchange, the Auto Run panel, or `maestro-cli`. The completion
 * modal shows `queue[0]`; Done (or Escape) drops it and the next one shows.
 * Two runs that finish together therefore read one after the other, never
 * one over the other.
 *
 * The queue drives the `playbookReport` modal-store entry: the first enqueue
 * opens it and the last dismissal closes it, so the layer stack and every
 * "is a modal open" check see the modal like any other.
 *
 * The queue is not persisted. A dismissed or lost report is never gone: it is
 * in History and in `<autoRunFolder>/.maestro-reports/`.
 */

import { create } from 'zustand';
import type { PlaybookRunReport } from '../../shared/playbookRunReport';
import { generateId } from '../utils/ids';
import { useModalStore } from './modalStore';

/** One finished run waiting in the queue. */
export interface PlaybookCompletion {
	/** Unique per enqueue: the same report shown twice is two entries. */
	id: string;
	/** The agent that ran the playbook (its cwd is where Save writes). */
	sessionId: string;
	report: PlaybookRunReport;
}

interface PlaybookCompletionState {
	queue: PlaybookCompletion[];
	/** Add a report to the back of the queue and make sure the modal is open. */
	enqueue: (sessionId: string, report: PlaybookRunReport) => void;
	/** Drop the report on screen. Closes the modal when it was the last one. */
	dismissCurrent: () => void;
	/** Drop every waiting report and close the modal. */
	clear: () => void;
}

export const usePlaybookCompletionStore = create<PlaybookCompletionState>()((set, get) => ({
	queue: [],

	enqueue: (sessionId, report) => {
		set((state) => ({ queue: [...state.queue, { id: generateId(), sessionId, report }] }));
		useModalStore.getState().openModal('playbookReport');
	},

	dismissCurrent: () => {
		const rest = get().queue.slice(1);
		set({ queue: rest });
		if (rest.length === 0) useModalStore.getState().closeModal('playbookReport');
	},

	clear: () => {
		set({ queue: [] });
		useModalStore.getState().closeModal('playbookReport');
	},
}));

/** The report on screen: the oldest one waiting, or null when none is. */
export const selectCurrentPlaybookCompletion = (
	state: Pick<PlaybookCompletionState, 'queue'>
): PlaybookCompletion | null => state.queue[0] ?? null;

/** How many reports are waiting, the one on screen included. */
export const selectPlaybookCompletionCount = (
	state: Pick<PlaybookCompletionState, 'queue'>
): number => state.queue.length;
