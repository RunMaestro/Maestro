/**
 * The desktop's binding over the hosted runtime (4.2 of the migration plan): what the windows and the
 * main-process store facade talk to, so neither touches the repository directly.
 *
 * - **Events** leave stamped (DG13): the agent's revision, the groups revision, and the id of the command
 *   that caused them. The revision is read inside the listener, which the repository calls after it has
 *   bumped it, so the stamp is the post-commit value. The command id travels in an `AsyncLocalStorage`
 *   scope: a command's events are emitted inside the promise chain the command was queued on, and a
 *   promise callback keeps the scope that was active when it was registered.
 * - **Commands** run the repository's own rules and answer the stamped events they caused, so a caller
 *   applies the authoritative records without waiting for the broadcast.
 * - **The fold** passes the boundary transforms (`fold-boundary.ts`) and then lands in the applier.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` sections 4.2, 4.5, and 4.6.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type {
	DesktopFold,
	DesktopRuntimeApi,
	DesktopSnapshot,
} from '../../shared/maestro-lib/agents/desktop-fold-types';
import { baselineOf, buildFold } from '../../shared/maestro-lib/agents/fold-builder';
import type { ClientResult, MaestroEvent } from '../../shared/maestro-lib/client/types';
import type { MaestroRuntime } from '../../shared/maestro-lib/runtime';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type {
	LibraryRuntimeCommand,
	LibraryRuntimeCommandAnswer,
	LibraryRuntimeCommandRequest,
	LibraryRuntimeEventMessage,
	LibraryRuntimeFoldAnswer,
	LibraryRuntimeStamp,
} from '../../shared/libraryRuntime';
import { compactSessionToolOutputs } from '../../shared/toolOutput';
import { relocateSessionImages } from '../storage/session-image-store';
import type { StoredSession } from '../stores/types';
import { logger } from '../utils/logger';
import { applyFoldBoundary } from './fold-boundary';

const LOG_CONTEXT = '[LibraryRuntime]';

/** A runtime that has the desktop API: one started in mode `desktop`. */
export type DesktopRuntime = MaestroRuntime & { desktop: DesktopRuntimeApi };

export interface DesktopBinding {
	/** Every runtime event, stamped. Returns the unsubscribe function. */
	onEvent(listener: (message: LibraryRuntimeEventMessage) => void): () => void;
	/** The stored records with transcripts and the revisions to guard later events with. */
	snapshot(): DesktopSnapshot;
	/**
	 * `snapshot()` after the same healing `sessions:getAll` does on load: pasted images still stored
	 * inline move to the image store and oversized tool results are compacted. Anything healed is
	 * written back through the fold, then the snapshot is read again so its revisions are true.
	 */
	loadSnapshot(): Promise<DesktopSnapshot>;
	/** One repository command. */
	command(request: LibraryRuntimeCommandRequest): Promise<LibraryRuntimeCommandAnswer>;
	/** A renderer's fold: boundary transforms, then the applier. */
	fold(fold: DesktopFold): Promise<LibraryRuntimeFoldAnswer>;
	/**
	 * The sessions a main-process writer holds, as a fold at the CURRENT revision: the writer read the
	 * stored state a moment ago, so its domain edits land (a plugin verb that renames an agent). With
	 * `removeAbsent` an agent the array leaves out is removed, which is the meaning `set('sessions')` had.
	 */
	writeSessions(
		sessions: readonly Record<string, unknown>[],
		options?: { removeAbsent?: boolean; activeSessionId?: string }
	): Promise<LibraryRuntimeFoldAnswer>;
	/**
	 * A flush from code that does not know about revisions (an older browser bundle, `sessions:setMany`):
	 * desktop-owned keys land, new agents are adopted, and its domain edits are dropped as drift, because
	 * a copy of unknown age must never overwrite a command.
	 */
	foldLegacySessions(
		sessions: readonly Record<string, unknown>[],
		removeIds?: readonly string[]
	): Promise<LibraryRuntimeFoldAnswer>;
	/** Groups from a caller that does not know about revisions: only `collapsed` lands. */
	foldLegacyGroups(groups: ReadonlyArray<{ id: string; collapsed?: boolean }>): Promise<void>;
	/** Set the active agent (stored in the sessions document). */
	setActiveSessionId(id: string): Promise<void>;
	/** Make everything accepted so far durable. */
	flush(): Promise<void>;
	dispose(): void;
}

function stampOf(runtime: DesktopRuntime, event: MaestroEvent): LibraryRuntimeStamp {
	switch (event.type) {
		case 'agent.added':
		case 'agent.updated':
			return { rev: runtime.desktop.revisionOf(event.agent.id) };
		case 'tab.added':
		case 'tab.updated':
		case 'tab.removed':
			return { rev: runtime.desktop.revisionOf(event.agentId) };
		case 'groups.changed':
			return { groupsRev: runtime.desktop.groupsRevision() };
		default:
			return {};
	}
}

const STAMPED_EVENT_TYPES = [
	'agent.added',
	'agent.updated',
	'agent.removed',
	'groups.changed',
	'tab.added',
	'tab.updated',
	'tab.removed',
	'host.lost',
] as const satisfies readonly MaestroEvent['type'][];

interface CommandScope {
	/** Absent for a fold: its events are not a command's. */
	commandId?: string;
	changes: LibraryRuntimeEventMessage[];
}

