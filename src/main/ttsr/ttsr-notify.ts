/**
 * Phase 4a - tell the user their turn was interrupted.
 *
 * A TTSR abort kills an agent mid-sentence and respawns it. That is invisible
 * unless the user happens to be watching that tab, so an interrupt raises a
 * toast on the existing `remote:notifyToast` channel - the same pipeline the
 * CLI's `notify_toast` and Cue's `action: notify` already drive (preload
 * `onRemoteNotifyToast` -> renderer `notifyToast`). No new notification
 * primitive: this module only shapes the params and hands them to the caller's
 * `safeSend`, which also fans the toast out to web-desktop bridge clients.
 *
 * Unlike `emitCueNotifyToast` this takes the injected `safeSend` rather than a
 * `BrowserWindow`, because the TTSR runtime is built with one already and never
 * touches Electron directly.
 */

import { getAgentDisplayName } from '../../shared/agentMetadata';
import type { TtsrToastMarker, TtsrTriggeredPayload } from '../../shared/ttsr-types';
import { resolveOwningMaestroSessionId } from '../coworking/coworking-session-id';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'TTSR';

/** The `remote:notifyToast` payload, narrowed to the fields TTSR sets. */
export interface TtsrToastParams {
	title: string;
	message: string;
	/** Orange announces the interrupt; red says the corrective turn never began. */
	color: 'orange' | 'red';
	/** Sticky: an interrupted turn is worth an explicit acknowledgement. */
	dismissible: true;
	/** Owning agent id, so the renderer can resolve the header strip. */
	sessionId: string;
	tabId?: string;
	clickAction: { kind: 'jump-session'; sessionId: string; tabId?: string };
	/**
	 * Structured detection marker. The display layer (Toast.tsx) reads `mode` to
	 * append the client-specific outcome line; the plain `message` above stays a
	 * sensible fallback for clients that ignore this field. Absent on the failure
	 * toast, whose whole point is that no client-specific outcome happened.
	 */
	ttsr?: TtsrToastMarker;
}

/**
 * Shape the toast for one corrective turn. Exported for tests; production goes
 * through {@link emitTtsrTriggeredToast}.
 *
 * The process id (`{session}-ai-{tab}`) is unwrapped to the bare agent id the
 * renderer keys sessions by - a composite would resolve to no agent, costing
 * both the name in the header strip and click-to-jump.
 */
export function buildTtsrToast(payload: TtsrTriggeredPayload): TtsrToastParams {
	const agentSessionId = resolveOwningMaestroSessionId(payload.sessionId);
	const names = payload.rules.map((rule) => rule.name).join(', ');
	const plural = payload.rules.length === 1 ? 'Rule' : 'Rules';

	// The broadcast payload states only the detection. Whether the corrective
	// turn resumes, restarts, or runs on the desktop app is a client-specific
	// outcome the display layer (Toast.tsx) appends from the `ttsr` marker, so
	// one payload reads correctly on both the desktop renderer and web clients.
	// The plain `message` stays a sensible fallback for clients that ignore the
	// marker. `fresh` is the degraded path (Gate A): the turn restarts from the
	// goal instead of resuming.
	return {
		title: `TTSR interrupted ${getAgentDisplayName(payload.agentId)}`,
		message: `${plural} ${names || '(unnamed)'} fired; the turn was interrupted.`,
		color: 'orange',
		dismissible: true,
		sessionId: agentSessionId,
		tabId: payload.tabId,
		clickAction: { kind: 'jump-session', sessionId: agentSessionId, tabId: payload.tabId },
		ttsr: { mode: payload.mode },
	};
}

/**
 * Shape the toast for a corrective turn that never started. Exported for tests;
 * production goes through {@link emitTtsrFailureToast}.
 *
 * "Did not start" rather than "failed": from main's side the two are
 * indistinguishable (an unacked interrupt looks the same whether the renderer
 * errored or was simply not there), and the honest instruction is the same -
 * open the desktop app, which is the only client that spawns corrective turns.
 * Red and sticky, because this one retracts a promise the orange toast made.
 */
export function buildTtsrFailureToast(
	payload: TtsrTriggeredPayload,
	error?: string
): TtsrToastParams {
	const agentSessionId = resolveOwningMaestroSessionId(payload.sessionId);
	const detail = error ? ` (${error})` : '';

	return {
		title: `TTSR could not resume ${getAgentDisplayName(payload.agentId)}`,
		message: `TTSR interrupted the turn but the corrective turn did not start${detail} - open the desktop app.`,
		color: 'red',
		dismissible: true,
		sessionId: agentSessionId,
		tabId: payload.tabId,
		clickAction: { kind: 'jump-session', sessionId: agentSessionId, tabId: payload.tabId },
	};
}

/**
 * Raise the interrupt toast. Never throws: a toast is advisory, and the
 * corrective turn must run whether or not the renderer was reachable.
 */
export function emitTtsrTriggeredToast(
	safeSend: (channel: string, ...args: unknown[]) => void,
	payload: TtsrTriggeredPayload
): void {
	try {
		safeSend('remote:notifyToast', buildTtsrToast(payload));
	} catch (err) {
		logger.warn('Failed to send TTSR interrupt toast', LOG_CONTEXT, {
			sessionId: payload.sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Raise the "corrective turn did not start" toast. Never throws, for the same
 * reason as {@link emitTtsrTriggeredToast}: it is called from a watchdog timer,
 * where an exception would have nowhere to go.
 */
export function emitTtsrFailureToast(
	safeSend: (channel: string, ...args: unknown[]) => void,
	payload: TtsrTriggeredPayload,
	error?: string
): void {
	try {
		safeSend('remote:notifyToast', buildTtsrFailureToast(payload, error));
	} catch (err) {
		logger.warn('Failed to send TTSR corrective-failure toast', LOG_CONTEXT, {
			sessionId: payload.sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
