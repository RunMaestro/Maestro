import type { ClipboardEventHandler, ComponentProps, KeyboardEventHandler } from 'react';
import type { Theme } from '../../../../../types';
import type { DocumentEditorMode, DocumentEditorProps } from '../types';
import { EditorTextarea } from './EditorTextarea';
import { MarkdownPreview } from './MarkdownPreview';

interface EditorContentProps {
	content: string;
	onContentChange: (content: string) => void;
	mode: DocumentEditorMode;
	onModeChange: (mode: DocumentEditorMode) => void;
	onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
	onPaste: ClipboardEventHandler<HTMLTextAreaElement>;
	markdownComponents: ComponentProps<typeof MarkdownPreview>['markdownComponents'];
	proseStyles: string;
	proseClassPrefix: string;
	theme: Theme;
	isLocked: boolean;
	textareaRef: DocumentEditorProps['textareaRef'];
	previewRef: DocumentEditorProps['previewRef'];
}

export function EditorContent({
	content,
	onContentChange,
	mode,
	onModeChange,
	onKeyDown,
	onPaste,
	markdownComponents,
	proseStyles,
	proseClassPrefix,
	theme,
	isLocked,
	textareaRef,
	previewRef,
}: EditorContentProps): JSX.Element {
	return (
		<div className="flex-1 min-h-0 flex flex-col overflow-hidden">
			{mode === 'edit' ? (
				<EditorTextarea
					content={content}
					onContentChange={onContentChange}
					onKeyDown={!isLocked ? onKeyDown : undefined}
					onPaste={onPaste}
					theme={theme}
					isLocked={isLocked}
					textareaRef={textareaRef}
				/>
			) : (
				<MarkdownPreview
					content={content}
					markdownComponents={markdownComponents}
					proseClassPrefix={proseClassPrefix}
					proseStyles={proseStyles}
					previewRef={previewRef}
					theme={theme}
					onEditShortcut={() => onModeChange('edit')}
				/>
			)}
		</div>
	);
}
