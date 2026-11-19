/**
 * Tier B of a playbook run report: what changed on disk while the run worked.
 *
 * The capture is two snapshots of the agent's folder, one at run start and one at run end, and
 * a diff between them. This module is the pure half: the snapshot shapes (plain JSON, so a
 * snapshot can cross IPC and sit in the renderer for the length of a run), the parsers for the
 * git output a snapshot is built from, and the diffs that turn two snapshots into
 * {@link DiskEvidence}. Running git and reading the file system is done by
 * `src/main/services/run-evidence.ts`, which both the desktop (over IPC) and the CLI engine
 * (through its environment port) call, so both produce the same shape.
 *
 * Two sources:
 * - `git`: the folder is in a git work tree. A snapshot holds the commit the run started from
 *   and every path that differed from it (tracked changes plus untracked files), with a blob
 *   hash per path so a file that was already dirty at start and was edited again still counts.
 *   Committed work is covered too: the end snapshot diffs the working tree against the START
 *   commit, so a commit the agent made in between is part of the change.
 * - `mtime`: the folder is not a repository. A snapshot lists files by modification time,
 *   bounded by {@link RUN_EVIDENCE_MTIME_MAX_DEPTH} and {@link RUN_EVIDENCE_MTIME_MAX_ENTRIES}.
 */

import type { DiskEvidence } from './playbookRunReport';

/** Folder levels the mtime scan reads: the folder's own files are level 1. */
export const RUN_EVIDENCE_MTIME_MAX_DEPTH = 3;
/** Files the mtime scan records before it stops. */
export const RUN_EVIDENCE_MTIME_MAX_ENTRIES = 200;
/** Directory names the mtime scan never enters. */
export const RUN_EVIDENCE_SKIPPED_DIRS: readonly string[] = ['node_modules', '.git'];
/** Dirty paths whose content is hashed; past this, a path that stays dirty counts as unchanged. */
export const RUN_EVIDENCE_MAX_HASHED_PATHS = 200;
/** git's empty tree: the base of a repository with no commit yet. */
export const GIT_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** How a path differs from the run's start commit: added, modified, or deleted. */
export type RunEvidenceGitStatus = 'A' | 'M' | 'D';

export interface RunEvidenceGitChange {
	status: RunEvidenceGitStatus;
	/** The blob hash of the file's content; absent for a deletion or when it was not hashed. */
	hash?: string;
}

/** Path (relative to the agent's folder, `/` separated) to its change against `base`. */
export type RunEvidenceGitChanges = Record<string, RunEvidenceGitChange>;

export interface GitRunEvidenceSnapshot {
	source: 'git';
	/** Epoch ms. */
	takenAt: number;
	/** The commit the run started from, or {@link GIT_EMPTY_TREE} in a repository with none. */
	base: string;
	changes: RunEvidenceGitChanges;
}

export interface MtimeRunEvidenceSnapshot {
	source: 'mtime';
	/** Epoch ms. */
	takenAt: number;
	/** Path (relative, `/` separated) to modification time in epoch ms. */
	files: Record<string, number>;
	/** True when the scan stopped at {@link RUN_EVIDENCE_MTIME_MAX_ENTRIES}. */
	truncated: boolean;
}

export type RunEvidenceSnapshot = GitRunEvidenceSnapshot | MtimeRunEvidenceSnapshot;

type FileLists = Pick<DiskEvidence, 'changedFiles' | 'createdFiles' | 'deletedFiles'>;

const sorted = (paths: Iterable<string>): string[] => [...paths].sort();

/** Split NUL-terminated git output (`-z`) into its fields, dropping the empty tail. */
export function splitNulFields(stdout: string): string[] {
	return stdout.split('\0').filter((field) => field.length > 0);
}

/**
 * Parse `git diff --name-status --no-renames -z` into path and status. A type change (`T`), an
 * unmerged path (`U`), and anything else that is not an add or a delete count as modified.
 */
export function parseGitNameStatusZ(stdout: string): Record<string, RunEvidenceGitStatus> {
	const fields = splitNulFields(stdout);
	const result: Record<string, RunEvidenceGitStatus> = {};
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const code = fields[i].charAt(0);
		result[fields[i + 1]] = code === 'A' ? 'A' : code === 'D' ? 'D' : 'M';
	}
	return result;
}

/**
 * The paths whose content should be hashed: every path that exists (not a deletion), up to
 * {@link RUN_EVIDENCE_MAX_HASHED_PATHS}, in sorted order so start and end pick the same ones.
 */
export function pathsToHash(statuses: Record<string, RunEvidenceGitStatus>): string[] {
	return sorted(Object.keys(statuses))
		.filter((path) => statuses[path] !== 'D')
		.slice(0, RUN_EVIDENCE_MAX_HASHED_PATHS);
}

