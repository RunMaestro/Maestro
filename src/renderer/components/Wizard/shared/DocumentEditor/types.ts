import type { RefObject } from 'react';
import type { Theme } from '../../../../types';
import type { GeneratedDocument } from '../../WizardContext';

export type DocumentEditorMode = 'edit' | 'preview';

export interface DocumentAttachment {
	filename: string;
	dataUrl: string;
}

export interface DocumentEditorProps {
	content: string;
	onContentChange: (content: string) => void;
	mode: DocumentEditorMode;
	onModeChange: (mode: DocumentEditorMode) => void;
	folderPath: string;
	selectedFile: string;
	attachments: DocumentAttachment[];
	onAddAttachment: (filename: string, dataUrl: string) => void;
	onRemoveAttachment: (filename: string) => void;
	theme: Theme;
	isLocked: boolean;
	textareaRef: RefObject<HTMLTextAreaElement>;
	previewRef: RefObject<HTMLDivElement>;
	documents: GeneratedDocument[];
	selectedDocIndex: number;
	onDocumentSelect: (index: number) => void;
	statsText: string;
	proseClassPrefix?: string;
	showHeader?: boolean;
	isDropdownOpen?: boolean;
	onDropdownOpenChange?: (isOpen: boolean) => void;
}
