import type { Theme } from '../../../../../types';
import type { GeneratedDocument } from '../../../WizardContext';
import { DocumentSelector } from '../../DocumentSelector';
import type { DocumentEditorMode } from '../types';
import { EditorModeToggle } from './EditorModeToggle';

interface EditorHeaderProps {
	showHeader: boolean;
	documents: GeneratedDocument[];
	selectedDocIndex: number;
	onDocumentSelect: (index: number) => void;
	mode: DocumentEditorMode;
	onModeChange: (mode: DocumentEditorMode) => void;
	statsText: string;
	theme: Theme;
	isLocked: boolean;
	isDropdownOpen?: boolean;
	onDropdownOpenChange?: (isOpen: boolean) => void;
}

export function EditorHeader({
	showHeader,
	documents,
	selectedDocIndex,
	onDocumentSelect,
	mode,
	onModeChange,
	statsText,
	theme,
	isLocked,
	isDropdownOpen,
	onDropdownOpenChange,
}: EditorHeaderProps): JSX.Element {
	if (!showHeader) {
		return (
			<div className="flex items-center justify-center gap-2 mb-3">
				<EditorModeToggle
					mode={mode}
					onModeChange={onModeChange}
					theme={theme}
					isLocked={isLocked}
				/>
			</div>
		);
	}

	return (
		<>
			<div className="flex items-center justify-center gap-3 mb-2">
				<DocumentSelector
					documents={documents}
					selectedIndex={selectedDocIndex}
					onSelect={onDocumentSelect}
					theme={theme}
					disabled={isLocked}
					className="min-w-0"
					isOpen={isDropdownOpen}
					onOpenChange={onDropdownOpenChange}
				/>

				<EditorModeToggle
					mode={mode}
					onModeChange={onModeChange}
					theme={theme}
					isLocked={isLocked}
				/>
			</div>

			<div className="text-center mb-3">
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					{statsText}
				</span>
			</div>
		</>
	);
}
