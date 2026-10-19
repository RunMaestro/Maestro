/**
 * useTabWindowPublisher - runs the owner window's patch publisher (Tab Windows,
 * D2): every agent this window owns that has a tab window is streamed to it,
 * as a snapshot and then coalesced deltas. The publisher itself is
 * `services/tabWindowPublisher.ts`.
 *
 * Only an app window mounts this. A tab window is a view, never a writer (D1).
 */

import { useEffect, useRef } from 'react';
import {
	startTabWindowPublisher,
	type OwnsSession,
	type TabWindowPublisher,
} from '../../services/tabWindowPublisher';

/** Mount once in App.tsx, inside the WindowProvider, beside the popped-tab guard. */
export function useTabWindowPublisher(ownsSession?: OwnsSession): void {
	const ownsSessionRef = useRef(ownsSession);
	ownsSessionRef.current = ownsSession;
	const publisherRef = useRef<TabWindowPublisher | null>(null);

	useEffect(() => {
		const publisher = startTabWindowPublisher((id) => ownsSessionRef.current?.(id) ?? true);
		publisherRef.current = publisher;
		return () => {
			publisher.stop();
			publisherRef.current = null;
		};
	}, []);

	// Ownership moves (Move to Window, an owner window closing) attach an agent
	// here, which then gets its snapshot, or drop one the new owner publishes.
	useEffect(() => {
		publisherRef.current?.sync();
	}, [ownsSession]);
}
