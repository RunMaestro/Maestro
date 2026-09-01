/**
 * Worktree checkpoints - the shared vocabulary.
 *
 * A checkpoint is a snapshot of one working tree that the user can return to:
 * staged state, unstaged edits, untracked files, and optionally ignored files.
 * It is stored as REAL GIT OBJECTS under `refs/maestro/checkpoints/<id>` rather
 * than as a shadow copy of the tree. That choice is the whole design:
 *
 * - A ref keeps its objects alive through `git gc`, so a checkpoint cannot rot.
 * - Objects are deduplicated against the repo's existing history, so a
 *   checkpoint of a large repo costs the delta, not another full copy on disk.
 * - It stays in sync with plain git. A parallel directory tree desynchronizes
 *   the moment the user runs `git checkout` themselves, which they will.
 *
 * This module is deliberately I/O free so both processes and the test suite can
 * use it: `src/main/git/checkpoints.ts` runs the git commands, the CLI and the
 * renderer both render what comes back.
 *
 * ## Why two trees per checkpoint
 *
 * Restoring has to reproduce the tree AND the staging area the user had. A
 * single tree cannot: everything in a tree is, by definition, tracked, so
 * restoring from one alone would leave the user's untracked `.env` sitting in
 * the index as a staged addition. So a checkpoint records:
 *
 * - `treeSha` - everything on disk (tracked + untracked, + ignored on request)
 * - `indexTreeSha` - only what was actually staged at checkpoint time
 *
 * Restore writes the first to disk, then rewinds the index to the second, which
 * leaves previously-untracked files present but untracked, exactly as they were.
 */

/** Ref namespace all checkpoints live under. */
export const CHECKPOINT_REF_PREFIX = 'refs/maestro/checkpoints';

/**
 * Bumped when the trailer set changes shape. A checkpoint written by a newer
 * build is skipped by an older one rather than half-parsed into a restore that
 * silently drops part of the tree.
 */
export const CHECKPOINT_FORMAT_VERSION = 1;

/** Trailer keys written into the checkpoint commit message. */
export const CHECKPOINT_TRAILERS = {
	version: 'Maestro-Checkpoint-Version',
	id: 'Maestro-Checkpoint-Id',
	indexTree: 'Maestro-Checkpoint-Index-Tree',
	head: 'Maestro-Checkpoint-Head',
	branch: 'Maestro-Checkpoint-Branch',
	worktree: 'Maestro-Checkpoint-Worktree',
	includesIgnored: 'Maestro-Checkpoint-Includes-Ignored',
	origin: 'Maestro-Checkpoint-Origin',
	created: 'Maestro-Checkpoint-Created',
} as const;

/**
 * What caused a checkpoint to exist. Surfaced in the UI because the three read
 * very differently to someone scanning the list: one they took, one Auto Run
 * took at a task boundary, and one Maestro took to make a restore undoable.
 */
export type CheckpointOrigin = 'manual' | 'auto-run' | 'pre-restore';

export interface GitCheckpoint {
	/** Stable id, also the last segment of the ref. */
	id: string;
	/** User-supplied label, or a generated one. The commit subject. */
	label: string;
	/** The checkpoint commit itself. */
	commitSha: string;
	/** Tree holding the full working-tree snapshot. */
	treeSha: string;
	/** Tree holding the staged-only snapshot. See the note at the top of this file. */
	indexTreeSha: string;
	/** HEAD at checkpoint time, or null in a repo with no commits yet. */
	headSha: string | null;
	/** Branch checked out at checkpoint time, or null when detached. */
	branch: string | null;
	/** Absolute path of the working tree this snapshot came from. */
	worktreePath: string;
	/** Whether `.gitignore`d files were captured too. */
	includesIgnored: boolean;
	origin: CheckpointOrigin;
	/**
	 * Creation time, epoch milliseconds.
	 *
	 * Read from the checkpoint's own trailer, not from the commit date. Git
	 * stores commit timestamps in whole SECONDS, so two checkpoints taken in the
	 * same second - an Auto Run boundary snapshot and a manual one, or two quick
	 * tasks - tie, and a newest-first sort then falls back to whatever order
	 * `for-each-ref` happened to emit. The commit date is still the fallback for
	 * a ref missing the trailer.
	 */
	createdAt: number;
}

export interface CreateCheckpointOptions {
	/** Label shown in the list. Falls back to a timestamped default. */
	label?: string;
	/**
	 * Capture `.gitignore`d files too. Off by default: a repo's ignored set is
	 * usually `node_modules` and build output, and snapshotting hundreds of
	 * thousands of objects to protect them is the disk problem this design
	 * exists to avoid. Turn it on for a tree whose ignored files are state
	 * rather than derivable output - a `.env`, a local database.
	 */
	includeIgnored?: boolean;
	origin?: CheckpointOrigin;
}

