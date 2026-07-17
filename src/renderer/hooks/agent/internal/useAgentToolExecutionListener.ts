/**
 * useAgentToolExecutionListener — registers `window.maestro.process.onToolExecution`
 *
 * Buffers tool events (running/completed/failed) and merges them into the
 * matching tab's logs. Identification rules (preserved verbatim):
 *  1. If the event has a `toolCallId`, build a deterministic log id
 *     `tool-${toolCallId}` and merge by id.
 *  2. Otherwise (Codex and similar agents that don't emit a call id), if
 *     the event finalises a tool call, walk the log array from newest to
 *     oldest and attribute it to the most recent still-`running` entry
 *     with the same `toolName`.
 *  3. Failing both, append a fresh tool log.
 *
 * The hook owns no shared state; it pulls `setSessions` from the store
 * lazily per-event so the closure stays small.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { REGEX_AI_TAB } from '../../../utils/sessionIdParser';
import { thinkingLogsRecorded } from './helpers/thinkingLogs';
import { useOwnedSessionGate } from './useOwnedSessionGate';
import type { LogEntry } from '../../../types';
import type { BatchedUpdater } from './types';

const NOOP_BATCHED_UPDATER: Pick<BatchedUpdater, 'flushNow'> = { flushNow: () => undefined };
const NOOP_THINKING_FLUSH = () => undefined;

export function useAgentToolExecutionListener(
	batchedUpdater: Pick<BatchedUpdater, 'flushNow'> = NOOP_BATCHED_UPDATER,
	flushThinkingForSession: (sessionId: string) => void = NOOP_THINKING_FLUSH
): void {
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;
		const getSessions = () => useSessionStore.getState().sessions;

		const unsubscribe = window.maestro.process.onToolExecution?.(
			(
				sessionId: string,
				toolEvent: {
					toolName: string;
					state?: unknown;
					timestamp: number;
					toolCallId?: string;
				}
			) => {
				// Window scoping: ignore agents this window doesn't own (broadcast events).
				if (!ownedGate.current?.(sessionId)) return;
				const aiTabMatch = sessionId.match(REGEX_AI_TAB);
				if (!aiTabMatch) return;

				const actualSessionId = aiTabMatch[1];
				const tabId = aiTabMatch[2];

				const owningSession = getSessions().find((session) => session.id === actualSessionId);
				if (!owningSession) return;
				// OMP lifecycle receipts must observe every earlier streamed chunk
				// before a synchronous tool entry or turn boundary is appended.
				if (owningSession.toolType === 'omp') {
					flushThinkingForSession(sessionId);
					batchedUpdater.flushNow();
				}
				if (!toolEvent.toolCallId && owningSession.toolType === 'omp') return;

				const logId = toolEvent.toolCallId
					? `tool-${toolEvent.toolCallId}`
					: `tool-${Date.now()}-${toolEvent.toolName}`;

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;

						const targetTab = s.aiTabs.find((t) => t.id === tabId);
						if (!targetTab) return s;
						if (!thinkingLogsRecorded(targetTab.showThinking) && s.toolType !== 'omp') return s;

						const newState = toolEvent.state as
							| NonNullable<LogEntry['metadata']>['toolState']
							| undefined;

						// Tag tool entries with `renderStyle: 'text-stream'` when the
						// session's resolved Claude mode is interactive so the TUI/API
						// footer pill matches the assistant text in the same turn.
						const isInteractive = s.claudeInteractive?.mode === 'interactive';

						const isFinalizing =
							newState?.status === 'completed' ||
							newState?.status === 'failed' ||
							newState?.status === 'error';
						let existingIdx = -1;
						if (toolEvent.toolCallId) {
							existingIdx = targetTab.logs.findIndex((l) => l.id === logId);
						} else if (isFinalizing) {
							for (let i = targetTab.logs.length - 1; i >= 0; i--) {
								const log = targetTab.logs[i];
								if (
									log.source === 'tool' &&
									log.text === toolEvent.toolName &&
									log.metadata?.toolState?.status === 'running'
								) {
									existingIdx = i;
									break;
								}
							}
						}

						let updatedLogs: LogEntry[];
						if (existingIdx >= 0) {
							const existing = targetTab.logs[existingIdx];
							const existingState = existing.metadata?.toolState;
							const mergedState: NonNullable<LogEntry['metadata']>['toolState'] = {
								...existingState,
								...newState,
								input: newState?.input ?? existingState?.input,
								output: newState?.output ?? existingState?.output,
								...(isFinalizing && {
									durationMs: Math.max(0, toolEvent.timestamp - existing.timestamp),
								}),
							};
							const mergedLog: LogEntry = {
								...existing,
								metadata: { ...existing.metadata, toolState: mergedState },
								...(isInteractive ? { renderStyle: 'text-stream' as const } : {}),
							};
							updatedLogs = [
								...targetTab.logs.slice(0, existingIdx),
								mergedLog,
								...targetTab.logs.slice(existingIdx + 1),
							];
						} else {
							const toolLog: LogEntry = {
								id: logId,
								timestamp: toolEvent.timestamp,
								source: 'tool',
								text: toolEvent.toolName,
								metadata: { toolState: newState },
								...(isInteractive ? { renderStyle: 'text-stream' as const } : {}),
							};
							updatedLogs = [...targetTab.logs, toolLog];
						}

						return {
							...s,
							aiTabs: s.aiTabs.map((tab) =>
								tab.id === tabId ? { ...tab, logs: updatedLogs } : tab
							),
						};
					})
				);
			}
		);

		return () => {
			unsubscribe?.();
		};
	}, [batchedUpdater, flushThinkingForSession, ownedGate]);
}
