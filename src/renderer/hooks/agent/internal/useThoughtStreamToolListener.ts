/**
 * useThoughtStreamToolListener - feeds tool calls into the Thought Stream panel.
 *
 * The sibling `useAgentToolExecutionListener` writes tool cells into a tab's
 * logs, but only when that tab's `showThinking` mode is on, and it matches the
 * streaming id with `REGEX_AI_TAB` alone - so an Auto Run (which spawns with a
 * `{sessionId}-batch-{timestamp}` id) never produces one. Both of those are why
 * the live activity feed cannot read from tab logs and taps the raw
 * `process:tool-execution` stream here instead, resolving the id with
 * `parseSessionId` so batch/synopsis spawns land on the right session.
 *
 * Cheap by default: every event hits a single early-out
 * (`capturing[sessionId]`) and does nothing unless that session has an open or
 * minimized capture. No coalescing - tool calls arrive per agent action, not per
 * frame, so each one is a single store write.
 */

import { useEffect } from 'react';
import { useThoughtStreamStore, type ToolActivityStatus } from '../../../stores/thoughtStreamStore';
import { parseSessionId } from '../../../utils/sessionIdParser';
import { describeToolActivity } from '../../../utils/toolActivityLabel';
import { useOwnedSessionGate } from './useOwnedSessionGate';

/**
 * Normalize the provider's tool status onto the feed's three states. Providers
 * disagree on the failure word (`failed` vs `error`) and omit the field entirely
 * for fire-and-forget events, which are treated as still running.
 */
function toActivityStatus(status: unknown): ToolActivityStatus {
	if (status === 'completed' || status === 'success') return 'completed';
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
				const baseSessionId = parsed.baseSessionId;

				// Early-out: skip all work unless this session is being captured.
				if (!useThoughtStreamStore.getState().capturing[baseSessionId]) return;

				// Interactive tabs carry a real tabId; batch/synopsis spawns don't, so
				// fall back to the full streaming id to keep parallel spawns distinct.
				const tabId = parsed.tabId ?? parsed.actualSessionId;

				const state = toolEvent.state as { status?: unknown; input?: unknown } | undefined;
				const { verb, target } = describeToolActivity(toolEvent.toolName, state?.input);

				useThoughtStreamStore.getState().appendToolActivity(baseSessionId, tabId, {
					toolName: toolEvent.toolName,
					verb,
					target,
					status: toActivityStatus(state?.status),
					toolCallId: toolEvent.toolCallId,
					timestamp: toolEvent.timestamp,
				});
			}
		);

		return () => {
			unsubscribe?.();
		};
	}, [ownedGate]);
}
