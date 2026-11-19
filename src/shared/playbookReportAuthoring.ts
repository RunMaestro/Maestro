/**
 * Authoring a playbook run report: tier C (the narrative) and the authored
 * "How to use it" and "Next steps" sections, plus where the finished report
 * is saved.
 *
 * Two sources write tier C, and both answer in the Director's Notes narrative
 * contract so `parseDirectorNotesNarrative` reads them:
 *
 * - The playbook's `report` document, run once after every other document
 *   (`playbook-report-document` prompt). It also writes `## How to use it`
 *   and `## Next steps` in markdown, read back by heading.
 * - Without one, a synthesis turn over the per-task synopses the run already
 *   collected (`playbook-report-synthesis` prompt), on the cheap tier.
 *
 * Tier C is skipped on a failed or stopped run: narrating a crash produces
 * fiction. An absent narrative is never an error; the report then shows the
 * facts. Pure, so the desktop runner and the CLI engine share it.
 */

import {
	parseDirectorNotesNarrative,
	recoverDirectorNotesNarrative,
	type DirectorNotesNarrative,
} from './directorNotesNarrative';
import { fileTimestampSlug } from './formatters';
import { forEachMarkdownLine } from './markdownTaskScan';
import {
	describePlaybookParamProvenance,
	resolvePlaybookParamValue,
	type PlaybookParamSet,
} from './playbookParams';
import type {
	DiskEvidence,
	FinalSummaryFacts,
	PlaybookRunReport,
	PlaybookRunReportParameter,
	PlaybookRunReportStatus,
} from './playbookRunReport';
import { playbookRunReportStatusLabel } from './playbookRunReport';

// ============================================================================
// Where reports are saved
// ============================================================================

/** The folder, inside the Auto Run folder, that keeps every run report. */
export const PLAYBOOK_REPORTS_DIR = '.maestro-reports';

/** The longest playbook slug a report file name carries. */
const REPORT_SLUG_MAX_LENGTH = 60;

/**
 * A playbook name as a file-name segment: lowercase ASCII letters, digits,
 * and single hyphens. `playbook` when nothing is left.
 */
export function playbookReportSlug(playbookName: string): string {
	const slug = playbookName
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, REPORT_SLUG_MAX_LENGTH)
		.replace(/-+$/, '');
	return slug || 'playbook';
}

/** `<playbook-slug>-<timestamp>`, the stem both report files share. */
export function playbookReportFileStem(playbookName: string, finishedAt: number): string {
	return `${playbookReportSlug(playbookName)}-${fileTimestampSlug(finishedAt)}`;
}

/** The two report files, relative to the Auto Run folder (forward slashes). */
export function playbookReportRelativePaths(
	playbookName: string,
	finishedAt: number
): { json: string; markdown: string } {
	const stem = `${PLAYBOOK_REPORTS_DIR}/${playbookReportFileStem(playbookName, finishedAt)}`;
	return { json: `${stem}.json`, markdown: `${stem}.md` };
}

/**
 * The file name "Save to project" writes into the agent's working directory:
 * `<playbook-slug>-REPORT-<timestamp>.md`, stamped with the time of the save.
 */
export function playbookReportProjectFileName(playbookName: string, savedAt: number): string {
	return `${playbookReportSlug(playbookName)}-REPORT-${fileTimestampSlug(savedAt)}.md`;
}

/** The `-<YYYYMMDD-HHMMSS>.json` tail every saved report's JSON file ends with. */
const REPORT_JSON_STAMP = /-(\d{8}-\d{6})\.json$/;

/**
 * The newest saved report among the names in `.maestro-reports/`, by the
 * timestamp in the file name (the slug comes first, so a plain sort would
 * order by playbook). Only the JSON copies count: they carry the data.
 * Undefined when there is none.
 */
export function latestPlaybookReportJsonName(names: readonly string[]): string | undefined {
	let latest: { name: string; stamp: string } | undefined;
	for (const name of names) {
		const stamp = REPORT_JSON_STAMP.exec(name)?.[1];
		if (stamp && (!latest || stamp > latest.stamp)) latest = { name, stamp };
	}
	return latest?.name;
}

const REPORT_STATUSES: ReadonlySet<string> = new Set<PlaybookRunReportStatus>([
	'completed',
	'partial',
	'failed',
	'stopped',
]);

/**
 * A saved report's JSON, read back. The file sits in the user's project and
 * anything may have edited it, so the fields the report's renderer walks are
 * checked; undefined when the text is not a report.
 */
export function parsePlaybookRunReportJson(raw: string): PlaybookRunReport | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object') return undefined;
	const report = value as Partial<PlaybookRunReport>;
	const facts = report.facts as Partial<PlaybookRunReport['facts']> | undefined;
	const valid =
		typeof report.playbookName === 'string' &&
		typeof report.status === 'string' &&
		REPORT_STATUSES.has(report.status) &&
		typeof report.finishedAt === 'number' &&
		typeof report.startedAt === 'number' &&
		Array.isArray(report.parameters) &&
		!!facts &&
		typeof facts === 'object' &&
		Array.isArray(facts.documents) &&
		Array.isArray(facts.stalledDocuments) &&
		typeof facts.totalCompletedTasks === 'number' &&
		typeof facts.totalElapsedMs === 'number';
	return valid ? (report as PlaybookRunReport) : undefined;
}

