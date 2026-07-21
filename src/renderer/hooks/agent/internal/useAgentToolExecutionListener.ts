/**
 * useAgentToolExecutionListener - registers `window.maestro.process.onToolExecution`
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
import { useOwnedSessionGate } from './useOwnedSessionGate';
import type { LogEntry } from '../../../types';

export function useAgentToolExecutionListener(): void {
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
					parentToolUseId?: string;
				}
			) => {
				// Window scoping: ignore agents this window doesn't own (broadcast events).
				if (!ownedGate.current?.(sessionId)) return;
				const aiTabMatch = sessionId.match(REGEX_AI_TAB);
				if (!aiTabMatch) return;

				const actualSessionId = aiTabMatch[1];
				const tabId = aiTabMatch[2];

				if (!getSessions().some((s) => s.id === actualSessionId)) return;

				const logId = toolEvent.toolCallId
					? `tool-${toolEvent.toolCallId}`
					: `tool-${Date.now()}-${toolEvent.toolName}`;

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;

						const targetTab = s.aiTabs.find((t) => t.id === tabId);
						if (!targetTab) return s;
						// Always record tool events regardless of the tab's `showTools`
						// setting. Visibility is a pure render concern (TerminalOutput
						// hides `source:'tool'` entries when tools are off), so recording
						// unconditionally keeps running->completed correlation intact
						// across a mid-run toggle and avoids the transcript churn that
						// dropping events / deleting logs caused (the flicker bug).

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
							};
							// The parent id can arrive on either the running or the
							// finalizing event; keep whichever we have seen.
							const mergedParentToolUseId =
								toolEvent.parentToolUseId ?? existing.metadata?.parentToolUseId;
							const mergedLog: LogEntry = {
								...existing,
								metadata: {
									...existing.metadata,
									toolState: mergedState,
									...(mergedParentToolUseId ? { parentToolUseId: mergedParentToolUseId } : {}),
								},
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
								metadata: {
									toolState: newState,
									...(toolEvent.parentToolUseId
										? { parentToolUseId: toolEvent.parentToolUseId }
										: {}),
								},
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
	}, [ownedGate]);
}
