import { useEffect } from 'react';
import type { AITab, LogEntry, Session } from '../../types';
import { updateSessionWith, useSessionStore } from '../../stores/sessionStore';
import { useOwnedSideEffectGate } from '../agent/internal/useOwnedSessionGate';
import { isWebDesktop } from '../../utils/runtimeContext';
import { logger } from '../../utils/logger';
import {
	applySessionTranscriptPatch,
	type SessionTranscriptPatch,
} from '../../../shared/sessionTranscript';
import { mergeSessionPersistenceChanges } from '../../../shared/sessionPersistenceMerge';
import { getRepairedUnifiedTabOrder } from '../../utils/tabHelpers';
import { isAiTabHidden } from '../../utils/unifiedTabOrderUtils';

const runtimeFields = [
	'state',
	'thinkingStartTime',
	'busySource',
	'statusMessage',
	'agentSessionId',
	'awaitingSessionId',
	'usageStats',
	'agentError',
	'agentErrorPaused',
	'agentErrorTabId',
	'pid',
	'currentCycleTokens',
	'currentCycleBytes',
] as const;
const rootRuntimeFields = [
	...runtimeFields,
	'browserTabs',
	'terminalTabs',
	'claudeInteractive',
] as const;
const fieldsFor = (row: Session | AITab) => ('aiTabs' in row ? rootRuntimeFields : runtimeFields);

function runtimeOf(row: Session | AITab): Record<string, unknown> {
	const source = row as unknown as Record<string, unknown>;
	return Object.fromEntries(
		fieldsFor(row)
			.filter((field) => source[field] !== undefined)
			.map((field) => [field, source[field]])
	);
}

function applyRuntime<T extends Session | AITab>(
	row: T,
	patch: SessionTranscriptPatch<LogEntry>
): T {
	const runtime = { ...patch.runtime };
	for (const field of ['browserTabs', 'terminalTabs'] as const) {
		if (!Array.isArray(runtime[field])) continue;
		const localRows = (row as unknown as Record<string, { id: string }[]>)[field] ?? [];
		const localById = new Map(localRows.map((item) => [item.id, item]));
		runtime[field] = (runtime[field] as { id: string }[]).map((incoming) => {
			const local = localById.get(incoming.id);
			const merged = local
				? mergeSessionPersistenceChanges(incoming, local, local, true)
				: { ...incoming };
			if (field === 'terminalTabs') {
				const record = merged as Record<string, unknown>;
				const flag = (incoming as Record<string, unknown>).ptyInitialized;
				if (flag === undefined) delete record.ptyInitialized;
				else record.ptyInitialized = flag;
			}
			return merged;
		});
	}
	const result = { ...row, ...runtime };
	for (const field of patch.clearRuntimeFields ?? [])
		delete (result as unknown as Record<string, unknown>)[field];
	return result;
}

