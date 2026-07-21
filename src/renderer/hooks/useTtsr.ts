/**
 * Renderer half of the TTSR interrupt loop (plan Phase 3b).
 *
 * Main aborts the offending turn on its own (no round-trip - bad output has to
 * stop as soon as a rule matches) and then hands the renderer everything needed
 * to continue the conversation. This hook performs that corrective respawn and
 * keeps the tab's UI honest while it happens:
 *
 * - `ttsr:abortPending` marks the turn so the exit that follows is treated as a
 *   TTSR interruption rather than a failed turn.
 * - `ttsr:triggered` respawns the turn with the `<system-interrupt>` prompt,
 *   resuming the provider session when Gate A says the agent can (or starting a
 *   fresh, goal-restating turn when it cannot).
 * - `ttsr:abortCleared` releases that mark when main withdraws an abort, so a
 *   turn that was never actually stopped is not left suppressed forever.
 *
 * Mount once, gated on the `ttsr` Encore feature.
 */

import { useEffect } from 'react';
import type { TtsrTriggeredPayload } from '../../shared/ttsr-types';
import { logger } from '../utils/logger';
import { generateId } from '../utils/ids';
import { prepareMaestroSystemPrompt } from '../utils/spawnHelpers';
import { buildTtsrRespawnConfig, resolveTtsrTarget } from '../utils/ttsrRespawn';
import { processService } from '../services/process';
import { getBatchState, selectAutoRunForcesReadOnly } from '../stores/batchStore';
import { notifyToast } from '../stores/notificationStore';
import { useSessionStore, updateAiTab, updateSessionWith } from '../stores/sessionStore';
import { useTtsrStore } from '../stores/ttsrStore';
import { useOwnedSessionGate } from './agent/internal/useOwnedSessionGate';
import type { LogEntry, Session } from '../types';

function systemLog(text: string): LogEntry {
	return { id: generateId(), timestamp: Date.now(), source: 'system', text };
}

/** One line in the transcript so the interruption is visible, not silent. */
function interruptionNotice(payload: TtsrTriggeredPayload): string {
	const names = payload.rules.map((rule) => rule.name).join(', ');
	const how =
		payload.mode === 'resume'
			? 'resuming the conversation'
			: 'restarting the turn (this agent cannot resume mid-turn)';
	return `TTSR interrupted this turn - rule${payload.rules.length === 1 ? '' : 's'}: ${names}. Reinjecting corrective guidance and ${how}.`;
}

/**
 * Hand the session back to the user after a corrective turn that never started.
 *
 * The aborted turn's exit was SUPPRESSED by the abort-pending flag (see
 * `useAgentExitListener`), so nothing downstream will ever clear the busy state:
 * without this the agent keeps its spinner and queue dispatch stays blocked
 * until the app is reloaded. The tab, the session, the flag, and the user all
 * have to be told, because each of them was left mid-turn.
 */
function releaseAfterFailedRespawn(
	session: Session,
	tabId: string,
	payload: TtsrTriggeredPayload,
	error: unknown
): void {
	const message = error instanceof Error ? error.message : String(error);

	updateAiTab(session.id, tabId, (current) => ({
		...current,
		state: 'idle',
		thinkingStartTime: undefined,
		logs: [...current.logs, systemLog(`TTSR could not resume the turn: ${message}`)],
	}));
	updateSessionWith(session.id, (current) => ({
		...current,
		state: 'idle',
		busySource: undefined,
		thinkingStartTime: undefined,
	}));
	useTtsrStore.getState().clearAbortPending(payload.sessionId);

	notifyToast({
		color: 'red',
		title: 'TTSR',
		message: `Interrupted by ${payload.rules.map((rule) => rule.name).join(', ')}, but the turn could not be resumed: ${message}`,
	});
}

/**
 * Spawn the corrective turn for one `ttsr:triggered` payload.
 *
 * Exported for tests; the hook is a thin subscription around it.
 */
