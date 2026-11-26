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
 * Chunks are coalesced on a THOUGHT_FLUSH_MS timer by `createThoughtCoalescer()`,
 * the same coalescer a hosted run's reasoning goes through (`hostedAgentSync`).
 */

import { useEffect } from 'react';
import { createThoughtCoalescer } from '../../../stores/thoughtStreamStore';
import { parseSessionId } from '../../../utils/sessionIdParser';
import type { ParsedSessionId } from '../../../utils/sessionIdParser';
import { useOwnedSessionGate } from './useOwnedSessionGate';

export { THOUGHT_FLUSH_MS } from '../../../stores/thoughtStreamStore';

/**
 * Streaming-id types the Thought Stream captures.
 *
 * Only Auto Run. Every in-app Auto Run path - the document loop, the batch
 * processor and the goal runner - funnels through `spawnAgentForSession`
 * (useAgentExecution), which mints exactly one shape, `{sessionId}-batch-{ts}`.
 * That single mint site is why this is a one-element set rather than a guess.
 *
 * Deliberately excluded:
 * - `ai-tab` / `legacy-ai`: ordinary conversation. This is the leak that made
 *   the panel show chat alongside a run.
 * - `synopsis`: background summarization of a finished turn. Not conversational,
 *   but not an Auto Run either, and attributing it to a run would misread it.
 * - `regular`: an unrecognized shape. Capturing the unknown is what produced the
 *   over-broad behaviour this replaces.
 */
export const AUTO_RUN_SESSION_TYPES: ReadonlySet<ParsedSessionId['type']> = new Set(['batch']);

export function useThoughtStreamCaptureListener(): void {
	const ownedGate = useOwnedSessionGate();

	useEffect(() => {
		const coalescer = createThoughtCoalescer();

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

				// ...and resolving them all to one base id is also why they MERGED: an
				// Auto Run and an ordinary chat in the same agent share a base session
				// id, so the run's Thoughts panel showed the conversation too. The base
				// id says which agent; only `type` says which kind of run, so the kind
				// is the gate and the base id stays the key.
				//
				// Adding a new Auto Run spawn shape means adding its type HERE. Leaving
				// it out reproduces the original bug - silently dropping that run's
				// thinking - so the set is asserted in this hook's tests rather than
				// left to be discovered.
				if (!AUTO_RUN_SESSION_TYPES.has(parsed.type)) return;

				// Interactive tabs carry a real tabId; batch/synopsis spawns don't, so
				// fall back to the full streaming id to keep parallel spawns distinct.
				const tabId = parsed.tabId ?? parsed.actualSessionId;
				coalescer.add(parsed.baseSessionId, tabId, content);
			}
		);

		return () => {
			unsubscribe?.();
			// Land whatever was mid-coalesce rather than dropping it - a teardown
			// mid-run (window close, hot reload) should not lose the last quarter
			// second of reasoning.
			coalescer.dispose();
		};
	}, [ownedGate]);
}
