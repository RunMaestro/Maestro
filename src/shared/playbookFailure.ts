/**
 * Playbook failure reports: the fingerprint that groups the same failure
 * across installs, the repo a failure is filed against, and the issue body
 * the user is shown before anything is sent.
 *
 * Shared because the desktop runner and the CLI engine both report failures,
 * and the fingerprint must match byte for byte or the maintainer's view splits
 * one failure into two buckets. It hashes with node `crypto`, so it runs in the
 * main process and the CLI; the renderer receives the composed issue over IPC.
 *
 * Privacy rule: an issue carries only public repo facts (the playbook id, its
 * published version, a document filename and task line as shipped) and
 * environment facts the feedback flow already sends (provider, app version).
 * Parameter values, paths, branch names, and repo names are never fields, so
 * they cannot appear.
 */

import { isSecretEnvKey } from './agentEnvironment';
import { canonicalJson } from './canonicalJson';
import { sha256Hex } from './maestro-lib/grok/host-seams';
import {
	forEachMarkdownLine,
	CHECKED_TASK_COUNT_REGEX,
	UNCHECKED_TASK_REGEX,
} from './markdownTaskScan';
import type { PlaybookParamProvenance } from './playbookParams';
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

/** The content repo: playbook documents and the manifest. */
export const PLAYBOOK_CONTENT_REPO = 'RunMaestro/Maestro-Playbooks';
/** The app repo: Maestro itself. */
export const MAESTRO_APP_REPO = 'RunMaestro/Maestro';

export type PlaybookFailureRepo = typeof PLAYBOOK_CONTENT_REPO | typeof MAESTRO_APP_REPO;

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

export interface PlaybookFailureFingerprintInput {
	playbookId: string;
	sourceVersion?: string;
	documentFilename: string;
	taskIndex: number;
	kind: PlaybookFailureKind;
}

/**
 * The fingerprint of a failure: sha256 of its public coordinates, 16 hex.
 *
 * Deliberately NOT salted with the installation id, unlike Cue's `hashName`.
 * Two users who hit the same task of the same playbook version must produce
 * the same fingerprint, or reports split into one bucket per install and the
 * maintainer can never see that a task fails for everyone. Every input is
 * public (a slug, a published version, a shipped filename, an ordinal, a
 * failure class), so there is nothing to hide by salting.
 *
 * A trailing `.md` on the filename is dropped first, so the desktop and the
 * CLI agree whichever spelling they hold.
 */
export function playbookFailureFingerprint(input: PlaybookFailureFingerprintInput): string {
	return sha256Hex(
		canonicalJson({
			playbookId: input.playbookId,
			sourceVersion: input.sourceVersion ?? '',
			documentFilename: documentBaseName(input.documentFilename),
			taskIndex: input.taskIndex,
			kind: input.kind,
		})
	).slice(0, 16);
}

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

function documentBaseName(filename: string): string {
	return filename.replace(/\.md$/i, '');
}

/**
 * Where an imported playbook keeps the shipped copy of a document, relative to
 * its Auto Run folder. Read the failing task from here, never from the working
 * copy, which holds expanded parameter values.
 */
export function pristineSourceRelativePath(documentFilename: string): string {
	return `${PLAYBOOK_PRISTINE_SOURCE_DIR}/${documentBaseName(documentFilename)}.md`;
}

/**
 * The `taskIndex`-th checkbox task line (0-based, checked or not, outside
 * fenced code) of a document, trimmed. Null when the document has fewer tasks.
 * Pass the pristine copy, so the line is the text that shipped.
 */
export function taskLineAtIndex(content: string, taskIndex: number): string | null {
	if (!Number.isInteger(taskIndex) || taskIndex < 0) return null;
	let seen = 0;
	let found: string | null = null;
	forEachMarkdownLine(content, (line) => {
		if (!CHECKED_TASK_COUNT_REGEX.test(line) && !UNCHECKED_TASK_REGEX.test(line)) return;
		if (seen === taskIndex) {
			found = line.trim();
			return false;
		}
		seen++;
	});
	return found;
}

const KIND_LABELS: Record<PlaybookFailureKind, { title: string; body: string }> = {
	stall: { title: 'stalled', body: 'Stalled: the task made no progress' },
	error: { title: 'errored', body: 'Error: the agent reported an error' },
	halt: { title: 'halted', body: 'Halted: the agent wrote a halt marker' },
	watchdog: { title: 'timed out', body: 'Watchdog: the turn went silent and was ended' },
	auth: { title: 'auth failure', body: 'Auth: the provider login failed' },
	spawn: { title: 'agent did not start', body: 'Spawn: the agent could not start' },
};

