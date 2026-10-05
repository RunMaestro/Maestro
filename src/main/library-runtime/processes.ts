/**
 * The desktop's answer to "is this agent running a turn, and stop everything it runs" (DG2).
 *
 * The desktop's turns run under ProcessManager, not in the library runtime's registry, so the
 * repository would otherwise call every agent idle and an agent delete would leave its processes
 * behind. The runtime composes this with its own registry: busy if either says so, a delete stops both.
 *
 * Liveness comes from what is running (`src/main/utils/agent-busy.ts`), never from the stored `state`,
 * which persistence rewrites to idle.
 */

import { isSessionBusyWithCli } from '../../shared/cli-activity';
import type { RepositoryProcesses } from '../../shared/maestro-lib/agents/repository';
import { isAiTabProcessActive } from '../utils/agent-busy';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[LibraryRuntime]';

/** The slice of ProcessManager this reads: probe a process, list them, kill one. */
export interface DesktopProcessSource {
	get(sessionId: string): unknown;
	getAll(): Array<{ sessionId: string }>;
	kill(sessionId: string): boolean;
}

/** An Auto Run turn: `<agentId>-batch-<timestamp>`. */
const batchIdOf = (agentId: string): string => `${agentId}-batch-`;

export function createDesktopRuntimeProcesses(
	getProcessManager: () => DesktopProcessSource | null
): RepositoryProcesses {
	return {
		isBusy(agentId, tabId) {
			if (isSessionBusyWithCli(agentId)) return true;
			const manager = getProcessManager();
			if (!manager) return false;
			if (tabId !== undefined) {
				// The repository does not know the active tab, and the legacy `<agentId>-ai` id belongs to
				// it. Counting that id for any tab errs toward refusing, which is the safe side.
				return isAiTabProcessActive(manager, agentId, tabId, true);
			}
			return manager
				.getAll()
				.some(
					({ sessionId }) =>
						sessionId === `${agentId}-ai` ||
						sessionId.startsWith(`${agentId}-ai-`) ||
						sessionId.startsWith(batchIdOf(agentId))
				);
		},

		async stopAgent(agentId) {
			const manager = getProcessManager();
			if (!manager) return;
			// Agent ids are UUIDs, so a process id that starts with `<agentId>-` is the agent's: every AI
			// tab, the legacy id, Auto Run and synopsis turns, command mode, and the terminal PTYs. Group
			// chat and consult processes carry another owner and are never matched.
			for (const { sessionId } of manager.getAll()) {
				if (!sessionId.startsWith(`${agentId}-`)) continue;
				try {
					manager.kill(sessionId);
				} catch (error) {
					logger.warn(
						`Stopping ${sessionId} for a removed agent failed: ${error instanceof Error ? error.message : String(error)}`,
						LOG_CONTEXT
					);
				}
			}
		},
	};
}
