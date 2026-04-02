const UNCHECKED_TASK_LINE_REGEX = /^(\s*[-*]\s*)\[\s*\](.*)$/;
const CHECKED_TASK_LINE_REGEX = /^(\s*[-*]\s*)\[[xX✓✔]\](.*)$/;

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
