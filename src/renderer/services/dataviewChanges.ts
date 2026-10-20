/**
 * dataviewChanges - one `dataview:changed` listener per window, fanned out to
 * every mounted Dataview block and inline span (DV-7).
 *
 * A note can hold dozens of blocks and inline `= expr` spans. Each one
 * registering its own IPC listener would cost one `ipcRenderer.on` per span and
 * trip the max-listeners warning, so the first subscriber installs the single
 * listener and the last one to leave removes it.
 */

import type { DataviewChangeEvent, DataviewQueryResponse } from '../../shared/dataview';

type ChangeHandler = (event: DataviewChangeEvent) => void;

const handlers = new Set<ChangeHandler>();
let unsubscribeIpc: (() => void) | null = null;

/** Receive every `dataview:changed` event. Returns the unsubscribe function. */
export function subscribeDataviewChanges(handler: ChangeHandler): () => void {
	handlers.add(handler);
	if (!unsubscribeIpc) {
		unsubscribeIpc = window.maestro.dataview.onChanged((event) => {
			// Copy first: a handler may unsubscribe (or a new block subscribe) mid-dispatch.
			for (const notify of [...handlers]) notify(event);
		});
	}
	return () => {
		handlers.delete(handler);
		if (handlers.size === 0 && unsubscribeIpc) {
			unsubscribeIpc();
			unsubscribeIpc = null;
		}
	};
}

/**
 * Whether a change makes a shown result stale: the same root on the same host,
 * at a newer revision than the one the result read (the contract on
 * `DataviewQueryResponse`).
 */
export function isDataviewChangeFor(
	event: DataviewChangeEvent,
	response: Pick<DataviewQueryResponse<unknown>, 'root' | 'sshRemoteId' | 'revision'>
): boolean {
	return (
		event.root === response.root &&
		(event.sshRemoteId ?? null) === (response.sshRemoteId ?? null) &&
		event.revision > response.revision
	);
}