/**
 * Pair `git hash-object` output (one hash per line, in argument order) with its paths. Output
 * that does not line up with the paths is discarded whole: a misaligned hash is worse than none.
 */
export function pairHashes(paths: string[], stdout: string): Record<string, string> {
	const hashes = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (hashes.length !== paths.length) return {};
	const result: Record<string, string> = {};
	paths.forEach((path, index) => {
		result[path] = hashes[index].trim();
	});
	return result;
}

/** Combine statuses and hashes into the `changes` a git snapshot keeps. */
export function buildGitChanges(
	statuses: Record<string, RunEvidenceGitStatus>,
	hashes: Record<string, string>
): RunEvidenceGitChanges {
	const changes: RunEvidenceGitChanges = {};
	for (const [path, status] of Object.entries(statuses)) {
		const hash = hashes[path];
		changes[path] = hash ? { status, hash } : { status };
	}
	return changes;
}

/**
 * What the run did, from the paths that differed from the start commit at start and at end.
 *
 * - Only at end: the run made the difference. Added is created, deleted is deleted, else changed.
 * - Only at start: the run undid a difference, so the file is back to the start commit. An added
 *   file that is gone was deleted; a deleted file that is back was created; else changed.
 * - At both: unchanged when the status matches and the content hash matches (or either hash is
 *   unknown). Otherwise a deletion at end is deleted, a file that was deleted at start and now
 *   exists is created, and anything else changed.
 */
export function diffGitChanges(
	start: RunEvidenceGitChanges,
	end: RunEvidenceGitChanges
): FileLists {
	const changed = new Set<string>();
	const created = new Set<string>();
	const deleted = new Set<string>();
	for (const path of new Set([...Object.keys(start), ...Object.keys(end)])) {
		const before = start[path];
		const after = end[path];
		if (!before && after) {
			if (after.status === 'A') created.add(path);
			else if (after.status === 'D') deleted.add(path);
			else changed.add(path);
		} else if (before && !after) {
			if (before.status === 'A') deleted.add(path);
			else if (before.status === 'D') created.add(path);
			else changed.add(path);
		} else if (before && after) {
			if (before.status === after.status) {
				if (after.status === 'D') continue;
				if (!before.hash || !after.hash || before.hash === after.hash) continue;
				changed.add(path);
			} else if (after.status === 'D') deleted.add(path);
			else if (before.status === 'D') created.add(path);
			else changed.add(path);
		}
	}
	return {
		changedFiles: sorted(changed),
		createdFiles: sorted(created),
		deletedFiles: sorted(deleted),
	};
}

/**
 * What the run did, from two mtime scans.
 *
 * A file only in the end scan is created, unless the start scan was truncated and the file is
 * older than the start (it was there, past the cap). A file only in the start scan is deleted,
 * unless `stillPresent` names it (the end scan was truncated and the caller found it on disk).
 * A file in both with a different modification time changed.
 */
export function diffMtimeSnapshots(
	start: MtimeRunEvidenceSnapshot,
	end: MtimeRunEvidenceSnapshot,
	stillPresent: ReadonlySet<string> = new Set()
): FileLists {
	const changed: string[] = [];
	const created: string[] = [];
	const deleted: string[] = [];
	for (const [path, mtime] of Object.entries(end.files)) {
		const before = start.files[path];
		if (before === undefined) {
			if (!start.truncated || mtime >= start.takenAt) created.push(path);
		} else if (before !== mtime) {
			changed.push(path);
		}
	}
	for (const path of Object.keys(start.files)) {
		if (end.files[path] === undefined && !stillPresent.has(path)) deleted.push(path);
	}
	return {
		changedFiles: sorted(changed),
		createdFiles: sorted(created),
		deletedFiles: sorted(deleted),
	};
}

/** Start-scan paths missing from a truncated end scan: the ones a caller must check on disk. */
export function mtimePathsToConfirm(
	start: MtimeRunEvidenceSnapshot,
	end: MtimeRunEvidenceSnapshot
): string[] {
	if (!end.truncated) return [];
	return Object.keys(start.files).filter((path) => end.files[path] === undefined);
}

/** Whether an untyped value (an IPC argument) is a snapshot this module produced. */
export function isRunEvidenceSnapshot(value: unknown): value is RunEvidenceSnapshot {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<RunEvidenceSnapshot>;
	if (typeof candidate.takenAt !== 'number') return false;
	if (candidate.source === 'git') {
		const git = candidate as Partial<GitRunEvidenceSnapshot>;
		return typeof git.base === 'string' && !!git.changes && typeof git.changes === 'object';
	}
	if (candidate.source === 'mtime') {
		const mtime = candidate as Partial<MtimeRunEvidenceSnapshot>;
		return !!mtime.files && typeof mtime.files === 'object' && typeof mtime.truncated === 'boolean';
	}
	return false;
}
