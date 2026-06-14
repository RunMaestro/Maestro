import type { ClipboardEventHandler, KeyboardEventHandler, RefObject } from 'react';
import type { Theme } from '../../../../../types';

interface EditorTextareaProps {
	content: string;
	onContentChange: (content: string) => void;
	onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
	onPaste: ClipboardEventHandler<HTMLTextAreaElement>;
	theme: Theme;
	isLocked: boolean;
	textareaRef: RefObject<HTMLTextAreaElement>;
}

export function EditorTextarea({
	content,
	onContentChange,
	onKeyDown,
	onPaste,
	theme,
	isLocked,
	textareaRef,
}: EditorTextareaProps): JSX.Element {
	return (
		<textarea
			ref={textareaRef}
			value={content}
			onChange={(event) => !isLocked && onContentChange(event.target.value)}
			onKeyDown={onKeyDown}
			onPaste={onPaste}
			readOnly={isLocked}
			placeholder="Your task document will appear here..."
			className={`w-full h-full border rounded p-4 bg-transparent outline-none resize-none font-mono text-sm overflow-y-auto ${
				isLocked ? 'cursor-not-allowed opacity-70' : ''
			}`}
			style={{
				borderColor: theme.colors.border,
				color: theme.colors.textMain,
			}}
		/>
	);
}
