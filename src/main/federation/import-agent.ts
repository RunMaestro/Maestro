/**
 * `import_agent` on the desktop app: a Federation lift whose remote runs Maestro itself, so the
 * desktop's bridge is the host the lift reaches (`discoverRemoteHost()` reports `desktop-running`
 * and no headless host starts). Without this the bridge echoed the message and the lift stopped
 * at "the running Maestro app does not support the 'import_agent' command".
 *
 * The checks and the stored record are `planAgentImport()`, the rule the headless host applies.
 * What is the desktop's own is where the record goes:
 *
 * - It is written to the sessions store and announced with `broadcastSessionLifecycle()`, the push
 *   every window and web-desktop client already applies when an agent appears from another client
 *   (`useSessionLifecycleSync`). The windows restore it exactly like an agent read from disk.
 * - Queued messages go through the bridge's own `enqueueCommand`, the path `dispatch --queue`
 *   takes. A window applies the push asynchronously, so a message that finds no agent yet is
 *   retried for a short, bounded time. A message still refused after that is reported as a notice,
 *   never retried again: the agent itself is already here (the headless host's contract).
 */

import type { AgentImportInput, AgentImportReceipt } from '../../shared/maestro-lib/client/types';
import { planAgentImport, type AgentImportPlan } from '../../shared/maestro-lib/agents/import-plan';
import { tabDefaultsFromSettings } from '../../shared/maestro-lib/agents/rules';
import { broadcastSessionLifecycle } from '../ipc/handlers/persistence';
import { getGroupsStore, getSessionsStore, getSettingsStore } from '../stores/getters';
import type { StoredSession } from '../stores/types';
import { removeAgentFiles } from '../../shared/maestro-lib/agents/removal-files';
import { isAgentBusy, type ProcessLivenessProbe } from '../utils/agent-busy';
import { getAppUserDataDir } from '../utils/app-user-data';
import { captureException } from '../utils/sentry';

/** What `enqueueCommand` answers, as far as an import reads it. */
export interface ImportEnqueueResult {
	success: boolean;
	error?: string;
	reason?: string;
}

export interface DesktopAgentImportDeps {
	/** Every stored agent, dormant ones included: an imported name must not collide with any. */
	getSessions(): StoredSession[];
	setSessions(sessions: StoredSession[]): void;
	getGroupIds(): string[];
	getSettings(): Record<string, unknown>;
	/**
	 * The live process table the copy an import replaces is read from and stopped on. Absent (the
	 * table is not up yet): a replace is refused, since nobody can tell whether that copy runs a turn.
	 */
	processes?: DesktopAgentProcesses;
	/** Remove the files a removed agent leaves beside its record (`removeAgentFiles()`). */
	removeFiles(agentId: string): Promise<void>;
	/**
	 * Tell every window and web client the agent entered the store, and which agents it replaced
	 * (the copy an earlier Move Back left here) left it.
	 */
	announceAdded(agent: StoredSession, removedIds?: string[]): void;
	enqueue(
		agentId: string,
		tabId: string,
		text: string,
		images: string[] | undefined
	): Promise<ImportEnqueueResult>;
	checkCwd?: (cwd: string) => string | null;
	sleep?: (ms: number) => Promise<void>;
}

/** How long a queued message waits for the windows to hold the new agent. */
export const IMPORT_ENQUEUE_RETRY_MS = 250;
export const IMPORT_ENQUEUE_ATTEMPTS = 20;

export type DesktopAgentImportResult =
	| { ok: true; receipt: AgentImportReceipt }
	| { ok: false; code: Extract<AgentImportPlan, { ok: false }>['code']; message: string };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The slice of the ProcessManager replacing an agent's copy reads and stops. */
export type ImportProcessTable = ProcessLivenessProbe & {
	kill(processId: string): boolean;
	closeAgent(agentId: string): void;
};

/** What replacing an agent's copy asks of this desktop's processes. */
export interface DesktopAgentProcesses {
	/** Whether any tab of the agent runs a turn now: the live table (`isAgentBusy()`), never `state`. */
	isBusy(agent: StoredSession): boolean;
	/** Stop every process the agent owns, as a remove does: AI turns, native runtimes, terminals. */
	stop(agent: StoredSession): void;
}

/** The desktop's process table, read and stopped the way removing an agent does. */
export function desktopAgentProcesses(table: ImportProcessTable): DesktopAgentProcesses {
	return {
		isBusy: (agent) => isAgentBusy(agent, table),
		stop: (agent) => {
			// Every AI process of every tab plus retained runtimes (`killAgentAiProcesses()` in the
			// renderer ends in the same `closeAgent`), then the agent's terminals.
			table.closeAgent(agent.id);
			table.kill(`${agent.id}-terminal`);
			for (const tab of agent.terminalTabs ?? []) {
				if (tab && typeof tab.id === 'string') table.kill(`${agent.id}-terminal-${tab.id}`);
			}
		},
	};
}

