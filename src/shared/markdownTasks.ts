/**
 * Markdown task-list helpers used by Auto Run.
 *
 * Task scanning intentionally ignores fenced code blocks so documentation examples like:
 *
 * ```markdown
 * - [ ] Example task
 * ```
 *
 * are not treated as executable Auto Run tasks.
 */

const UNCHECKED_TASK_REGEX = /^[\s]*[-*]\s*\[\s*\]\s*.+$/;
const CHECKED_TASK_COUNT_REGEX = /^[\s]*[-*]\s*\[[xX✓✔]\]\s*.+$/;
const CHECKED_TASK_MARKER_REGEX = /^(\s*[-*]\s*)\[[xX✓✔]\]/;
const UNCHECKED_TASK_TEXT_REGEX = /^[\s]*[-*]\s*\[\s*\]\s*(.+)$/;

function getFenceMarker(line: string): string | null {
	const match = line.match(/^\s*(`{3,}|~{3,})/);
	return match ? match[1][0] : null;
}

function mapLinesOutsideFencedCodeBlocks(
	content: string,
	mapLine: (line: string) => string
): string {
	let inFence = false;
	let fenceMarker: string | null = null;

	return content
		.split('\n')
		.map((line) => {
			const marker = getFenceMarker(line);

			if (marker && (!inFence || marker === fenceMarker)) {
				inFence = !inFence;
				fenceMarker = inFence ? marker : null;
				return line;
			}

			return inFence ? line : mapLine(line);
		})
		.join('\n');
}

function getLinesOutsideFencedCodeBlocks(content: string): string[] {
	let inFence = false;
	let fenceMarker: string | null = null;
	const lines: string[] = [];

	for (const line of content.split('\n')) {
		const marker = getFenceMarker(line);

		if (marker && (!inFence || marker === fenceMarker)) {
			inFence = !inFence;
			fenceMarker = inFence ? marker : null;
			continue;
		}

		if (!inFence) {
			lines.push(line);
		}
	}

	return lines;
}

export function countUncheckedMarkdownTasks(content: string): number {
	return getLinesOutsideFencedCodeBlocks(content).filter((line) =>
		UNCHECKED_TASK_REGEX.test(line.replace(/\r$/, ''))
	).length;
}

export function countCheckedMarkdownTasks(content: string): number {
	return getLinesOutsideFencedCodeBlocks(content).filter((line) =>
		CHECKED_TASK_COUNT_REGEX.test(line.replace(/\r$/, ''))
	).length;
}

export function countMarkdownTasks(content: string): { completed: number; total: number } {
	const completed = countCheckedMarkdownTasks(content);
	return {
		completed,
		total: completed + countUncheckedMarkdownTasks(content),
	};
}

export function extractUncheckedMarkdownTasks(content: string): string[] {
	return getLinesOutsideFencedCodeBlocks(content)
		.map((line) => line.replace(/\r$/, '').match(UNCHECKED_TASK_TEXT_REGEX)?.[1]?.trim())
		.filter((task): task is string => Boolean(task));
}

export function uncheckAllMarkdownTasks(content: string): string {
	return mapLinesOutsideFencedCodeBlocks(content, (line) =>
		line.replace(CHECKED_TASK_MARKER_REGEX, '$1[ ]')
	);
}
