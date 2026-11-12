/**
 * launchOutro - what the Playbook Launch outro says about a launch that ended, as plain data.
 *
 * Pure rules, so the modal that draws them (`PlaybookOutroModal`) holds no wording of its own: how
 * the run ended, its numbers, what cleanup did with the task documents, and the playbook author's
 * own title, summary, next steps and files with their `{{TOKEN}}`s filled in.
 *
 * The author's text is filled from the launch RECORD, never from the current manifest. The record
 * keeps the `launch` block as it was when the launch started, and the answers it ran with, so a
 * manifest that changed since cannot change what a finished launch says.
 */

import { formatCost, formatElapsedTime } from '../../../../shared/formatters';
import type { PlaybookLaunchRecord } from '../../../../shared/marketplace-types';
import { renderLaunchOutro } from '../../../../shared/playbookLaunch';
import {
	buildTemplateReplacements,
	type TemplateSessionInfo,
} from '../../../../shared/templateVariables';

/** How a line reads: the color it takes in the dialog. */
export type LaunchOutroTone = 'success' | 'warning' | 'error' | 'dim';

/** One sentence about the launch and the tone it is said in. */
export interface LaunchOutroLine {
	tone: LaunchOutroTone;
	text: string;
}

/** One number about the run. */
export interface LaunchOutroStat {
	id: 'tasks' | 'time' | 'cost';
	label: string;
	value: string;
}

/** Everything the outro shows, ready to draw. */
export interface LaunchOutroView {
	/** The author's title, else the playbook's. */
	title: string;
	/** How the run ended. */
	status: LaunchOutroLine;
	/** Tasks, time and cost. Empty when the launch never recorded how the run ended. */
	stats: LaunchOutroStat[];
	/** Markdown. */
	summary: string;
	/** Markdown bullets, one per entry. */
	nextSteps: string[];
	/** The outputs to offer as Open buttons. */
	files: Array<{ label: string; path: string }>;
	/** The file whose first heading section is the verdict. */
	reportFile?: string;
	/** What cleanup did with the task documents. Absent while it has not run. */
	cleanup?: LaunchOutroLine;
}

/**
 * Stands in for an agent that was deleted before the outro opened. It still carries the id, so the
 * built-ins that depend only on the launch (the Auto Run folder, the date) come out right; the
 * ones that name the agent come out empty, because the record does not keep them.
 */
function departedAgent(sessionId: string): TemplateSessionInfo {
	return { id: sessionId, name: '', toolType: '', cwd: '' };
}

/**
 * The built-in `{{NAME}}` values an outro is filled with, as the run itself saw them. The run
 * reads `{{AUTORUN_FOLDER}}` as the agent's Auto Run folder (the folder the launch imported into,
 * not the launch folder inside it) and the clock as of each task, so the date is the one the first
 * task ran on: the report files the playbooks write are named with it
 * (`SECURITY_LOG_{{AGENT_NAME}}_{{DATE}}.md`). Reading "now" instead would point an outro opened
 * the next day at a file that does not exist.
 */
export function launchOutroBuiltins(
	launch: Pick<PlaybookLaunchRecord, 'sessionId' | 'autoRunFolderPath' | 'startedAt'>,
	agent: TemplateSessionInfo | undefined
): Record<string, string> {
	return buildTemplateReplacements({
		session: agent ?? departedAgent(launch.sessionId),
		autoRunFolder: launch.autoRunFolderPath,
		now: new Date(launch.startedAt),
	});
}

/** How the run ended. A stopped run says what happened to the documents, so the person can resume. */
function launchStatus(launch: PlaybookLaunchRecord): LaunchOutroLine {
	switch (launch.status) {
		case 'completed':
			return { tone: 'success', text: 'Completed' };
		case 'stopped':
			return {
				tone: 'warning',
				text: 'Stopped. The task documents were kept so you can resume.',
			};
		case 'failed':
			return { tone: 'error', text: 'The launch did not finish.' };
		case 'running':
			return { tone: 'dim', text: 'Still running.' };
	}
}

function plural(count: number, noun: string): string {
	return count === 1 ? noun : `${noun}s`;
}

/** Tasks, time and cost. The cost is left out when the run did not report one. */
function launchStats(launch: PlaybookLaunchRecord): LaunchOutroStat[] {
	const { completion } = launch;
	if (!completion) return [];
	const stats: LaunchOutroStat[] = [
		{
			id: 'tasks',
			label: plural(completion.totalTasks, 'Task'),
			value: `${completion.completedTasks} of ${completion.totalTasks}`,
		},
		{ id: 'time', label: 'Time', value: formatElapsedTime(completion.elapsedTimeMs) },
	];
	if (completion.totalCostUsd !== undefined) {
		stats.push({ id: 'cost', label: 'Cost', value: formatCost(completion.totalCostUsd) });
	}
	return stats;
}

/**
 * What cleanup did with the launch folder. Cleanup keeps the folder when the playbook says to, when
 * the person saved the playbook to reuse (the saved playbook runs from that folder), and always
 * when the run was stopped. Nothing is said before cleanup has run.
 */
function launchCleanup(launch: PlaybookLaunchRecord): LaunchOutroLine | undefined {
	const folder = `"${launch.folderRelativePath}"`;
	switch (launch.cleanup) {
		case 'done':
			return { tone: 'dim', text: 'Cleanup: the task documents were removed.' };
		case 'kept':
			return {
				tone: 'dim',
				text: launch.keepSavedPlaybook
					? `Cleanup: the task documents were kept in ${folder}, because you saved this playbook to reuse.`
					: `Cleanup: the task documents were kept in ${folder}, as this playbook asks.`,
			};
		case 'skipped-stopped':
			return {
				tone: 'dim',
				text: `Cleanup: skipped, because the run was stopped. The task documents are in ${folder}.`,
			};
		case 'failed':
			return {
				tone: 'error',
				text: `Cleanup: could not remove the task documents in ${folder}.${
					launch.cleanupError ? ` ${launch.cleanupError}` : ''
				}`,
			};
		case undefined:
			return undefined;
	}
}

/**
 * The author's next steps as one markdown bullet list, for `<Markdown>`. A step that runs over
 * several lines keeps them under its bullet.
 */
export function launchBulletList(steps: readonly string[]): string {
	return steps.map((step) => `- ${step.trim().replace(/\n/g, '\n  ')}`).join('\n');
}

/**
 * Build everything the outro shows for a launch.
 *
 * @param launch the launch record, from `marketplace:launchChanged` or `marketplace:getLaunch`
 * @param agent the agent the run used, for the built-ins that name it; `undefined` when it is gone
 */
export function buildLaunchOutro(
	launch: PlaybookLaunchRecord,
	agent: TemplateSessionInfo | undefined
): LaunchOutroView {
	const outro = renderLaunchOutro(launch.spec, launch.values, launchOutroBuiltins(launch, agent));
	return {
		title: outro.title?.trim() || launch.playbookTitle,
		status: launchStatus(launch),
		stats: launchStats(launch),
		summary: outro.summary,
		nextSteps: outro.nextSteps,
		files: outro.files,
		reportFile: outro.reportFile,
		cleanup: launchCleanup(launch),
	};
}
