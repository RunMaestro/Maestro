/**
 * Diff annotations: review comments a user drops on lines of the Git Diff
 * viewer, batched, and handed back to the agent as one prompt.
 *
 * The model is deliberately tiny - `{ file, line, side, body }` plus the
 * react-diff-view change key the comment is anchored to - and the serializer
 * is pure so the prompt the agent receives can be pinned by tests.
 */
import { getChangeKey } from 'react-diff-view';
import type { ChangeData } from 'react-diff-view';

/**
 * Which version of the file a line number refers to. A removed line only has a
 * number in the OLD file, so the prompt has to say which one it means or the
 * agent goes looking for the wrong line.
 */
export type DiffAnnotationSide = 'old' | 'new';

/** What kind of diff line was annotated, as shown to the agent. */
export type DiffAnnotationLineKind = 'added' | 'removed' | 'unchanged';

export interface DiffAnnotation {
	id: string;
	/** Repo-relative path of the file the line belongs to. */
	file: string;
	/** 1-based line number, in the file version named by `side`. */
	line: number;
	side: DiffAnnotationSide;
	kind: DiffAnnotationLineKind;
	/** The code on that line (react-diff-view has already dropped the +/- marker). */
	lineText: string;
	/** react-diff-view change key, used to render the comment under its row. */
	changeKey: string;
	/** The reviewer's comment, markdown allowed. */
	body: string;
}

/** Where a change sits, independent of the comment text. */
export type DiffAnnotationAnchor = Omit<DiffAnnotation, 'id' | 'body'>;

/**
 * Resolve the file/line/side a clicked diff row refers to.
 *
 * An added line exists only in the new file and a removed line only in the old
 * one. An unchanged line exists in both; it is anchored to the new file unless
 * the click came from the old side of a split view.
 */
export function anchorForChange(
	file: string,
	change: ChangeData,
	clickedSide?: DiffAnnotationSide
): DiffAnnotationAnchor {
	const changeKey = getChangeKey(change);
	const lineText = change.content;
	if (change.type === 'insert') {
		return { file, line: change.lineNumber, side: 'new', kind: 'added', lineText, changeKey };
	}
	if (change.type === 'delete') {
		return { file, line: change.lineNumber, side: 'old', kind: 'removed', lineText, changeKey };
	}
	const side = clickedSide === 'old' ? 'old' : 'new';
	return {
		file,
		line: side === 'old' ? change.oldLineNumber : change.newLineNumber,
		side,
		kind: 'unchanged',
		lineText,
		changeKey,
	};
}

/** `src/app.ts:42`, plus a note when the number refers to the old file. */
export function formatAnnotationLocation(annotation: DiffAnnotationAnchor): string {
	const base = `${annotation.file}:${annotation.line}`;
	return annotation.side === 'old' ? `${base} (previous version)` : base;
}

function compareAnnotations(a: DiffAnnotation, b: DiffAnnotation): number {
	if (a.file !== b.file) return a.file < b.file ? -1 : 1;
	if (a.line !== b.line) return a.line - b.line;
	// Old-side lines first at the same number, matching how a diff reads.
	if (a.side !== b.side) return a.side === 'old' ? -1 : 1;
	return 0;
}

const KIND_LABEL: Record<DiffAnnotationLineKind, string> = {
	added: 'added line',
	removed: 'removed line',
	unchanged: 'unchanged line',
};

/**
 * Format a batch of annotations into the single prompt sent to the agent.
 *
 * Every comment names its file and line explicitly and quotes the code on that
 * line, so the agent can locate it without guessing even after the file has
 * moved on. Annotations with an empty body are skipped. Returns `''` when
 * nothing is left to send.
 */
export function formatDiffReviewPrompt(annotations: readonly DiffAnnotation[]): string {
	const usable = annotations
		.filter((a) => a.body.trim().length > 0)
		.slice()
		.sort(compareAnnotations);
	if (usable.length === 0) return '';

	const count = usable.length === 1 ? '1 comment' : `${usable.length} comments`;
	const lines: string[] = [
		`I reviewed your changes in the git diff and left ${count} on specific lines. Please address each one.`,
		'',
		'Line numbers refer to the new version of the file unless marked "previous version", which means the line was removed or is numbered as it was before your change.',
	];

	usable.forEach((annotation, index) => {
		lines.push('', `## ${index + 1}. ${formatAnnotationLocation(annotation)}`, '');
		lines.push(`On the ${KIND_LABEL[annotation.kind]}:`, '');
		const code = annotation.lineText.length > 0 ? annotation.lineText : '(blank line)';
		lines.push(`> ${code}`, '');
		lines.push(annotation.body.trim());
	});

	return lines.join('\n');
}
