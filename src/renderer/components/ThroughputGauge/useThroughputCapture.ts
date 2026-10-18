/**
 * useThroughputCapture - feeds the Throughput Gauge from live agent output.
 *
 * Mounted only while the `throughputGauge` Encore Feature is on, so with the
 * feature off no listener and no timer exist. While mounted it routes the raw
 * `process:*` stream into one module-level rate engine
 * (`src/shared/throughputRate.ts`) and publishes its rolling rates to
 * `throughputGaugeStore` on a timer:
 *
 * - `onThinkingChunk` -> `recordStreamedText`: the live signal.
 * - `onData` -> `recordReplyText`, NEVER `recordStreamedText`: for structured
 *   output providers this is the finished reply re-sent at turn end, after the
 *   usage report that already counted it. The engine's reply latch refuses it.
 * - `onCallUsage` -> `recordCallUsage`: one API call's real spend as it lands
 *   (claude-code). The live signal for a turn that is mostly tool calls, whose
 *   text is too thin (or redacted) to estimate from.
 * - `onUsage` -> `recordUsage` with the agent's `toolType`, which decides
 *   whether cache reads sit inside `inputTokens`.
 * - `onExit` -> `forgetSource`, so per-turn state never accumulates.
 *
 * Every source is keyed by its RAW process session id (a forced-parallel turn
 * runs beside the tab's normal one); the agent id is only the scope key.
 *
 * Only agent turns count: `ai-tab`, `legacy-ai`, `batch` (Auto Run) and
 * `synopsis` are real model throughput. `regular` covers the command terminal
 * (`{id}-terminal`) and bare-id shell output, which are not tokens. Group chat
 * (`group-chat-*`) is left out for now: only its usage reaches the renderer,
 * and it belongs to no single agent to scope on. It is refused by its prefix,
 * not by the parse: a participant's name is user-supplied, so
 * `group-chat-{id}-participant-my-ai-agent-{ts}` parses as an AI tab.
 *
 * Each tick reads `throughputGaugeSettings` and the active agent from their
 * stores at tick time, never through the effect's dependencies, so changing a
 * setting or switching agents never tears down and resubscribes the listeners.
 * Scope `active` counts only the active agent's samples; the rolling window is
 * the user's. A peak or history measured under another scope, agent, or window
 * is not comparable, so a change of any of them restarts both.
 *
 * Publishing runs on a `setInterval`, not `requestAnimationFrame`, for the
 * reason `useThoughtStreamCaptureListener` gives: rAF stops while the window is
 * hidden, and a timer keeps the reading honest for an unattended run.
 */

import { useEffect } from 'react';
import { GROUP_CHAT_PREFIX } from '../../../shared/maestro-lib/groupchat/session-ids';
import {
	createThroughputTracker,
	type ThroughputRates,
	type ThroughputSample,
} from '../../../shared/throughputRate';
import { useOwnedSessionGate } from '../../hooks/agent/internal/useOwnedSessionGate';
import { selectActiveSession, selectSessionById, useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useThroughputGaugeStore } from '../../stores/throughputGaugeStore';
import { parseSessionId } from '../../utils/sessionIdParser';

/** How often the gauge reads the engine and publishes to the store. */
export const THROUGHPUT_PUBLISH_MS = 250;

const ZERO_RATES: ThroughputRates = { in: 0, out: 0, combined: 0 };

/**
 * The one engine instance. Module-level so the hook's effect can re-subscribe
 * without losing the window of samples; cleared when the hook unmounts.
 */
export const throughputTracker = createThroughputTracker();

export function useThroughputCapture(): void {
	const ownedGate = useOwnedSessionGate();

	useEffect(() => {
		const processApi = window.maestro.process;

		/** The agent id a raw process id counts toward, or null when it does not count. */
		const agentTurnOf = (rawSessionId: string): string | null => {
			if (rawSessionId.startsWith(GROUP_CHAT_PREFIX)) return null;
			if (!ownedGate.current?.(rawSessionId)) return null;
			const parsed = parseSessionId(rawSessionId);
			return parsed.type === 'regular' ? null : parsed.baseSessionId;
		};

		const providerOf = (agentId: string) =>
			selectSessionById(agentId)(useSessionStore.getState())?.toolType;

		const unsubscribers = [
			processApi.onThinkingChunk?.((sessionId: string, content: string) => {
				const agentId = agentTurnOf(sessionId);
				if (agentId === null) return;
				throughputTracker.recordStreamedText(sessionId, agentId, content, performance.now());
			}),
			processApi.onData((sessionId: string, data: string) => {
				const agentId = agentTurnOf(sessionId);
				if (agentId === null) return;
				throughputTracker.recordReplyText(sessionId, agentId, data, performance.now());
			}),
			processApi.onCallUsage?.((sessionId, usage) => {
				const agentId = agentTurnOf(sessionId);
				if (agentId === null) return;
				throughputTracker.recordCallUsage(
					sessionId,
					agentId,
					usage,
					performance.now(),
					providerOf(agentId)
				);
			}),
			processApi.onUsage((sessionId, usageStats) => {
				const agentId = agentTurnOf(sessionId);
				if (agentId === null) return;
				throughputTracker.recordUsage(
					sessionId,
					agentId,
					usageStats,
					performance.now(),
					providerOf(agentId)
				);
			}),
			processApi.onExit((sessionId: string) => {
				// Not gated: forgetting a source this window never tracked is a no-op.
				throughputTracker.forgetSource(sessionId);
			}),
		];

		// Scope, agent, and window of the last tick. `null` until the first tick,
		// which has nothing earlier to be incomparable with.
		let readingRule: string | null = null;

		const timer = setInterval(() => {
			const now = performance.now();
			throughputTracker.prune(now);
			const { scope, windowMs } = useSettingsStore.getState().throughputGaugeSettings;
			const activeAgentId =
				scope === 'active' ? (selectActiveSession(useSessionStore.getState())?.id ?? null) : null;
			const gauge = useThroughputGaugeStore.getState();

			const rule = `${scope}:${activeAgentId ?? ''}:${windowMs}`;
			if (readingRule !== null && rule !== readingRule) gauge.restartReadings();
			readingRule = rule;

			// Active scope with no agent at all reads zero rather than everything.
			const filter =
				scope === 'active'
					? (sample: ThroughputSample) => sample.agentId === activeAgentId
					: undefined;
			gauge.publish(throughputTracker.rates(now, windowMs, filter));
		}, THROUGHPUT_PUBLISH_MS);

		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe?.();
			clearInterval(timer);
			throughputTracker.clear();
			// Drop every reading: a gauge switched off mid-stream must not come back
			// showing the rate, the peak, or the sparkline trace it had when it left.
			const gauge = useThroughputGaugeStore.getState();
			gauge.restartReadings();
			gauge.publish(ZERO_RATES);
		};
	}, [ownedGate]);
}
