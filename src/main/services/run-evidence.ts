/**
 * Disk evidence for a playbook run: snapshot the agent's folder at run start, snapshot it again
 * at run end, and diff the two into `DiskEvidence` (tier B of the run report, see
 * `src/shared/playbookRunReport.ts`). The snapshot shapes and the diffs are pure and live in
 * `src/shared/runEvidence.ts`; this module runs git and reads the file system.
 *
 * Both Auto Run engines call it, so both produce the same shape: the desktop through the
 * `autorun:evidenceStart` / `autorun:evidenceEnd` IPC pair (`src/main/ipc/handlers/autorun.ts`,
 * git SSH-aware through `execGitReadOnly`), and the CLI engine through its environment port
 * (`src/cli/services/autorun-cli-deps.ts`, local git). Nothing here imports Electron.
 *
 * Evidence is best effort. A folder git cannot read, a remote that is not a repository (the
 * mtime scan is local only), or a git command that fails all answer `null`, never an error: a
 * run report without a "Files changed" section is still a report.
 */

import { promises as fs, type Dirent } from 'fs';
import path from 'path';
import { execFileNoThrow, type ExecResult } from '../../shared/maestro-lib/launch/exec-file';
import type { DiskEvidence } from '../../shared/playbookRunReport';
import {
	GIT_EMPTY_TREE,
	RUN_EVIDENCE_MTIME_MAX_DEPTH,
	RUN_EVIDENCE_MTIME_MAX_ENTRIES,
	RUN_EVIDENCE_SKIPPED_DIRS,
	buildGitChanges,
	diffGitChanges,
	diffMtimeSnapshots,
	mtimePathsToConfirm,
	pairHashes,
	parseGitNameStatusZ,
	pathsToHash,
	splitNulFields,
	type GitRunEvidenceSnapshot,
	type MtimeRunEvidenceSnapshot,
	type RunEvidenceGitChanges,
	type RunEvidenceGitStatus,
	type RunEvidenceSnapshot,
} from '../../shared/runEvidence';

/** Per git command budget. A run waits on these twice, so they stay short. */
export const RUN_EVIDENCE_GIT_TIMEOUT_MS = 20_000;

/** Run one git command in the agent's folder (locally or over SSH) and report how it went. */
export type RunEvidenceGitRunner = (args: string[]) => Promise<ExecResult>;

/** Where a snapshot is taken. */
export interface RunEvidenceHost {
	/** The agent's folder: a local path, or the remote path for an SSH agent. */
	cwd: string;
	git: RunEvidenceGitRunner;
	/**
	 * Whether the folder is on this machine. The mtime fallback reads the local file system, so
	 * a remote folder that is not a git repository has no evidence.
	 */
	local: boolean;
	/** Epoch ms. Injected for tests. */
	now?: () => number;
}

/**
 * Variables that point git at a repository other than the one `cwd` is in. Git exports them to
 * hooks (from a linked worktree that includes `GIT_DIR`), so a CLI run started from one would
 * otherwise read the hook's repository instead of the agent's folder.
 */
const REPOSITORY_LOCATION_ENV_VARS = [
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_INDEX_FILE',
	'GIT_COMMON_DIR',
	'GIT_OBJECT_DIRECTORY',
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_PREFIX',
] as const;

/**
 * A git runner for a folder on this machine: it reads the repository `cwd` is in, whatever the
 * inherited environment says, and takes no optional locks so it never fights the agent's git.
 */
export function createLocalGitRunner(cwd: string): RunEvidenceGitRunner {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
	for (const name of REPOSITORY_LOCATION_ENV_VARS) delete env[name];
	return (args) => execFileNoThrow('git', args, cwd, { env, timeout: RUN_EVIDENCE_GIT_TIMEOUT_MS });
}

const succeeded = (result: ExecResult): boolean => result.exitCode === 0;

async function isGitWorkTree(git: RunEvidenceGitRunner): Promise<boolean> {
	const result = await git(['rev-parse', '--is-inside-work-tree']);
	return succeeded(result) && result.stdout.trim() === 'true';
}

/**
 * Every path that differs from `base`, relative to the folder: tracked changes (staged or not,
 * committed since `base` or not) plus untracked files that are not ignored. `null` when git fails.
 */
async function readGitStatuses(
	git: RunEvidenceGitRunner,
	base: string
): Promise<Record<string, RunEvidenceGitStatus> | null> {
	const [diff, untracked] = await Promise.all([
		git(['diff', '--name-status', '--no-renames', '--relative', '-z', base, '--']),
		git(['ls-files', '--others', '--exclude-standard', '-z']),
	]);
	if (!succeeded(diff) || !succeeded(untracked)) return null;
	const statuses = parseGitNameStatusZ(diff.stdout);
	for (const file of splitNulFields(untracked.stdout)) statuses[file] = 'A';
	return statuses;
}

/** Content hashes for `paths`; empty when there is nothing to hash or git fails. */
async function hashPaths(
	git: RunEvidenceGitRunner,
	paths: string[]
): Promise<Record<string, string>> {
	if (paths.length === 0) return {};
	const result = await git(['hash-object', '--', ...paths]);
	return succeeded(result) ? pairHashes(paths, result.stdout) : {};
}

