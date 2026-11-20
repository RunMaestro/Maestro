/**
 * Git drafts: shared, process-agnostic pieces.
 *
 * The `git-drafts` Local Models task writes a pull request title and body from
 * what a branch changed. The model reads a SUMMARY of the branch (its commit
 * subjects and `git diff --stat`), never the diff itself: a local model's whole
 * context is a few thousand tokens, and a real diff does not fit in it.
 *
 * Everything here is pure string work with no Electron, Node, or DOM
 * dependency: the reply contract, the caps that keep the summary inside a small
 * context, and the result shape that travels over IPC and the CLI bridge. The
 * git reads and the model call are main-process only
 * (`src/main/local-models/git-drafts.ts`).
 *
 * A draft only ever FILLS fields. Nothing in this feature creates a pull
 * request or a commit; the person reviews the text and presses the button.
 */

/** Longest pull request title a draft may fill, before ellipsis. */
export const GIT_DRAFT_TITLE_MAX_LENGTH = 100;

/** Longest pull request body a draft may fill. */
export const GIT_DRAFT_BODY_MAX_LENGTH = 4000;

/**
 * Caps on the branch summary handed to the model. Counted in lines AND in
 * characters, because a line of file path is several tokens: both blocks at
 * their cap come to roughly 1,600 tokens, which leaves a 4,096 token local
 * context room for the instructions and the reply.
 */
export const GIT_DRAFT_COMMIT_CAPS: GitDraftLineCaps = Object.freeze({
	maxLines: 40,
	maxChars: 2400,
	maxLineLength: 160,
});
export const GIT_DRAFT_STAT_CAPS: GitDraftLineCaps = Object.freeze({
	maxLines: 60,
	maxChars: 2400,
	maxLineLength: 120,
});

export interface GitDraftLineCaps {
	maxLines: number;
	maxChars: number;
	maxLineLength: number;
}

/** A pull request draft, cleaned up and ready to put in the form. */
export interface PullRequestDraft {
	title: string;
	body: string;
}

/**
 * The reply shape `git-draft-pr-local.md` asks for. `title` comes first so a
 * reply cut off at the token budget loses the end of the body, not the title.
 */
export const GIT_DRAFT_PR_REPLY_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		title: { type: 'string', maxLength: GIT_DRAFT_TITLE_MAX_LENGTH },
		body: { type: 'string' },
	},
	required: ['title', 'body'],
	additionalProperties: false,
};

/** What a caller sends. Crosses IPC and the CLI bridge, so it is validated in main. */
export interface PullRequestDraftRequest {
	/** The LOCAL repository (or worktree) the pull request is opened from. */
	cwd: string;
	/** The branch the pull request targets. Omitted: the repository default. */
	baseBranch?: string;
}

/**
 * Why a draft produced no text.
 *
 * - `off`          - the task is switched off; the affordance should be hidden.
 * - `unavailable`  - the assigned model or endpoint could not run.
 * - `no-changes`   - the branch has no commits the base does not have.
 * - `git-failed`   - not a repository, an unknown base branch, or git failed.
 * - `unusable`     - the model answered, but not with a title.
 * - `cancelled`    - the draft timed out.
 */
export type PullRequestDraftFailure =
	| 'off'
	| 'unavailable'
	| 'no-changes'
	| 'git-failed'
	| 'unusable'
	| 'cancelled';

export type PullRequestDraftResult =
	| {
			success: true;
			title: string;
			body: string;
			/** The branch the draft was compared against. */
			baseBranch: string;
			/** Commits on the branch that the base does not have. */
			commitCount: number;
			/** True when the commit list or the diff summary was cut to fit the model. */
			truncated: boolean;
			/** The local model or endpoint that wrote the draft, named for a person. */
			producedBy?: string;
	  }
	| {
			success: false;
			status: PullRequestDraftFailure;
			/** Written for a person. Shown beside the button and printed by the CLI. */
			error: string;
			producedBy?: string;
	  };

/** Flatten to one line and cap the length. */
function flattenToLine(value: string, maxLength: number): string {
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length > maxLength ? `${flat.slice(0, maxLength - 3).trimEnd()}...` : flat;
}

