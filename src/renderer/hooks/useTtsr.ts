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
 * - `ttsr:matched` counts every match, interrupting or not, into the display
 *   store so the Rules panel can show that a `never`-mode rule fired at all.
 * - `ttsr:correctiveResult` reports back whether the respawn happened, so main
 *   can retract its optimistic interrupt toast on every client when it did not.
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
import { isWebDesktop } from '../utils/runtimeContext';
import { useOwnedSessionGate } from './agent/internal/useOwnedSessionGate';
import type { LogEntry, Session } from '../types';

function systemLog(text: string): LogEntry {
	return { id: generateId(), timestamp: Date.now(), source: 'system', text };
}

/**
 * The badged user entry that marks the `<system-interrupt>` injection in the
 * transcript. Carries the rendered injection prompt as its text (collapsed by
 * default in LogItem) and a `ttsr` marker so the boundary is visible - both in
 * the live tab and, via normal log persistence, in History.
 */
function ttsrInjectionLog(payload: TtsrTriggeredPayload): LogEntry {
	return {
		id: generateId(),
		timestamp: Date.now(),
		source: 'user',
		text: payload.injectionPrompt,
		ttsr: {
			rules: payload.rules.map((rule) => rule.name),
			mode: payload.mode,
		},
	};
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
 * Web-desktop transcript notice. Same boundary marker as
 * {@link interruptionNotice}, but the corrective turn is spawned by the desktop
 * renderer, not here - so the tail tells the web user where the output comes
 * from instead of claiming this client is resuming anything.
 */
function webInterruptionNotice(payload: TtsrTriggeredPayload): string {
	const names = payload.rules.map((rule) => rule.name).join(', ');
	return `TTSR interrupted this turn - rule${payload.rules.length === 1 ? '' : 's'}: ${names}. The corrective turn is run by the desktop app; its output will appear here.`;
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
	// Session-level release follows the same rule as `useAgentExitListener`:
	// another tab mid-turn keeps the agent busy. Only the interrupted tab's turn
	// died here; flipping the whole session idle would wipe a sibling tab's
	// spinner (and thinkingStartTime) while it is still streaming.
	updateSessionWith(session.id, (current) => {
		const anyTabStillBusy = current.aiTabs.some((tab) => tab.state === 'busy');
		return anyTabStillBusy
			? current
			: { ...current, state: 'idle', busySource: undefined, thinkingStartTime: undefined };
	});
	useTtsrStore.getState().clearAbortPending(payload.sessionId);

	notifyToast({
		color: 'red',
		title: 'TTSR',
		message: `Interrupted by ${payload.rules.map((rule) => rule.name).join(', ')}, but the turn could not be resumed: ${message}`,
	});
}

/**
 * Tell main whether the corrective turn started.
 *
 * Main raised the interrupt toast optimistically and armed a watchdog; this ack
 * is what cancels it. Advisory in both directions: a preload without the method
 * (older build, some web-desktop shims) just falls through to main's timeout,
 * which raises the same failure toast a beat later.
 */
function reportCorrectiveResult(sessionId: string, ok: boolean, error?: string): void {
	const report = window.maestro?.ttsr?.reportCorrectiveResult;
	if (!report) return;
	void report({ sessionId, ok, error })?.catch((err: unknown) => {
		logger.warn('[TTSR] Could not report corrective result', undefined, {
			sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
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
		reportCorrectiveResult(payload.sessionId, false, 'the tab no longer exists');
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
		// why the turn stopped before the corrective one starts. The gray system line
		// narrates the abort; the badged `source: 'user'` entry marks the actual
		// `<system-interrupt>` injection so it shows the TTSR boundary in the
		// transcript and rides normal log persistence into History.
		updateAiTab(session.id, tab.id, (current) => ({
			...current,
			logs: [...current.logs, systemLog(interruptionNotice(payload)), ttsrInjectionLog(payload)],
			state: 'busy',
			thinkingStartTime: Date.now(),
			agentError: undefined,
		}));

		await processService.spawn(config);
		// Acked only after the spawn returns: the promise the interrupt toast made
		// is "the turn is being corrected", and until this resolves it is not.
		reportCorrectiveResult(payload.sessionId, true);
		return true;
	} catch (error) {
		logger.error('[TTSR] Corrective turn failed to spawn', undefined, error);
		releaseAfterFailedRespawn(session, tab.id, payload, error);
		reportCorrectiveResult(
			payload.sessionId,
			false,
			error instanceof Error ? error.message : String(error)
		);
		return false;
	}
}

/**
 * Subscribe to the TTSR push events and drive the corrective respawn.
 */
export function useTtsr(enabled: boolean): void {
	// `ttsr:triggered` is broadcast to EVERY window and to every web-desktop
	// bridge client (see the MULTI-WINDOW INVARIANT in `safe-send.ts`), so the
	// corrective respawn has to be spawned by exactly one renderer. Two spawning
	// it would race in ProcessManager: the second spawn kills the first
	// mid-flight, and if the first already reached the provider the
	// `<system-interrupt>` lands twice. Desktop windows are covered by the
	// ownership gate below; web-desktop clients are NOT (their `ownsSession` is
	// a permit-all by design - a browser client mirrors every agent), so they
	// never respawn at all. The desktop primary window is always alive to do it:
	// the web server that serves these clients runs inside the Electron app.
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
			// only the owning desktop window actually respawns the turn.
			useTtsrStore.getState().noteTriggered(payload);
			if (isWebDesktop()) {
				// Web-desktop clients never spawn the corrective turn (see the
				// MULTI-WINDOW INVARIANT below); the desktop primary window does.
				// But the transcript must not stop mid-sentence with no boundary,
				// so append a notice explaining where the correction runs. Do NOT
				// flip the tab to busy: the mirrored process:* events from the
				// desktop-spawned turn already drive the visible streaming here.
				const target = resolveTtsrTarget(useSessionStore.getState().sessions, payload);
				if (target) {
					updateAiTab(target.session.id, target.tab.id, (current) => ({
						...current,
						logs: [...current.logs, systemLog(webInterruptionNotice(payload))],
					}));
				}
				return;
			}
			if (!ownedGate.current?.(payload.sessionId)) return;
			void runTtsrCorrectiveTurn(payload);
		});

		// Every match, interrupting or not, is counted for the Rules panel's match
		// line - a `never`-mode rule otherwise fires in complete silence, which
		// users read as TTSR being broken. Display-only: EVERY client records
		// (desktop, extra windows, web-desktop), because the store is per-renderer
		// display state, so there is no ownership gate and no `isWebDesktop()`
		// branch here. Older preloads and some web-desktop builds lack the method;
		// TTSR degrades rather than crashing, same as the missing-bridge case.
		const offMatched = bridge.onMatched
			? bridge.onMatched((payload) => {
					const target = resolveTtsrTarget(useSessionStore.getState().sessions, payload);
					// No tab means no project root to key the counts by. Nothing was
					// reserved for this payload, so dropping it costs a display line.
					if (!target) return;
					useTtsrStore.getState().noteMatched(target.session.cwd, payload);
				})
			: undefined;

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
			offMatched?.();
			// Nothing is listening for `ttsr:triggered` any more, so any mark still
			// standing can never be cleared by the normal path - and a standing mark
			// suppresses that session's exits for good. Drop them with the listeners.
			useTtsrStore.getState().clearAllAbortPending();
		};
	}, [enabled, ownedGate]);
}