export async function runTtsrCorrectiveTurn(payload: TtsrTriggeredPayload): Promise<boolean> {
	const target = resolveTtsrTarget(useSessionStore.getState().sessions, payload);
	if (!target) {
		// The tab went away while the abort was in flight (session closed, tab
		// deleted). There is nothing left to correct - but the abort-pending mark
		// has to go, or it would suppress exits on that id for good.
		logger.warn('[TTSR] No tab for corrective turn, dropping', undefined, {
			sessionId: payload.sessionId,
		});
		useTtsrStore.getState().clearAbortPending(payload.sessionId);
		return false;
	}

	const { session, tab } = target;
	try {
		const agent = await window.maestro.agents.get(payload.agentId);
		if (!agent) throw new Error(`${payload.agentId} agent not found`);

		const appendSystemPrompt = await prepareMaestroSystemPrompt({
			session,
			activeTabId: tab.id,
		});

		const config = buildTtsrRespawnConfig({
			payload,
			session,
			tab,
			agent,
			appendSystemPrompt,
			autoRunForcesReadOnly: selectAutoRunForcesReadOnly(getBatchState(), session.id),
		});

		// Busy before the spawn: the aborted turn's exit was suppressed, so the tab
		// still reads busy from the user's side, and the transcript line has to say
		// why the turn stopped before the corrective one starts.
		updateAiTab(session.id, tab.id, (current) => ({
			...current,
			logs: [...current.logs, systemLog(interruptionNotice(payload))],
			state: 'busy',
			thinkingStartTime: Date.now(),
			agentError: undefined,
		}));

		await processService.spawn(config);
		return true;
	} catch (error) {
		logger.error('[TTSR] Corrective turn failed to spawn', undefined, error);
		releaseAfterFailedRespawn(session, tab.id, payload, error);
		return false;
	}
}

/**
 * Subscribe to the TTSR push events and drive the corrective respawn.
 */
export function useTtsr(enabled: boolean): void {
	// `ttsr:triggered` is broadcast to EVERY window and to every web-desktop
	// bridge client (see the MULTI-WINDOW INVARIANT in `safe-send.ts`), so the
	// corrective respawn has to be window-scoped exactly like the `process:*`
	// listeners are. Two renderers spawning it would race in ProcessManager:
	// the second spawn kills the first mid-flight, and if the first already
	// reached the provider the `<system-interrupt>` lands twice.
	const ownedGate = useOwnedSessionGate();

	useEffect(() => {
		if (!enabled) return;
		// The bridge is absent in older preloads and in some web-desktop builds;
		// TTSR degrades to detection-only rather than crashing the renderer.
		const bridge = window.maestro?.ttsr;
		if (!bridge) return;

		const offAbortPending = bridge.onAbortPending((payload) => {
			useTtsrStore.getState().noteAbortPending(payload);
		});

		const offTriggered = bridge.onTriggered((payload) => {
			// Display state is per-renderer, so every window records the payload;
			// only the owning one actually respawns the turn.
			useTtsrStore.getState().noteTriggered(payload);
			if (!ownedGate.current?.(payload.sessionId)) return;
			void runTtsrCorrectiveTurn(payload);
		});

		// Main withdrew the abort: the turn was never stopped, so exit handling has
		// to be released or the tab stays busy for good.
		const offAbortCleared = bridge.onAbortCleared((payload) => {
			logger.warn('[TTSR] Abort withdrawn, no corrective turn', undefined, {
				sessionId: payload.sessionId,
				reason: payload.reason,
			});
			useTtsrStore.getState().clearAbortPending(payload.sessionId);
		});

		return () => {
			offAbortPending();
			offTriggered();
			offAbortCleared();
			// Nothing is listening for `ttsr:triggered` any more, so any mark still
			// standing can never be cleared by the normal path - and a standing mark
			// suppresses that session's exits for good. Drop them with the listeners.
			useTtsrStore.getState().clearAllAbortPending();
		};
	}, [enabled, ownedGate]);
}
