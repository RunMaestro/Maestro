import { useState } from 'react';
import type { DocumentEditorProps } from './types';
import { AttachmentStrip, EditorContent, EditorHeader } from './components';
import { useDocumentEditorKeyboard, useDocumentEditorPaste, useMarkdownPreview } from './hooks';

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
	documents,
	selectedDocIndex,
	onDocumentSelect,
	statsText,
	proseClassPrefix = 'doc-editor',
	showHeader = true,
	isDropdownOpen,
	onDropdownOpenChange,
}: DocumentEditorProps): JSX.Element {
	const [attachmentsExpanded, setAttachmentsExpanded] = useState(true);

	const handlePaste = useDocumentEditorPaste({
		content,
		folderPath,
		selectedFile,
		isLocked,
		onContentChange,
		onAddAttachment,
		textareaRef,
	});

	const handleKeyDown = useDocumentEditorKeyboard({
		content,
		mode,
		onContentChange,
		onModeChange,
		textareaRef,
	});

	const { proseStyles, markdownComponents } = useMarkdownPreview({
		folderPath,
		proseClassPrefix,
		theme,
	});

	return (
		<div className="flex flex-col flex-1 min-h-0">
			<EditorHeader
				showHeader={showHeader}
				documents={documents}
				selectedDocIndex={selectedDocIndex}
				onDocumentSelect={onDocumentSelect}
				mode={mode}
				onModeChange={onModeChange}
				statsText={statsText}
				theme={theme}
				isLocked={isLocked}
				isDropdownOpen={isDropdownOpen}
				onDropdownOpenChange={onDropdownOpenChange}
			/>

			{mode === 'edit' && (
				<AttachmentStrip
					attachments={attachments}
					attachmentsExpanded={attachmentsExpanded}
					setAttachmentsExpanded={setAttachmentsExpanded}
					theme={theme}
					onRemoveAttachment={onRemoveAttachment}
				/>
			)}

			<EditorContent
				content={content}
				onContentChange={onContentChange}
				mode={mode}
				onModeChange={onModeChange}
				onKeyDown={handleKeyDown}
				onPaste={handlePaste}
				markdownComponents={markdownComponents}
				proseStyles={proseStyles}
				proseClassPrefix={proseClassPrefix}
				theme={theme}
				isLocked={isLocked}
				textareaRef={textareaRef}
				previewRef={previewRef}
			/>
		</div>
	);
}

export default DocumentEditor;
