/**
 * The playbook run report: what a finished Auto Run did, how to use the
 * result, and what to do next.
 *
 * Shared so the desktop runner and the CLI engine build the same report and
 * cannot drift. Three tiers, each owned by a different source:
 *
 * - Tier A, `facts`: the counts the final Auto Run summary already reports.
 *   {@link buildFinalSummaryFacts} is the pure part of the renderer's
 *   `buildFinalSummary`, moved here so the CLI can use it too.
 * - Tier B, `evidence`: what changed on disk between run start and run end,
 *   from git when the cwd is a repository, from file mtimes otherwise. The
 *   source is rendered so the report never overstates its confidence.
 * - Tier C, `narrative`: the only model-authored part, in the Director's Notes
 *   narrative contract so its parser and markdown renderer are reused.
 *
 * Pure and dependency-free apart from other shared modules.
 */

import { formatElapsedTime, humanizeDuration } from './duration';
import { formatCost, formatCount } from './formatters';
import { narrativeToMarkdown, type DirectorNotesNarrative } from './directorNotesNarrative';
import type { PlaybookParamProvenance } from './playbookParams';
import { RUN_EVIDENCE_MTIME_MAX_DEPTH, RUN_EVIDENCE_MTIME_MAX_ENTRIES } from './runEvidence';
import type { AutoRunFailureKind } from './stats-types';

// ============================================================================
// Tier A: facts
// ============================================================================

/** The run counters the final summary is built from. */
export interface FinalSummaryFactsParams {
	wasStopped: boolean;
	totalCompletedTasks: number;
	totalElapsedMs: number;
	/** Document filename to the reason it stopped making progress. */
	stalledDocuments: ReadonlyMap<string, string>;
	documents: ReadonlyArray<{ filename: string }>;
	loopEnabled: boolean;
	loopIteration: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCost: number;
}

/** The status words the final summary uses (`Auto Run <statusText>: ...`). */
export type FinalSummaryStatusText = 'stopped' | 'stalled' | 'completed with stalls' | 'completed';

/**
 * Tier A of the report. Plain data (no `Map`), so a report survives a JSON
 * round trip through `.maestro-reports/`.
 */
export interface FinalSummaryFacts {
	wasStopped: boolean;
	statusText: FinalSummaryStatusText;
	/** The sentence the summary's Status line shows (`Completed with 1 stalled document(s)`). */
	statusMessage: string;
	/** The one-line History summary (`Auto Run completed: 3 tasks in 2m 5s`). */
	summary: string;
	/** False when the user stopped the run or every document stalled. */
	isSuccess: boolean;
	totalCompletedTasks: number;
	totalElapsedMs: number;
	loopEnabled: boolean;
	loopsCompleted: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCost: number;
	/** Document filenames in run order. */
	documents: string[];
	stalledDocuments: Array<{ filename: string; reason: string }>;
}

/**
 * The facts of a finished run. Pure: the same counters always give the same
 * facts.
 */
export function buildFinalSummaryFacts(params: FinalSummaryFactsParams): FinalSummaryFacts {
	const {
		wasStopped,
		totalCompletedTasks,
		totalElapsedMs,
		stalledDocuments,
		documents,
		loopEnabled,
		loopIteration,
		totalInputTokens,
		totalOutputTokens,
		totalCost,
	} = params;

	const stalledCount = stalledDocuments.size;
	const allDocsStalled = stalledCount === documents.length;
	const someDocsStalled = stalledCount > 0 && stalledCount < documents.length;
	const statusText: FinalSummaryStatusText = wasStopped
		? 'stopped'
		: allDocsStalled
			? 'stalled'
			: someDocsStalled
				? 'completed with stalls'
				: 'completed';

	let statusMessage: string;
	if (wasStopped) {
		statusMessage = 'Stopped by user';
	} else if (allDocsStalled) {
		statusMessage = `Stalled - All ${stalledCount} document(s) stopped making progress`;
	} else if (someDocsStalled) {
		statusMessage = `Completed with ${stalledCount} stalled document(s)`;
	} else {
		statusMessage = 'Completed';
	}

	const stalledSuffix = stalledCount > 0 ? ` (${stalledCount} stalled)` : '';
	const summary = `Auto Run ${statusText}: ${totalCompletedTasks} task${totalCompletedTasks !== 1 ? 's' : ''} in ${formatElapsedTime(totalElapsedMs)}${stalledSuffix}`;

	return {
		wasStopped,
		statusText,
		statusMessage,
		summary,
		isSuccess: !wasStopped && !allDocsStalled,
		totalCompletedTasks,
		totalElapsedMs,
		loopEnabled,
		loopsCompleted: loopEnabled ? loopIteration + 1 : 1,
		totalInputTokens,
		totalOutputTokens,
		totalCost,
		documents: documents.map((d) => d.filename),
		stalledDocuments: [...stalledDocuments].map(([filename, reason]) => ({ filename, reason })),
	};
}

