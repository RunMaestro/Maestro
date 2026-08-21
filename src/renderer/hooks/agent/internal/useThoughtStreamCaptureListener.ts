/**
 * useThoughtStreamCaptureListener - feeds the Thought Stream panel.
 *
 * Subscribes to the same raw `process:thinking-chunk` IPC stream as
 * `useAgentThinkingListener`, but routes chunks into `thoughtStreamStore`
 * INDEPENDENT of any tab's `showThinking` setting. This is what lets a user
 * introspect an Auto Run's reasoning even when thinking display is off.
 *
 * Capture is ambient: every owned session's chunks are buffered whether or not
 * the panel is open, so opening the stream on a run that has been hanging for
 * ten minutes shows those ten minutes rather than an empty log. The store
 * bounds the buffers (see MAX_THOUGHT_CHARS_PER_SESSION / MAX_CAPTURED_SESSIONS).
 *
 * Chunks are coalesced on a THOUGHT_FLUSH_MS timer, not requestAnimationFrame:
 * rAF is paused while the window is hidden or minimized, which is exactly when
 * a long unattended run is producing the reasoning the user later wants to read.
 * A timer keeps flushing (throttled, not stopped) in the background, and at one
 * store write every 250ms per session the always-on path stays cheap.
 */

import { useEffect, useRef } from 'react';
import { useThoughtStreamStore } from '../../../stores/thoughtStreamStore';
import { parseSessionId } from '../../../utils/sessionIdParser';
import { useOwnedSessionGate } from './useOwnedSessionGate';

/** Coalescing window for the raw chunk stream. */
export const THOUGHT_FLUSH_MS = 250;

export function useThoughtStreamCaptureListener(): void {
	const bufferRef = useRef<Map<string, string>>(new Map());
	const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const ownedGate = useOwnedSessionGate();

	useEffect(() => {
		const buffer = bufferRef.current;

		const flush = () => {
			flushTimerRef.current = null;
			if (buffer.size === 0) return;
			const chunks = new Map(buffer);
			buffer.clear();
			const appendThought = useThoughtStreamStore.getState().appendThought;
			for (const [chunkKey, text] of chunks) {
				const sepIndex = chunkKey.indexOf(':');
				appendThought(chunkKey.slice(0, sepIndex), chunkKey.slice(sepIndex + 1), text);
			}
		};

		const unsubscribe = window.maestro.process.onThinkingChunk?.(
			(sessionId: string, content: string) => {
				// Window scoping: ignore agents this window doesn't own (broadcast events).
				if (!ownedGate.current?.(sessionId)) return;
				// Auto Run spawns its agent with a `{sessionId}-batch-{timestamp}`
				// streaming id (see spawnAgentForSession), NOT the `{sessionId}-ai-{tabId}`
				// shape interactive tabs use. parseSessionId resolves BOTH (and synopsis/
				// legacy/regular) down to the base maestro session id, which is exactly
				// the key the thought stream captures under. Using REGEX_AI_TAB alone
				// silently dropped every Auto Run thinking chunk.
				const parsed = parseSessionId(sessionId);

				// Interactive tabs carry a real tabId; batch/synopsis spawns don't, so
				// fall back to the full streaming id to keep parallel spawns distinct.
				const tabId = parsed.tabId ?? parsed.actualSessionId;
				const key = `${parsed.baseSessionId}:${tabId}`;
				buffer.set(key, (buffer.get(key) || '') + content);

				if (flushTimerRef.current === null) {
					flushTimerRef.current = setTimeout(flush, THOUGHT_FLUSH_MS);
				}
			}
		);

		return () => {
			unsubscribe?.();
			if (flushTimerRef.current !== null) {
				clearTimeout(flushTimerRef.current);
				flushTimerRef.current = null;
			}
			// Land whatever was mid-coalesce rather than dropping it - a teardown
			// mid-run (window close, hot reload) should not lose the last quarter
			// second of reasoning.
			flush();
		};
	}, [ownedGate]);
}
