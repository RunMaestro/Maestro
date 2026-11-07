/**
 * Git drafts: write a pull request title and body with the `git-drafts` Local
 * Models assignment.
 *
 * One implementation for both callers: the Create Pull Request form's "Draft
 * with local model" button (`localModels:draftPullRequest`) and
 * `maestro-cli models run git-drafts --cwd <path>` (`local_models_git_draft`
 * over the CLI bridge). Both read the same assignment, summarize the same
 * branch, and get the same result shape.
 *
 * It only ever returns text. Nothing here pushes, commits, or opens a pull
 * request: the form fills its fields and the person presses Create.
 *
 * The verdicts, none of which falls back to an agent:
 *   - `off` is the default. Git drafts is new with Local Models and has no
 *     agent path, so there is nothing to keep using; the form hides the button.
 *   - `unavailable` and `cancelled` fail with the reason, which the form shows
 *     beside the button on every attempt (so no deduplicated toast on top).
 *
 * Local only, on purpose. Create Pull Request runs `git push` and `gh` on this
 * machine against a local checkout (`git:createPR` takes no SSH remote), so the
 * branch summary is read here too, and the text never leaves the machine
 * unless the user assigned an endpoint that is somewhere else.
 */

import * as path from 'path';

import {
	GIT_DRAFT_PR_REPLY_SCHEMA,
	formatPullRequestDraftInput,
	parsePullRequestDraftReply,
	type PullRequestDraftRequest,
	type PullRequestDraftResult,
} from '../../shared/gitDrafts';
import {
	LOCAL_MODEL_TASKS,
	localModelAssignmentSourceLabel,
	resolveLocalModelAssignment,
} from '../../shared/local-models/tasks';
import { taskAssignmentLocation } from '../../shared/local-models/settings-location';
import { getPrompt } from '../prompt-manager';
import { logger } from '../utils/logger';
import { execGit } from '../utils/remote-git';
import { getConfiguredLocalModelEndpoints } from './endpoint-service';
import { readLocalModelAssignments } from './sources';
import { runLocalTask } from './task-router';

const LOG_CONTEXT = '[GitDrafts]';

const TASK_ID = 'git-drafts';

/** Where a person assigns the task's source, for refusal text. */
const ASSIGNMENT_LOCATION = taskAssignmentLocation(TASK_ID);

/** A title and a short body, as JSON. */
const GIT_DRAFT_MAX_TOKENS = 700;

/**
 * How long a draft may take. Long enough for a cold local model to load and
 * write a few hundred tokens; the person is watching a spinner on a button.
 */
export const GIT_DRAFT_TIMEOUT_MS = 120 * 1000;

/** Commits read from the log. Far more than the model is shown (see the caps). */
const MAX_LOG_COMMITS = 1000;

/** The branches the form defaults its target to, in order (see `CreatePRModal`). */
const DEFAULT_BASE_BRANCHES = ['main', 'master'] as const;

function fail(
	status: Extract<PullRequestDraftResult, { success: false }>['status'],
	error: string,
	producedBy?: string
): PullRequestDraftResult {
	return { success: false, status, error, ...(producedBy && { producedBy }) };
}

/**
 * Validate a request that crossed a process boundary (IPC or the CLI bridge).
 * A bad request throws with a message a person can act on.
 */
export function parsePullRequestDraftRequest(value: unknown): PullRequestDraftRequest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('A pull request draft needs a repository path (cwd).');
	}
	const record = value as Record<string, unknown>;
	if (typeof record.cwd !== 'string' || record.cwd.trim() === '') {
		throw new Error('A pull request draft needs a repository path (cwd).');
	}
	if (!path.isAbsolute(record.cwd)) {
		throw new Error(`The repository path must be absolute: ${record.cwd}`);
	}
	const request: PullRequestDraftRequest = { cwd: record.cwd };

	if (record.baseBranch !== undefined && record.baseBranch !== null && record.baseBranch !== '') {
		if (typeof record.baseBranch !== 'string' || !isSafeBranchName(record.baseBranch)) {
			throw new Error(`Not a valid branch name: ${String(record.baseBranch)}`);
		}
		request.baseBranch = record.baseBranch;
	}
	return request;
}

/**
 * Whether a branch name is safe to hand to git as a revision. The leading `-`
 * is the one that matters: the name lands in an argument position, and a name
 * that starts with a dash would be read as an option.
 */