export interface CheckpointResult {
	success: boolean;
	checkpoint?: GitCheckpoint;
	error?: string;
}

export interface CheckpointListResult {
	success: boolean;
	checkpoints: GitCheckpoint[];
	error?: string;
}

export interface RestoreCheckpointResult {
	success: boolean;
	/**
	 * The safety checkpoint taken immediately before the restore overwrote
	 * anything, so the restore itself can be undone. Absent only when the
	 * caller explicitly opted out.
	 */
	safetyCheckpoint?: GitCheckpoint;
	error?: string;
}

export interface DeleteCheckpointResult {
	success: boolean;
	error?: string;
}

/** Full ref path for a checkpoint id. */
export function checkpointRef(id: string): string {
	return `${CHECKPOINT_REF_PREFIX}/${id}`;
}

/**
 * Ids become ref path segments, so they have to survive `git check-ref-format`.
 * Generated ids are already safe; this exists to reject a hand-passed one from
 * the CLI before it reaches git, where the failure would surface as a raw
 * "not a valid ref name" the user cannot act on.
 */
export function isValidCheckpointId(id: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && !id.includes('..') && !id.endsWith('.');
}

/**
 * Build a checkpoint id from a timestamp plus a random tail.
 *
 * Sortable-by-name is the point: `git for-each-ref` sorts lexically, so a
 * leading timestamp means the ref listing is already in creation order without
 * a second pass to read every commit's date. The random tail breaks ties
 * between two checkpoints taken inside the same second (an Auto Run boundary
 * checkpoint and a manual one can collide easily).
 */
export function buildCheckpointId(timestampMs: number, randomTail: string): string {
	const stamp = new Date(timestampMs)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d+Z$/, 'Z');
	return `${stamp}-${randomTail}`;
}