/**
 * The `**Auto Run Summary**` block of the final History entry, from the facts
 * alone. The renderer appends its achievement progress below it.
 */
export function renderFinalSummaryFactsMarkdown(facts: FinalSummaryFacts): string {
	const stalledDocsSection: string[] = [];
	if (facts.stalledDocuments.length > 0) {
		stalledDocsSection.push('**Stalled Documents**');
		stalledDocsSection.push(
			'The following documents stopped making progress after multiple attempts:'
		);
		for (const { filename, reason } of facts.stalledDocuments) {
			stalledDocsSection.push(`- **${filename}**: ${reason}`);
		}
		stalledDocsSection.push(
			'*Tasks in stalled documents may need manual review or clarification.*'
		);
	}

	const { totalInputTokens, totalOutputTokens, totalCost } = facts;
	return [
		`**Auto Run Summary**`,
		`- **Status:** ${facts.statusMessage}`,
		`- **Tasks Completed:** ${facts.totalCompletedTasks}`,
		`- **Total Duration:** ${formatElapsedTime(facts.totalElapsedMs)}`,
		facts.loopEnabled ? `- **Loops Completed:** ${facts.loopsCompleted}` : '',
		totalInputTokens > 0 || totalOutputTokens > 0
			? `- **Total Tokens:** ${(totalInputTokens + totalOutputTokens).toLocaleString()} (${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out)`
			: '',
		totalCost > 0 ? `- **Total Cost:** $${totalCost.toFixed(4)}` : '',
		`- **Documents:** ${facts.documents.join(', ')}`,
		...stalledDocsSection,
	]
		.filter((line) => line !== '')
		.join('\n');
}

// ============================================================================
// Tier B: disk evidence
// ============================================================================

/**
 * What changed on disk during the run. Paths are relative to the run's cwd.
 * `source` says how it was derived: `git` compares two `git status` + `HEAD`
 * snapshots; `mtime` lists files modified after the run started and cannot
 * tell a created file from a changed one or see deletions at all.
 */
export interface DiskEvidence {
	source: 'git' | 'mtime';
	changedFiles: string[];
	createdFiles: string[];
	deletedFiles: string[];
	branch?: string;
	prUrl?: string;
}

// ============================================================================
// The report
// ============================================================================

/**
 * How the run ended, as the report shows it. `partial` is a run that finished
 * with some documents stalled; `failed` is a halt, or a run where every
 * document stalled.
 */
export type PlaybookRunReportStatus = 'completed' | 'partial' | 'failed' | 'stopped';

/** One parameter the run used, and where its value came from. */
export interface PlaybookRunReportParameter {
	name: string;
	value: string;
	source: PlaybookParamProvenance;
}

/**
 * One thing that did not happen: a document that stalled, the last task
 * error, or the halt that ended the run. Located by document and task so the
 * user knows where to look.
 */
export interface PlaybookRunReportProblem {
	kind: AutoRunFailureKind;
	/** The document's filename, as the run listed it. */
	document: string;
	/**
	 * The 0-based task the run was on: the document's checked-task count when
	 * it happened. Absent when the source did not record it.
	 */
	taskIndex?: number;
	/** The stall reason, the agent error's message, or the halt reason. */
	message: string;
}

export interface PlaybookRunReport {
	playbookName: string;
	playbookId?: string;
	status: PlaybookRunReportStatus;
	facts: FinalSummaryFacts;
	/**
	 * What did not happen, for the card above the narrative: the last error or
	 * halt first, then every stalled document. Built by
	 * {@link buildPlaybookRunReportProblems}; a report without it (an older
	 * one) falls back to `facts.stalledDocuments`.
	 */
	problems?: PlaybookRunReportProblem[];
	evidence?: DiskEvidence;
	narrative?: DirectorNotesNarrative;
	/** Authored "How to use it" markdown, rendered verbatim. */
	howToUse?: string;
	nextSteps?: string[];
	parameters: PlaybookRunReportParameter[];
	/** Epoch ms. */
	startedAt: number;
	/** Epoch ms. */
	finishedAt: number;
	/** Where the rendered markdown was saved, once it has been. */
	reportPath?: string;
	/**
	 * The folder the run worked in (the worktree when it used one): the
	 * evidence paths are relative to it, so it is what makes them clickable.
	 */
	cwd?: string;
}

