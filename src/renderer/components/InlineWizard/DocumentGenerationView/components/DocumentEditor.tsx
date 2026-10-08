import { DocumentEditor as SharedDocumentEditor } from '../../../Wizard/shared/DocumentEditor';
import type { DocumentEditorProps } from '../types';

export function DocumentEditor({
	content,
	onContentChange,
	mode,
	onModeChange,
	folderPath,
	selectedFile,
	attachments,
	onAddAttachment,
	onRemoveAttachment,
	theme,
	isLocked,
	textareaRef,
	previewRef,
}: DocumentEditorProps): JSX.Element {
	return (
		<SharedDocumentEditor
			content={content}
			onContentChange={onContentChange}
			mode={mode}
			onModeChange={onModeChange}
			folderPath={folderPath ?? ''}
			selectedFile={selectedFile ?? ''}
			attachments={attachments}
			onAddAttachment={onAddAttachment}
			onRemoveAttachment={onRemoveAttachment}
			theme={theme}
			isLocked={isLocked}
			textareaRef={textareaRef}
			previewRef={previewRef}
			documents={[]}
			selectedDocIndex={0}
			onDocumentSelect={() => {}}
			statsText=""
			proseClassPrefix="doc-gen-view"
			showHeader={false}
		/>
	);
}
