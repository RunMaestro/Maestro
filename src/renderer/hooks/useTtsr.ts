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
import { useSessionStore, updateAiTab } from '../stores/sessionStore';
import { useTtsrStore } from '../stores/ttsrStore';
import type { LogEntry } from '../types';

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
 * Spawn the corrective turn for one `ttsr:triggered` payload.
 *
 * Exported for tests; the hook is a thin subscription around it.
 */
export async function runTtsrCorrectiveTurn(payload: TtsrTriggeredPayload): Promise<boolean> {
	const target = resolveTtsrTarget(useSessionStore.getState().sessions, payload);
	if (!target) {
		// The tab went away while the abort was in flight (session closed, tab
		// deleted). There is nothing left to correct.
		logger.warn('[TTSR] No tab for corrective turn, dropping', undefined, {
			sessionId: payload.sessionId,
		});
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
		});

		// Back to busy before the spawn: the aborted turn's exit already flipped
		// this tab to idle, and leaving it there would let the queue dispatch
		// another turn onto the same process session id.
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
		updateAiTab(session.id, tab.id, (current) => ({
			...current,
			state: 'idle',
			thinkingStartTime: undefined,
			logs: [
				...current.logs,
				systemLog(`TTSR could not resume the turn: ${(error as Error).message}`),
			],
		}));
		return false;
	}
}

/**
 * Subscribe to the TTSR push events and drive the corrective respawn.
 */
export function useTtsr(enabled: boolean): void {
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
			useTtsrStore.getState().noteTriggered(payload);
			void runTtsrCorrectiveTurn(payload);
		});

		return () => {
			offAbortPending();
			offTriggered();
		};
	}, [enabled]);
}
