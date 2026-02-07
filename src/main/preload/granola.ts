/**
 * Preload API for Granola meeting transcript integration
 *
 * Provides the window.maestro.granola namespace for:
 * - Fetching recent meeting documents
 * - Fetching meeting transcripts
 */

import { ipcRenderer } from 'electron';
import type {
	GranolaDocument,
	GranolaTranscript,
	GranolaResult,
} from '../../shared/granola-types';

export interface GranolaApi {
	getDocuments: (limit?: number) => Promise<GranolaResult<GranolaDocument[]>>;
	getTranscript: (documentId: string) => Promise<GranolaResult<GranolaTranscript>>;
}

export function createGranolaApi(): GranolaApi {
	return {
		getDocuments: (limit?: number) =>
			ipcRenderer.invoke('granola:get-documents', limit),
		getTranscript: (documentId: string) =>
			ipcRenderer.invoke('granola:get-transcript', documentId),
	};
}
