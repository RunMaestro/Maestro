/**
 * Preload API for the Work Graph
 *
 * Provides the window.maestro.workGraph namespace for:
 * - Listing, searching, getting, creating, updating, deleting work items
 * - Claim lifecycle (claim, renew, release, complete)
 * - Event log and tag management
 * - Import and agent-ready work queries
 * - Real-time change notifications (onChanged)
 *
 * NOTE: The ipcMain handlers for these channels live in the Work Graph storage
 * layer (not yet wired via a handler file). The preload bridge is provided here
 * so the renderer can call these methods once the handlers are registered.
 */

import { ipcRenderer } from 'electron';

export function createWorkGraphApi() {
	return {
		/** List work items, optionally filtered. */
		listItems: (filters?: unknown) => ipcRenderer.invoke('workGraph:listItems', filters),

		/** Full-text / field search across work items. */
		searchItems: (filters: unknown) => ipcRenderer.invoke('workGraph:searchItems', filters),

		/** Retrieve a single work item by ID. */
		getItem: (id: string) => ipcRenderer.invoke('workGraph:getItem', id),

		/** Create a new work item. */
		createItem: (input: unknown) => ipcRenderer.invoke('workGraph:createItem', input),

		/** Update an existing work item. */
		updateItem: (input: unknown) => ipcRenderer.invoke('workGraph:updateItem', input),

		/** Delete a work item by ID. */
		deleteItem: (id: string) => ipcRenderer.invoke('workGraph:deleteItem', id),

		/** Claim a work item for an agent session. */
		claimItem: (input: unknown) => ipcRenderer.invoke('workGraph:claimItem', input),

		/** Renew an active claim (extend the lease). */
		renewClaim: (input: unknown) => ipcRenderer.invoke('workGraph:renewClaim', input),

		/** Release an active claim (return item to available state). */
		releaseClaim: (input: unknown) => ipcRenderer.invoke('workGraph:releaseClaim', input),

		/** Mark a claim as complete (terminal state). */
		completeClaim: (input: unknown) => ipcRenderer.invoke('workGraph:completeClaim', input),

		/** List all events for a work item. */
		listEvents: (workItemId: string) => ipcRenderer.invoke('workGraph:listEvents', workItemId),

		/** List all tag definitions. */
		listTags: () => ipcRenderer.invoke('workGraph:listTags'),

		/** Upsert a tag definition. */
		upsertTag: (definition: unknown) => ipcRenderer.invoke('workGraph:upsertTag', definition),

		/** Import a set of work items. */
		importItems: (input: unknown) => ipcRenderer.invoke('workGraph:importItems', input),

		/** Return unblocked, agent-ready work items. */
		getUnblockedAgentReadyWork: (filters?: unknown) =>
			ipcRenderer.invoke('workGraph:getUnblockedAgentReadyWork', filters),

		/**
		 * Listen for real-time Work Graph change events pushed from the main
		 * process via 'workGraph:changed'. Returns an unsubscribe function.
		 */
		onChanged: (handler: (event: unknown) => void): (() => void) => {
			const listener = (_e: unknown, event: unknown) => handler(event);
			ipcRenderer.on('workGraph:changed', listener);
			return () => {
				ipcRenderer.removeListener('workGraph:changed', listener);
			};
		},
	};
}

export type WorkGraphApi = ReturnType<typeof createWorkGraphApi>;
