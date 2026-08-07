interface FenceMarker {
	character: '`' | '~';
	length: number;
	suffix: string;
}

export type MarkdownTaskState = 'checked' | 'unchecked' | null;

export interface MarkdownLine {
	line: string;
	isOutsideFence: boolean;
	taskState: MarkdownTaskState;
}

const UNCHECKED_TASK_REGEX = /^\s*[-*+]\s*\[\s*\]\s*.+$/;
const UNCHECKED_TASK_TEXT_REGEX = /^\s*[-*+]\s*\[\s*\]\s*(.+)$/;
const CHECKED_TASK_REGEX = /^\s*[-*+]\s*\[[xX✓✔]\]\s*.+$/;
const CHECKED_TASK_MARKER_REGEX = /^(\s*[-*+]\s*)\[[xX✓✔]\]/;

function parseFenceMarker(line: string): FenceMarker | null {
	const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
	if (!match) return null;

	return {
		character: match[1][0] as '`' | '~',
		length: match[1].length,
		suffix: match[2],
	};
}

function getTaskState(line: string): MarkdownTaskState {
	if (CHECKED_TASK_REGEX.test(line)) return 'checked';
	if (UNCHECKED_TASK_REGEX.test(line)) return 'unchecked';
	return null;
}

export function getMarkdownLines(content: string): MarkdownLine[] {
	let openFence: Pick<FenceMarker, 'character' | 'length'> | null = null;
	const normalizedContent = content.replace(/\r\n?/g, '\n');

	return normalizedContent.split('\n').map((line) => {
		const marker = parseFenceMarker(line);

		if (!openFence) {
			const isOpeningFence = marker && (marker.character === '~' || !marker.suffix.includes('`'));
			if (isOpeningFence) {
				openFence = { character: marker.character, length: marker.length };
				return { line, isOutsideFence: false, taskState: null };
			}

			return { line, isOutsideFence: true, taskState: getTaskState(line) };
		}

		const isClosingFence =
			marker?.character === openFence.character &&
			marker.length >= openFence.length &&
			marker.suffix.trim() === '';
		if (isClosingFence) {
			openFence = null;
		}

		return { line, isOutsideFence: false, taskState: null };
	});
}

function getTaskLines(content: string): MarkdownLine[] {
	return getMarkdownLines(content).filter(
		({ isOutsideFence, taskState }) => isOutsideFence && taskState !== null
	);
}

export function countUncheckedMarkdownTasks(content: string): number {
	return getTaskLines(content).filter(({ taskState }) => taskState === 'unchecked').length;
}

export function countCheckedMarkdownTasks(content: string): number {
	return getTaskLines(content).filter(({ taskState }) => taskState === 'checked').length;
}

export function countMarkdownTasks(content: string): { completed: number; total: number } {
	const taskLines = getTaskLines(content);
	const completed = taskLines.filter(({ taskState }) => taskState === 'checked').length;
	return {
		completed,
		total: taskLines.length,
	};
}

export function extractUncheckedMarkdownTasks(content: string): string[] {
	return getTaskLines(content)
		.filter(({ taskState }) => taskState === 'unchecked')
		.map(({ line }) => line.match(UNCHECKED_TASK_TEXT_REGEX)?.[1]?.trim())
		.filter((task): task is string => Boolean(task));
}

export function uncheckAllMarkdownTasks(content: string): string {
	const markdownLines = getMarkdownLines(content);
	let lineIndex = 0;

	return content
		.split(/(\r\n|\r|\n)/)
		.map((segment, index) => {
			if (index % 2 === 1) return segment;

			const markdownLine = markdownLines[lineIndex++];
			return markdownLine?.isOutsideFence
				? segment.replace(CHECKED_TASK_MARKER_REGEX, '$1[ ]')
				: segment;
		})
		.join('');
}
