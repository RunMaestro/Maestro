/**
 * Browser bootstrap projection and the merge that makes it safe to persist.
 *
 * A web-desktop client boots from `sessions:getBootstrap`, which strips every
 * AI tab transcript, the legacy session-level logs, and command history so a
 * phone does not have to parse the whole sessions file before the agent list
 * appears. The projected record carries a `deferredContent` marker naming what
 * was left behind. The browser loads those pieces on demand
 * (`readDeferredContent`), and every browser save goes back through
 * `mergeDeferredSessionContent`, which restores whatever is still unloaded from
 * the full stored record before the write reaches disk.
 *
 * Pure functions over `StoredSession`: the IPC handlers in
 * `ipc/handlers/persistence.ts` own the store and the write queue.
 */

import type { StoredSession } from './types';
import { pruneAiTabRefs } from './session-ai-tabs';
import {
	MAX_PERSISTED_AI_COMMAND_HISTORY,
	MAX_PERSISTED_SESSION_LOGS,
	mergeDeferredItems,
	type DeferredSessionContent,
} from '../../shared/deferredSessionContent';

type StoredAiTab = { id: string; logs: { id?: string; timestamp?: number }[] };

/** What `sessions:getDeferredContent` returns for one agent. */
export interface DeferredContentPayload {
	logs?: StoredAiTab['logs'];
	shellLogs?: unknown[];
	agentCommands?: unknown[];
	aiCommandHistory?: string[];
}

/**
 * Map every AI tab an agent holds, open or snoozed (alone or inside a snoozed
 * group). Returning `undefined` drops the tab; a snoozed group left with no
 * members is dropped with it.
 */
function mapStoredAiTabs(
	session: StoredSession,
	mapTab: (tab: StoredAiTab) => StoredAiTab | undefined
): StoredSession {
	return {
		...session,
		aiTabs: session.aiTabs?.flatMap((tab: StoredAiTab) => {
			const mapped = mapTab(tab);
			return mapped ? [mapped] : [];
		}),
		snoozedTabs: session.snoozedTabs?.flatMap((entry: StoredSession) => {
			if (entry.type === 'group') {
				const members = entry.members?.flatMap((member: StoredSession) => {
					if (member.type !== 'ai') return [member];
					const tab = mapTab(member.tab);
					return tab ? [{ ...member, tab }] : [];
				});
				return members?.length || !entry.members?.length ? [{ ...entry, members }] : [];
			}
			if (entry.type !== 'ai') return [entry];
			const tab = mapTab(entry.tab);
			return tab ? [{ ...entry, tab }] : [];
		}),
	};
}

/** Find an AI tab by id, whether it is open or parked in a snooze. */
function findStoredAiTab(session: StoredSession, tabId: string): StoredAiTab | undefined {
	const open = (session.aiTabs as StoredAiTab[] | undefined)?.find((tab) => tab.id === tabId);
	if (open) return open;
	for (const entry of session.snoozedTabs ?? []) {
		if (entry.type === 'ai' && entry.tab?.id === tabId) return entry.tab;
		if (entry.type === 'group') {
			const member = entry.members?.find(
				(item: StoredSession) => item.type === 'ai' && item.tab?.id === tabId
			);
			if (member) return member.tab;
		}
	}
	return undefined;
}

/** The thin record a browser client boots from. */
export function projectWebSession(session: StoredSession): StoredSession {
	const tabIds: string[] = [];
	const projected = mapStoredAiTabs(session, (tab) => {
		tabIds.push(tab.id);
		return { ...tab, logs: [] };
	});
	// A legacy agent without createdAt must retain its historical age even though
	// the browser never receives the log timestamps used by renderer restoration.
	let createdAt = session.createdAt;
	if (!createdAt) {
		let earliest = Infinity;
		for (const tab of session.aiTabs ?? []) {
			if (tab.createdAt) earliest = Math.min(earliest, tab.createdAt);
			for (const log of tab.logs ?? []) {
				if (log.timestamp) earliest = Math.min(earliest, log.timestamp);
			}
		}
		for (const item of session.workLog ?? []) {
			if (item.timestamp) earliest = Math.min(earliest, item.timestamp);
		}
		createdAt = earliest === Infinity ? Date.now() : earliest;
	}
	return {
		...projected,
		createdAt,
		aiLogs: [],
		shellLogs: [],
		agentCommands: undefined,
		aiCommandHistory: undefined,
		deferredContent: { tabIds, commands: true } satisfies DeferredSessionContent,
	};
}

