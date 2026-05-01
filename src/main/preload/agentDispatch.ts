/**
 * Preload API for Agent Dispatch
 *
 * Provides the window.maestro.agentDispatch namespace for:
 * - Kanban board items from in-memory ClaimTracker (getBoard)
 * - Fleet registry entries (getFleet)
 * - Manual assignment, claim release, pause/resume (runtime handlers)
 * - Claim lifecycle events: onClaimStarted, onClaimEnded (renderer subscribes)
 * - MCP/slash-command registry: listAgents, listEligible, assign, release, pause, resume, createSubtask, status
 *
 * #444: workGraph namespace removed — GitHub Projects v2 is the sole durable state.
 * Board data now comes from the in-memory ClaimTracker via IPC events.
 */

import { ipcRenderer } from 'electron';

export function createAgentDispatchApi() {
	return {
		// -----------------------------------------------------------------------
		// Runtime handlers (agent-dispatch.ts)
		// -----------------------------------------------------------------------

		/** Return kanban-ready claim state from the in-memory ClaimTracker. */
		getBoard: () => ipcRenderer.invoke('agentDispatch:getBoard'),

		/** Return all current fleet entries from the FleetRegistry. */
		getFleet: () => ipcRenderer.invoke('agentDispatch:getFleet'),

		/** Manually assign a work item to an agent (userInitiated must be true). */
		assignManually: (input: unknown) => ipcRenderer.invoke('agentDispatch:assignManually', input),

		/** Release an active claim on a work item (clears AI Assigned Slot on GitHub). */
		releaseClaim: (input: unknown) => ipcRenderer.invoke('agentDispatch:releaseClaim', input),

		/** Pause auto-pickup for an agent (in-memory only, resets on restart). */
		pauseAgent: (agentId: string) => ipcRenderer.invoke('agentDispatch:pauseAgent', agentId),

		/** Resume auto-pickup for an agent (in-memory only, resets on restart). */
		resumeAgent: (agentId: string) => ipcRenderer.invoke('agentDispatch:resumeAgent', agentId),

		// -----------------------------------------------------------------------
		// Claim lifecycle events (#444)
		// Subscribe to these to keep the Dev Crew tab up to date without polling.
		// -----------------------------------------------------------------------

		/**
		 * Subscribe to claim-started events emitted by SlotExecutor just before
		 * the agent process is spawned. Returns an unsubscribe function.
		 */
		onClaimStarted: (
			handler: (event: {
				projectPath: string;
				role: string;
				agentId: string;
				sessionId: string;
				issueNumber?: number;
				issueTitle?: string;
				claimedAt: string;
			}) => void
		): (() => void) => {
			const listener = (_e: unknown, ev: unknown) => handler(ev as Parameters<typeof handler>[0]);
			ipcRenderer.on('agentDispatch:claimStarted', listener);
			return () => {
				ipcRenderer.removeListener('agentDispatch:claimStarted', listener);
			};
		},

		/**
		 * Subscribe to claim-ended events emitted by SlotExecutor after the agent
		 * process exits (success or failure). Returns an unsubscribe function.
		 */
		onClaimEnded: (
			handler: (event: {
				projectPath: string;
				role: string;
				agentId: string;
				sessionId: string;
				exitCode?: number;
			}) => void
		): (() => void) => {
			const listener = (_e: unknown, ev: unknown) => handler(ev as Parameters<typeof handler>[0]);
			ipcRenderer.on('agentDispatch:claimEnded', listener);
			return () => {
				ipcRenderer.removeListener('agentDispatch:claimEnded', listener);
			};
		},

		// -----------------------------------------------------------------------
		// Slash-command IPC handlers (agent-dispatch-slash-commands.ts).
		// NOTE: despite the old "-mcp" filename, these are plain Electron IPC channels, not MCP tools.
		// -----------------------------------------------------------------------

		/** List all registered agents from the in-memory dispatch registry. */
		listAgents: () => ipcRenderer.invoke('agentDispatch:listAgents'),

		/** List unclaimed agent-ready work items. */
		listEligible: () => ipcRenderer.invoke('agentDispatch:listEligible'),

		/** Claim a work item for an agent. */
		assign: (params: { itemId: string; sessionId: string }) =>
			ipcRenderer.invoke('agentDispatch:assign', params),

		/** Release an in-progress item back to agent-ready. */
		release: (params: { itemId: string }) => ipcRenderer.invoke('agentDispatch:release', params),

		/** Mark an agent as offline (paused). */
		pause: (params: { sessionId: string }) => ipcRenderer.invoke('agentDispatch:pause', params),

		/** Restore a paused agent to idle. */
		resume: (params: { sessionId: string }) => ipcRenderer.invoke('agentDispatch:resume', params),

		/** Create a new agent-ready subtask under an existing parent work item. */
		createSubtask: (params: { title: string; parentId: string; dependsOn?: string[] }) =>
			ipcRenderer.invoke('agentDispatch:createSubtask', params),

		/** Combined snapshot for slash commands and MCP status checks. */
		status: () => ipcRenderer.invoke('agentDispatch:status'),
	};
}

export type AgentDispatchApi = ReturnType<typeof createAgentDispatchApi>;