/**
 * Read a reply written against {@link GIT_DRAFT_PR_REPLY_SCHEMA}.
 *
 * `json` is the parsed reply when it parsed, else undefined. There is no
 * plain-text fallback: a reply that is not the object cannot be split into a
 * title and a body without guessing, and a guess would put half a sentence in
 * the title field. The schema keeps the SHAPE, not the content, so the title
 * is still cleaned: a small model wraps it in quotes or ends it with a period
 * often enough to matter.
 */
export function parsePullRequestDraftReply(json: unknown): PullRequestDraft | null {
	if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
	const record = json as Record<string, unknown>;
	if (typeof record.title !== 'string') return null;

	const title = flattenToLine(
		record.title
			.trim()
			.replace(/^["'`]+|["'`]+$/g, '')
			.replace(/\.$/, ''),
		GIT_DRAFT_TITLE_MAX_LENGTH
	);
	if (!title) return null;

	const rawBody = typeof record.body === 'string' ? record.body.replace(/\r\n/g, '\n').trim() : '';
	const body =
		rawBody.length > GIT_DRAFT_BODY_MAX_LENGTH
			? `${rawBody.slice(0, GIT_DRAFT_BODY_MAX_LENGTH - 3).trimEnd()}...`
			: rawBody;
	return { title, body };
}

/**
 * Keep the leading lines that fit the caps. Returns the kept lines and how many
 * were dropped, so the caller can say so in the text the model reads: a model
 * shown 40 of 300 commits must be told there are more, or it describes the
 * branch as only those 40.
 */
export function capDraftLines(
	lines: readonly string[],
	caps: GitDraftLineCaps
): { kept: string[]; dropped: number } {
	const kept: string[] = [];
	let chars = 0;
	for (const raw of lines) {
		if (kept.length >= caps.maxLines) break;
		const line =
			raw.length > caps.maxLineLength ? `${raw.slice(0, caps.maxLineLength - 3)}...` : raw;
		if (chars + line.length > caps.maxChars) break;
		kept.push(line);
		chars += line.length + 1;
	}
	return { kept, dropped: lines.length - kept.length };
}

function nonEmptyLines(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== '');
}

/** What the branch looks like, as git printed it. */
export interface PullRequestDraftInput {
	sourceBranch: string;
	baseBranch: string;
	/** `git log --oneline <base>..HEAD`, newest first. */
	commits: string;
	/** `git diff --stat <base>...HEAD`. */
	diffStat: string;
}

/**
 * Build the text the model reads (the user turn; the instructions are the
 * `git-draft-pr-local` prompt, sent as the system turn).
 *
 * The NEWEST commits are kept when the log is cut, and the diff summary's last
 * line (`12 files changed, 340 insertions(+), ...`) always survives: it is the
 * one line that still describes the whole change after the file list is cut.
 */
export function formatPullRequestDraftInput(input: PullRequestDraftInput): {
	prompt: string;
	commitCount: number;
	truncated: boolean;
} {
	const commitLines = nonEmptyLines(input.commits);
	const commits = capDraftLines(commitLines, GIT_DRAFT_COMMIT_CAPS);

	const statLines = nonEmptyLines(input.diffStat);
	// `git diff --stat` ends with the totals line whenever anything changed.
	const totals = statLines.length > 0 ? statLines[statLines.length - 1] : '';
	const files = capDraftLines(statLines.slice(0, -1), GIT_DRAFT_STAT_CAPS);

	const sections = [
		`Branch: ${flattenToLine(input.sourceBranch, 200)}`,
		`Target branch: ${flattenToLine(input.baseBranch, 200)}`,
		'',
		`Commits (${commitLines.length}, newest first):`,
		...commits.kept,
		...(commits.dropped > 0 ? [`... and ${commits.dropped} earlier commits not shown`] : []),
		'',
		'Files changed:',
		...files.kept,
		...(files.dropped > 0 ? [`... and ${files.dropped} more files not shown`] : []),
		...(totals ? [totals.trim()] : []),
	];

	return {
		prompt: sections.join('\n'),
		commitCount: commitLines.length,
		truncated: commits.dropped > 0 || files.dropped > 0,
	};
}
