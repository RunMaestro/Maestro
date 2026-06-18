export interface TextEditResult {
	content: string;
	cursorPosition: number;
}

export function insertTextAtSelection(
	content: string,
	start: number,
	end: number,
	insertText: string
): TextEditResult {
	return {
		content: content.substring(0, start) + insertText + content.substring(end),
		cursorPosition: start + insertText.length,
	};
}

export function insertCheckboxAtCursor(content: string, cursorPosition: number): TextEditResult {
	const textBeforeCursor = content.substring(0, cursorPosition);
	const textAfterCursor = content.substring(cursorPosition);
	const lastNewline = textBeforeCursor.lastIndexOf('\n');
	const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
	const textOnCurrentLine = textBeforeCursor.substring(lineStart);

	if (textOnCurrentLine.length === 0) {
		return {
			content: textBeforeCursor + '- [ ] ' + textAfterCursor,
			cursorPosition: cursorPosition + 6,
		};
	}

	return {
		content: textBeforeCursor + '\n- [ ] ' + textAfterCursor,
		cursorPosition: cursorPosition + 7,
	};
}

export function continueMarkdownList(
	content: string,
	cursorPosition: number
): TextEditResult | null {
	const textBeforeCursor = content.substring(0, cursorPosition);
	const textAfterCursor = content.substring(cursorPosition);
	const currentLineStart = textBeforeCursor.lastIndexOf('\n') + 1;
	const currentLine = textBeforeCursor.substring(currentLineStart);

	const taskListMatch = currentLine.match(/^(\s*)- \[([ x])\]\s+/);
	const unorderedListMatch = currentLine.match(/^(\s*)([-*])\s+/);

	if (taskListMatch) {
		const indent = taskListMatch[1];
		return {
			content: textBeforeCursor + '\n' + indent + '- [ ] ' + textAfterCursor,
			cursorPosition: cursorPosition + indent.length + 7,
		};
	}

	if (unorderedListMatch) {
		const indent = unorderedListMatch[1];
		const marker = unorderedListMatch[2];
		return {
			content: textBeforeCursor + '\n' + indent + marker + ' ' + textAfterCursor,
			cursorPosition: cursorPosition + indent.length + 3,
		};
	}

	return null;
}

export function buildImageInsertion(
	content: string,
	cursorPosition: number,
	filename: string,
	relativePath: string
): TextEditResult {
	const textBefore = content.substring(0, cursorPosition);
	const textAfter = content.substring(cursorPosition);
	const imageMarkdown = `![${filename}](${relativePath})`;

	let prefix = '';
	let suffix = '';
	if (textBefore.length > 0 && !textBefore.endsWith('\n')) {
		prefix = '\n';
	}
	if (textAfter.length > 0 && !textAfter.startsWith('\n')) {
		suffix = '\n';
	}

	return {
		content: textBefore + prefix + imageMarkdown + suffix + textAfter,
		cursorPosition: cursorPosition + prefix.length + imageMarkdown.length + suffix.length,
	};
}