/**
 * The report status for a run, from its facts. A halt marker the user did not
 * stop counts as a failure, the same rule `autoRunOutcomeStatus` applies to
 * the stats row.
 */
export function playbookRunReportStatus(
	facts: Pick<FinalSummaryFacts, 'statusText'>,
	halted = false
): PlaybookRunReportStatus {
	if (facts.statusText === 'stopped') return 'stopped';
	if (halted || facts.statusText === 'stalled') return 'failed';
	if (facts.statusText === 'completed with stalls') return 'partial';
	return 'completed';
}

const STATUS_LABELS: Record<PlaybookRunReportStatus, string> = {
	completed: 'Completed',
	partial: 'Partially completed',
	failed: 'Failed',
	stopped: 'Stopped',
};

/** The label a report status is shown with. */
export function playbookRunReportStatusLabel(status: PlaybookRunReportStatus): string {
	return STATUS_LABELS[status];
}

/** Markdown inline code that survives a backtick in the text. */
function inlineCode(text: string): string {
	const fence = text.includes('`') ? '``' : '`';
	const pad = fence === '``' ? ' ' : '';
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** Text that is safe inside one markdown table cell. */
function tableCell(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * The narrative's own `##` sections, demoted one level so they sit under the
 * report's "What was done" heading.
 */
function demotedNarrativeMarkdown(narrative: DirectorNotesNarrative): string {
	return narrativeToMarkdown(narrative)
		.trim()
		.replace(/^(#{1,5}) /gm, '#$1 ');
}

/** A failure the runner recorded: where it happened, without the words. */
export interface PlaybookRunFailureLocation {
	kind: AutoRunFailureKind;
	documentFilename?: string;
	taskIndex?: number;
}

/**
 * The report's `problems`: the last error or halt (the thing that ended or
 * broke the run, so it leads), then each stalled document with the task it
 * stalled on. `failures` is the run's failure log in order (the same entries
 * the stats row gets); a stalled document's task is its last `stall` entry.
 * Pure.
 */
export function buildPlaybookRunReportProblems(params: {
	stalledDocuments: FinalSummaryFacts['stalledDocuments'];
	failures?: ReadonlyArray<PlaybookRunFailureLocation>;
	lastError?: PlaybookRunReportProblem | null;
}): PlaybookRunReportProblem[] {
	const stallTask = new Map<string, number>();
	for (const failure of params.failures ?? []) {
		if (
			failure.kind === 'stall' &&
			failure.documentFilename !== undefined &&
			failure.taskIndex !== undefined
		) {
			stallTask.set(failure.documentFilename, failure.taskIndex);
		}
	}
	const problems: PlaybookRunReportProblem[] = [];
	if (params.lastError) problems.push(params.lastError);
	for (const { filename, reason } of params.stalledDocuments) {
		const taskIndex = stallTask.get(filename);
		problems.push({
			kind: 'stall',
			document: filename,
			...(taskIndex !== undefined && { taskIndex }),
			message: reason,
		});
	}
	return problems;
}

/** Everything a finished run knows that its report is built from. */
export interface BuildPlaybookRunReportParams {
	playbookName: string;
	playbookId?: string;
	/** The facts from the reconciled totals (the same ones the final History row shows). */
	facts: FinalSummaryFacts;
	/** The agent wrote a halt marker (or the run refused to start a task): a failure. */
	halted?: boolean;
	/** The run's failure log in order, for the task each stalled document stalled on. */
	failures?: ReadonlyArray<PlaybookRunFailureLocation>;
	/** The last error or halt, which leads "What did not happen". */
	lastError?: PlaybookRunReportProblem | null;
	evidence?: DiskEvidence | null;
	/** Tier C, when a report document or a synthesis turn wrote it. */
	authored?: Pick<PlaybookRunReport, 'narrative' | 'howToUse' | 'nextSteps'>;
	parameters: PlaybookRunReportParameter[];
	startedAt: number;
	finishedAt: number;
	cwd?: string;
}

/**
 * The report of a finished run, from its facts and the optional tiers. The
 * one place the status and the "What did not happen" list are derived, so the
 * desktop runner and the CLI engine build the same report. Pure.
 */
export function buildPlaybookRunReport(params: BuildPlaybookRunReportParams): PlaybookRunReport {
	const problems = buildPlaybookRunReportProblems({
		stalledDocuments: params.facts.stalledDocuments,
		failures: params.failures,
		lastError: params.lastError,
	});
	const { narrative, howToUse, nextSteps } = params.authored ?? {};
	return {
		playbookName: params.playbookName,
		...(params.playbookId !== undefined && { playbookId: params.playbookId }),
		status: playbookRunReportStatus(params.facts, params.halted ?? false),
		facts: params.facts,
		...(problems.length > 0 && { problems }),
		...(params.evidence && { evidence: params.evidence }),
		...(narrative && { narrative }),
		...(howToUse && { howToUse }),
		...(nextSteps && { nextSteps }),
		parameters: params.parameters,
		startedAt: params.startedAt,
		finishedAt: params.finishedAt,
		...(params.cwd !== undefined && { cwd: params.cwd }),
	};
}

/** `task 3 of \`doc.md\``, or just the document when the task is unknown. */
function problemLocation(problem: PlaybookRunReportProblem): string {
	const doc = inlineCode(problem.document);
	return problem.taskIndex === undefined ? doc : `task ${problem.taskIndex + 1} of ${doc}`;
}

function whatDidNotHappenSection(report: PlaybookRunReport): string[] {
	const lines = ['## What did not happen', ''];
	const problems =
		report.problems ??
		buildPlaybookRunReportProblems({ stalledDocuments: report.facts.stalledDocuments });
	const stalls = problems.filter((p) => p.kind === 'stall');
	const ending = problems.filter((p) => p.kind !== 'stall');

	if (problems.length === 0) {
		lines.push('The run ended before every task was finished.');
		return lines;
	}
	for (const problem of ending) {
		const what = problem.kind === 'halt' ? 'The agent halted the run' : 'The run hit an error';
		lines.push(`**${what}** at ${problemLocation(problem)}: ${problem.message}`, '');
	}
	if (stalls.length > 0) {
		lines.push('These documents stopped making progress after multiple attempts:', '');
		for (const stall of stalls) {
			lines.push(`- ${problemLocation(stall)}: ${stall.message}`);
		}
	}
	return lines;
}

function whatWasDoneSection(report: PlaybookRunReport): string[] {
	const lines = ['## What was done', ''];
	if (report.narrative && report.narrative.sections.length > 0) {
		lines.push(demotedNarrativeMarkdown(report.narrative));
		return lines;
	}
	const { facts } = report;
	lines.push(
		`- **Tasks completed:** ${formatCount(facts.totalCompletedTasks)}`,
		`- **Documents:** ${facts.documents.map(inlineCode).join(', ') || 'none'}`
	);
	if (facts.loopEnabled) lines.push(`- **Loops completed:** ${formatCount(facts.loopsCompleted)}`);
	return lines;
}

function filesChangedSection(evidence: DiskEvidence): string[] {
	const lines = ['## Files changed', ''];
	lines.push(
		evidence.source === 'git'
			? '_From git: the working tree and HEAD compared at run start and run end._'
			: `_From file modification times: this folder is not a git repository, so only the first ${RUN_EVIDENCE_MTIME_MAX_ENTRIES} files in its top ${RUN_EVIDENCE_MTIME_MAX_DEPTH} folder levels are compared._`,
		''
	);
	if (evidence.branch) lines.push(`- **Branch:** ${inlineCode(evidence.branch)}`);
	if (evidence.prUrl) lines.push(`- **Pull request:** ${evidence.prUrl}`);
	if (evidence.branch || evidence.prUrl) lines.push('');

	const groups: Array<[string, string[]]> = [
		['Created', evidence.createdFiles],
		['Changed', evidence.changedFiles],
		['Deleted', evidence.deletedFiles],
	];
	const nonEmpty = groups.filter(([, files]) => files.length > 0);
	if (nonEmpty.length === 0) {
		lines.push('No file changes were detected.');
		return lines;
	}
	for (const [label, files] of nonEmpty) {
		lines.push(`**${label}** (${formatCount(files.length)})`, '');
		for (const file of files) lines.push(`- ${inlineCode(file)}`);
		lines.push('');
	}
	return lines;
}

function configurationSection(parameters: PlaybookRunReportParameter[]): string[] {
	const lines = ['## Configuration', '', '| Parameter | Value | Source |', '| --- | --- | --- |'];
	for (const { name, value, source } of parameters) {
		lines.push(`| ${tableCell(name)} | ${tableCell(value) || '_empty_'} | ${source} |`);
	}
	return lines;
}

/**
 * The footer facts (duration, tokens, cost, finish time), one phrase each.
 * The markdown footer joins them; the completion modal shows them as a line.
 */
export function playbookReportFooterParts(report: PlaybookRunReport): string[] {
	const { facts } = report;
	const parts = [`Duration: ${humanizeDuration(facts.totalElapsedMs)}`];
	const totalTokens = facts.totalInputTokens + facts.totalOutputTokens;
	if (totalTokens > 0) {
		parts.push(
			`Tokens: ${formatCount(totalTokens)} (${formatCount(facts.totalInputTokens)} in / ${formatCount(facts.totalOutputTokens)} out)`
		);
	}
	parts.push(`Cost: ${formatCost(facts.totalCost)}`);
	parts.push(`Finished: ${new Date(report.finishedAt).toISOString()}`);
	return parts;
}

/**
 * The report split into its sections, each a markdown block with its own
 * heading. A section with nothing to say is absent. Copy and Save join them
 * ({@link renderPlaybookReportMarkdown}); the completion modal renders them
 * one by one, so both always show the same words.
 */
export interface PlaybookReportSections {
	/** `# <playbook name>` and the status line. */
	title: string;
	/** Partial and failed runs only. */
	whatDidNotHappen?: string;
	whatWasDone: string;
	howToUse?: string;
	nextSteps?: string;
	filesChanged?: string;
	configuration?: string;
	/** A rule and the italic footer line. */
	footer: string;
}

function block(lines: string[]): string {
	return lines.join('\n').trimEnd();
}

/** Every section of `report` as markdown. */
export function playbookReportSections(report: PlaybookRunReport): PlaybookReportSections {
	const { facts, status } = report;

	const taskWord = facts.totalCompletedTasks === 1 ? 'task' : 'tasks';
	const statusLine = [
		`**Status:** ${playbookRunReportStatusLabel(status)}`,
		`${formatCount(facts.totalCompletedTasks)} ${taskWord} completed`,
	];
	// The stall sentence explains a partial or stalled run. Elsewhere it only
	// repeats the label, and for a halted run it would wrongly say "Completed".
	if (!facts.wasStopped && facts.stalledDocuments.length > 0) {
		statusLine.push(facts.statusMessage);
	}

	const sections: PlaybookReportSections = {
		title: block([`# ${report.playbookName}`, '', statusLine.join(' · ')]),
		whatWasDone: block(whatWasDoneSection(report)),
		footer: block(['---', '', `_${playbookReportFooterParts(report).join(' · ')}_`]),
	};

	if (status === 'partial' || status === 'failed') {
		sections.whatDidNotHappen = block(whatDidNotHappenSection(report));
	}

	const howToUse = report.howToUse?.trim();
	if (howToUse) sections.howToUse = block(['## How to use it', '', howToUse]);

	const nextSteps = (report.nextSteps ?? []).map((step) => step.trim()).filter(Boolean);
	if (nextSteps.length > 0) {
		sections.nextSteps = block(['## Next steps', '', ...nextSteps.map((step) => `- ${step}`)]);
	}

	if (report.evidence) sections.filesChanged = block(filesChangedSection(report.evidence));

	if (report.parameters.length > 0) {
		sections.configuration = block(configurationSection(report.parameters));
	}

	return sections;
}

/**
 * A run summary History entry's text without the report it leads with: the
 * entry's `fullResponse` is the rendered report followed by the classic
 * Auto Run summary, and a view that draws the report from the entry's
 * `playbookReport` wants only the rest. Text that does not start with the
 * report comes back whole, so nothing is ever dropped.
 */
export function stripLeadingPlaybookReport(text: string, report: PlaybookRunReport): string {
	const rendered = renderPlaybookReportMarkdown(report).trimEnd();
	if (!text.startsWith(rendered)) return text;
	return text.slice(rendered.length).trim();
}

/**
 * The report as a markdown document, the text Copy and Save produce.
 *
 * Section order: title and status line; "What did not happen" (partial and
 * failed runs only, above the narrative so a failure is read first); "What
 * was done" (the narrative, or the facts without one); "How to use it"
 * (verbatim); "Next steps"; "Files changed"; "Configuration"; and a footer
 * with duration, tokens, and cost. A section with nothing to say is left out.
 */
export function renderPlaybookReportMarkdown(report: PlaybookRunReport): string {
	const s = playbookReportSections(report);
	return (
		[
			s.title,
			s.whatDidNotHappen,
			s.whatWasDone,
			s.howToUse,
			s.nextSteps,
			s.filesChanged,
			s.configuration,
			s.footer,
		]
			.filter((section): section is string => Boolean(section))
			.join('\n\n')
			.trim() + '\n'
	);
}