function isSafeBranchName(name: string): boolean {
	return name.length <= 250 && !name.startsWith('-') && !/[\s~^:?*[\\]|\.\./.test(name);
}

/** The first of `candidates` that names a commit in this repository. */
async function firstResolvableRef(cwd: string, candidates: readonly string[]) {
	for (const ref of candidates) {
		const result = await execGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
		if (result.exitCode === 0) return ref;
	}
	return null;
}

/**
 * The revision to compare against. A named branch is tried as a local branch
 * and then as `origin/<branch>`, since a fresh worktree often has the target
 * only as a remote-tracking ref. With no branch named, the form's own default
 * order applies (`main`, then `master`).
 */
async function resolveBaseRef(
	cwd: string,
	baseBranch: string | undefined
): Promise<{ branch: string; ref: string } | null> {
	const branches = baseBranch ? [baseBranch] : DEFAULT_BASE_BRANCHES;
	for (const branch of branches) {
		const ref = await firstResolvableRef(cwd, [branch, `origin/${branch}`]);
		if (ref) return { branch, ref };
	}
	return null;
}

/**
 * Draft a pull request title and body for the branch checked out at `cwd`.
 *
 * Throws only for an unclassified failure inside the model engine, which is a
 * bug (the task router reports it; see `runLocalTask`).
 */
export async function draftPullRequest(
	request: PullRequestDraftRequest
): Promise<PullRequestDraftResult> {
	const task = LOCAL_MODEL_TASKS[TASK_ID];

	// Answer `off` before reading the repository: a task that is switched off is
	// off whatever state the branch is in. Same resolver the router uses below.
	const assignment = resolveLocalModelAssignment(readLocalModelAssignments(), TASK_ID);
	if (assignment.type === 'off') {
		return fail(
			'off',
			`${task.label} is off. Assign it a local model or an endpoint in ${ASSIGNMENT_LOCATION}.`
		);
	}

	const { cwd } = request;
	const head = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
	if (head.exitCode !== 0) {
		return fail('git-failed', `${cwd} is not a git repository with a commit to draft from.`);
	}
	const sourceBranch = head.stdout.trim();

	const base = await resolveBaseRef(cwd, request.baseBranch);
	if (!base) {
		return fail(
			'git-failed',
			request.baseBranch
				? `The target branch "${request.baseBranch}" does not exist in this repository.`
				: `Could not find a target branch (tried ${DEFAULT_BASE_BRANCHES.join(', ')}). Name one.`
		);
	}

	const log = await execGit(
		[
			'log',
			'--oneline',
			'--no-decorate',
			'--no-color',
			`--max-count=${MAX_LOG_COMMITS}`,
			`${base.ref}..HEAD`,
		],
		cwd
	);
	if (log.exitCode !== 0) {
		return fail('git-failed', log.stderr.trim() || 'git log failed.');
	}
	if (log.stdout.trim() === '') {
		return fail(
			'no-changes',
			`${sourceBranch} has no commits that ${base.branch} does not have, so there is nothing to draft from.`
		);
	}

	// Three dots: what the branch changed since it left the target, which is
	// what the pull request will show, not what the target did in the meantime.
	const stat = await execGit(
		['diff', '--stat', '--stat-width=120', '--no-color', `${base.ref}...HEAD`],
		cwd
	);
	if (stat.exitCode !== 0) {
		return fail('git-failed', stat.stderr.trim() || 'git diff failed.');
	}

	const input = formatPullRequestDraftInput({
		sourceBranch,
		baseBranch: base.branch,
		commits: log.stdout,
		diffStat: stat.stdout,
	});

	const verdict = await runLocalTask(TASK_ID, {
		system: getPrompt('git-draft-pr-local'),
		prompt: input.prompt,
		maxTokens: GIT_DRAFT_MAX_TOKENS,
		jsonSchema: GIT_DRAFT_PR_REPLY_SCHEMA,
		signal: AbortSignal.timeout(GIT_DRAFT_TIMEOUT_MS),
	});

	switch (verdict.status) {
		case 'off':
			// The assignment changed between the check above and the call.
			return fail(
				'off',
				`${task.label} is off. Assign it a local model or an endpoint in ${ASSIGNMENT_LOCATION}.`
			);
		case 'use-utility-agent':
			// The registry refuses this assignment for the task; a hand-edited
			// settings file is the only way here. There is no agent path to keep.
			return fail(
				'unavailable',
				`${task.label} cannot run on the Utility Agent. Assign it a local model or an endpoint in ${ASSIGNMENT_LOCATION}.`
			);
		case 'cancelled':
			logger.warn('Pull request draft timed out', LOG_CONTEXT, { source: verdict.source });
			return fail('cancelled', 'The assigned model took too long to answer. Try again.');
		case 'unavailable':
			logger.warn('Pull request draft skipped: assigned model unavailable', LOG_CONTEXT, {
				source: verdict.source,
				code: verdict.code,
				reason: verdict.reason,
			});
			return fail('unavailable', verdict.reason);
		case 'ok': {
			const producedBy =
				localModelAssignmentSourceLabel(verdict.source, getConfiguredLocalModelEndpoints()) ??
				undefined;
			const draft = parsePullRequestDraftReply(verdict.json);
			if (!draft) {
				logger.warn('Assigned model returned no usable pull request draft', LOG_CONTEXT, {
					source: verdict.source,
					responseLength: verdict.text.length,
				});
				return fail(
					'unusable',
					'The model did not return a usable title. Try again, or assign a larger model.',
					producedBy
				);
			}
			logger.info('Pull request draft ready', LOG_CONTEXT, {
				source: verdict.source,
				durationMs: verdict.durationMs,
				commitCount: input.commitCount,
				truncated: input.truncated,
			});
			return {
				success: true,
				...draft,
				baseBranch: base.branch,
				commitCount: input.commitCount,
				truncated: input.truncated,
				...(producedBy && { producedBy }),
			};
		}
	}
}

/**
 * The transport-facing entry: IPC (`localModels:draftPullRequest`) and the CLI
 * bridge (`maestro-cli models run git-drafts --cwd`) hand over an untrusted
 * value, checked here once for both.
 */
export async function draftPullRequestRequest(value: unknown): Promise<PullRequestDraftResult> {
	return draftPullRequest(parsePullRequestDraftRequest(value));
}
