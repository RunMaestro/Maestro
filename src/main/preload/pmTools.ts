/**
 * Preload API for the pm-tools IPC channels (#430).
 *
 * Exposes window.maestro.pmTools.{setStatus, setRole, setBlocked} so agents
 * (and any renderer code) can call the three agent-callable project management
 * tools without touching ipcRenderer directly.
 *
 * Slash-command wiring is out of scope here — that is #428's job.
 */

import { ipcRenderer } from 'electron';

export function createPmToolsApi() {
	return {
		/**
		 * Update the Projects v2 Status field for the agent's currently-claimed work item.
		 * @param agentSessionId - the calling agent's session ID (used to look up its claim)
		 * @param status - one of: Idea | PRD Draft | Refinement | Tasks Ready | In Progress | In Review | Blocked | Done
		 */
		setStatus: (agentSessionId: string, status: string) =>
			ipcRenderer.invoke('pm:setStatus', { agentSessionId, status }),

		/**
		 * Update the Projects v2 Role field for the agent's currently-claimed work item.
		 * @param agentSessionId - the calling agent's session ID
		 * @param role - one of: runner | fixer | reviewer | merger
		 */
		setRole: (agentSessionId: string, role: string) =>
			ipcRenderer.invoke('pm:setRole', { agentSessionId, role }),

		/**
		 * Set the work item to Blocked status, update the Projects v2 Status field,
		 * and post a GitHub comment with the reason.
		 * @param agentSessionId - the calling agent's session ID
		 * @param reason - human-readable explanation (posted as a GitHub comment)
		 */
		setBlocked: (agentSessionId: string, reason: string) =>
			ipcRenderer.invoke('pm:setBlocked', { agentSessionId, reason }),
	};
}

export type PmToolsApi = ReturnType<typeof createPmToolsApi>;