// ============================================================================
// When tier C runs
// ============================================================================

/**
 * Whether a run with this status gets a narrative. Only a run that finished
 * (all documents, or all but the stalled ones) is narrated.
 */
export function playbookReportNarrativeAllowed(status: PlaybookRunReportStatus): boolean {
	return status === 'completed' || status === 'partial';
}

// ============================================================================
// Reading the answer back
// ============================================================================

/** The heading the report document's "How to use it" section is read from. */
export const REPORT_HOW_TO_USE_HEADING = 'How to use it';
/** The heading the report document's "Next steps" section is read from. */
export const REPORT_NEXT_STEPS_HEADING = 'Next steps';

const HEADING_REGEX = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

function normalizeHeading(text: string): string {
	return text
		.replace(/[*_`]/g, '')
		.replace(/[:.]+$/, '')
		.trim()
		.toLowerCase();
}

interface HeadingLine {
	index: number;
	level: number;
	text: string;
}

function headingLines(markdown: string): HeadingLine[] {
	const headings: HeadingLine[] = [];
	forEachMarkdownLine(markdown, (line, index) => {
		const match = HEADING_REGEX.exec(line);
		if (match) headings.push({ index, level: match[1].length, text: normalizeHeading(match[2]) });
	});
	return headings;
}

/**
 * The body of the first section headed `heading` (any level, case and
 * trailing punctuation ignored), up to the next heading of the same or a
 * higher level. Headings inside code fences do not count. Trimmed; undefined
 * when the heading is absent or the section is empty.
 */
export function extractMarkdownSection(markdown: string, heading: string): string | undefined {
	const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
	const headings = headingLines(markdown);
	const wanted = normalizeHeading(heading);
	const start = headings.findIndex((h) => h.text === wanted);
	if (start === -1) return undefined;
	const { index, level } = headings[start];
	const end = headings.slice(start + 1).find((h) => h.level <= level);
	const body = lines
		.slice(index + 1, end ? end.index : lines.length)
		.join('\n')
		.trim();
	return body === '' ? undefined : body;
}

const LIST_ITEM_REGEX = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;

/**
 * The items of a markdown list section, one string per top-level item, with
 * continuation lines joined on. A section with no list is one item.
 */
export function parseMarkdownListItems(section: string): string[] {
	const items: string[] = [];
	let topIndent: number | null = null;
	for (const rawLine of section.replace(/\r\n?/g, '\n').split('\n')) {
		if (rawLine.trim() === '') continue;
		const match = LIST_ITEM_REGEX.exec(rawLine);
		const indent = match ? match[1].length : -1;
		if (match && (topIndent === null || indent <= topIndent)) {
			topIndent = indent;
			items.push(match[2].trim());
		} else if (items.length > 0) {
			items[items.length - 1] = `${items[items.length - 1]} ${rawLine.trim()}`.trim();
		}
	}
	if (items.length === 0) {
		const text = section.trim();
		return text ? [text] : [];
	}
	return items.filter((item) => item !== '');
}

/** The narrative in a reply, strict first, then salvaged; undefined when neither works. */
function readNarrative(raw: string): DirectorNotesNarrative | undefined {
	if (raw.trim() === '') return undefined;
	const parsed = parseDirectorNotesNarrative(raw);
	if (parsed.ok) return parsed.narrative.sections.length > 0 ? parsed.narrative : undefined;
	const recovered = recoverDirectorNotesNarrative(raw);
	return recovered.ok && recovered.narrative.sections.length > 0 ? recovered.narrative : undefined;
}

/** What the report document's reply contributes to the report. */
export interface PlaybookReportAuthoredParts {
	narrative?: DirectorNotesNarrative;
	howToUse?: string;
	nextSteps?: string[];
}

/**
 * Read the report document's reply: the narrative JSON (looked for before the
 * first authored heading, so a JSON example inside "How to use it" is never
 * mistaken for it), then the two markdown sections by heading. Any part that
 * is missing or malformed is left out.
 */
export function parsePlaybookReportAnswer(raw: string): PlaybookReportAuthoredParts {
	const text = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n') : '';
	const parts: PlaybookReportAuthoredParts = {};

	const authored = new Set(
		[REPORT_HOW_TO_USE_HEADING, REPORT_NEXT_STEPS_HEADING].map(normalizeHeading)
	);
	const firstAuthored = headingLines(text).find((h) => authored.has(h.text));
	const head = firstAuthored ? text.split('\n').slice(0, firstAuthored.index).join('\n') : text;
	const narrative = readNarrative(head) ?? (firstAuthored ? readNarrative(text) : undefined);
	if (narrative) parts.narrative = narrative;

	const howToUse = extractMarkdownSection(text, REPORT_HOW_TO_USE_HEADING);
	if (howToUse) parts.howToUse = howToUse;

	const nextStepsSection = extractMarkdownSection(text, REPORT_NEXT_STEPS_HEADING);
	if (nextStepsSection) {
		const nextSteps = parseMarkdownListItems(nextStepsSection);
		if (nextSteps.length > 0) parts.nextSteps = nextSteps;
	}
	return parts;
}

/** Read the synthesis turn's reply: the narrative only. */
export function parsePlaybookReportSynthesis(raw: string): DirectorNotesNarrative | undefined {
	return readNarrative(typeof raw === 'string' ? raw : '');
}

// ============================================================================
// Building the prompts
// ============================================================================

/** One task's synopsis, as the synthesis turn reads it. */
export interface PlaybookReportSynopsis {
	/** The document filename the task belonged to. */
	document: string;
	summary: string;
	success: boolean;
}

/** The most synopses a synthesis prompt carries; the newest are kept. */
export const REPORT_SYNOPSES_MAX = 200;
/** The most changed files a prompt lists. */
const REPORT_PROMPT_FILES_MAX = 100;

/** The synopses as a markdown list, oldest first, newest kept when over the cap. */
export function formatPlaybookReportSynopses(synopses: readonly PlaybookReportSynopsis[]): string {
	const usable = synopses.filter((s) => s.summary.trim() !== '');
	if (usable.length === 0) return '(No task reported a synopsis.)';
	const kept = usable.slice(-REPORT_SYNOPSES_MAX);
	const lines = kept.map(
		(s) =>
			`- [${s.document}]${s.success ? '' : ' (failed)'} ${s.summary.trim().replace(/\s*\n\s*/g, ' ')}`
	);
	if (kept.length < usable.length) {
		lines.unshift(`(The first ${usable.length - kept.length} synopses are left out.)`);
	}
	return lines.join('\n');
}

/** The run's facts as a short markdown list for a report prompt. */
export function formatPlaybookReportRunFacts(
	status: PlaybookRunReportStatus,
	facts: FinalSummaryFacts
): string {
	const lines = [
		`- Status: ${playbookRunReportStatusLabel(status)}`,
		`- Tasks completed: ${facts.totalCompletedTasks}`,
		`- Documents: ${facts.documents.join(', ') || 'none'}`,
	];
	if (facts.loopEnabled) lines.push(`- Loops completed: ${facts.loopsCompleted}`);
	for (const { filename, reason } of facts.stalledDocuments) {
		lines.push(`- Stalled: ${filename} (${reason})`);
	}
	return lines.join('\n');
}

/** What changed on disk, as a short markdown list for a report prompt. */
export function formatPlaybookReportFilesChanged(evidence: DiskEvidence | undefined): string {
	if (!evidence) return '(Not recorded for this run.)';
	const lines: string[] = [];
	const groups: Array<[string, string[]]> = [
		['created', evidence.createdFiles],
		['changed', evidence.changedFiles],
		['deleted', evidence.deletedFiles],
	];
	let listed = 0;
	let omitted = 0;
	for (const [label, files] of groups) {
		for (const file of files) {
			if (listed < REPORT_PROMPT_FILES_MAX) {
				lines.push(`- ${label}: ${file}`);
				listed++;
			} else {
				omitted++;
			}
		}
	}
	if (evidence.branch) lines.unshift(`- branch: ${evidence.branch}`);
	if (evidence.prUrl) lines.unshift(`- pull request: ${evidence.prUrl}`);
	if (omitted > 0) lines.push(`- (${omitted} more files)`);
	return lines.length > 0 ? lines.join('\n') : '(No file changes were detected.)';
}

/**
 * Fill a report prompt template. One pass over `{{NAME}}` tokens, so a value
 * that itself holds `{{...}}` (a document, a synopsis) is inserted literally
 * and never substituted again. Unknown tokens are left for the caller's
 * template-variable pass.
 */
export function fillPlaybookReportPrompt(
	template: string,
	values: Readonly<Record<string, string>>
): string {
	return template.replace(/\{\{([A-Z_]+)\}\}/g, (token, name: string) =>
		Object.prototype.hasOwnProperty.call(values, name) ? values[name] : token
	);
}

// ============================================================================
// The Configuration table
// ============================================================================

/**
 * The parameters a run used, in declaration order, with the value each one
 * resolved to and where it came from. A parameter with no value is listed
 * with an empty value and `unresolved`.
 */
export function buildPlaybookRunReportParameters(
	set: PlaybookParamSet | undefined
): PlaybookRunReportParameter[] {
	if (!set) return [];
	return set.specs.map((spec) => ({
		name: spec.name,
		value: resolvePlaybookParamValue(spec, set.values) ?? '',
		source: describePlaybookParamProvenance(spec, set.values, undefined),
	}));
}
