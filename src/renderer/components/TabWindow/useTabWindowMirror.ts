/**
 * useTabWindowMirror - keep this tab window's agent in the renderer
 * `sessionStore`, built from the owner window's patches (Tab Windows, D2). The
 * stream itself is `services/tabWindowMirror.ts`.
 *
 * It subscribes on mount, then asks the owner for a snapshot once the registry
 * record names the agent, once per agent for the page load. A new or reloaded
 * window holds nothing yet, and the snapshot the owner sent when the window
 * attached can arrive before this page listens. Subscribing first means the
 * answer cannot slip past. Later record changes (a tab switch, a reorder) need
 * no snapshot.
 *
 * Mount once, in `TabWindowRoot`. An app window never runs it.
 */

import { useEffect, useRef } from 'react';
import type { TabWindowInfo } from '../../../shared/tabWindowTypes';
import { startTabWindowMirror, type TabWindowMirrorStream } from '../../services/tabWindowMirror';

export function useTabWindowMirror(info: TabWindowInfo | null): void {
	const infoRef = useRef(info);
	infoRef.current = info;
	const streamRef = useRef<TabWindowMirrorStream | null>(null);
	const requestedFor = useRef<string | null>(null);

	useEffect(() => {
		const stream = startTabWindowMirror(() => infoRef.current);
		streamRef.current = stream;
		return () => {
			stream.stop();
			streamRef.current = null;
		};
	}, []);

	// Declared after the subscription, so it runs after it on mount.
	useEffect(() => {
		const stream = streamRef.current;
		if (!stream || !info || requestedFor.current === info.agentId) return;
		if (stream.requestSnapshot(info)) requestedFor.current = info.agentId;
	}, [info]);
}