/** Default label for a checkpoint the user did not name. */
export function defaultCheckpointLabel(timestampMs: number): string {
	const d = new Date(timestampMs);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `Checkpoint ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * A label becomes a commit subject, so it must stay on one line. Newlines would
 * push the rest of the label into the commit BODY, where the trailer parser
 * would then read the user's prose as malformed trailers.
 */
export function sanitizeCheckpointLabel(label: string): string {
	return label.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export interface CheckpointCommitMessageInput {
	label: string;
	id: string;
	/** Epoch milliseconds. See `GitCheckpoint.createdAt` for why this is stored. */
	createdAt: number;
	indexTreeSha: string;
	headSha: string | null;
	branch: string | null;
	worktreePath: string;
	includesIgnored: boolean;
	origin: CheckpointOrigin;
}

/**
 * Render the checkpoint commit message: subject line, blank line, trailers.
 *
 * The metadata lives in the commit rather than in a sidecar JSON file so that a
 * checkpoint is exactly one thing - a git object graph rooted at a ref. A
 * sidecar would be a second source of truth to keep in sync, and it would go
 * stale the instant someone deleted the ref with plain git.
 */
export function formatCheckpointCommitMessage(input: CheckpointCommitMessageInput): string {
	const t = CHECKPOINT_TRAILERS;
	const lines = [
		`${t.version}: ${CHECKPOINT_FORMAT_VERSION}`,
		`${t.id}: ${input.id}`,
		`${t.indexTree}: ${input.indexTreeSha}`,
		`${t.head}: ${input.headSha ?? ''}`,
		`${t.branch}: ${input.branch ?? ''}`,
		`${t.worktree}: ${input.worktreePath}`,
		`${t.includesIgnored}: ${input.includesIgnored ? 'true' : 'false'}`,
		`${t.origin}: ${input.origin}`,
		`${t.created}: ${input.createdAt}`,
	];
	return `${sanitizeCheckpointLabel(input.label)}\n\n${lines.join('\n')}\n`;
}

/**
 * Extract a single trailer value from a commit message.
 *
 * Scans the BODY only - everything after the first blank line. The subject is
 * the user's (or an agent's) free-text label, so it can contain anything,
 * including a line that looks exactly like a trailer. Reading from line 0 would
 * let a checkpoint named `Maestro-Checkpoint-Origin: auto-run` mislabel itself,
 * and the same trick against `Maestro-Checkpoint-Index-Tree` would point a
 * restore's index rewind at an attacker-chosen tree.
 */
function readTrailer(message: string, key: string): string | undefined {
	const separator = message.indexOf('\n\n');
	if (separator === -1) return undefined;
	const body = message.slice(separator + 2);
	for (const line of body.split('\n')) {
		const idx = line.indexOf(':');
		if (idx === -1) continue;
		if (line.slice(0, idx).trim() !== key) continue;
		return line.slice(idx + 1).trim();
	}
	return undefined;
}

export interface ParseCheckpointInput {
	/** Ref name, full or just the trailing id segment. */
	ref: string;
	commitSha: string;
	treeSha: string;
	/** Full commit message (subject + body). */
	message: string;
	/** Commit timestamp in epoch SECONDS, as git reports it. */
	committedAtSeconds: number;
}

/**
 * Turn one `for-each-ref` row into a checkpoint, or null if it isn't one.
 *
 * Returning null rather than throwing is deliberate: the namespace is plain
 * git, so anything can put a ref there, and one unreadable ref must not take
 * down the whole listing.
 */
export function parseCheckpointRef(input: ParseCheckpointInput): GitCheckpoint | null {
	const version = Number(readTrailer(input.message, CHECKPOINT_TRAILERS.version));
	// A newer format is skipped, not guessed at. Half-reading a checkpoint whose
	// trailer set changed would produce a restore that silently drops part of
	// the tree, which is worse than not offering the restore at all.
	if (!Number.isFinite(version) || version > CHECKPOINT_FORMAT_VERSION) return null;

	const indexTreeSha = readTrailer(input.message, CHECKPOINT_TRAILERS.indexTree);
	// Without the index tree there is no way to put the staging area back, so
	// the checkpoint cannot be restored faithfully and does not belong in a list
	// of things offered as restorable.
	if (!indexTreeSha) return null;

	const id =
		readTrailer(input.message, CHECKPOINT_TRAILERS.id) ||
		input.ref.slice(input.ref.lastIndexOf('/') + 1);
	if (!id) return null;

	const head = readTrailer(input.message, CHECKPOINT_TRAILERS.head);
	const branch = readTrailer(input.message, CHECKPOINT_TRAILERS.branch);
	const origin = readTrailer(input.message, CHECKPOINT_TRAILERS.origin);

	return {
		id,
		label: input.message.split('\n', 1)[0]?.trim() || id,
		commitSha: input.commitSha,
		treeSha: input.treeSha,
		indexTreeSha,
		headSha: head ? head : null,
		branch: branch ? branch : null,
		worktreePath: readTrailer(input.message, CHECKPOINT_TRAILERS.worktree) || '',
		includesIgnored: readTrailer(input.message, CHECKPOINT_TRAILERS.includesIgnored) === 'true',
		origin: isCheckpointOrigin(origin) ? origin : 'manual',
		createdAt: readCreatedAt(input),
	};
}

/**
 * Millisecond creation time, falling back to the commit's whole-second date.
 *
 * The fallback keeps a ref written without the trailer listable rather than
 * dropping it - the ordering within one second degrades, which is far better
 * than a checkpoint the user cannot see or restore.
 */
function readCreatedAt(input: ParseCheckpointInput): number {
	const stamp = Number(readTrailer(input.message, CHECKPOINT_TRAILERS.created));
	if (Number.isFinite(stamp) && stamp > 0) return stamp;
	return input.committedAtSeconds * 1000;
}

function isCheckpointOrigin(value: string | undefined): value is CheckpointOrigin {
	return value === 'manual' || value === 'auto-run' || value === 'pre-restore';
}

/**
 * Narrow a list to the checkpoints belonging to one working tree.
 *
 * Refs are shared across every worktree of a repo (only HEAD is per-worktree),
 * so an unfiltered listing shows every sibling worktree's snapshots too.
 * Offering those for restore would be actively dangerous - they describe a tree
 * that isn't the one on screen.
 */
export function filterCheckpointsForWorktree(
	checkpoints: GitCheckpoint[],
	worktreePath: string
): GitCheckpoint[] {
	const target = normalizeWorktreePath(worktreePath);
	return checkpoints.filter((c) => normalizeWorktreePath(c.worktreePath) === target);
}

/**
 * Compare worktree paths without caring about a trailing separator or the
 * case-insensitivity of Windows and macOS filesystems. `git rev-parse
 * --show-toplevel` and a session's stored `cwd` routinely differ on exactly
 * those, and a mismatch here hides every checkpoint the user just took.
 */
export function normalizeWorktreePath(p: string): string {
	return p
		.replace(/[\\/]+$/, '')
		.replace(/\\/g, '/')
		.toLowerCase();
}

/** Human-readable one-liner for CLI list output and UI subtitles. */
export function describeCheckpointOrigin(origin: CheckpointOrigin): string {
	switch (origin) {
		case 'auto-run':
			return 'Auto Run';
		case 'pre-restore':
			return 'Before restore';
		default:
			return 'Manual';
	}
}
