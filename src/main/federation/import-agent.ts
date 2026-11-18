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
	/** Tell every window and web client the agent entered the store. */
	announceAdded(agent: StoredSession): void;
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

/** The desktop's stores and lifecycle push, with the bridge's own `enqueueCommand` for the queue. */
export function buildDesktopAgentImportDeps(
	enqueue: DesktopAgentImportDeps['enqueue']
): DesktopAgentImportDeps {
	return {
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
		announceAdded: (agent) =>
			broadcastSessionLifecycle(undefined, { added: [agent], removedIds: [] }),
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

	// The maestro-lib record is the stored shape: the store keeps what the record holds.
	const agent = planned.agent as unknown as StoredSession;
	deps.setSessions([...sessions, agent]);
	deps.announceAdded(agent);

	const sleep = deps.sleep ?? defaultSleep;
	let queued = 0;
	const notices: string[] = [];
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
