/**
 * The process registry: the one place that knows which agent processes the
 * runtime started and still owns.
 *
 * Empty in Phase 5, which starts no turn; Phase 6 registers every turn it
 * starts. It exists now because three things already ask it questions: the
 * repository refuses a working-directory move or a tab close while a process
 * runs (RT14: live state, never the stored `state`, which the desktop rewrites
 * to idle), an agent delete stops everything the agent runs, and shutdown must
 * not leave an orphan it could have stopped.
 *
 * lib-D2: the registry owns process lifetime only. What a turn amounted to is
 * the caller's policy (`resolveTurnOutcome`), so nothing here reads an exit code.
 */

import type { RepositoryProcesses } from '../agents/repository';
import { logger } from '../host';
import type { TurnHandle } from '../run/start-turn';

const LOG_CONTEXT = '[ProcessRegistry]';

/** The part of a `TurnHandle` the registry uses, so a fake can stand in for one. */
export type RegisteredTurn = Pick<TurnHandle, 'interrupt' | 'terminate' | 'terminateNow'> & {
	readonly done: Promise<unknown>;
};

export interface ProcessRegistry extends RepositoryProcesses {
	/** Track a running turn. It drops out of the registry by itself when `done` settles. */
	register(agentId: string, tabId: string, turn: RegisteredTurn): void;
	/** A user interrupt: the first stage a person's Stop uses. Resolves once the turn has ended. */
	interruptTab(agentId: string, tabId: string): Promise<boolean>;
	/** A tab close and a fence start at terminate (lib-D5). Resolves once the turns have ended. */
	stopTab(agentId: string, tabId: string): Promise<void>;
	/** Quit and fence: stop every registered turn. */
	stopAll(): Promise<void>;
	/** Last resort for `process.on('exit')`: no grace, nothing awaited. */
	terminateAllNow(): void;
	/** How many turns are registered. */
	size(): number;
}

export interface ProcessRegistryOptions {
	/** How long `stop*` waits for a turn to end before it resolves anyway. Default 10000. */
	waitMs?: number;
}

interface Entry {
	agentId: string;
	tabId: string;
	turn: RegisteredTurn;
}

/** Resolves when `promise` settles or after `ms`, whichever is first. Never rejects. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		promise.then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			() => {
				clearTimeout(timer);
				resolve();
			}
		);
	});
}

export function createProcessRegistry(options: ProcessRegistryOptions = {}): ProcessRegistry {
	const waitMs = options.waitMs ?? 10_000;
	const entries = new Set<Entry>();

	const matching = (agentId: string, tabId?: string): Entry[] =>
		[...entries].filter(
			(entry) => entry.agentId === agentId && (tabId === undefined || entry.tabId === tabId)
		);

	const stopEntries = async (
		list: Entry[],
		stop: (turn: RegisteredTurn) => void
	): Promise<void> => {
		for (const entry of list) {
			try {
				stop(entry.turn);
			} catch (error) {
				logger.warn(
					`Stopping ${entry.agentId}/${entry.tabId} failed: ${error instanceof Error ? error.message : String(error)}`,
					LOG_CONTEXT
				);
			}
		}
		await Promise.all(list.map((entry) => settledWithin(entry.turn.done, waitMs)));
	};

	return {
		register(agentId, tabId, turn) {
			const entry: Entry = { agentId, tabId, turn };
			entries.add(entry);
			const forget = (): void => {
				entries.delete(entry);
			};
			turn.done.then(forget, forget);
		},
		isBusy: (agentId, tabId) => matching(agentId, tabId).length > 0,
		async interruptTab(agentId, tabId) {
			const list = matching(agentId, tabId);
			await stopEntries(list, (turn) => turn.interrupt());
			return list.length > 0;
		},
		stopTab: (agentId, tabId) => stopEntries(matching(agentId, tabId), (turn) => turn.terminate()),
		stopAgent: (agentId) => stopEntries(matching(agentId), (turn) => turn.terminate()),
		stopAll: () => stopEntries([...entries], (turn) => turn.terminate()),
		terminateAllNow() {
			for (const entry of [...entries]) {
				try {
					entry.turn.terminateNow();
				} catch {
					// The process is going away with this one; there is nobody left to tell.
				}
			}
		},
		size: () => entries.size,
	};
}
