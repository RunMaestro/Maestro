import { useEffect } from 'react';
import { generateUUID } from '../../../shared/uuid';
import type { AITab, LogEntry, Session } from '../../types';
import { updateSessionWith, useSessionStore } from '../../stores/sessionStore';
import { useOwnedSideEffectGate } from '../agent/internal/useOwnedSessionGate';
import { isWebDesktop } from '../../utils/runtimeContext';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { isExpectedBridgeError } from '../../../shared/bridgeError';
import {
	applySessionTranscriptPatch,
	consumeEmptyTranscriptCreation,
	type SessionTranscriptPatch,
	type SessionRuntimeSnapshot,
} from '../../../shared/sessionTranscript';
import { mergeSessionPersistenceChanges } from '../../../shared/sessionPersistenceMerge';
import { getRepairedUnifiedTabOrder, settleAgentStateFromTabs } from '../../utils/tabHelpers';
import { getBaseSessionId } from '../../utils/sessionIdParser';
import type { PendingPermissionSnapshot } from '../../../shared/pendingPermissions';
import { isAiTabHidden } from '../../utils/unifiedTabOrderUtils';
import { registerSessionTranscriptFlush } from '../../services/sessionPersistenceFlush';

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

/** Apply live runtime, or a private snapshot only if its captured turn is still current. */
export function applyRuntime<T extends Session | AITab>(
	row: T,
	patch: SessionRuntimeSnapshot,
	baseline?: T
): T {
	if (
		baseline &&
		fieldsFor(row).some(
			(field) => !Object.is(Reflect.get(row, field), Reflect.get(baseline, field))
		)
	)
		return row;
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
		let queueGeneration = useSessionStore.getState().sessionReconciliationGeneration;
		const unsubscribeSync = api.onTranscriptSync((patch) => {
			if (ownsTranscript.current?.(patch.sessionId)) return;
			const generation = useSessionStore.getState().sessionReconciliationGeneration;
			if (generation !== queueGeneration) {
				queueGeneration = generation;
				queue = Promise.resolve();
			}
			const applied = queue.then(async () => {
				if (generation !== useSessionStore.getState().sessionReconciliationGeneration) return;
				await whenSessionsLoaded();
				if (disposed || generation !== useSessionStore.getState().sessionReconciliationGeneration)
					return;
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
			});
			queue = applied.catch((error) =>
				logger.error('Failed to apply owning host transcript', 'Sessions', error)
			);
			return applied;
		});
		if (isWebDesktop())
			return () => {
				disposed = true;
				unsubscribeSync();
			};

		const sourceGeneration = generateUUID();
		const sequences = new Map<string, number>();
		const publications = new Map<string, { logs: LogEntry[]; ack: Promise<boolean> }>();
		registerSessionTranscriptFlush(async (sessionId, tabId, boundaryId) => {
			if (disposed || !ownsTranscript.current?.(sessionId))
				throw new Error('DispatchTranscriptOwnerUnavailable');
			const tab = useSessionStore
				.getState()
				.sessions.find((session) => session.id === sessionId)
				?.aiTabs.find((tab) => tab.id === tabId);
			const published = publications.get(`${sessionId}-ai-${tabId}`);
			if (
				!tab ||
				published?.logs !== tab.logs ||
				!tab.logs.some((row) => row.id === boundaryId && row.source === 'user')
			)
				throw new Error('DispatchTranscriptBoundaryUnavailable');
			if (
				!(await published.ack) ||
				disposed ||
				!ownsTranscript.current?.(sessionId) ||
				!useSessionStore
					.getState()
					.sessions.find((session) => session.id === sessionId)
					?.aiTabs.find((current) => current.id === tabId && current.createdAt === tab.createdAt)
					?.logs.some((row) => row.id === boundaryId && row.source === 'user')
			)
				throw new Error('DispatchTranscriptCommitFailed');
		});
		let pendingVersion = -1;
		let pendingAgents = new Set<string>();
		const projectPendingPermissions = () => {
			if (disposed || pendingVersion < 0) return;
			useSessionStore.getState().setSessions((sessions) => {
				let changed = false;
				const next = sessions.map((session) => {
					if (pendingAgents.has(session.id)) {
						if (session.state === 'waiting_input' || session.state === 'error') return session;
						changed = true;
						return { ...session, state: 'waiting_input' as const };
					}
					if (session.state !== 'waiting_input') return session;
					changed = true;
					return settleAgentStateFromTabs(session);
				});
				return changed ? next : sessions;
			});
		};
		const acceptPendingPermissions = (snapshot: PendingPermissionSnapshot) => {
			queue = queue
				.then(async () => {
					await whenSessionsLoaded();
					if (disposed || snapshot.version <= pendingVersion) return;
					pendingVersion = snapshot.version;
					pendingAgents = new Set(snapshot.processIds.map(getBaseSessionId));
					projectPendingPermissions();
				})
				.catch((error) =>
					logger.error('Failed to apply pending permission runtime', 'Sessions', error)
				);
		};
		const unsubscribePending =
			window.maestro.process.onPendingPermissionsChanged?.(acceptPendingPermissions);
		const unsubscribeProjection = useSessionStore.subscribe((state, previous) => {
			if (state.sessions !== previous.sessions) projectPendingPermissions();
		});
		void window.maestro.process
			.getPendingPermissions?.()
			.then(acceptPendingPermissions)
			.catch((error) => logger.warn('Pending permission runtime unavailable', 'Sessions', error));

		const publish = (
			session: Session,
			row: Session | AITab,
			previous: Session | AITab | undefined,
			field: SessionTranscriptPatch['field'],
			tabId?: string,
			requestId?: string,
			metadataOnly = false,
			forceBinding = false
		) => {
			const logs = metadataOnly
				? []
				: ((row as unknown as Record<string, LogEntry[]>)[field] ?? []);
			const previousLogs =
				!metadataOnly && previous
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
			if (!requestId && logs === previousLogs && !runtimeChanged && !forceBinding) return;
			const previousById = requestId
				? undefined
				: new Map(previousLogs.map((log) => [log.id, log]));
			const ids = requestId ? undefined : new Set(logs.map((log) => log.id));
			const patch: SessionTranscriptPatch<LogEntry> = {
				sessionId: session.id,
				tabId,
				field,
				...(!requestId &&
					tabId && {
						observation: {
							sourceGeneration,
							sequence: (sequences.get(tabId) ?? 0) + 1,
							createdAt: (row as AITab).createdAt,
							provider: session.toolType,
							...(!previous &&
								!logs.length &&
								!(row as AITab).agentSessionId &&
								consumeEmptyTranscriptCreation(logs) && { emptyCreation: true }),
						},
						...(!previous && { snapshot: true }),
					}),
				upserts: requestId ? logs : logs.filter((log) => previousById!.get(log.id) !== log),
				removedIds: requestId
					? []
					: previousLogs.filter((log) => !ids!.has(log.id)).map((log) => log.id),
				orderIds: logs === previousLogs && !requestId ? [] : logs.map((log) => log.id),
				...(requestId && { snapshot: true }),
				...(requestId &&
					metadataOnly &&
					!tabId && {
						tabInventory: session.aiTabs
							.filter((tab) => !tab.wizardState?.isActive)
							.map((tab) => ({
								id: tab.id,
								agentSessionId: tab.agentSessionId,
								name: tab.name,
								starred: tab.starred,
								createdAt: tab.createdAt,
								state: tab.state,
								hidden: tab.hidden,
								readOnlyMode: tab.readOnlyMode,
								permissionMode: tab.permissionMode,
								saveToHistory: tab.saveToHistory,
								showThinking: tab.showThinking,
								customModel: tab.customModel,
								customEffort: tab.customEffort,
								...runtimeOf(tab),
								clearRuntimeFields: fieldsFor(tab).filter(
									(key) => Reflect.get(tab, key) === undefined
								),
							})),
					}),
				...(runtime && {
					runtime,
					clearRuntimeFields: fieldsFor(row).filter((key) => !(key in runtime)),
				}),
			};
			if (patch.observation) sequences.set(tabId!, patch.observation.sequence);
			const ack = api.publishTranscript(patch, requestId);
			if (tabId && !requestId) publications.set(`${session.id}-ai-${tabId}`, { logs, ack });
			void ack.catch((error) =>
				logger.error('Failed to publish owning host transcript', 'Sessions', error)
			);
		};
		const unsubscribeRequest = api.onTranscriptRequest?.(
			({ sessionId, tabId, requestId, metadataOnly }) => {
				if (!ownsTranscript.current?.(sessionId)) return;
				void (async () => {
					// Requests can arrive while the native owner is still hydrating. Do
					// not drop that request permanently: answer once its tree is ready.
					if (!useSessionStore.getState().sessions.some((item) => item.id === sessionId))
						await whenSessionsLoaded();
					if (disposed || !ownsTranscript.current?.(sessionId)) return;
					const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
					const tab = session?.aiTabs.find((item) => item.id === tabId);
					if (session && tab)
						publish(session, tab, undefined, 'logs', tabId, requestId, metadataOnly);
					else if (session && !tabId)
						publish(session, session, undefined, 'shellLogs', undefined, requestId, metadataOnly);
				})().catch((error) => {
					if (isExpectedBridgeError(error)) return;
					logger.error('Failed to answer owning host snapshot', 'Sessions', error);
					captureException(error, {
						extra: { operation: 'useSessionTranscriptSync.answerSnapshot' },
					});
				});
			}
		);
		const unsubscribeStore = useSessionStore.subscribe((state, previousState) => {
			// A prior runtime projection subscriber may have superseded this frame.
			if (state.sessions !== useSessionStore.getState().sessions) return;
			if (state.sessions === previousState.sessions) return;
			const previousById = new Map(previousState.sessions.map((session) => [session.id, session]));
			for (const session of state.sessions) {
				if (!ownsTranscript.current?.(session.id)) continue;
				const previous = previousById.get(session.id);
				previousById.delete(session.id);
				if (session === previous) continue;
				publish(session, session, previous, 'aiLogs');
				publish(session, session, previous, 'shellLogs');
				const previousTabs = new Map(previous?.aiTabs.map((tab) => [tab.id, tab]));
				const openTabIds = new Set(session.aiTabs.map((tab) => tab.id));
				for (const old of previous?.aiTabs ?? []) {
					if (openTabIds.has(old.id)) continue;
					publications.delete(`${session.id}-ai-${old.id}`);
					const sequence = (sequences.get(old.id) ?? 0) + 1;
					sequences.set(old.id, sequence);
					void api
						.publishTranscript({
							sessionId: session.id,
							tabId: old.id,
							field: 'logs',
							upserts: [],
							removedIds: [],
							orderIds: [],
							observation: {
								sourceGeneration,
								sequence,
								createdAt: old.createdAt,
								provider: session.toolType,
								closed: true,
							},
						})
						.catch((error) =>
							logger.error('Failed to publish closed transcript', 'Sessions', error)
						);
				}
				for (const tab of session.aiTabs) {
					if (tab !== previousTabs.get(tab.id) || session.toolType !== previous?.toolType)
						publish(
							session,
							tab,
							previousTabs.get(tab.id),
							'logs',
							tab.id,
							undefined,
							false,
							session.toolType !== previous?.toolType
						);
				}
			}
			for (const removed of previousById.values())
				for (const tab of removed.aiTabs) publications.delete(`${removed.id}-ai-${tab.id}`);
		});
		return () => {
			disposed = true;
			registerSessionTranscriptFlush(null);
			unsubscribeSync();
			unsubscribeRequest?.();
			unsubscribePending?.();
			unsubscribeProjection();
			unsubscribeStore();
		};
	}, [ownsTranscript, whenSessionsLoaded]);
}
