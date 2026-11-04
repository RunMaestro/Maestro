import * as fs from 'fs/promises';
import * as path from 'path';
import { canonicalJson } from '../../shared/canonicalJson';
import { isSessionBusyWithCli } from '../../shared/cli-activity';
import type {
	WorktreePullRequestCleanupBlocker,
	WorktreePullRequestCleanupPreflightRequest,
} from '../../shared/worktreePullRequestCleanup';
import { getSessionsStore } from '../stores/getters';
import { branchSwitchBlocker, type BranchSwitchGuardDeps } from '../utils/branch-switch-guard';
import { getHeadlessAgentActivity } from '../utils/headless-agent-activity';
import { foldPathCase, isPathWithin } from '../utils/real-path-containment';

/**
 * Native evidence of consumers, never evidence of their complete absence.
 * The process table omits command-runner children; persisted tabs/idle state omit
 * unsaved renderer and web-client changes. No exclusion is acquired here.
 */
export async function inspectWorktreeCleanupConsumers(
	request: WorktreePullRequestCleanupPreflightRequest,
	deps: BranchSwitchGuardDeps = {}
): Promise<WorktreePullRequestCleanupBlocker[]> {
	const blockers: WorktreePullRequestCleanupBlocker[] = [];
	const block = (code: WorktreePullRequestCleanupBlocker['code'], message: string) =>
		blockers.push({ code, message });
	if (request.sshRemoteId)
		return [
			{ code: 'ssh-unsupported', message: 'Native cleanup inspection requires a local host.' },
		];
	try {
		// Resolve the source each time. A missing manager is never an empty table.
		const sample = () => {
			const source = deps.getProcessManager?.();
			if (!source) throw new Error('Native process registry is unavailable.');
			const sessions = getSessionsStore().get('sessions');
			const processes = source.getAll();
			if (
				!Array.isArray(sessions) ||
				sessions.some((s) => !s || typeof s.id !== 'string' || !s.id) ||
				new Set(sessions.map((s) => s.id)).size !== sessions.length ||
				!Array.isArray(processes) ||
				processes.some((p) => !p || typeof p.sessionId !== 'string')
			)
				throw new Error('Native consumer inventory is malformed.');
			// Copy before any await: sources may mutate their objects in place.
			const serialized = canonicalJson({
				sessions,
				processes: processes.map(({ sessionId, cwd, projectPath, sshRemoteId, isTerminal }) => ({
					sessionId,
					cwd,
					projectPath,
					sshRemoteId,
					isTerminal,
				})),
				headless: getHeadlessAgentActivity(),
			});
			return {
				serialized,
				data: JSON.parse(serialized) as {
					sessions: typeof sessions;
					processes: typeof processes;
					headless: ReturnType<typeof getHeadlessAgentActivity>;
				},
			};
		};
		const before = sample();
		if (!path.isAbsolute(request.worktreePath)) throw new Error('An absolute target is required.');
		const root = foldPathCase(await fs.realpath(request.worktreePath));
		const within = async (value: unknown) => {
			if (typeof value !== 'string' || !path.isAbsolute(value))
				throw new Error('A consumer path is unavailable.');
			return isPathWithin(foldPathCase(await fs.realpath(value)), root);
		};
		const { sessions, processes, headless } = before.data;
		const owner = sessions.find((s) => s.id === request.sessionId);
		if (!owner || owner.sshRemoteId || owner.sessionSshRemoteConfig || !(await within(owner.cwd)))
			throw new Error('Local target registration is unavailable.');
		const affected = new Set([owner.id]);
		// A nested worktree/child registration remains a consumer even if its cwd moved.
		for (let size = -1; size !== affected.size; ) {
			size = affected.size;
			for (const session of sessions)
				if (affected.has(session.parentSessionId)) affected.add(session.id);
		}
		for (const session of sessions) {
			if (session.sshRemoteId || session.sessionSshRemoteConfig) {
				if (affected.has(session.id)) block('active-consumer', 'A descendant uses an SSH host.');
				continue;
			}
			if ((await within(session.cwd)) || (await within(session.projectRoot)))
				affected.add(session.id);
			if (affected.has(session.id)) {
				if (session.id !== owner.id)
					block('active-consumer', 'Another registered agent depends on the checkout.');
				for (const key of [
					'aiTabs',
					'filePreviewTabs',
					'browserTabs',
					'terminalTabs',
					'unifiedTabOrder',
					'executionQueue',
				]) {
					const items: unknown = session[key];
					if (items !== undefined && !Array.isArray(items))
						throw new Error('Registered tabs or queued work are malformed.');
					if (Array.isArray(items) && items.length)
						block('active-consumer', `Registered ${key} depend on the checkout.`);
				}
				if (session.toolType === 'terminal' || session.inputMode === 'terminal')
					block('active-consumer', 'A registered terminal uses the checkout.');
				if (headless.counts[session.id] > 0 || isSessionBusyWithCli(session.id))
					block('active-consumer', 'Headless or CLI work is active for this agent.');
			}
			// A different agent may have an unsaved file open in the target tree.
			if (session.filePreviewTabs !== undefined && !Array.isArray(session.filePreviewTabs))
				throw new Error('File tab inventory is malformed.');
			for (const tab of session.filePreviewTabs ?? []) {
				if (!tab || typeof tab !== 'object') throw new Error('File tab identity is unavailable.');
				if (!tab.sshRemoteId && (await within(tab.path)))
					block('active-consumer', 'An open file tab references the checkout.');
			}
		}
		for (const process of processes) {
			const owned = [...affected].some(
				(id) => process.sessionId === id || process.sessionId.startsWith(`${id}-`)
			);
			if (process.sshRemoteId) {
				if (owned) block('active-consumer', 'A target process uses an SSH host.');
				continue;
			}
			// Include terminal shells and both paths; projectPath must not hide cwd.
			if (
				owned ||
				(await within(process.cwd)) ||
				(process.projectPath !== undefined && (await within(process.projectPath)))
			)
				block('active-consumer', 'A native AI or terminal process depends on the checkout.');
		}
		// Reuse the live push/pull guard, but never interpret its null as safety.
		const branchBlocker = await branchSwitchBlocker(deps, request.worktreePath);
		if (branchBlocker) block('mutation-busy', branchBlocker);
		if (sample().serialized !== before.serialized)
			block('mutation-busy', 'Consumers or registration changed during inspection.');
		block('unknown', 'Live clients, command-runner and external consumers lack shared exclusion.');
	} catch {
		block('active-consumer', 'Native consumer evidence is missing, malformed or unavailable.');
	}
	return blockers;
}
