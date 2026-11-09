/**
 * Move to Host and the lifted-agent pointer, as a Left Bar row, its context menu, and the command
 * palette read them (FED-SSH-06). Both answer nothing while the Federation Encore Feature is off:
 * the mirror store is empty then, so no menu item, chip, or palette entry appears.
 */

import { useMemo } from 'react';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import {
	liftedMirrorTarget,
	moveToHostPeer,
	type LiftableAgent,
	type LiftedMirrorTarget,
} from '../../utils/peerMirrorView';
import type { MirroredPeer } from '../../../shared/maestro-lib/client/peer-mirror';

/** The connected peer "Move to Host" would lift `agent` onto, or undefined when not offered. */
export function useMoveToHostPeer(
	agent: LiftableAgent | null | undefined
): MirroredPeer | undefined {
	const enabled = usePeerMirrorStore((s) => s.enabled);
	const order = usePeerMirrorStore((s) => s.order);
	const peers = usePeerMirrorStore((s) => s.peers);
	return useMemo(() => {
		if (!enabled || !agent) return undefined;
		return moveToHostPeer(
			agent,
			order.flatMap((peerId) => (peers[peerId] ? [peers[peerId]] : []))
		);
	}, [enabled, agent, order, peers]);
}

/**
 * Where a lifted agent's pointer leads, or undefined (never moved, or the feature is off). Takes
 * the stored `liftedTo` value, so a memo'd Left Bar row recomputes only when the pointer changes.
 */
export function useLiftedMirrorTarget(liftedTo: unknown): LiftedMirrorTarget | undefined {
	const enabled = usePeerMirrorStore((s) => s.enabled);
	const peers = usePeerMirrorStore((s) => s.peers);
	return useMemo(
		() => (enabled && liftedTo ? liftedMirrorTarget({ liftedTo }, peers) : undefined),
		[enabled, liftedTo, peers]
	);
}
