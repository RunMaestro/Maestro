/**
 * Hook for fetching Granola meeting documents and transcripts.
 * Manages loading/error state and caches the document list.
 */

import { useState, useCallback } from 'react';
import type {
	GranolaDocument,
	GranolaTranscript,
	GranolaErrorType,
} from '../../shared/granola-types';

interface UseGranolaReturn {
	documents: GranolaDocument[];
	loading: boolean;
	error: GranolaErrorType | null;
	fetchDocuments: () => Promise<void>;
	fetchTranscript: (documentId: string) => Promise<GranolaTranscript | null>;
}

export function useGranola(): UseGranolaReturn {
	const [documents, setDocuments] = useState<GranolaDocument[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<GranolaErrorType | null>(null);

	const fetchDocuments = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await window.maestro.granola.getDocuments(50);
			if (result.success) {
				setDocuments(result.data);
			} else {
				setError(result.error);
				setDocuments([]);
			}
		} catch {
			setError('api_error');
			setDocuments([]);
		} finally {
			setLoading(false);
		}
	}, []);

	const fetchTranscript = useCallback(async (documentId: string): Promise<GranolaTranscript | null> => {
		try {
			const result = await window.maestro.granola.getTranscript(documentId);
			if (result.success) {
				return result.data;
			}
			return null;
		} catch {
			return null;
		}
	}, []);

	return { documents, loading, error, fetchDocuments, fetchTranscript };
}
