/**
 * The renderer-safe half of playbook failure reports: the failure kinds, the
 * repo a failure is filed against, and the report a finished run's
 * "Report a problem" builds.
 *
 * Split from `playbookFailure.ts` because that module hashes with node
 * `crypto` for the fingerprint, which the renderer bundle cannot load. This
 * file imports nothing from node, so the Auto Run runner and the completion
 * modal can use it; `playbookFailure.ts` re-exports all of it.
 */

import type { PlaybookParamProvenance } from './playbookParams';
import type { PlaybookRunReport } from './playbookRunReport';
import type { AutoRunFailureKind } from './stats-types';
import { PLAYBOOK_PRISTINE_SOURCE_DIR, type AgentError } from './types';

/**
 * What went wrong. The Auto Run failure kinds (the playbook content stalled,
 * errored, or halted), plus the three that are the app or the provider:
 * the host watchdog ended the turn, the provider's login failed, or the agent
 * could not start. The values are fingerprint input, so renaming one splits
 * every existing bucket for it.
 */
export type PlaybookFailureKind = AutoRunFailureKind | 'watchdog' | 'auth' | 'spawn';

const PLAYBOOK_FAILURE_KINDS: ReadonlySet<string> = new Set<PlaybookFailureKind>([
	'stall',
	'error',
	'halt',
	'watchdog',
	'auth',
	'spawn',
]);

/** Whether an untyped value (an IPC payload field) is a failure kind. */
export function isPlaybookFailureKind(value: unknown): value is PlaybookFailureKind {
	return typeof value === 'string' && PLAYBOOK_FAILURE_KINDS.has(value);
}

/** The content repo: playbook documents and the manifest. */
export const PLAYBOOK_CONTENT_REPO = 'RunMaestro/Maestro-Playbooks';
/** The app repo: Maestro itself. */
export const MAESTRO_APP_REPO = 'RunMaestro/Maestro';

export type PlaybookFailureRepo = typeof PLAYBOOK_CONTENT_REPO | typeof MAESTRO_APP_REPO;

/** The label every playbook failure issue carries, on either repo. */
export const PLAYBOOK_FAILURE_LABEL = 'playbook-failure';

/** The HTML comment key a filed issue carries its fingerprint under. Searched for dedup. */
export const PLAYBOOK_FAILURE_FINGERPRINT_MARKER = 'maestro:playbook-failure-fingerprint';

/** One parameter the failed run used. The value is read for its shape only. */
export interface PlaybookFailureParameter {
	name: string;
	/** The resolved value. Never written to the issue. */
	value?: string;
	provenance: PlaybookParamProvenance;
}

/** Everything a failure report is built from. */
export interface PlaybookFailureReport {
	/** The manifest entry id (`provenance.marketplaceId`). Public. */
	playbookId: string;
	/** The manifest `lastUpdated` the playbook was imported at. Public. */
	sourceVersion?: string;
	/** The document's filename as shipped, with or without `.md`. */
	documentFilename: string;
	/** The 0-based task the run was on: the document's checked-task count at the time. */
	taskIndex: number;
	kind: PlaybookFailureKind;
	/** The agent's provider id, e.g. `claude-code`. */
	agentProvider: string;
	appVersion: string;
	parameters?: PlaybookFailureParameter[];
}

/**
 * A failure report as the renderer sends it: everything but the app version,
 * which the main process stamps so the issue names the build that filed it.
 */
export type PlaybookFailureReportInput = Omit<PlaybookFailureReport, 'appVersion'>;

const APP_FAILURE_KINDS: ReadonlySet<PlaybookFailureKind> = new Set(['watchdog', 'auth', 'spawn']);

/**
 * The repo a failure is filed against. A watchdog, auth, or spawn failure is
 * the app or the provider, which the playbook author cannot fix; everything
 * else is the content (a task line that stalled, errored, or halted), whose
 * fix is an edit in the playbooks repo.
 */
export function routePlaybookFailure(
	report: Pick<PlaybookFailureReport, 'kind'>
): PlaybookFailureRepo {
	return APP_FAILURE_KINDS.has(report.kind) ? MAESTRO_APP_REPO : PLAYBOOK_CONTENT_REPO;
}

/**
 * The failure kind of an agent error that ended a playbook turn: the host
 * watchdog, a provider login failure, and a provider CLI that is not installed
 * are app failures; any other agent error is a plain `error`.
 */
export function playbookFailureKindForAgentError(
	error: Pick<AgentError, 'type' | 'source'>
): PlaybookFailureKind {
	if (error.source === 'host-supervision') return 'watchdog';
	if (error.type === 'auth_expired') return 'auth';
	if (error.type === 'agent_not_installed') return 'spawn';
	return 'error';
}

/** A document filename without a trailing `.md`. */
export function playbookDocumentBaseName(filename: string): string {
	return filename.replace(/\.md$/i, '');
}

/**
 * Where an imported playbook keeps the shipped copy of a document, relative to
 * its Auto Run folder. Read the failing task from here, never from the working
 * copy, which holds expanded parameter values.
 */
export function pristineSourceRelativePath(documentFilename: string): string {
	return `${PLAYBOOK_PRISTINE_SOURCE_DIR}/${playbookDocumentBaseName(documentFilename)}.md`;
}

/** A failure a finished run can report, and where its shipped text lives. */
export interface PlaybookFailureDraft {
	report: PlaybookFailureReportInput;
	/**
	 * The pristine copy of the failing document, relative to the run report's
	 * `autoRunFolderPath`: `<playbook folder>/.maestro-playbook/source/<doc>.md`.
	 */
	pristineDocumentPath: string;
}

/**
 * The failure "Report a problem" files for a finished run, or null when the
 * run has nothing to report: it completed or was stopped, its playbook did
 * not come from the Exchange (nobody upstream can fix a local playbook), or
 * no problem is located at a task.
 *
 * The problem that leads the report (the last error or halt, then the first
 * stall) is the one filed. A run-list document is `<playbook folder>/<doc>`,
 * so the shipped filename is the last segment and the pristine copy sits in
 * that folder's `.maestro-playbook/source/`.
 */
export function playbookFailureFromRunReport(
	report: Pick<PlaybookRunReport, 'status' | 'source' | 'problems' | 'parameters'>,
	agentProvider: string
): PlaybookFailureDraft | null {
	if (report.status !== 'failed' && report.status !== 'partial') return null;
	if (!report.source?.marketplaceId) return null;
	const problem = report.problems?.find((p) => p.taskIndex !== undefined);
	if (!problem || problem.taskIndex === undefined) return null;

	const segments = problem.document.split(/[\\/]/);
	const documentFilename = playbookDocumentBaseName(segments[segments.length - 1] ?? '');
	if (!documentFilename) return null;
	const folder = segments.slice(0, -1).join('/');
	const pristine = pristineSourceRelativePath(documentFilename);

	return {
		report: {
			playbookId: report.source.marketplaceId,
			...(report.source.sourceVersion && { sourceVersion: report.source.sourceVersion }),
			documentFilename,
			taskIndex: problem.taskIndex,
			kind: problem.failureKind ?? problem.kind,
			agentProvider,
			parameters: report.parameters.map((param) => ({
				name: param.name,
				value: param.value,
				provenance: param.source,
			})),
		},
		pristineDocumentPath: folder ? `${folder}/${pristine}` : pristine,
	};
}
