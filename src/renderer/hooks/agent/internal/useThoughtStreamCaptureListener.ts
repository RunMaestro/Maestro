/**
 * useThoughtStreamCaptureListener - feeds the Thought Stream panel.
 *
 * Subscribes to the same raw `process:thinking-chunk` IPC stream as
 * `useAgentThinkingListener`, but routes chunks into `thoughtStreamStore`
 * INDEPENDENT of any tab's `showThinking` setting. This is what lets a user
 * introspect an Auto Run's reasoning even when thinking display is off.
 *
 * Cheap by default: every chunk hits a single early-out
 * (`capturing[sessionId]`) and does nothing unless that session has an open or
 * minimized capture. Active captures are coalesced per `requestAnimationFrame`
 * (same approach as the thinking-log listener) so a high-frequency stream
 * becomes one store write per frame.
 */

import { useEffect, useRef } from 'react';
import { useThoughtStreamStore } from '../../../stores/thoughtStreamStore';
import { parseSessionId } from '../../../utils/sessionIdParser';
import { useOwnedSessionGate } from './useOwnedSessionGate';

export function useThoughtStreamCaptureListener(): void {
	const bufferRef = useRef<Map<string, string>>(new Map());
	const rafIdRef = useRef<number | null>(null);
	const ownedGate = useOwnedSessionGate();

	useEffect(() => {
		const buffer = bufferRef.current;

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
				const baseSessionId = parsed.baseSessionId;

				// Early-out: skip all work unless this session is being captured.
				if (!useThoughtStreamStore.getState().capturing[baseSessionId]) return;

				// Interactive tabs carry a real tabId; batch/synopsis spawns don't, so
				// fall back to the full streaming id to keep parallel spawns distinct.
				const tabId = parsed.tabId ?? parsed.actualSessionId;
				const key = `${baseSessionId}:${tabId}`;
				bufferRef.current.set(key, (bufferRef.current.get(key) || '') + content);

				if (rafIdRef.current === null) {
					rafIdRef.current = requestAnimationFrame(() => {
						rafIdRef.current = null;
						const chunks = new Map(bufferRef.current);
						bufferRef.current.clear();
						const appendThought = useThoughtStreamStore.getState().appendThought;
						for (const [chunkKey, text] of chunks) {
							const sepIndex = chunkKey.indexOf(':');
							const sid = chunkKey.slice(0, sepIndex);
							const tid = chunkKey.slice(sepIndex + 1);
							appendThought(sid, tid, text);
						}
					});
				}
			}
		);

		return () => {
			unsubscribe?.();
			if (rafIdRef.current !== null) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = null;
			}
			buffer.clear();
		};
	}, [ownedGate]);
}
