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
 * Covered here: an agent created or removed (the stats lifecycle rows), an agent renamed (the provider's
 * own session name), and a tab renamed or starred (the provider's session name and star, the History
 * relabel, and the starred transcript mirror). The listener hands back the work it started, which the
 * binding waits for before it answers the command: a window that refreshes a cache on the answer then
 * reads what these wrote.
 */

import type { LibraryRuntimeEventMessage } from '../../shared/libraryRuntime';
import type { AgentRecord, AITabRecord } from '../../shared/maestro-lib/store/records';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[LibraryRuntime]';

/** The part of a tab the effects compare: a rename and a star are changes to these two. */
interface TabMark {
	name: string | null;
	starred: boolean;
}

export interface DesktopEffectsDeps {
	/** The agents the runtime holds now, so a rename can be told from a first sighting. Their tabs seed the tab marks. */
	initialAgents: ReadonlyArray<
		Pick<AgentRecord, 'id' | 'name'> & Partial<Pick<AgentRecord, 'aiTabs'>>
	>;
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
	/**
	 * A tab was named (an empty `name` clears it): write it as the provider session name of the tab's
	 * conversation and relabel the History entries that conversation made. Nothing to do for a tab with
	 * no provider session yet.
	 */
	syncTabName(agent: AgentRecord, tab: AITabRecord, name: string): void | Promise<unknown>;
	/**
	 * A tab was starred or unstarred: write the star to the provider's origin record and keep the starred
	 * transcript mirror in step (snapshot on star, release on unstar).
	 */
	syncTabStarred(agent: AgentRecord, tab: AITabRecord, starred: boolean): void | Promise<unknown>;
	now?: () => number;
}

/** Start the listener. Returns what `DesktopBinding.onEvent` wants as its listener. */
export function createDesktopEffects(
	deps: DesktopEffectsDeps
): (message: LibraryRuntimeEventMessage) => Promise<void> | void {
	const names = new Map<string, string>(deps.initialAgents.map((agent) => [agent.id, agent.name]));
	const tabMarks = new Map<string, Map<string, TabMark>>();
	const markOf = (tab: AITabRecord): TabMark => ({
		name: typeof tab.name === 'string' && tab.name ? tab.name : null,
		starred: tab.starred === true,
	});
	for (const agent of deps.initialAgents) {
		tabMarks.set(
			agent.id,
			new Map((agent.aiTabs ?? []).map((tab) => [tab.id, markOf(tab)] as const))
		);
	}
	const now = deps.now ?? Date.now;

	/** Run one effect. Resolves when it is done, and never rejects: a failed effect is logged and the command still answers. */
	const run = async (what: string, effect: () => void | Promise<unknown>): Promise<void> => {
		try {
			await effect();
		} catch (error) {
			logger.warn(
				`${what} failed: ${error instanceof Error ? error.message : String(error)}`,
				LOG_CONTEXT
			);
		}
	};

	return (message) => {
		const { event } = message;
		const work: Array<Promise<void>> = [];
		// Keep the names current even for a fold's events, so a later rename is measured against the truth.
		if (event.type === 'agent.added' || event.type === 'agent.updated') {
			const before = names.get(event.agent.id);
			names.set(event.agent.id, event.agent.name);
			// The same for tabs: what a tab was called and whether it was starred, before this event.
			const earlier = tabMarks.get(event.agent.id);
			const current = new Map<string, TabMark>();
			for (const tab of event.agent.aiTabs ?? []) {
				const mark = markOf(tab);
				current.set(tab.id, mark);
				const was = earlier?.get(tab.id);
				if (message.fromFold || !was) continue;
				if (was.name !== mark.name) {
					work.push(
						run('Syncing the tab name', () => deps.syncTabName(event.agent, tab, mark.name ?? ''))
					);
				}
				if (was.starred !== mark.starred) {
					work.push(
						run('Syncing the tab star', () => deps.syncTabStarred(event.agent, tab, mark.starred))
					);
				}
			}
			tabMarks.set(event.agent.id, current);
			if (message.fromFold) return;
			if (event.type === 'agent.added') {
				const ssh = event.agent.sessionSshRemoteConfig as { enabled?: boolean } | undefined;
				work.push(
					run('Recording the agent created', () =>
						deps.recordSessionCreated({
							sessionId: event.agent.id,
							agentType: event.agent.toolType,
							projectPath: event.agent.cwd ?? '',
							createdAt: typeof event.agent.createdAt === 'number' ? event.agent.createdAt : now(),
							isRemote: ssh?.enabled === true,
							isWorktree: typeof event.agent.parentSessionId === 'string',
						})
					)
				);
			} else if (before !== undefined && before !== event.agent.name) {
				work.push(
					run('Syncing the provider session name', () =>
						deps.syncProviderSessionName(event.agent, event.agent.name)
					)
				);
			}
			return work.length > 0 ? Promise.all(work).then(() => undefined) : undefined;
		}
		if (event.type === 'agent.removed') {
			names.delete(event.agentId);
			tabMarks.delete(event.agentId);
			if (message.fromFold) return;
			return run('Recording the agent closed', () =>
				deps.recordSessionClosed(event.agentId, now())
			);
		}
	};
}
