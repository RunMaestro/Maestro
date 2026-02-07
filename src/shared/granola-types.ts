/**
 * Types for Granola meeting transcript integration.
 *
 * Granola stores auth tokens locally at ~/Library/Application Support/Granola/supabase.json.
 * API endpoints: POST https://api.granola.ai/v2/get-documents, POST https://api.granola.ai/v1/get-document-transcript
 */

export interface GranolaDocument {
	id: string;
	title: string;
	createdAt: number; // epoch ms, parsed from API's created_at
	participants: string[]; // extracted from API's people array
}

export interface GranolaTranscript {
	documentId: string;
	title: string;
	plainText: string; // joined transcript segments
}

export type GranolaResult<T> =
	| { success: true; data: T }
	| { success: false; error: GranolaErrorType };

export type GranolaErrorType = 'not_installed' | 'auth_expired' | 'api_error' | 'network_error';
