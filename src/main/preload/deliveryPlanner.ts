/**
 * Preload API for the Delivery Planner
 *
 * Provides the window.maestro.deliveryPlanner namespace for:
 * - PRD creation and decomposition (createPrd, decomposePrd, decomposeEpic)
 * - Dashboard snapshot (dashboard)
 * - GitHub/external mirror sync (sync)
 * - Bug follow-up and progress comments
 * - Path resolution and progress tracking
 * - Doc gap promotion
 * - Real-time progress events (onProgress)
 */

import { ipcRenderer } from 'electron';

export function createDeliveryPlannerApi() {
	return {
		/** Create a new PRD work item. */
		createPrd: (input: unknown) => ipcRenderer.invoke('deliveryPlanner:createPrd', input),

		/** Decompose a PRD into an Epic. */
		decomposePrd: (input: unknown) => ipcRenderer.invoke('deliveryPlanner:decomposePrd', input),

		/** Decompose an Epic into Tasks. */
		decomposeEpic: (input: unknown) => ipcRenderer.invoke('deliveryPlanner:decomposeEpic', input),

		/** Return dashboard snapshot (optionally scoped to a projectPath). */
		dashboard: (filters?: { projectPath?: string; gitPath?: string }) =>
			ipcRenderer.invoke('deliveryPlanner:dashboard', filters),

		/** Sync a work item to GitHub and/or external mirror. */
		sync: (input: unknown) => ipcRenderer.invoke('deliveryPlanner:sync', input),

		/** Create a bug follow-up work item. */
		createBugFollowUp: (input: unknown) =>
			ipcRenderer.invoke('deliveryPlanner:createBugFollowUp', input),

		/** Add a progress comment to a work item. */
		addProgressComment: (input: unknown) =>
			ipcRenderer.invoke('deliveryPlanner:addProgressComment', input),

		/** Resolve project/git paths for the delivery planner. */
		resolvePaths: (input?: unknown) => ipcRenderer.invoke('deliveryPlanner:resolvePaths', input),

		/** Get the decomposition progress snapshot for a work item. */
		getProgress: (id: string) => ipcRenderer.invoke('deliveryPlanner:getProgress', id),

		/** List all active decomposition progress snapshots. */
		listProgress: () => ipcRenderer.invoke('deliveryPlanner:listProgress'),

		/** Promote a documentation gap to a first-class work item. */
		promoteDocGap: (input: unknown) => ipcRenderer.invoke('deliveryPlanner:promoteDocGap', input),

		/**
		 * Listen for real-time decomposition progress events pushed from the
		 * main process via 'deliveryPlanner:progress'. Returns an unsubscribe
		 * function.
		 */
		onProgress: (handler: (event: unknown) => void): (() => void) => {
			const listener = (_e: unknown, event: unknown) => handler(event);
			ipcRenderer.on('deliveryPlanner:progress', listener);
			return () => {
				ipcRenderer.removeListener('deliveryPlanner:progress', listener);
			};
		},
	};
}

export type DeliveryPlannerApi = ReturnType<typeof createDeliveryPlannerApi>;
