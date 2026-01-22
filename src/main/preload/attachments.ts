/**
 * Preload API for attachments
 *
 * Provides the window.maestro.attachments namespace for:
 * - Per-session image storage for scratchpad
 * - Saving, loading, deleting attachments
 * - Listing attachments for a session
 */

import { ipcRenderer } from 'electron';

/**
 * Response from attachment operations
 */
export interface AttachmentResponse {
	success: boolean;
	error?: string;
}

/**
 * Response from loading an attachment
 */
export interface AttachmentLoadResponse {
	success: boolean;
	data?: string;
	error?: string;
}

/**
 * Response from listing attachments
 */
export interface AttachmentListResponse {
	success: boolean;
	files?: string[];
	error?: string;
}

/**
 * Response from getting attachment path
 */
export interface AttachmentPathResponse {
	success: boolean;
	path?: string;
	error?: string;
}

/**
 * Creates the attachments API object for preload exposure
 */
export function createAttachmentsApi() {
	return {
		/**
		 * Save an attachment for a session
		 * @param sessionId - Session ID
		 * @param base64Data - Base64 encoded file data
		 * @param filename - Filename to save as
		 */
		save: (sessionId: string, base64Data: string, filename: string): Promise<AttachmentResponse> =>
			ipcRenderer.invoke('attachments:save', sessionId, base64Data, filename),

		/**
		 * Load an attachment for a session
		 * @param sessionId - Session ID
		 * @param filename - Filename to load
		 */
		load: (sessionId: string, filename: string): Promise<AttachmentLoadResponse> =>
			ipcRenderer.invoke('attachments:load', sessionId, filename),

		/**
		 * Delete an attachment for a session
		 * @param sessionId - Session ID
		 * @param filename - Filename to delete
		 */
		delete: (sessionId: string, filename: string): Promise<AttachmentResponse> =>
			ipcRenderer.invoke('attachments:delete', sessionId, filename),

		/**
		 * List all attachments for a session
		 * @param sessionId - Session ID
		 */
		list: (sessionId: string): Promise<AttachmentListResponse> =>
			ipcRenderer.invoke('attachments:list', sessionId),

		/**
		 * Get the filesystem path for session attachments
		 * @param sessionId - Session ID
		 */
		getPath: (sessionId: string): Promise<AttachmentPathResponse> =>
			ipcRenderer.invoke('attachments:getPath', sessionId),
	};
}

/**
 * TypeScript type for the attachments API
 */
export type AttachmentsApi = ReturnType<typeof createAttachmentsApi>;