async function startGitSnapshot(
	git: RunEvidenceGitRunner,
	takenAt: number
): Promise<GitRunEvidenceSnapshot | null> {
	const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
	// No commit yet: everything in the folder is new against the empty tree.
	const base = succeeded(head) && head.stdout.trim() ? head.stdout.trim() : GIT_EMPTY_TREE;
	const statuses = await readGitStatuses(git, base);
	if (!statuses) return null;
	const hashes = await hashPaths(git, pathsToHash(statuses));
	return { source: 'git', takenAt, base, changes: buildGitChanges(statuses, hashes) };
}

async function finishGitEvidence(
	git: RunEvidenceGitRunner,
	start: GitRunEvidenceSnapshot
): Promise<DiskEvidence | null> {
	const [statuses, branchResult] = await Promise.all([
		readGitStatuses(git, start.base),
		git(['rev-parse', '--abbrev-ref', 'HEAD']),
	]);
	if (!statuses) return null;
	// Only a path that was dirty at both ends needs its content compared.
	const overlapping = pathsToHash(
		Object.fromEntries(
			Object.entries(statuses).filter(([file, status]) => start.changes[file]?.status === status)
		)
	).filter((file) => start.changes[file]?.hash);
	const end: RunEvidenceGitChanges = buildGitChanges(statuses, await hashPaths(git, overlapping));
	const branch = succeeded(branchResult) ? branchResult.stdout.trim() : '';
	return {
		source: 'git',
		...diffGitChanges(start.changes, end),
		// `HEAD` is git's answer for a detached checkout: there is no branch.
		...(branch && branch !== 'HEAD' ? { branch } : {}),
	};
}

/**
 * List files under `root` by modification time: breadth first, names sorted, at most
 * {@link RUN_EVIDENCE_MTIME_MAX_DEPTH} levels and {@link RUN_EVIDENCE_MTIME_MAX_ENTRIES} files,
 * never entering {@link RUN_EVIDENCE_SKIPPED_DIRS} or following a symlink. The same folder
 * always yields the same walk order, so two scans of an unchanged folder match.
 */
export async function scanMtimeSnapshot(
	root: string,
	takenAt: number
): Promise<MtimeRunEvidenceSnapshot | null> {
	const files: Record<string, number> = {};
	let count = 0;
	let level: string[] = [''];
	for (let depth = 1; depth <= RUN_EVIDENCE_MTIME_MAX_DEPTH && level.length > 0; depth++) {
		const next: string[] = [];
		for (const relativeDir of level) {
			let entries: Dirent[];
			try {
				entries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true });
			} catch {
				// The root itself must be readable; a subfolder that vanished or is locked is skipped.
				if (relativeDir === '') return null;
				continue;
			}
			entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			for (const entry of entries) {
				const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					if (!RUN_EVIDENCE_SKIPPED_DIRS.includes(entry.name)) next.push(relative);
					continue;
				}
				if (!entry.isFile()) continue;
				if (count >= RUN_EVIDENCE_MTIME_MAX_ENTRIES) {
					return { source: 'mtime', takenAt, files, truncated: true };
				}
				try {
					const stat = await fs.stat(path.join(root, relative));
					files[relative] = stat.mtimeMs;
					count++;
				} catch {
					// Gone between the listing and the stat: it is not part of this snapshot.
				}
			}
		}
		level = next;
	}
	return { source: 'mtime', takenAt, files, truncated: false };
}

async function finishMtimeEvidence(
	root: string,
	start: MtimeRunEvidenceSnapshot,
	takenAt: number
): Promise<DiskEvidence | null> {
	const end = await scanMtimeSnapshot(root, takenAt);
	if (!end) return null;
	// A truncated end scan can miss a file that is still there; only the disk can say.
	const stillPresent = new Set<string>();
	for (const file of mtimePathsToConfirm(start, end)) {
		try {
			await fs.stat(path.join(root, file));
			stillPresent.add(file);
		} catch {
			// Not there: a real deletion.
		}
	}
	return { source: 'mtime', ...diffMtimeSnapshots(start, end, stillPresent) };
}

/**
 * Snapshot the folder at run start: git when it is a work tree, otherwise (for a local folder)
 * an mtime scan. `null` when there is nothing to compare against later.
 */
export async function startRunEvidence(host: RunEvidenceHost): Promise<RunEvidenceSnapshot | null> {
	const takenAt = (host.now ?? Date.now)();
	if (await isGitWorkTree(host.git)) return startGitSnapshot(host.git, takenAt);
	return host.local ? scanMtimeSnapshot(host.cwd, takenAt) : null;
}

/** Diff the folder at run end against the start snapshot. `null` when it cannot be read. */
export async function finishRunEvidence(
	host: RunEvidenceHost,
	start: RunEvidenceSnapshot
): Promise<DiskEvidence | null> {
	if (start.source === 'git') return finishGitEvidence(host.git, start);
	if (!host.local) return null;
	return finishMtimeEvidence(host.cwd, start, (host.now ?? Date.now)());
}