/** Text that is safe inside one markdown table cell. */
function tableCell(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Markdown inline code that survives a backtick in the text. */
function inlineCode(text: string): string {
	const fence = text.includes('`') ? '``' : '`';
	const pad = fence === '``' ? ' ' : '';
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** A fenced block whose fence is longer than any backtick run in the text. */
function fencedBlock(text: string, language: string): string {
	const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = '`'.repeat(Math.max(3, longestRun + 1));
	return `${fence}${language}\n${text}\n${fence}`;
}

const PATH_LIKE = /^(~|\.{1,2})?[\\/]|^[a-z]:[\\/]/i;

/**
 * What a parameter's value looks like, never what it is: `url`, `path`,
 * `number`, or a length. A URL can name a private repo and a path names the
 * user's machine, so neither gets even a length.
 */
function describeValueShape(value: string): string {
	const trimmed = value.trim();
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return 'url';
	if (PATH_LIKE.test(trimmed)) return 'path, withheld';
	if (trimmed !== '' && Number.isFinite(Number(trimmed))) return 'number';
	return `${[...trimmed].length} chars`;
}

/**
 * One line per parameter, by shape: `set (url)`, `default`, `unset`. A name
 * that looks like a secret is left out entirely, because even its presence
 * says what the user configured.
 */
export function describePlaybookFailureParameters(
	parameters: ReadonlyArray<PlaybookFailureParameter>
): string[] {
	const lines: string[] = [];
	for (const param of parameters) {
		if (isSecretEnvKey(param.name)) continue;
		let shape: string;
		if (param.provenance === 'default') shape = 'default';
		else if (param.provenance === 'unresolved' || !param.value?.trim()) shape = 'unset';
		else shape = `set (${describeValueShape(param.value)})`;
		lines.push(`- ${inlineCode(param.name)}: ${shape}`);
	}
	return lines;
}

export interface BuildPlaybookFailureIssueOptions {
	/**
	 * The pristine copy of the failing document, read from
	 * {@link pristineSourceRelativePath} under the playbook's folder. Absent or
	 * null when the import kept none; the task line is then omitted, never
	 * read from the working copy.
	 */
	pristineSource?: string | null;
}

export interface PlaybookFailureIssue {
	repo: PlaybookFailureRepo;
	title: string;
	body: string;
	fingerprint: string;
}

/**
 * The issue a failure files, exactly as the user is shown it before sending.
 * The fingerprint rides in an HTML comment at the end: invisible on GitHub,
 * exactly searchable for dedup.
 */
export function buildPlaybookFailureIssue(
	report: PlaybookFailureReport,
	options: BuildPlaybookFailureIssueOptions = {}
): PlaybookFailureIssue {
	const fingerprint = playbookFailureFingerprint(report);
	const document = `${documentBaseName(report.documentFilename)}.md`;
	const taskNumber = report.taskIndex + 1;
	const kind = KIND_LABELS[report.kind];

	const title = `Playbook ${report.playbookId}: ${kind.title} at ${document} task ${taskNumber}`;

	const rows: Array<[string, string]> = [
		['Playbook', inlineCode(report.playbookId)],
		['Version', report.sourceVersion ? inlineCode(report.sourceVersion) : 'unknown'],
		['Document', inlineCode(document)],
		['Task', `${taskNumber} (index ${report.taskIndex})`],
		['Failure', kind.body],
		['Agent provider', report.agentProvider || 'unknown'],
		['Maestro version', report.appVersion || 'unknown'],
	];
	const sections: string[] = [
		'## Playbook failure',
		'',
		'| Field | Value |',
		'| --- | --- |',
		...rows.map(([field, value]) => `| ${field} | ${tableCell(value)} |`),
	];

	const taskLine =
		options.pristineSource != null
			? taskLineAtIndex(options.pristineSource, report.taskIndex)
			: null;
	sections.push('', '### Task as shipped', '');
	sections.push(
		taskLine
			? fencedBlock(taskLine, 'markdown')
			: '_The shipped copy of this task was not available._'
	);

	const parameterLines = describePlaybookFailureParameters(report.parameters ?? []);
	if (parameterLines.length > 0) {
		sections.push('', '### Configured parameters', '', ...parameterLines);
	}

	sections.push('', `<!-- ${PLAYBOOK_FAILURE_FINGERPRINT_MARKER}: ${fingerprint} -->`);

	return { repo: routePlaybookFailure(report), title, body: sections.join('\n'), fingerprint };
}
