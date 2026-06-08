import { useCallback, useRef, useState } from 'react';
import type { MarketplacePlaybook } from '../../../../shared/marketplace-types';
import { generateDefaultFolderName } from '../helpers';

export interface UsePlaybookDetailStateParams {
	fetchReadme: (playbookPath: string) => Promise<string | null>;
	fetchDocument: (playbookPath: string, filename: string) => Promise<string | null>;
}

export function usePlaybookDetailState({
	fetchReadme,
	fetchDocument,
}: UsePlaybookDetailStateParams) {
	const [selectedPlaybook, setSelectedPlaybook] = useState<MarketplacePlaybook | null>(null);
	const [showDetailView, setShowDetailView] = useState(false);
	const [readmeContent, setReadmeContent] = useState<string | null>(null);
	const [selectedDocFilename, setSelectedDocFilename] = useState<string | null>(null);
	const [documentContent, setDocumentContent] = useState<string | null>(null);
	const [isLoadingDocument, setIsLoadingDocument] = useState(false);
	const [targetFolderName, setTargetFolderName] = useState('');
	const latestRequestRef = useRef(0);

	const handleBackToList = useCallback(() => {
		latestRequestRef.current += 1;
		setShowDetailView(false);
		setSelectedPlaybook(null);
		setReadmeContent(null);
		setSelectedDocFilename(null);
		setDocumentContent(null);
		setIsLoadingDocument(false);
		setTargetFolderName('');
	}, []);

	const handleSelectPlaybook = useCallback(
		async (playbook: MarketplacePlaybook) => {
			setSelectedPlaybook(playbook);
			setShowDetailView(true);
			setSelectedDocFilename(null);
			setDocumentContent(null);
			setTargetFolderName(generateDefaultFolderName(playbook.title));

			const requestId = latestRequestRef.current + 1;
			latestRequestRef.current = requestId;
			setIsLoadingDocument(true);
			const readme = await fetchReadme(playbook.path);
			if (latestRequestRef.current !== requestId) return;
			setReadmeContent(readme);
			setIsLoadingDocument(false);
		},
		[fetchReadme]
	);

	const handleSelectDocument = useCallback(
		async (filename: string) => {
			if (!selectedPlaybook) return;

			if (filename === '') {
				latestRequestRef.current += 1;
				setSelectedDocFilename(null);
				setDocumentContent(null);
				setIsLoadingDocument(false);
				return;
			}

			setSelectedDocFilename(filename);
			const requestId = latestRequestRef.current + 1;
			latestRequestRef.current = requestId;
			setIsLoadingDocument(true);
			const content = await fetchDocument(selectedPlaybook.path, filename);
			if (latestRequestRef.current !== requestId) return;
			setDocumentContent(content);
			setIsLoadingDocument(false);
		},
		[selectedPlaybook, fetchDocument]
	);

	return {
		selectedPlaybook,
		showDetailView,
		readmeContent,
		selectedDocFilename,
		documentContent,
		isLoadingDocument,
		targetFolderName,
		setTargetFolderName,
		handleBackToList,
		handleSelectPlaybook,
		handleSelectDocument,
	};
}
