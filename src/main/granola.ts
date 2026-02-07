/**
 * Granola meeting transcript integration.
 *
 * Two functions to fetch meeting documents and transcripts from Granola's API.
 * Auth token read from ~/Library/Application Support/Granola/supabase.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { logger } from './utils/logger';
import type {
	GranolaDocument,
	GranolaTranscript,
	GranolaResult,
	GranolaErrorType,
} from '../shared/granola-types';

const LOG_CONTEXT = '[Granola]';
const API_BASE = 'https://api.granola.ai';

const DEFAULT_TOKEN_PATH = path.join(app.getPath('appData'), 'Granola', 'supabase.json');

function readToken(tokenPath: string): string | null {
	try {
		const raw = fs.readFileSync(tokenPath, 'utf-8');
		const data = JSON.parse(raw);
		// Token is in workos_tokens which may be a JSON string
		let workosTokens = data.workos_tokens;
		if (typeof workosTokens === 'string') {
			workosTokens = JSON.parse(workosTokens);
		}
		return workosTokens?.access_token || null;
	} catch {
		return null;
	}
}

function errorType(error: unknown): GranolaErrorType {
	if (error instanceof TypeError && String(error).includes('fetch')) {
		return 'network_error';
	}
	return 'api_error';
}

export async function getRecentMeetings(
	tokenPath = DEFAULT_TOKEN_PATH,
	limit = 50
): Promise<GranolaResult<GranolaDocument[]>> {
	const token = readToken(tokenPath);
	if (!token) {
		// Check if the file exists at all to distinguish not_installed vs auth_expired
		if (!fs.existsSync(tokenPath)) {
			return { success: false, error: 'not_installed' };
		}
		return { success: false, error: 'auth_expired' };
	}

	try {
		const response = await fetch(`${API_BASE}/v2/get-documents`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ limit }),
		});

		if (response.status === 401 || response.status === 403) {
			return { success: false, error: 'auth_expired' };
		}
		if (!response.ok) {
			logger.error(`Granola API error: ${response.status}`, LOG_CONTEXT);
			return { success: false, error: 'api_error' };
		}

		const body = await response.json();
		const docs: GranolaDocument[] = (body.docs || []).map((doc: any) => ({
			id: doc.id,
			title: doc.title || 'Untitled Meeting',
			createdAt: new Date(doc.created_at).getTime(),
			participants: (doc.people || []).map((p: any) => p.name || p.email || 'Unknown'),
		}));

		return { success: true, data: docs };
	} catch (error) {
		logger.error(`Failed to fetch Granola documents: ${error}`, LOG_CONTEXT);
		return { success: false, error: errorType(error) };
	}
}

export async function getTranscript(
	documentId: string,
	tokenPath = DEFAULT_TOKEN_PATH
): Promise<GranolaResult<GranolaTranscript>> {
	const token = readToken(tokenPath);
	if (!token) {
		if (!fs.existsSync(tokenPath)) {
			return { success: false, error: 'not_installed' };
		}
		return { success: false, error: 'auth_expired' };
	}

	try {
		// First get the document title
		const docResponse = await fetch(`${API_BASE}/v2/get-documents`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ limit: 1, filter: { ids: [documentId] } }),
		});

		let title = 'Meeting';
		if (docResponse.ok) {
			const docBody = await docResponse.json();
			title = docBody.docs?.[0]?.title || title;
		}

		// Fetch transcript segments
		const response = await fetch(`${API_BASE}/v1/get-document-transcript`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ document_id: documentId }),
		});

		if (response.status === 401 || response.status === 403) {
			return { success: false, error: 'auth_expired' };
		}
		if (!response.ok) {
			logger.error(`Granola transcript API error: ${response.status}`, LOG_CONTEXT);
			return { success: false, error: 'api_error' };
		}

		const segments = await response.json();
		// API returns array of segments: { text, source, start_timestamp, end_timestamp }
		const segmentArray = Array.isArray(segments) ? segments : [];
		const plainText = segmentArray.map((s: any) => s.text || '').join('\n');

		return {
			success: true,
			data: { documentId, title, plainText },
		};
	} catch (error) {
		logger.error(`Failed to fetch Granola transcript: ${error}`, LOG_CONTEXT);
		return { success: false, error: errorType(error) };
	}
}