/** The desktop's stores and lifecycle push, with the bridge's own `enqueueCommand` for the queue. */
export function buildDesktopAgentImportDeps(
	enqueue: DesktopAgentImportDeps['enqueue'],
	processTable: ImportProcessTable | null | undefined
): DesktopAgentImportDeps {
	return {
		...(processTable ? { processes: desktopAgentProcesses(processTable) } : {}),
		// The desktop keeps closed tabs on the record, so only the playbooks file is left to remove.
		removeFiles: (agentId) => removeAgentFiles({ userDataDir: getAppUserDataDir() }, agentId),
		getSessions: () => {
			const sessions = getSessionsStore().get('sessions', []);
			return Array.isArray(sessions) ? sessions : [];
		},
		setSessions: (sessions) => getSessionsStore().set('sessions', sessions),
		getGroupIds: () => {
			const groups = getGroupsStore().get('groups', []);
			return Array.isArray(groups) ? groups.map((group) => group.id) : [];
		},
		getSettings: () => getSettingsStore().store as unknown as Record<string, unknown>,
		announceAdded: (agent, removedIds = []) =>
			broadcastSessionLifecycle(undefined, { added: [agent], removedIds }),
		enqueue,
	};
}

/** Store an imported agent on this desktop, then queue its waiting messages in order. */
export async function importAgentIntoDesktop(
	input: AgentImportInput,
	deps: DesktopAgentImportDeps
): Promise<DesktopAgentImportResult> {
	const sessions = deps.getSessions();
	const planned = planAgentImport(input, {
		agents: sessions,
		groupIds: deps.getGroupIds(),
		defaults: tabDefaultsFromSettings(deps.getSettings()),
		...(deps.checkCwd ? { checkCwd: deps.checkCwd } : {}),
	});
	if (!planned.ok) return planned;

	// The agent's earlier copy a Move Back left here (`planned.replaces`) leaves the way a remove
	// takes an agent away: refused while it runs a turn (the live table, read in the same tick as
	// the write, so no turn starts between the two), its processes stopped, its files removed.
	const replaced = planned.replaces
		? sessions.find((session) => session.id === planned.replaces)
		: undefined;
	if (replaced) {
		if (!deps.processes) {
			return {
				ok: false,
				code: 'rejected',
				message: `This Maestro cannot tell yet whether the copy this import replaces (${replaced.id}) is running a turn. Try the move again in a moment.`,
			};
		}
		if (deps.processes.isBusy(replaced)) {
			return {
				ok: false,
				code: 'rejected',
				message: `The copy this import replaces (${replaced.id}) is running a turn. Wait for it to finish, or stop it, then move again.`,
			};
		}
		deps.processes.stop(replaced);
	}

	// The maestro-lib record is the stored shape: the store keeps what the record holds. The
	// replaced copy goes in the same write.
	const agent = planned.agent as unknown as StoredSession;
	const kept = replaced ? sessions.filter((session) => session.id !== replaced.id) : sessions;
	deps.setSessions([...kept, agent]);
	deps.announceAdded(agent, replaced ? [replaced.id] : []);
	const notices: string[] = [];
	if (replaced) {
		try {
			await deps.removeFiles(replaced.id);
		} catch (error) {
			// The agent is moved; a playbooks file left behind does not undo that, but it is said.
			void captureException(error, {
				area: 'federation',
				operation: 'import-replace-files',
				agentId: replaced.id,
			});
			notices.push(
				`The playbooks of the replaced copy (${replaced.id}) were not removed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	const sleep = deps.sleep ?? defaultSleep;
	let queued = 0;
	for (const item of input.queue ?? []) {
		let result: ImportEnqueueResult = { success: false };
		for (let attempt = 1; attempt <= IMPORT_ENQUEUE_ATTEMPTS; attempt++) {
			result = await deps.enqueue(agent.id, item.tabId, item.text, item.images);
			if (result.success || result.reason !== 'session-not-found') break;
			if (attempt < IMPORT_ENQUEUE_ATTEMPTS) await sleep(IMPORT_ENQUEUE_RETRY_MS);
		}
		if (result.success) queued += 1;
		else {
			notices.push(
				`A queued message for tab ${item.tabId} was not queued: ${result.error ?? 'the desktop refused it'}`
			);
		}
	}
	return {
		ok: true,
		receipt: { agentId: agent.id, queued, ...(notices.length > 0 ? { notices } : {}) },
	};
}
