/**
 * @file branch-switch-guard.ts
 * @description Refuses a branch switch while something depends on the working tree.
 *
 * A checkout rewrites every file that differs between the two branches. Two kinds
 * of work read those files while they run, and break when the files change under
 * them:
 *
 * - A push or pull Maestro started. The pre-push hook validates the WORKING TREE,
 *   not the commit it pushes. On 2026-10-03 a branch switch mid-push deleted ~130
 *   files that only main had, Prettier hit ENOENT on each, and the push failed.
 *   A switch that happens to pass is worse: it validates the other branch's files.
 * - An agent running a turn there. It reads and edits files of one branch, then
 *   finds itself on another.
 *
 * Scope is the git working tree, not the agent. Worktrees have their own trees, so
 * an agent busy in a worktree does not block a switch in the main checkout.
 *
 * This guards branch switches Maestro performs. A `git checkout` typed in a shell
 * does not pass through here.
 */

import fs from 'fs/promises';
import path from 'path';
import { execGit } from './remote-git';
import type { SshRemoteConfig } from '../../shared/types';

/** Minimal slice of a ManagedProcess this module reads. */
export interface WorkTreeProcess {
	sessionId: string;
	cwd: string;
	isTerminal: boolean;
	projectPath?: string;
	sshRemoteId?: string;
}

/** Minimal slice of ProcessManager this module reads. */
export interface WorkTreeProcessSource {
	getAll(): WorkTreeProcess[];
}

export interface BranchSwitchGuardDeps {
	getProcessManager?: () => WorkTreeProcessSource | null | undefined;
	/** Agent name for an agent id, so the refusal can say who is working. */
	getAgentName?: (agentId: string) => string | undefined;
}

/** In-flight push/pull runs, keyed by work tree (see `workTreeKey`). */
const remoteSyncsInFlight = new Map<string, { operation: string; count: number }>();

function workTreeKey(sshRemoteId: string | undefined, root: string): string {
	return `${sshRemoteId ?? 'local'}:${root}`;
}

/** Top directory of the git work tree that holds `dir`, or null if none. */
async function resolveWorkTreeRoot(
	dir: string,
	sshRemote?: SshRemoteConfig | null
): Promise<string | null> {
	const result = await execGit(
		['rev-parse', '--show-toplevel'],
		dir,
		sshRemote,
		sshRemote ? dir : undefined
	);
	if (result.exitCode !== 0) return null;
	const root = result.stdout.trim();
	return root || null;
}

/**
 * Mark a push/pull as running in the work tree that holds `cwd` until the
 * returned release function is called. Call release in a `finally`.
 */
export async function beginRemoteSync(
	operation: string,
	cwd: string,
	sshRemote?: SshRemoteConfig | null,
	remoteCwd?: string
): Promise<() => void> {
	const root = await resolveWorkTreeRoot(sshRemote ? remoteCwd || cwd : cwd, sshRemote);
	if (!root) return () => {};
	const key = workTreeKey(sshRemote?.id, root);
	const entry = remoteSyncsInFlight.get(key);
	if (entry) entry.count += 1;
	else remoteSyncsInFlight.set(key, { operation, count: 1 });

	let released = false;
	return () => {
		if (released) return;
		released = true;
		const current = remoteSyncsInFlight.get(key);
		if (!current) return;
		current.count -= 1;
		if (current.count <= 0) remoteSyncsInFlight.delete(key);
	};
}

function isWithin(child: string, parent: string, pathMod: typeof path.posix): boolean {
	const rel = pathMod.relative(parent, child);
	return rel === '' || (!rel.startsWith('..') && !pathMod.isAbsolute(rel));
}

async function realpathOrSelf(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return p;
	}
}

/** `{agentId}-ai-{tabId}`, `{agentId}-batch-...`, etc. -> `{agentId}`. */
function agentIdFromProcessId(processId: string): string {
	const match = /^(.+?)-(?:ai|batch|cue|synopsis)(?:-|$)/.exec(processId);
	return match ? match[1] : processId;
}

/**
 * Why a branch switch in the work tree that holds `cwd` must not happen now,
 * or null when it is safe.
 */
export async function branchSwitchBlocker(
	deps: BranchSwitchGuardDeps,
	cwd: string,
	sshRemote?: SshRemoteConfig | null,
	remoteCwd?: string
): Promise<string | null> {
	const targetDir = sshRemote ? remoteCwd || cwd : cwd;
	const root = await resolveWorkTreeRoot(targetDir, sshRemote);
	// Not a repo: git checkout will fail with its own message.
	if (!root) return null;

	const sync = remoteSyncsInFlight.get(workTreeKey(sshRemote?.id, root));
	if (sync) {
		return `A git ${sync.operation} is running in this working tree. Wait for it to finish before you change branch.`;
	}

	const processes = deps.getProcessManager?.()?.getAll() ?? [];
	const pathMod = sshRemote ? path.posix : path;
	const localRoot = sshRemote ? root : await realpathOrSelf(root);
	const busyAgentIds = new Set<string>();
	for (const proc of processes) {
		// Shell tabs stay open whether or not anything runs in them.
		if (proc.isTerminal) continue;
		if ((proc.sshRemoteId ?? undefined) !== (sshRemote?.id ?? undefined)) continue;
		const agentDir = proc.projectPath || proc.cwd;
		if (!agentDir) continue;
		const dir = sshRemote ? agentDir : await realpathOrSelf(agentDir);
		if (!isWithin(dir, localRoot, pathMod)) continue;
		// A worktree nested inside the repo is its own work tree.
		if (dir !== localRoot) {
			const procRoot = await resolveWorkTreeRoot(dir, sshRemote);
			if (procRoot && (sshRemote ? procRoot : await realpathOrSelf(procRoot)) !== localRoot) {
				continue;
			}
		}
		busyAgentIds.add(agentIdFromProcessId(proc.sessionId));
	}
	if (busyAgentIds.size === 0) return null;

	const names = [...busyAgentIds].map((id) => deps.getAgentName?.(id) || 'an agent');
	const unique = [...new Set(names)];
	const who =
		unique.length === 1
			? unique[0]
			: `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
	const running = unique.length === 1 ? 'has a turn running' : 'have turns running';
	const sentence = `${who} ${running} in this working tree. Wait for it to finish before you change branch.`;
	return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Test-only: forget every in-flight push/pull. */
export function __resetBranchSwitchGuardForTests(): void {
	remoteSyncsInFlight.clear();
}
