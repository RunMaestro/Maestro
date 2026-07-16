import { useCallback, useEffect, useRef, useState } from 'react';
import { PLAYBOOKS_DIR } from '../../../../../../shared/maestro-paths';
import { escapeRegExp } from '../../../../../../shared/stringUtils';
import type { GeneratedDocument, WizardState } from '../../../WizardContext';

export function usePhaseReviewDocumentState({
	state,
	getPhase1Content,
	setCurrentDocumentIndex,
}: {
	state: WizardState;
	getPhase1Content: () => string;
	setCurrentDocumentIndex: (index: number) => void;
}) {
	const { generatedDocuments, directoryPath, currentDocumentIndex } = state;
	const currentDoc = generatedDocuments[currentDocumentIndex] || generatedDocuments[0];
	const folderPath = `${directoryPath}/${PLAYBOOKS_DIR}`;

	const [localContent, setLocalContent] = useState(
		currentDocumentIndex === 0 ? getPhase1Content() : currentDoc?.content || ''
	);
	const [mode, setMode] = useState<'edit' | 'preview'>('preview');
	const [attachments, setAttachments] = useState<Array<{ filename: string; dataUrl: string }>>([]);
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);

	const readyButtonRef = useRef<HTMLButtonElement>(null);
	const tourButtonRef = useRef<HTMLButtonElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const previewRef = useRef<HTMLDivElement>(null);
	const prevDocumentIndexRef = useRef<number>(currentDocumentIndex);

	useEffect(() => {
		const newContent =
			currentDocumentIndex === 0
				? getPhase1Content()
				: generatedDocuments[currentDocumentIndex]?.content || '';
		setLocalContent(newContent);

		if (prevDocumentIndexRef.current !== currentDocumentIndex) {
			setMode('preview');
			prevDocumentIndexRef.current = currentDocumentIndex;
		}
	}, [currentDocumentIndex, generatedDocuments, getPhase1Content]);

	const handleDocumentSelect = useCallback(
		(index: number) => {
			setCurrentDocumentIndex(index);
		},
		[setCurrentDocumentIndex]
	);

	const handleContentChange = useCallback((newContent: string) => {
		setLocalContent(newContent);
	}, []);

	const handleModeChange = useCallback((newMode: 'edit' | 'preview') => {
		setMode(newMode);
		setTimeout(() => {
			if (newMode === 'edit') {
				textareaRef.current?.focus();
			} else {
				previewRef.current?.focus();
			}
		}, 50);
	}, []);

	const handleAddAttachment = useCallback((filename: string, dataUrl: string) => {
		setAttachments((prev) => [...prev, { filename, dataUrl }]);
	}, []);

	const handleRemoveAttachment = useCallback(
		async (filename: string) => {
			setAttachments((prev) => prev.filter((attachment) => attachment.filename !== filename));
			await window.maestro.autorun.deleteImage(folderPath, filename);

			const escapedPath = escapeRegExp(filename);
			const fname = filename.split('/').pop() || filename;
			const escapedFilename = escapeRegExp(fname);
			const regex = new RegExp(`!\\[${escapedFilename}\\]\\(${escapedPath}\\)\\n?`, 'g');
			setLocalContent((prev) => prev.replace(regex, ''));
		},
		[folderPath]
	);

	return {
		currentDoc: currentDoc as GeneratedDocument | undefined,
		folderPath,
		localContent,
		mode,
		attachments,
		isDropdownOpen,
		readyButtonRef,
		tourButtonRef,
		containerRef,
		textareaRef,
		previewRef,
		setIsDropdownOpen,
		handleDocumentSelect,
		handleContentChange,
		handleModeChange,
		handleAddAttachment,
		handleRemoveAttachment,
	};
}
