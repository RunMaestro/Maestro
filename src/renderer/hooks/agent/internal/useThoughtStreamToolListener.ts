/**
 * useThoughtStreamToolListener - feeds the ACTION half of the Thought Stream.
 *
 * Subscribes to the same raw `process:tool-execution` IPC stream as
 * `useAgentToolExecutionListener`, but routes events into `thoughtStreamStore`
 * rather than into a tab's logs. Two things make that a separate listener
 * rather than a second consumer of the existing one:
 *
 * 1. The in-chat listener resolves the streaming id with `REGEX_AI_TAB` alone,
 *    so an Auto Run - which spawns as `{sessionId}-batch-{timestamp}` - has
 *    every tool call dropped. That is less a bug in that listener than a
 *    consequence of what it does: it writes into `aiTabs[tabId].logs`, and a
 *    batch spawn has no tab to write into. An Auto Run therefore has no
 *    transcript that could carry its tool calls, which is exactly the gap this
 *    fills.
 * 2. The transcript only RENDERS tool entries when the tab's tool-call
 *    visibility is on. The Thought Stream is explicitly the surface for
 *    watching a run you are not otherwise watching, so it must not inherit a
 *    display setting.
 *
 * Scope matches the thinking listener exactly - `AUTO_RUN_SESSION_TYPES`, i.e.
 * Auto Run and nothing else - and imports that set rather than restating it.
 * The two listeners feed ONE timeline, so any divergence in what they admit
 * would interleave a run's actions with some other stream's reasoning. It also
 * keeps the panel from filling with ordinary conversation, which is the
 * over-capture that set is there to prevent.
 *
 * Capture is ambient, matching the thinking listener: a user opens this panel
 * BECAUSE a run has been burning tokens for ten minutes, and a feed that only
 * started recording at open time would hand them an empty list at exactly the
 * moment the history is the answer.
 *
 * There is no rAF/timer coalescing here, unlike the thinking stream. Thinking
 * arrives as a token-rate chunk firehose; tool calls arrive once per agent
 * action, which is orders of magnitude slower and already the granularity the
 * feed displays.
 */

import { useEffect } from 'react';
import { useThoughtStreamStore, type ToolActivityStatus } from '../../../stores/thoughtStreamStore';
import { parseSessionId } from '../../../utils/sessionIdParser';
import { describeToolActivity } from '../../../utils/toolActivityLabel';
import { AUTO_RUN_SESSION_TYPES } from './useThoughtStreamCaptureListener';
import { useOwnedSessionGate } from './useOwnedSessionGate';

/** The tool lifecycle payload, as providers deliver it over IPC. */
interface ToolEventState {
	status?: string;
	input?: unknown;
	output?: unknown;
}

/**
 * Normalize provider status wording onto the three states the feed renders.
 * `error` and `failed` are the same outcome spelled two ways; anything absent
 * or unrecognized means the call is still in flight, which is the reading that
 * cannot mislead - it resolves itself the moment a completion arrives.
 */
function normalizeStatus(status: string | undefined): ToolActivityStatus {
	if (status === 'completed') return 'completed';
	if (status === 'failed' || status === 'error') return 'failed';
	return 'running';
}

export function useThoughtStreamToolListener(): void {
	const ownedGate = useOwnedSessionGate();

	useEffect(() => {
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

				const parsed = parseSessionId(sessionId);
				// Auto Run only - see AUTO_RUN_SESSION_TYPES. Adding a new Auto Run
				// spawn shape means adding its type there, once, for both listeners.
				if (!AUTO_RUN_SESSION_TYPES.has(parsed.type)) return;

				// Interactive tabs carry a real tabId; batch/synopsis spawns don't, so
				// fall back to the full streaming id to keep parallel spawns distinct.
				// This mirrors the thinking listener exactly, so a tool call and the
				// reasoning around it land on the SAME timeline under the same tab key
				// - which is what lets the feed interleave them.
				const tabId = parsed.tabId ?? parsed.actualSessionId;

				const state = (toolEvent.state ?? undefined) as ToolEventState | undefined;
				useThoughtStreamStore.getState().appendToolActivity(parsed.baseSessionId, tabId, {
					toolName: toolEvent.toolName,
					label: describeToolActivity(toolEvent.toolName, state?.input),
					status: normalizeStatus(state?.status),
					toolCallId: toolEvent.toolCallId,
					// Use the provider's own timestamp so a call's position on the
					// timeline reflects when it happened, not when we processed it.
					timestamp: toolEvent.timestamp,
				});
			}
		);

		return () => {
			unsubscribe?.();
		};
	}, [ownedGate]);
}
