import type { RefObject } from 'react';
import type { Theme } from '../../../types';
import type { GeneratedDocument } from '../../Wizard/WizardContext';

export interface DocumentGenerationViewProps {
	/** Theme for styling */
	theme: Theme;
	/** Array of generated documents */
	documents: GeneratedDocument[];
	/** Index of the currently selected document */
	currentDocumentIndex: number;
	/** Whether documents are still being generated */
	isGenerating: boolean;
	/** Streaming content being generated (shown during generation) */
	streamingContent?: string;
	/** Called when generation completes and user clicks Done */
	onComplete: () => void;
	/** Called when user wants to complete the wizard AND immediately start the Batch Runner for the generated docs */
	onCompleteAndStartAutoRun?: () => void;
	/** Called when user selects a different document */
	onDocumentSelect: (index: number) => void;
	/** Folder path for Auto Run docs */
	folderPath?: string;
	/** Called when document content changes (for editing) */
	onContentChange?: (content: string, docIndex: number) => void;
	/** Progress message to show during generation */
	progressMessage?: string;
	/** Current document being generated (for progress indicator) */
	currentGeneratingIndex?: number;
	/** Total number of documents to generate (for progress indicator) */
	totalDocuments?: number;
	/** Called when user wants to cancel generation */
	onCancel?: () => void;
	/** Subfolder name where documents are saved (for completion message) */
	subfolderName?: string;
	/** Wall-clock timestamp (ms) when generation started; used so elapsed time survives unmount/remount when switching tabs */
	startedAt?: number;
}

export interface DocumentSelectorProps {
	documents: GeneratedDocument[];
	selectedIndex: number;
	onSelect: (index: number) => void;
	theme: Theme;
	disabled?: boolean;
}

export interface DocumentEditorProps {
	content: string;
	onContentChange: (content: string) => void;
	mode: 'edit' | 'preview';
	onModeChange: (mode: 'edit' | 'preview') => void;
	folderPath?: string;
	selectedFile?: string;
	attachments: Array<{ filename: string; dataUrl: string }>;
	onAddAttachment: (filename: string, dataUrl: string) => void;
	onRemoveAttachment: (filename: string) => void;
	theme: Theme;
	isLocked: boolean;
	textareaRef: RefObject<HTMLTextAreaElement>;
	previewRef: RefObject<HTMLDivElement>;
}
