/**
 * Granola IPC Handlers
 *
 * Two IPC channels for fetching Granola meeting documents and transcripts.
 * Data functions live in src/main/granola.ts.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { getRecentMeetings, getTranscript } from '../../granola';

const LOG_CONTEXT = '[Granola]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export function registerGranolaHandlers(): void {
	ipcMain.handle(
		'granola:get-documents',
		withIpcErrorLogging(handlerOpts('get-documents'), async (limit?: number) => {
			return getRecentMeetings(undefined, limit);
		})
	);

	ipcMain.handle(
		'granola:get-transcript',
		withIpcErrorLogging(handlerOpts('get-transcript'), async (documentId: string) => {
			return getTranscript(documentId);
		})
	);
}
