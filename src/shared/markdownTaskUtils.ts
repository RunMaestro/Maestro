const UNCHECKED_TASK_LINE_REGEX = /^(\s*[-*]\s*)\[\s*\](.*)$/;
const CHECKED_TASK_LINE_REGEX = /^(\s*[-*]\s*)\[[xX✓✔]\](.*)$/;
const TASK_LINE_REGEX = /^[\s]*[-*]\s*\[(?:\s|x|X|✓|✔)\]\s*.*$/;

function isUncheckedTaskLine(line: string): boolean {
	return UNCHECKED_TASK_LINE_REGEX.test(line);
}

function isCheckedTaskLine(line: string): boolean {
	return CHECKED_TASK_LINE_REGEX.test(line);
}

function toUncheckedTaskLine(line: string): string {
	return line.replace(CHECKED_TASK_LINE_REGEX, '$1[ ]$2');
}

function countCheckedTaskLines(lines: string[]): number {
	return lines.filter((line) => isCheckedTaskLine(line)).length;
}

function trimTrailingBlankLines(lines: string[]): string[] {
	const trimmed = [...lines];
	while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.trim() === '') {
		trimmed.pop();
	}
	return trimmed;
}

function collectTaskBlock(lines: string[], startIndex: number): string[] {
	const block = [lines[startIndex]];

	for (let index = startIndex + 1; index < lines.length; index++) {
		const line = lines[index] ?? '';
		if (TASK_LINE_REGEX.test(line) || /^#{1,6}\s/.test(line)) {
			break;
		}
		block.push(line);
	}

	return trimTrailingBlankLines(block);
}

export function buildActiveTaskDocumentContext(content: string): string {
	if (!content) {
		return '';
	}

	const lines = content.split(/\r?\n/);
	const taskIndices = lines
		.map((line, index) => (TASK_LINE_REGEX.test(line) ? index : -1))
		.filter((index) => index >= 0);
	const uncheckedTaskIndices = lines
		.map((line, index) => (isUncheckedTaskLine(line) ? index : -1))
		.filter((index) => index >= 0);

	if (taskIndices.length === 0 || uncheckedTaskIndices.length === 0) {
		return content;
	}

	const [activeTaskIndex, nextTaskIndex] = uncheckedTaskIndices;
	const compactLines: string[] = [];
	const preambleLines = trimTrailingBlankLines(lines.slice(0, taskIndices[0]));

	if (preambleLines.length > 0) {
		compactLines.push(...preambleLines, '');
	}

	compactLines.push(...collectTaskBlock(lines, activeTaskIndex));

	if (nextTaskIndex !== undefined) {
		compactLines.push('', ...collectTaskBlock(lines, nextTaskIndex));
	}

	return trimTrailingBlankLines(compactLines).join('\n');
}

export function revertNewlyCheckedTasks(before: string, after: string): string {
	if (!before || !after || before === after) {
		return after;
	}

	const beforeLines = before.split(/\r?\n/);
	const afterLines = after.split(/\r?\n/);
	const revertedLineIndexes = new Set<number>();
	const targetReverts = Math.max(
		0,
		countCheckedTaskLines(afterLines) - countCheckedTaskLines(beforeLines)
	);

	if (targetReverts === 0) {
		return after;
	}

	let revertedCount = 0;
	const sharedLength = Math.min(beforeLines.length, afterLines.length);

	for (let index = 0; index < sharedLength && revertedCount < targetReverts; index++) {
		if (
			isUncheckedTaskLine(beforeLines[index] ?? '') &&
			isCheckedTaskLine(afterLines[index] ?? '')
		) {
			afterLines[index] = toUncheckedTaskLine(afterLines[index] ?? '');
			revertedLineIndexes.add(index);
			revertedCount++;
		}
	}

	for (let index = 0; index < afterLines.length && revertedCount < targetReverts; index++) {
		if (revertedLineIndexes.has(index)) {
			continue;
		}
		if (isCheckedTaskLine(afterLines[index] ?? '')) {
			afterLines[index] = toUncheckedTaskLine(afterLines[index] ?? '');
			revertedCount++;
		}
	}

	return afterLines.join('\n');
}
