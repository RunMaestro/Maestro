interface FenceMarker {
	character: '`' | '~';
	length: number;
	suffix: string;
}

interface MarkdownLine {
	line: string;
	isOutsideFence: boolean;
}

const UNCHECKED_TASK_REGEX = /^\s*[-*]\s*\[\s*\]\s*.+$/;
const UNCHECKED_TASK_TEXT_REGEX = /^\s*[-*]\s*\[\s*\]\s*(.+)$/;
const CHECKED_TASK_REGEX = /^\s*[-*]\s*\[[xX]\]\s*.+$/;
const CHECKED_TASK_MARKER_REGEX = /^(\s*[-*]\s*)\[[xX]\]/;

function parseFenceMarker(line: string): FenceMarker | null {
	const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
	if (!match) return null;

	return {
		character: match[1][0] as '`' | '~',
		length: match[1].length,
		suffix: match[2],
	};
}

function getMarkdownLines(content: string): MarkdownLine[] {
	let openFence: Pick<FenceMarker, 'character' | 'length'> | null = null;

	return content.split('\n').map((line) => {
		const marker = parseFenceMarker(line);

		if (!openFence) {
			const isOpeningFence = marker && (marker.character === '~' || !marker.suffix.includes('`'));
			if (isOpeningFence) {
				openFence = { character: marker.character, length: marker.length };
				return { line, isOutsideFence: false };
			}

			return { line, isOutsideFence: true };
		}

		const isClosingFence =
			marker?.character === openFence.character &&
			marker.length >= openFence.length &&
			marker.suffix.trim() === '';
		if (isClosingFence) {
			openFence = null;
		}

		return { line, isOutsideFence: false };
	});
}

function getTaskLines(content: string): string[] {
	return getMarkdownLines(content)
		.filter(({ isOutsideFence }) => isOutsideFence)
		.map(({ line }) => line.replace(/\r$/, ''));
}

export function countUncheckedMarkdownTasks(content: string): number {
	return getTaskLines(content).filter((line) => UNCHECKED_TASK_REGEX.test(line)).length;
}

export function countCheckedMarkdownTasks(content: string): number {
	return getTaskLines(content).filter((line) => CHECKED_TASK_REGEX.test(line)).length;
}

export function countMarkdownTasks(content: string): { completed: number; total: number } {
	const completed = countCheckedMarkdownTasks(content);
	return {
		completed,
		total: completed + countUncheckedMarkdownTasks(content),
	};
}

export function extractUncheckedMarkdownTasks(content: string): string[] {
	return getTaskLines(content)
		.map((line) => line.match(UNCHECKED_TASK_TEXT_REGEX)?.[1]?.trim())
		.filter((task): task is string => Boolean(task));
}

export function uncheckAllMarkdownTasks(content: string): string {
	return getMarkdownLines(content)
		.map(({ line, isOutsideFence }) =>
			isOutsideFence ? line.replace(CHECKED_TASK_MARKER_REGEX, '$1[ ]') : line
		)
		.join('\n');
}