/** Process log construction belongs to the same full renderer that owns completion. */
export function useSessionTranscriptSync(whenSessionsLoaded: () => Promise<void>): void {
	const ownsTranscript = useOwnedSideEffectGate();
	useEffect(() => {
		const api = window.maestro.sessions;
		if (!api.onTranscriptSync || !api.publishTranscript) return;
		let disposed = false;
		let queue = Promise.resolve();
		const unsubscribeSync = api.onTranscriptSync((patch) => {
			if (ownsTranscript.current?.(patch.sessionId)) return;
			queue = queue
				.then(async () => {
					await whenSessionsLoaded();
					if (disposed) return;
					updateSessionWith(patch.sessionId, (session) => {
						if (patch.tabId) {
							return {
								...session,
								aiTabs: session.aiTabs.map((tab) => {
									if (tab.id !== patch.tabId) return tab;
									const logs =
										patch.orderIds.length ||
										patch.upserts.length ||
										patch.removedIds.length ||
										patch.snapshot
											? applySessionTranscriptPatch(tab.logs, patch)
											: tab.logs;
									const newOutput =
										!patch.snapshot &&
										patch.upserts.some(
											(row) =>
												row.source === 'stdout' &&
												tab.logs.find((previous) => previous.id === row.id)?.text !== row.text
										);
									const unread =
										tab.id !== session.activeTabId ||
										session.id !== useSessionStore.getState().activeSessionId ||
										tab.isAtBottom === false;
									const hasUnread =
										newOutput && (!unread || !isAiTabHidden(tab)) ? unread : tab.hasUnread;
									return { ...applyRuntime(tab, patch), logs, hasUnread };
								}),
							};
						}
						const logs = (session as unknown as Record<string, LogEntry[]>)[patch.field] ?? [];
						const updated = {
							...applyRuntime(session, patch),
							[patch.field]: applySessionTranscriptPatch(logs, patch),
						};
						return { ...updated, unifiedTabOrder: getRepairedUnifiedTabOrder(updated) };
					});
				})
				.catch((error) =>
					logger.error('Failed to apply owning host transcript', 'Sessions', error)
				);
		});
		if (isWebDesktop())
			return () => {
				disposed = true;
				unsubscribeSync();
			};

		const publish = (
			session: Session,
			row: Session | AITab,
			previous: Session | AITab | undefined,
			field: SessionTranscriptPatch['field'],
			tabId?: string,
			requestId?: string
		) => {
			const logs = (row as unknown as Record<string, LogEntry[]>)[field] ?? [];
			const previousLogs = previous
				? ((previous as unknown as Record<string, LogEntry[]>)[field] ?? [])
				: [];
			const runtime = tabId || field === 'shellLogs' ? runtimeOf(row) : undefined;
			const runtimeChanged =
				runtime &&
				fieldsFor(row).some(
					(field) =>
						(row as unknown as Record<string, unknown>)[field] !==
						(previous as unknown as Record<string, unknown> | undefined)?.[field]
				);
			if (!requestId && logs === previousLogs && !runtimeChanged) return;
			const previousById = new Map(previousLogs.map((log) => [log.id, log]));
			const ids = new Set(logs.map((log) => log.id));
			const patch: SessionTranscriptPatch<LogEntry> = {
				sessionId: session.id,
				tabId,
				field,
				upserts: requestId ? logs : logs.filter((log) => previousById.get(log.id) !== log),
				removedIds: requestId
					? []
					: previousLogs.filter((log) => !ids.has(log.id)).map((log) => log.id),
				orderIds: logs === previousLogs && !requestId ? [] : logs.map((log) => log.id),
				...(requestId && { snapshot: true }),
				...(runtime && {
					runtime,
					clearRuntimeFields: fieldsFor(row).filter((key) => !(key in runtime)),
				}),
			};
			void api
				.publishTranscript(patch, requestId)
				.catch((error) =>
					logger.error('Failed to publish owning host transcript', 'Sessions', error)
				);
		};
		const unsubscribeRequest = api.onTranscriptRequest?.(({ sessionId, tabId, requestId }) => {
			if (!ownsTranscript.current?.(sessionId)) return;
			const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
			const tab = session?.aiTabs.find((item) => item.id === tabId);
			if (session && tab) publish(session, tab, undefined, 'logs', tabId, requestId);
			else if (session && !tabId)
				publish(session, session, undefined, 'shellLogs', undefined, requestId);
		});
		const unsubscribeStore = useSessionStore.subscribe((state, previousState) => {
			if (state.sessions === previousState.sessions) return;
			const previousById = new Map(previousState.sessions.map((session) => [session.id, session]));
			for (const session of state.sessions) {
				if (!ownsTranscript.current?.(session.id)) continue;
				const previous = previousById.get(session.id);
				if (session === previous) continue;
				publish(session, session, previous, 'aiLogs');
				publish(session, session, previous, 'shellLogs');
				const previousTabs = new Map(previous?.aiTabs.map((tab) => [tab.id, tab]));
				for (const tab of session.aiTabs) {
					if (tab !== previousTabs.get(tab.id))
						publish(session, tab, previousTabs.get(tab.id), 'logs', tab.id);
				}
			}
		});
		return () => {
			disposed = true;
			unsubscribeSync();
			unsubscribeRequest?.();
			unsubscribeStore();
		};
	}, [ownsTranscript, whenSessionsLoaded]);
}
