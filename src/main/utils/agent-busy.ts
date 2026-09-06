/**
 * @file agent-busy.ts
 * @description Answers "is this agent doing work right now?" from the main process.
 *
 * The persisted session record is NOT a usable source for this: `useDebouncedPersistence`
 * forces every session and tab back to `state: 'idle'` before writing, so a stuck busy
 * state can't survive a restart. Liveness therefore has to come from what is actually
 * running: a managed process keyed by the desktop's compound AI id (`{agentId}-ai-{tabId}`),
 * plus the CLI activity registry for playbook runs the CLI drives on that agent.
 *
 * Two levels are exported because two questions get asked:
 * - `isAiTabProcessActive()` - is THIS tab running a turn? (per-tab state display)
 * - `isAgentBusy()`          - is ANY tab of this agent running a turn? (may I engage it?)
 */

import { isSessionBusyWithCli } from '../../shared/cli-activity';

/**
 * Minimal slice of ProcessManager this module needs, so callers can pass a real
 * manager, the group chat's `IProcessManager`, or a test double.
 */
export interface ProcessLivenessProbe {
	get(sessionId: string): unknown;
}

/**
 * Minimal slice of a stored session: its id, which tab is active, and its AI tabs.
 */
export interface AgentBusyProbeSession {
	id: string;
	activeTabId?: string;
	aiTabs?: Array<{ id?: string } | null | undefined>;
}

/**
 * True when a live agent process is attached to a specific AI tab.
 *
 * The active tab also answers to the legacy bare `{agentId}-ai` id, which older
 * spawn paths still use, so it is checked for that tab only.
 */
export function isAiTabProcessActive(
	processManager: ProcessLivenessProbe | null | undefined,
	agentId: string,
	tabId: string,
	isActiveTab: boolean
): boolean {
	if (!processManager) return false;
	return Boolean(
		processManager.get(`${agentId}-ai-${tabId}`) ||
		(isActiveTab && processManager.get(`${agentId}-ai`))
	);
}

/**
 * True when any AI tab of this agent is running a turn, or the CLI is running a
 * playbook against it.
 *
 * Used to decide whether it is safe to hand the agent more work from somewhere
 * else (Group Chat delegation, for instance) - two processes in one working
 * directory conflict over the same files.
 */
export function isAgentBusy(
	session: AgentBusyProbeSession,
	processManager: ProcessLivenessProbe | null | undefined
): boolean {
	if (isSessionBusyWithCli(session.id)) return true;
	if (!processManager) return false;

	const aiTabs = session.aiTabs ?? [];
	for (const tab of aiTabs) {
		if (!tab || typeof tab.id !== 'string') continue;
		if (isAiTabProcessActive(processManager, session.id, tab.id, tab.id === session.activeTabId)) {
			return true;
		}
	}
	return false;
}
