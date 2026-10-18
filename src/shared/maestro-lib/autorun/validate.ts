/**
 * Line-level checks of an Auto Run document (AR-2).
 *
 * An Auto Run only works through `- [ ]` tasks, and an invisible mistake (a
 * numbered checkbox, a halt marker nobody sees because HTML comments render as
 * nothing) reads as "I pressed Run and nothing happened". Every check here rides
 * the scanners the engines use, so the warning and the run cannot disagree:
 * `forEachMarkdownLine` for fences, the task regexes for what counts as a task,
 * `findHaltMarker` for what stops a run, `scanMaestroMarkers` for the rest.
 */

import {
	CHECKED_TASK_COUNT_REGEX,
	UNCHECKED_TASK_REGEX,
	countMarkdownTasks,
	forEachMarkdownLine,
} from '../../markdownTaskScan';
import { findHaltMarker, scanMaestroMarkers } from '../../autorunMarkers';

export type AutoRunIssueSeverity = 'error' | 'warning' | 'info';

export interface AutoRunIssue {
	severity: AutoRunIssueSeverity;
	/** 1-indexed line, or 0 for a finding about the whole document. */
	line: number;
	message: string;
}

/** A checkbox that is not a task: `1. [ ] x`. */
const NUMBERED_CHECKBOX = /^\s*\d+[.)]\s*\[[ xX]?\]/;
/** A checkbox with no list marker: `[ ] x`. */
const BARE_CHECKBOX = /^\s*\[[ xX]?\]\s*\S/;
/** A list checkbox holding a mark the engines do not know: `- [-] x`. */
const UNKNOWN_MARK_CHECKBOX = /^\s*[-*+]\s*\[[^\sxX✓✔\]]\]/;
/** A checkbox with nothing after it: `- [ ]`. */
const EMPTY_TASK = /^\s*[-*+]\s*\[[\sxX✓✔]*\]\s*$/;

/**
 * Everything worth telling the author about `content`, in line order.
 * Errors stop a run from starting; warnings leave a task or a marker silently
 * ignored; info says what a run will do at a marker.
 */
export function validateAutoRunDocument(content: string): AutoRunIssue[] {
	const issues: AutoRunIssue[] = [];

	forEachMarkdownLine(content, (line, index) => {
		const at = index + 1;
		if (CHECKED_TASK_COUNT_REGEX.test(line) || UNCHECKED_TASK_REGEX.test(line)) return;

		if (NUMBERED_CHECKBOX.test(line)) {
			issues.push({
				severity: 'warning',
				line: at,
				message: 'A numbered checkbox is not a task. Write it as "- [ ] ...".',
			});
		} else if (BARE_CHECKBOX.test(line)) {
			issues.push({
				severity: 'warning',
				line: at,
				message: 'A checkbox needs a leading dash to be a task. Write it as "- [ ] ...".',
			});
		} else if (EMPTY_TASK.test(line)) {
			issues.push({ severity: 'warning', line: at, message: 'This task has no text.' });
		} else if (UNKNOWN_MARK_CHECKBOX.test(line)) {
			issues.push({
				severity: 'warning',
				line: at,
				message: 'Only "[ ]" (open) and "[x]" (done) mean something. This box is ignored.',
			});
		}
	});

	const halt = findHaltMarker(content);
	if (halt) {
		issues.push({
			severity: 'error',
			line: halt.line + 1,
			message: `A halt marker stands alone${halt.reason ? ` (${halt.reason})` : ''}, so a run refuses to start. Delete it, or wrap it in backticks to show it as an example.`,
		});
	}

	for (const marker of scanMaestroMarkers(content)) {
		// The halt marker is the error above; reporting it twice would only be noise.
		if (marker.kind === 'halt') continue;
		if (marker.status === 'invalid') {
			const invalid = marker.hint?.invalid
				?.map((entry) => `${entry.attribute}="${entry.value}"`)
				.join(', ');
			issues.push({
				severity: 'warning',
				line: marker.line + 1,
				message: `This ${marker.kind} marker names a value Maestro does not know${invalid ? ` (${invalid})` : ''}, so it is ignored.`,
			});
		} else if (marker.kind === 'hitl' && marker.status === 'live') {
			issues.push({
				severity: 'info',
				line: marker.line + 1,
				message: `A human gate pauses the run here${marker.reason ? `: ${marker.reason}` : ''}.`,
			});
		}
	}

	const counts = countMarkdownTasks(content);
	if (counts.total === 0) {
		issues.push({
			severity: 'warning',
			line: 0,
			message: 'No tasks found. Auto Run works through "- [ ]" checkboxes.',
		});
	}

	return issues.sort((a, b) => a.line - b.line);
}

/** `2 errors, 1 warning`, or `no problems`: the line a result view opens with. */
export function summarizeAutoRunIssues(issues: readonly AutoRunIssue[]): string {
	const count = (severity: AutoRunIssueSeverity) =>
		issues.filter((issue) => issue.severity === severity).length;
	const parts: string[] = [];
	const errors = count('error');
	const warnings = count('warning');
	if (errors) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
	if (warnings) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
	return parts.length > 0 ? parts.join(', ') : 'no problems';
}