function dispatch(
	runtime: DesktopRuntime,
	command: LibraryRuntimeCommand
): Promise<ClientResult<unknown>> {
	switch (command.method) {
		case 'agents.create':
			return runtime.agents.create(command.input);
		case 'agents.update':
			return runtime.agents.update(command.agentId, command.patch);
		case 'agents.rename':
			return runtime.agents.rename(command.agentId, command.name);
		case 'agents.remove':
			return runtime.agents.remove(command.agentId);
		case 'groups.create':
			return runtime.groups.create(command.input);
		case 'groups.rename':
			return runtime.groups.rename(command.groupId, command.name);
		case 'groups.update':
			return runtime.desktop.updateGroup(command.groupId, command.patch);
		case 'groups.remove':
			return runtime.groups.remove(command.groupId);
		case 'groups.moveAgent':
			return runtime.groups.moveAgent(command.agentId, command.groupId);
	}
}

export function createDesktopBinding(runtime: DesktopRuntime): DesktopBinding {
	const scope = new AsyncLocalStorage<CommandScope>();
	const listeners = new Set<(message: LibraryRuntimeEventMessage) => void>();

	const unsubscribe = runtime.events.subscribe(
		(event) => {
			const current = scope.getStore();
			const message: LibraryRuntimeEventMessage = {
				event,
				...stampOf(runtime, event),
				...(current?.commandId !== undefined ? { origin: { commandId: current.commandId } } : {}),
				...(current && current.commandId === undefined ? { fromFold: true as const } : {}),
			};
			current?.changes.push(message);
			for (const listener of [...listeners]) {
				try {
					listener(message);
				} catch (error) {
					logger.warn(
						`A runtime event listener threw: ${error instanceof Error ? error.message : String(error)}`,
						LOG_CONTEXT
					);
				}
			}
		},
		{ types: STAMPED_EVENT_TYPES }
	);

	const storedAgents = (): AgentRecord[] =>
		(runtime.desktop.documents().sessions.sessions ?? []).filter(
			(entry): entry is AgentRecord => typeof (entry as { id?: unknown })?.id === 'string'
		);

	const baselines = (withRev: boolean) => {
		const map = new Map<string, { baseline: ReturnType<typeof baselineOf>; rev?: number }>();
		for (const agent of storedAgents()) {
			map.set(agent.id, {
				baseline: baselineOf(agent),
				...(withRev ? { rev: runtime.desktop.revisionOf(agent.id) } : {}),
			});
		}
		return map;
	};

	const stored = (agentId: string): StoredSession | undefined =>
		storedAgents().find((agent) => agent.id === agentId) as unknown as StoredSession | undefined;

	async function landFold(fold: DesktopFold): Promise<LibraryRuntimeFoldAnswer> {
		const bounded = await applyFoldBoundary(fold, stored);
		// A fold's events are marked, so the side effects of a change skip what a renderer already did.
		const result = await scope.run({ changes: [] }, () => runtime.desktop.fold(bounded));
		for (const drift of result.drift) {
			logger.debug(`Fold drift: ${drift.kind}`, LOG_CONTEXT, drift);
		}
		return { ok: true, ...result };
	}

	return {
		onEvent(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		snapshot: () => runtime.desktop.snapshot(),

		async loadSnapshot() {
			const first = runtime.desktop.snapshot();
			try {
				const { sessions: relocated, relocated: images } = await relocateSessionImages(
					first.agents
				);
				let compactedCount = 0;
				const healed = relocated.map((agent) => {
					const result = compactSessionToolOutputs(agent);
					compactedCount += result.compacted;
					return result.session;
				});
				if (images === 0 && compactedCount === 0) return first;
				await landFold(
					buildFold(healed as unknown as Record<string, unknown>[], {
						baselines: baselines(true),
					})
				);
				return runtime.desktop.snapshot();
			} catch (error) {
				// Healing must never block a window from loading its agents.
				logger.warn(
					`Healing the stored sessions failed: ${error instanceof Error ? error.message : String(error)}`,
					LOG_CONTEXT
				);
				return first;
			}
		},

		async command(request) {
			const changes: LibraryRuntimeEventMessage[] = [];
			const result = await scope.run({ commandId: request.commandId, changes }, () =>
				dispatch(runtime, request.command)
			);
			return { result, changes };
		},

		fold: landFold,

		writeSessions(sessions, options = {}) {
			return landFold(
				buildFold(sessions, {
					baselines: baselines(true),
					removeAbsent: options.removeAbsent === true,
					...(options.activeSessionId !== undefined
						? { activeSessionId: options.activeSessionId }
						: {}),
				})
			);
		},

		foldLegacySessions(sessions, removeIds = []) {
			const fold = buildFold(sessions, { baselines: baselines(false) });
			if (removeIds.length > 0) fold.removeAgents = [...removeIds];
			return landFold(fold);
		},

		async foldLegacyGroups(groups) {
			const collapsed: Record<string, boolean> = {};
			for (const group of groups) collapsed[group.id] = group.collapsed === true;
			await scope.run({ changes: [] }, () =>
				runtime.desktop.fold({ agents: [], groups: { collapsed } })
			);
		},

		async setActiveSessionId(id) {
			await runtime.desktop.fold({ agents: [], activeSessionId: id });
		},

		flush: () => runtime.desktop.flush(),

		dispose() {
			unsubscribe();
			listeners.clear();
		},
	};
}