/**
 * The deferred pieces of one stored agent: a tab's transcript, the
 * session-level command content, or both. Throws when the agent or the tab is
 * gone, so the browser keeps its marker and can retry instead of treating
 * "no longer exists" as "empty".
 */
export function readDeferredContent(
	session: StoredSession | undefined,
	sessionId: string,
	tabId: string | null,
	includeCommands: boolean
): DeferredContentPayload {
	if (!session) throw new Error(`Agent ${sessionId} no longer exists`);
	const tab = tabId ? findStoredAiTab(session, tabId) : undefined;
	if (tabId && !tab) throw new Error(`Tab ${tabId} no longer exists`);
	return {
		...(tab ? { logs: tab.logs ?? [] } : {}),
		...(includeCommands
			? {
					shellLogs: session.shellLogs ?? [],
					agentCommands: session.agentCommands ?? [],
					aiCommandHistory: session.aiCommandHistory ?? [],
				}
			: {}),
	};
}

/**
 * Fold a browser write back into the full stored record.
 *
 * A record without a marker is complete and passes through untouched. For a
 * marked record, every still-deferred tab takes its stored transcript plus
 * whatever the browser appended, a deferred tab main no longer holds (closed by
 * another client) is dropped rather than resurrected, and the session-level
 * logs and command history are merged the same way. The marker never reaches
 * disk. Callers must run `dropResurrections` first: a marked record with no
 * stored counterpart is refused here.
 */
export function mergeDeferredSessionContent(
	incoming: StoredSession,
	stored: StoredSession | undefined
): StoredSession {
	const deferred = incoming.deferredContent as DeferredSessionContent | undefined;
	if (!deferred) return incoming;
	if (
		!stored ||
		!Array.isArray(deferred.tabIds) ||
		deferred.tabIds.some((id) => typeof id !== 'string')
	) {
		throw new Error(`Refusing to persist invalid deferred content for agent ${incoming.id}`);
	}
	const tabIds = new Set(deferred.tabIds);
	const removedTabIds = new Set<string>();
	const merged = mapStoredAiTabs(incoming, (tab) => {
		if (!tabIds.has(tab.id)) return tab;
		const previousTab = findStoredAiTab(stored, tab.id);
		if (!previousTab) {
			removedTabIds.add(tab.id);
			return undefined;
		}
		return {
			...tab,
			logs: mergeDeferredItems(
				previousTab.logs,
				tab.logs,
				(log) => log.id,
				MAX_PERSISTED_SESSION_LOGS
			),
		};
	});
	const { deferredContent: _deferredContent, ...rest } = merged;
	const complete = pruneAiTabRefs(rest as StoredSession, removedTabIds);
	if (deferred.commands) {
		// This marker also protects legacy session-level logs omitted from the bootstrap.
		complete.aiLogs = mergeDeferredItems(
			stored.aiLogs,
			incoming.aiLogs,
			(log: { id?: string }) => log.id
		);
		complete.shellLogs = mergeDeferredItems(
			stored.shellLogs,
			incoming.shellLogs,
			(log: { id?: string }) => log.id
		);
		complete.agentCommands = mergeDeferredItems(
			stored.agentCommands,
			incoming.agentCommands,
			(command: { command: string }) => command.command
		);
		complete.aiCommandHistory = mergeDeferredItems(
			stored.aiCommandHistory,
			incoming.aiCommandHistory,
			(command: string) => command,
			MAX_PERSISTED_AI_COMMAND_HISTORY
		);
	}
	return complete;
}
