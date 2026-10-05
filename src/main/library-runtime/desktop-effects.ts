/**
 * The side effects of a committed change, performed in main for every surface (4.9 of the migration plan).
 *
 * Today the renderer performs these after its own edit, and the remote duplicate skips some of them.
 * With the runtime hosted, a command from a window and a message from the TUI or `maestro-cli` reach the
 * same repository, so one listener over its events performs them for both and a renderer site that
 * migrated to a command stops making the calls.
 *
 * Only changes that came from a COMMAND are acted on. An event the runtime emitted while landing a
 * renderer's fold (an agent adopted, a domain edit landed, an agent removed) is a site that has not
 * migrated yet, and that site still does its own bookkeeping: acting on it here would count it twice.
 *
 * Covered here: an agent created or removed (the stats lifecycle rows) and an agent renamed (the
 * provider's own session name). Tab renames and stars move with the tab commands.
 */

import type { LibraryRuntimeEventMessage } from '../../shared/libraryRuntime';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[LibraryRuntime]';

export interface DesktopEffectsDeps {
	/** The agents the runtime holds now, so a rename can be told from a first sighting. */
	initialAgents: ReadonlyArray<Pick<AgentRecord, 'id' | 'name'>>;
	recordSessionCreated(event: {
		sessionId: string;
		agentType: string;
		projectPath: string;
		createdAt: number;
		isRemote: boolean;
		isWorktree: boolean;
	}): void | Promise<unknown>;
	recordSessionClosed(sessionId: string, closedAt: number): void | Promise<unknown>;
	/** Write `name` as the provider session name of the agent's conversation, when it has one. */
	syncProviderSessionName(agent: AgentRecord, name: string): void | Promise<unknown>;
	now?: () => number;
}

/** Start the listener. Returns what `DesktopBinding.onEvent` wants as its listener. */
export function createDesktopEffects(
	deps: DesktopEffectsDeps
): (message: LibraryRuntimeEventMessage) => void {
	const names = new Map<string, string>(deps.initialAgents.map((agent) => [agent.id, agent.name]));
	const now = deps.now ?? Date.now;

	const run = (what: string, effect: () => void | Promise<unknown>): void => {
		try {
			void Promise.resolve(effect()).catch((error) =>
				logger.warn(
					`${what} failed: ${error instanceof Error ? error.message : String(error)}`,
					LOG_CONTEXT
				)
			);
		} catch (error) {
			logger.warn(
				`${what} failed: ${error instanceof Error ? error.message : String(error)}`,
				LOG_CONTEXT
			);
		}
	};

	return (message) => {
		const { event } = message;
		// Keep the names current even for a fold's events, so a later rename is measured against the truth.
		if (event.type === 'agent.added' || event.type === 'agent.updated') {
			const before = names.get(event.agent.id);
			names.set(event.agent.id, event.agent.name);
			if (message.fromFold) return;
			if (event.type === 'agent.added') {
				const ssh = event.agent.sessionSshRemoteConfig as { enabled?: boolean } | undefined;
				run('Recording the agent created', () =>
					deps.recordSessionCreated({
						sessionId: event.agent.id,
						agentType: event.agent.toolType,
						projectPath: event.agent.cwd ?? '',
						createdAt: typeof event.agent.createdAt === 'number' ? event.agent.createdAt : now(),
						isRemote: ssh?.enabled === true,
						isWorktree: typeof event.agent.parentSessionId === 'string',
					})
				);
			} else if (before !== undefined && before !== event.agent.name) {
				run('Syncing the provider session name', () =>
					deps.syncProviderSessionName(event.agent, event.agent.name)
				);
			}
			return;
		}
		if (event.type === 'agent.removed') {
			names.delete(event.agentId);
			if (message.fromFold) return;
			run('Recording the agent closed', () => deps.recordSessionClosed(event.agentId, now()));
		}
	};
}
