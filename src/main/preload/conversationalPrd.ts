/**
 * Preload API for the Conversational PRD Planner
 *
 * Provides the window.maestro.conversationalPrd namespace for:
 * - Opening a new planning conversation (createSession)
 * - Submitting a user turn (sendMessage)
 * - Retrieving a session by ID (getSession)
 * - Listing sessions (listSessions)
 * - Archiving a session (archiveSession)
 * - Finalizing/committing a draft as a Delivery Planner PRD item (finalizeSession)
 */

import { ipcRenderer } from 'electron';

export function createConversationalPrdApi() {
	return {
		/** Open a new planning conversation. */
		createSession: (input: unknown) => ipcRenderer.invoke('conversationalPrd:createSession', input),

		/** Submit a user turn and receive the assistant reply + draft delta. */
		sendMessage: (input: unknown) => ipcRenderer.invoke('conversationalPrd:sendMessage', input),

		/** Retrieve a session by its conversationId. */
		getSession: (conversationId: string) =>
			ipcRenderer.invoke('conversationalPrd:getSession', conversationId),

		/** List sessions, optionally filtered by projectPath and/or includeArchived. */
		listSessions: (filters?: { projectPath?: string; includeArchived?: boolean }) =>
			ipcRenderer.invoke('conversationalPrd:listSessions', filters),

		/** Archive a session (hides it from the default list). */
		archiveSession: (input: { sessionId: string; actor?: unknown }) =>
			ipcRenderer.invoke('conversationalPrd:archiveSession', input),

		/** Commit the accumulated draft as a Delivery Planner PRD work item. */
		finalizeSession: (input: unknown) =>
			ipcRenderer.invoke('conversationalPrd:finalizeSession', input),
	};
}

export type ConversationalPrdApi = ReturnType<typeof createConversationalPrdApi>;
