/**
 * useAgentThinkingListener - registers `window.maestro.process.onThinkingChunk`
 *
 * High-frequency stream - chunks are buffered and flushed inside a single
 * `requestAnimationFrame` to coalesce up to 60Hz worth of writes into one
 * setSessions pass. The buffer + RAF id are owned by this hook (not shared
 * with any other listener), so cleanup is local.
 *
 * Thinking-mode contract:
 * - 'off':  the chunk is dropped.
 * - 'on'/'sticky': the chunk is appended to the last `source: 'thinking'` log
 *   if present, otherwise a new thinking log is created.
 * - Stale-straggler drop: if the tab's last log is already the turn's
 *   `source: 'stdout'` answer, the chunk is dropped instead of creating a new
 *   thinking log below that answer. This hook writes on a ~16ms rAF while the
 *   answer arrives via the 200ms batched flush in useBatchedSessionUpdates,
 *   whose inline clear point owns the mid-turn removal of thinking logs; a
 *   chunk buffered just before that flush would otherwise land just after it.
 *   Applies in 'sticky' mode too - sticky preserves thinking logs already on
 *   screen, it does not entitle a stale buffer to materialize a new one.
 *
 * Concatenated-tool-name guard: malformed chunks containing a stream of
 * back-to-back tool names get dropped (or *replace* an existing log) rather
 * than rendered as text.
 */

import { useEffect, useRef } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { REGEX_AI_TAB } from '../../../utils/sessionIdParser';
import { isLikelyConcatenatedToolNames } from '../../../constants/app';
import { thinkingLogsRecorded } from './helpers/thinkingLogs';
import { generateId } from '../../../utils/ids';
import { logger } from '../../../utils/logger';
import { useOwnedSessionGate } from './useOwnedSessionGate';
import { canAppendToLogEntry } from '../../../utils/logEntries';
import type { LogEntry } from '../../../types';

