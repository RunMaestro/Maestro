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
import type { TtsrTriggeredPayload } from '../../shared/ttsr-types';
import { resolveOwningMaestroSessionId } from '../coworking/coworking-session-id';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'TTSR';

/** The `remote:notifyToast` payload, narrowed to the fields TTSR sets. */
export interface TtsrToastParams {
	title: string;
	message: string;
	color: 'orange';
	/** Sticky: an interrupted turn is worth an explicit acknowledgement. */
	dismissible: true;
	/** Owning agent id, so the renderer can resolve the header strip. */
	sessionId: string;
	tabId?: string;
	clickAction: { kind: 'jump-session'; sessionId: string; tabId?: string };
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
	// `fresh` is the degraded path (Gate A): the turn restarts from the goal
	// instead of resuming, which is a visible difference worth naming.
	const outcome =
		payload.mode === 'resume'
			? 'Resuming with corrective guidance.'
			: 'Restarting the turn with corrective guidance.';

	return {
		title: `TTSR interrupted ${getAgentDisplayName(payload.agentId)}`,
		message: `${plural} ${names || '(unnamed)'} fired. ${outcome}`,
		color: 'orange',
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
