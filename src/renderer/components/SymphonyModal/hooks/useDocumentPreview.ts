import { useCallback, useRef, useState } from 'react';
import type { RegisteredRepository } from '../../../../shared/symphony-types';
import { logger } from '../../../utils/logger';

export interface DocumentFetchResult {
	success: boolean;
	content?: string;
	error?: string;
}

export interface UseDocumentPreviewDeps {
	selectedRepo: RegisteredRepository | null;
	fetchDocumentContent: (path: string) => Promise<DocumentFetchResult>;
}

export interface UseDocumentPreviewResult {
	documentPreview: string | null;
	isLoadingDocument: boolean;
	previewDocument: (path: string, isExternal: boolean) => Promise<void>;
	resetPreview: () => void;
}

/**
 * Coordinates the markdown preview pane in RepositoryDetailView.
 *
 * - External (http/https) paths → fetch via IPC and surface the content.
 * - Repo-relative paths → show a placeholder explaining the doc lives in the
 *   repo and will be available once the contribution starts.
 * - If no repo is selected, the call is a no-op.
 */
export function useDocumentPreview({
	selectedRepo,
	fetchDocumentContent,
}: UseDocumentPreviewDeps): UseDocumentPreviewResult {
	const [documentPreview, setDocumentPreview] = useState<string | null>(null);
	const [isLoadingDocument, setIsLoadingDocument] = useState(false);
	const fetchDocumentContentRef = useRef(fetchDocumentContent);
	const latestPreviewRequestIdRef = useRef(0);
	fetchDocumentContentRef.current = fetchDocumentContent;

	const previewDocument = useCallback(
		async (path: string, isExternal: boolean) => {
			if (!selectedRepo) return;
			const requestId = latestPreviewRequestIdRef.current + 1;
			latestPreviewRequestIdRef.current = requestId;
			const isCurrentRequest = () => latestPreviewRequestIdRef.current === requestId;

			setIsLoadingDocument(true);
			setDocumentPreview(null);

			try {
				if (isExternal && path.startsWith('http')) {
					const result = await fetchDocumentContentRef.current(path);
					if (!isCurrentRequest()) return;
					if (result.success && result.content !== undefined) {
						setDocumentPreview(result.content);
					} else {
						setDocumentPreview(`*Failed to load document: ${result.error || 'Unknown error'}*`);
					}
				} else {
					if (!isCurrentRequest()) return;
					setDocumentPreview(
						`*This document is located at \`${path}\` in the repository and will be available when you start the contribution.*`
					);
				}
			} catch (error) {
				logger.error('Failed to fetch document:', undefined, error);
				if (!isCurrentRequest()) return;
				setDocumentPreview(
					`*Failed to load document: ${error instanceof Error ? error.message : 'Unknown error'}*`
				);
			} finally {
				if (isCurrentRequest()) {
					setIsLoadingDocument(false);
				}
			}
		},
		[selectedRepo]
	);

	const resetPreview = useCallback(() => {
		latestPreviewRequestIdRef.current += 1;
		setDocumentPreview(null);
		setIsLoadingDocument(false);
	}, []);

	return { documentPreview, isLoadingDocument, previewDocument, resetPreview };
}
