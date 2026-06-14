import { useCallback } from 'react';
import type { ClipboardEvent, RefObject } from 'react';
import { captureException, captureMessage } from '../../../../../utils/sentry';
import { buildImageInsertion, insertTextAtSelection } from '../utils/editorCommands';

interface UseDocumentEditorPasteArgs {
	content: string;
	folderPath: string;
	selectedFile: string;
	isLocked: boolean;
	onContentChange: (content: string) => void;
	onAddAttachment: (filename: string, dataUrl: string) => void;
	textareaRef: RefObject<HTMLTextAreaElement>;
}

export function useDocumentEditorPaste({
	content,
	folderPath,
	selectedFile,
	isLocked,
	onContentChange,
	onAddAttachment,
	textareaRef,
}: UseDocumentEditorPasteArgs) {
	return useCallback(
		async (event: ClipboardEvent<HTMLTextAreaElement>) => {
			if (isLocked) return;

			const items = event.clipboardData?.items;
			if (!items) return;

			const itemList = Array.from(items);
			const hasImage = itemList.some((item) => item.type.startsWith('image/'));

			if (!hasImage) {
				const text = event.clipboardData.getData('text/plain');
				if (!text) return;

				const trimmedText = text.trim();
				if (trimmedText === text) return;

				event.preventDefault();
				const textarea = textareaRef.current;
				if (!textarea) return;

				const start = textarea.selectionStart ?? 0;
				const end = textarea.selectionEnd ?? 0;
				const result = insertTextAtSelection(content, start, end, trimmedText);
				onContentChange(result.content);

				requestAnimationFrame(() => {
					textarea.selectionStart = textarea.selectionEnd = result.cursorPosition;
				});
				return;
			}

			if (!folderPath || !selectedFile) return;

			const imageItem = itemList.find((item) => item.type.startsWith('image/'));
			if (!imageItem) return;

			event.preventDefault();
			const file = imageItem.getAsFile();
			if (!file) return;

			const textareaAtPaste = textareaRef.current;
			if (!textareaAtPaste) return;
			const insertionStart = textareaAtPaste.selectionStart ?? content.length;

			const reader = new FileReader();
			reader.onerror = () => {
				captureException(reader.error ?? new Error('Failed to read pasted image'), {
					extra: {
						context: 'useDocumentEditorPaste.reader.onerror',
						folderPath,
						selectedFile,
						imageType: imageItem.type,
					},
				});
			};

			reader.onload = async (readerEvent) => {
				const base64Data = readerEvent.target?.result as string;
				if (!base64Data) return;

				const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, '');
				const extension = imageItem.type.split('/')[1] || 'png';
				let result: Awaited<ReturnType<typeof window.maestro.autorun.saveImage>>;
				try {
					result = await window.maestro.autorun.saveImage(
						folderPath,
						selectedFile,
						base64Content,
						extension
					);
				} catch (error) {
					captureException(error, {
						extra: {
							context: 'useDocumentEditorPaste.saveImage',
							folderPath,
							selectedFile,
							imageType: imageItem.type,
						},
					});
					return;
				}

				if (!result.success || !result.relativePath) {
					const message = 'Pasted image save failed';
					const error = new Error(result.error || message);
					captureMessage(message, {
						level: 'error',
						extra: {
							context: 'useDocumentEditorPaste.saveImage.result',
							folderPath,
							selectedFile,
							imageType: imageItem.type,
							error: result.error,
							hasRelativePath: !!result.relativePath,
						},
					});
					captureException(error, {
						extra: {
							context: 'useDocumentEditorPaste.saveImage.result',
							folderPath,
							selectedFile,
							imageType: imageItem.type,
						},
					});
					return;
				}

				const filename = result.relativePath.split('/').pop() || result.relativePath;
				onAddAttachment(filename, base64Data);

				const textarea = textareaRef.current;
				if (!textarea) return;
				const latestContent = textarea.value ?? content;
				const currentInsertionStart = Math.min(insertionStart, latestContent.length);

				const insertion = buildImageInsertion(
					latestContent,
					currentInsertionStart,
					filename,
					result.relativePath
				);
				onContentChange(insertion.content);

				setTimeout(() => {
					textarea.setSelectionRange(insertion.cursorPosition, insertion.cursorPosition);
					textarea.focus();
				}, 0);
			};
			reader.readAsDataURL(file);
		},
		[content, folderPath, selectedFile, isLocked, onContentChange, onAddAttachment, textareaRef]
	);
}
