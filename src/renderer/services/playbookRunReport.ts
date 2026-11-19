/**
 * The desktop's side of a playbook run report: loading the two authoring
 * prompts, saving a finished report under `<autoRunFolder>/.maestro-reports/`
 * as JSON (the data, for the completion modal and History) and as rendered
 * markdown (what Copy and Save produce), reading the newest one back, and the
 * completion modal's "Save to project".
 *
 * The report itself is built and rendered by the shared modules
 * (`src/shared/playbookRunReport.ts`, `src/shared/playbookReportAuthoring.ts`),
 * so the CLI engine writes the same two files.
 *
 * Saving is never allowed to cost a run: a failed write is logged and the
 * report is still shown and attached to History, just without `reportPath`.
 */

import { joinPath } from '../../shared/formatters';
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import {
	latestPlaybookReportJsonName,
	parsePlaybookRunReportJson,
	PLAYBOOK_REPORTS_DIR,
	playbookReportProjectFileName,
	playbookReportRelativePaths,
} from '../../shared/playbookReportAuthoring';
import {
	renderPlaybookReportMarkdown,
	type PlaybookRunReport,
} from '../../shared/playbookRunReport';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'PlaybookRunReport';

export type PlaybookReportPromptId =
	| typeof PROMPT_IDS.PLAYBOOK_REPORT_DOCUMENT
	| typeof PROMPT_IDS.PLAYBOOK_REPORT_SYNTHESIS;

/**
 * One of the report prompts, customizations and includes applied. Not
 * cached: a report is written once per run, and an edit in Settings should
 * apply to the next run.
 */
export async function loadPlaybookReportPrompt(id: PlaybookReportPromptId): Promise<string> {
	const result = await window.maestro.prompts.get(id);
	if (!result.success || typeof result.content !== 'string' || result.content.trim() === '') {
		throw new Error(`Failed to load ${id} prompt: ${result.error ?? 'empty'}`);
	}
	return result.content;
}

/** Where a saved report lives. */
export interface SavedPlaybookRunReport {
	/** The rendered markdown, absolute. */
	markdownPath: string;
	/** The JSON, absolute. */
	jsonPath: string;
}

/**
 * Write `report` to `<autoRunFolder>/.maestro-reports/<slug>-<timestamp>.{json,md}`,
 * on the agent's SSH remote when it has one. The JSON copy carries
 * `reportPath` (the markdown path). Returns the paths, or null when either
 * write failed.
 */
export async function savePlaybookRunReport(
	report: PlaybookRunReport,
	autoRunFolder: string,
	sshRemoteId?: string
): Promise<SavedPlaybookRunReport | null> {
	const relative = playbookReportRelativePaths(report.playbookName, report.finishedAt);
	const markdownPath = joinPath(autoRunFolder, relative.markdown);
	const jsonPath = joinPath(autoRunFolder, relative.json);
	const saved: PlaybookRunReport = { ...report, reportPath: markdownPath };
	try {
		await window.maestro.fs.mkdir(joinPath(autoRunFolder, PLAYBOOK_REPORTS_DIR), sshRemoteId);
		const markdownWrite = await window.maestro.fs.writeFile(
			markdownPath,
			renderPlaybookReportMarkdown(saved),
			sshRemoteId
		);
		const jsonWrite = await window.maestro.fs.writeFile(
			jsonPath,
			`${JSON.stringify(saved, null, 2)}\n`,
			sshRemoteId
		);
		if (!markdownWrite?.success || !jsonWrite?.success) {
			logger.warn('Report write failed', LOG_CONTEXT, { markdownPath, jsonPath });
			return null;
		}
		return { markdownPath, jsonPath };
	} catch (error) {
		logger.warn('Report write failed', LOG_CONTEXT, { markdownPath, jsonPath, error });
		return null;
	}
}

/**
 * "Save to project": write the rendered report to
 * `<cwd>/<playbook-slug>-REPORT-<timestamp>.md`, on the agent's SSH remote
 * when it has one. Returns the absolute path; throws when the write fails, so
 * the caller can say so.
 */
export async function savePlaybookReportToProject(
	report: PlaybookRunReport,
	cwd: string,
	sshRemoteId?: string,
	savedAt: number = Date.now()
): Promise<string> {
	const path = joinPath(cwd, playbookReportProjectFileName(report.playbookName, savedAt));
	const result = await window.maestro.fs.writeFile(
		path,
		renderPlaybookReportMarkdown(report),
		sshRemoteId
	);
	if (!result?.success) throw new Error(`Could not write ${path}`);
	return path;
}

/**
 * The newest report saved under `<autoRunFolder>/.maestro-reports/`, read
 * from its JSON copy. Null when the folder is missing, holds no report, or
 * the newest file is not a readable report.
 */
export async function loadLatestPlaybookRunReport(
	autoRunFolder: string,
	sshRemoteId?: string
): Promise<PlaybookRunReport | null> {
	const dir = joinPath(autoRunFolder, PLAYBOOK_REPORTS_DIR);
	let names: string[];
	try {
		const entries = await window.maestro.fs.readDir(dir, sshRemoteId);
		names = entries.filter((entry) => entry.isFile).map((entry) => entry.name);
	} catch {
		// No .maestro-reports/ yet: this agent has never finished a playbook run.
		return null;
	}
	const latest = latestPlaybookReportJsonName(names);
	if (!latest) return null;
	const raw = await window.maestro.fs.readFile(joinPath(dir, latest), sshRemoteId);
	if (raw === null) return null;
	const report = parsePlaybookRunReportJson(raw);
	if (!report) logger.warn('Saved report is not readable', LOG_CONTEXT, { file: latest });
	return report ?? null;
}
