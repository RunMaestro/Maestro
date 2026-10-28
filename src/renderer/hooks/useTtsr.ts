/** TTSR offers corrections to the same persisted queue and Steer owner as the composer. */
import { useEffect } from 'react';
import type { QueueSteerResult } from '../../shared/chatSteering';
import type { TtsrTriggeredPayload } from '../../shared/ttsr-types';
import { steerQueuedItem } from '../services/chatSteering';
import { flushSessionPersistenceNow } from '../services/sessionPersistenceFlush';
import {
	buildQueuedMessageItem,
	removeQueuedItem,
	setQueuedItemPaused,
} from '../services/queuedPrompt';
import { notifyToast } from '../stores/notificationStore';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { useTtsrStore } from '../stores/ttsrStore';
import { getSteerEligibility } from '../utils/executionQueue';
import { isWebDesktop } from '../utils/runtimeContext';
import { resolveTtsrTarget } from '../utils/ttsrTarget';
import { useOwnedSessionGate } from './agent/internal/useOwnedSessionGate';

/**
 * Persist a held queue item before claiming main's deferred reminder. If the
 * renderer disappears after the claim, the held item survives reload; an
 * uncertain claim stays held rather than sending the guidance twice.
 * After a successful claim only steerQueuedItem owns delivery and restoration.
 */
export async function runTtsrSteering(
	payload: TtsrTriggeredPayload,
	isActive: () => boolean = () => true
): Promise<QueueSteerResult | null> {
	if (isWebDesktop() || !isActive()) return null;
	const claim = window.maestro?.ttsr?.claimSteeringRequest;
	if (!claim || !window.maestro?.process?.steer) return null;
	const target = resolveTtsrTarget(useSessionStore.getState().sessions, payload);
	if (!target) return null;
	const { session, tab } = target;
	// Native queue steering targets the stable AI-tab process. A forced-parallel
	// process must not steer a different turn that happens to share its tab.
	if (payload.sessionId !== `${session.id}-ai-${tab.id}`) return null;
	const message = buildQueuedMessageItem({ session, tab, text: payload.injectionPrompt });
	const requestPrefix = `${payload.requestId}:`;
	const item = {
		...message,
		// Each renderer gets its own candidate. A losing claim can remove only its
		// candidate, never the winning window's durable held row.
		id: `${requestPrefix}${message.id}`,
		// Rule text is literal guidance, never a new consult/delegation request.
		crossAgentMention: undefined,
		crossAgentOnly: undefined,
	};
	if (!getSteerEligibility(session, item).canSteer) return null;
	if (
		session.executionQueue.some((queued) => queued.id.startsWith(requestPrefix)) ||
		session.pendingSteers?.some((pending) => pending.item.id.startsWith(requestPrefix))
	)
		return null;
	updateSessionWith(session.id, (current) => ({
		...current,
		executionQueue: [...current.executionQueue, { ...item, paused: true }],
	}));
	// The canonical flush may handle a disk failure without rejecting. Read back
	// this exact held item before transferring main's last copy of the guidance.
	try {
		await flushSessionPersistenceNow(useSessionStore.getState().sessions);
		const stored = await window.maestro.sessions.getBootstrap();
		const held = stored
			.find((storedSession) => storedSession.id === session.id)
			?.executionQueue?.find((queued) => queued.id === item.id);
		if (!held?.paused || held.text !== item.text || !isActive()) {
			removeQueuedItem(session.id, item.id);
			return null;
		}
	} catch {
		removeQueuedItem(session.id, item.id);
		return null;
	}
	let claimed: boolean;
	try {
		claimed = await claim({ sessionId: payload.sessionId, requestId: payload.requestId });
	} catch {
		notifyToast({
			color: 'orange',
			title: 'TTSR guidance held',
			message:
				'The guidance handoff could not be confirmed. Its queued message is paused; resume it only if the agent did not receive the guidance.',
			dismissible: true,
			sessionId: session.id,
			tabId: tab.id,
		});
		return null;
	}
	if (!claimed) {
		removeQueuedItem(session.id, item.id);
		return null;
	}
	if (!isActive()) return null;
	// This synchronous unpause is immediately followed by the canonical native
	// park, before React's queue drainer can dispatch the item as another turn.
	if (!setQueuedItemPaused(session.id, item.id, false)) return null;
	return steerQueuedItem(session.id, item.id);
}

export function useTtsr(enabled: boolean): void {
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		if (!enabled) return;
		const bridge = window.maestro?.ttsr;
		if (!bridge) return;
		let active = true;
		const offTriggered = bridge.onTriggered((payload) => {
			if (isWebDesktop() || !ownedGate.current?.(payload.sessionId)) return;
			void runTtsrSteering(payload, () => active);
		});
		const offMatched = bridge.onMatched?.((payload) => {
			const target = resolveTtsrTarget(useSessionStore.getState().sessions, payload);
			if (target) useTtsrStore.getState().noteMatched(target.session.cwd, payload);
		});
		return () => {
			active = false;
			offTriggered();
			offMatched?.();
		};
	}, [enabled, ownedGate]);
}
