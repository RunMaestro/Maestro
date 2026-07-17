/**
 * useAgentThinkingListener — registers `window.maestro.process.onThinkingChunk`
 *
 * High-frequency stream — chunks are buffered and flushed inside a single
 * `requestAnimationFrame` to coalesce up to 60Hz worth of writes into one
 * setSessions pass. The buffer + RAF id are owned by this hook (not shared
 * with any other listener), so cleanup is local.
 *
 * Thinking-mode contract:
 * - 'off':  the chunk is dropped.
 * - 'on'/'sticky': the chunk is appended to the last `source: 'thinking'` log
 *   if present, otherwise a new thinking log is created.
 *
 * Concatenated-tool-name guard: malformed chunks containing a stream of
 * back-to-back tool names get dropped (or *replace* an existing log) rather
 * than rendered as text.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { REGEX_AI_TAB } from '../../../utils/sessionIdParser';
import { isLikelyConcatenatedToolNames } from '../../../constants/app';
import { thinkingLogsRecorded } from './helpers/thinkingLogs';
import { generateId } from '../../../utils/ids';
import { logger } from '../../../utils/logger';
import { useOwnedSessionGate } from './useOwnedSessionGate';
import type { LogEntry } from '../../../types';
import { NOOP_OMP_EVENT_COORDINATOR, type OmpEventCoordinator } from './useOmpEventCoordinator';

export function useAgentThinkingListener(
	ompEventCoordinator: OmpEventCoordinator = NOOP_OMP_EVENT_COORDINATOR
): (sessionId: string) => void {
	const thinkingChunkBufferRef = useRef<Map<string, string>>(new Map());
	const thinkingChunkRafIdRef = useRef<number | null>(null);
	const ownedGate = useOwnedSessionGate();

	const flushThinkingChunks = useCallback((chunksToProcess: Map<string, string>) => {
		if (chunksToProcess.size === 0) return;
		useSessionStore.getState().setSessions((prev) =>
			prev.map((session) => {
				const relevantChunks = [...chunksToProcess].filter(([key]) =>
					key.startsWith(session.id + ':')
				);
				if (relevantChunks.length === 0) return session;

				const isInteractive = session.claudeInteractive?.mode === 'interactive';
				let updatedTabs = session.aiTabs;
				for (const [key, bufferedContent] of relevantChunks) {
					const [chunkSessionId, chunkTabId] = key.split(':');
					if (chunkSessionId !== session.id) continue;

					const targetTab = updatedTabs.find((tab) => tab.id === chunkTabId);
					if (!targetTab || !thinkingLogsRecorded(targetTab.showThinking)) continue;
					if (isLikelyConcatenatedToolNames(bufferedContent)) {
						logger.warn(
							'[App] Skipping malformed thinking chunk (concatenated tool names):',
							undefined,
							bufferedContent.substring(0, 100)
						);
						continue;
					}

					const lastLog = targetTab.logs[targetTab.logs.length - 1];
					const isContinuation = lastLog?.source === 'thinking';
					const combinedText = isContinuation ? lastLog.text + bufferedContent : '';
					const continuationIsMalformed =
						isContinuation && isLikelyConcatenatedToolNames(combinedText);
					if (continuationIsMalformed)
						logger.warn(
							'[App] Detected malformed thinking content, replacing instead of appending'
						);

					const nextLogs: LogEntry[] = isContinuation
						? [
								...targetTab.logs.slice(0, -1),
								{
									...lastLog,
									text: continuationIsMalformed ? bufferedContent : combinedText,
									...(isInteractive ? { renderStyle: 'text-stream' as const } : {}),
								},
							]
						: [
								...targetTab.logs,
								{
									id: generateId(),
									timestamp: Date.now(),
									source: 'thinking',
									text: bufferedContent,
									...(isInteractive ? { renderStyle: 'text-stream' as const } : {}),
								},
							];
					updatedTabs = updatedTabs.map((tab) =>
						tab.id === chunkTabId ? { ...tab, logs: nextLogs } : tab
					);
				}
				return updatedTabs === session.aiTabs ? session : { ...session, aiTabs: updatedTabs };
			})
		);
	}, []);

	const flushThinkingForSession = useCallback(
		(sessionId: string) => {
			const aiTabMatch = sessionId.match(REGEX_AI_TAB);
			if (!aiTabMatch) return;
			const bufferKey = `${aiTabMatch[1]}:${aiTabMatch[2]}`;
			const bufferedContent = thinkingChunkBufferRef.current.get(bufferKey);
			if (!bufferedContent) return;
			thinkingChunkBufferRef.current.delete(bufferKey);
			flushThinkingChunks(new Map([[bufferKey, bufferedContent]]));
		},
		[flushThinkingChunks]
	);

	useEffect(() => {
		const thinkingChunkBuffer = thinkingChunkBufferRef.current;
		const unsubscribe = window.maestro.process.onThinkingChunk?.(
			(sessionId: string, content: string) => {
				if (!ownedGate.current?.(sessionId)) return;
				const aiTabMatch = sessionId.match(REGEX_AI_TAB);
				if (!aiTabMatch) return;
				const bufferKey = `${aiTabMatch[1]}:${aiTabMatch[2]}`;
				const session = useSessionStore
					.getState()
					.sessions.find((item) => item.id === aiTabMatch[1]);
				if (session?.toolType === 'omp') {
					ompEventCoordinator.enqueue(sessionId, () =>
						flushThinkingChunks(new Map([[bufferKey, content]]))
					);
					return;
				}

				thinkingChunkBuffer.set(bufferKey, (thinkingChunkBuffer.get(bufferKey) || '') + content);
				if (thinkingChunkRafIdRef.current !== null) return;
				thinkingChunkRafIdRef.current = requestAnimationFrame(() => {
					const buffer = thinkingChunkBufferRef.current;
					if (buffer.size === 0) {
						thinkingChunkRafIdRef.current = null;
						return;
					}
					const chunksToProcess = new Map(buffer);
					buffer.clear();
					thinkingChunkRafIdRef.current = null;
					flushThinkingChunks(chunksToProcess);
				});
			}
		);

		return () => {
			unsubscribe?.();
			if (thinkingChunkRafIdRef.current !== null) {
				cancelAnimationFrame(thinkingChunkRafIdRef.current);
				thinkingChunkRafIdRef.current = null;
			}
			thinkingChunkBuffer.clear();
		};
	}, [flushThinkingChunks, ompEventCoordinator, ownedGate]);

	return flushThinkingForSession;
}