export function useAgentThinkingListener(): void {
	// Buffered text plus the moment buffering STARTED for that tab. The timestamp
	// is what separates a chunk that outlived its turn's answer (stale) from
	// reasoning that legitimately follows an intermediate assistant message: only
	// the former was already in hand before the stdout log appeared.
	const thinkingChunkBufferRef = useRef<Map<string, { text: string; bufferedAt: number }>>(
		new Map()
	);
	const thinkingChunkRafIdRef = useRef<number | null>(null);
	const ownedGate = useOwnedSessionGate();

	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;
		const thinkingChunkBuffer = thinkingChunkBufferRef.current;

		const unsubscribe = window.maestro.process.onThinkingChunk?.(
			(sessionId: string, content: string) => {
				// Window scoping: ignore agents this window doesn't own (broadcast events).
				if (!ownedGate.current?.(sessionId)) return;
				const aiTabMatch = sessionId.match(REGEX_AI_TAB);
				if (!aiTabMatch) return;

				const actualSessionId = aiTabMatch[1];
				const tabId = aiTabMatch[2];
				const bufferKey = `${actualSessionId}:${tabId}`;

				const existing = thinkingChunkBufferRef.current.get(bufferKey);
				thinkingChunkBufferRef.current.set(bufferKey, {
					text: (existing?.text ?? '') + content,
					// Keep the FIRST chunk's timestamp for the whole coalesced batch.
					bufferedAt: existing?.bufferedAt ?? Date.now(),
				});

				if (thinkingChunkRafIdRef.current === null) {
					thinkingChunkRafIdRef.current = requestAnimationFrame(() => {
						const buffer = thinkingChunkBufferRef.current;
						if (buffer.size === 0) {
							thinkingChunkRafIdRef.current = null;
							return;
						}

						const chunksToProcess = new Map(buffer);
						buffer.clear();
						thinkingChunkRafIdRef.current = null;

						setSessions((prev) =>
							prev.map((s) => {
								let hasChanges = false;
								for (const [key] of chunksToProcess) {
									if (key.startsWith(s.id + ':')) {
										hasChanges = true;
										break;
									}
								}
								if (!hasChanges) return s;

								// Tag thinking entries with `renderStyle: 'text-stream'` when the
								// session's resolved Claude mode is interactive so the TUI/API
								// footer pill matches the assistant text in the same turn.
								const isInteractive = s.claudeInteractive?.mode === 'interactive';

								let updatedTabs = s.aiTabs;
								for (const [key, buffered] of chunksToProcess) {
									const bufferedContent = buffered.text;
									const [chunkSessionId, chunkTabId] = key.split(':');
									if (chunkSessionId !== s.id) continue;

									const targetTab = updatedTabs.find((t) => t.id === chunkTabId);
									if (!targetTab) continue;

									if (!thinkingLogsRecorded(targetTab.showThinking)) continue;

									if (isLikelyConcatenatedToolNames(bufferedContent)) {
										logger.warn(
											'[App] Skipping malformed thinking chunk (concatenated tool names):',
											undefined,
											bufferedContent.substring(0, 100)
										);
										continue;
									}

									// Three log-update branches collapsed into one map call:
									//   1. New thinking log when last log isn't thinking → append.
									//   2. Continuation that combines cleanly → replace last log
									//      with combined text.
									//   3. Continuation that combined into malformed concatenated
									//      tool names → replace last log with this chunk only
									//      (drop the prior text rather than worsen the noise).
									const lastLog = targetTab.logs[targetTab.logs.length - 1];

									// A chunk that outlives its turn's answer is stale: the inline clear
									// point in useBatchedSessionUpdates already removed the thinking block
									// this chunk belonged to and appended the answer below it. Appending
									// now would resurrect a stale prefix of that same answer underneath
									// it. Tested explicitly (not as !isContinuation) because a
									// self-contained thinking card is a non-continuation too.
									//
									// The timestamp comparison is what keeps this narrow. Claude Code and
									// Factory Droid stream at MESSAGE granularity, so an intermediate
									// assistant message flushes as stdout mid-turn and more reasoning can
									// legitimately follow it. Dropping on `source === 'stdout'` alone
									// silenced that reasoning for the rest of the turn. Only a chunk that
									// was ALREADY buffered when the stdout landed is stale; one that
									// arrived afterwards is new content and must be appended.
									const outlivedItsAnswer =
										lastLog?.source === 'stdout' && lastLog.timestamp >= buffered.bufferedAt;
									if (outlivedItsAnswer) continue;

									// Same rule as every other coalescing site: same source AND not a
									// self-contained card. See utils/logEntries.ts.
									const isContinuation = canAppendToLogEntry(lastLog, 'thinking');
									const combinedText = isContinuation ? lastLog.text + bufferedContent : '';
									const continuationIsMalformed =
										isContinuation && isLikelyConcatenatedToolNames(combinedText);
									if (continuationIsMalformed) {
										logger.warn(
											'[App] Detected malformed thinking content, replacing instead of appending'
										);
									}

									let nextLogs: LogEntry[];
									if (!isContinuation) {
										const newLog: LogEntry = {
											id: generateId(),
											timestamp: Date.now(),
											source: 'thinking',
											text: bufferedContent,
											...(isInteractive ? { renderStyle: 'text-stream' as const } : {}),
										};
										nextLogs = [...targetTab.logs, newLog];
									} else {
										const replacementText = continuationIsMalformed
											? bufferedContent
											: combinedText;
										nextLogs = [
											...targetTab.logs.slice(0, -1),
											{
												...lastLog,
												text: replacementText,
												...(isInteractive ? { renderStyle: 'text-stream' as const } : {}),
											},
										];
									}

									updatedTabs = updatedTabs.map((tab) =>
										tab.id === chunkTabId ? { ...tab, logs: nextLogs } : tab
									);
								}

								return updatedTabs === s.aiTabs ? s : { ...s, aiTabs: updatedTabs };
							})
						);
					});
				}
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
	}, [ownedGate]);
}
