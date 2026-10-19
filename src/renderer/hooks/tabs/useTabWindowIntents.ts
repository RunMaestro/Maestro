/**
 * useTabWindowIntents - runs the owner window's intent dispatcher (Tab Windows,
 * D2): every action a user takes in one of this window's agents' tab windows
 * arrives as an intent and runs here, through the same function this window's
 * own UI calls. The dispatcher itself is `services/tabWindowIntents.ts`.
 *
 * The owner functions passed in live in App-level hooks and change identity as
 * App re-renders, so they are read through a ref: the subscription is made once.
 *
 * Only an app window mounts this. A tab window is a view, never a writer (D1).
 */

import { useEffect, useRef } from 'react';
import {
	startTabWindowIntentDispatcher,
	type TabWindowOwnerHandlers,
} from '../../services/tabWindowIntents';
import type { OwnsSession } from '../../services/tabWindowPublisher';
import { logger } from '../../utils/logger';

/**
 * Bring the calling app window to the front: after an intent whose result shows
 * in this window (a file link opens here), the user has to see it. `windowId`
 * is this window's registry id when known; otherwise it is asked for.
 */
export async function raiseOwnWindow(windowId?: string | null): Promise<void> {
	const windows = window.maestro?.windows;
	if (!windows) return;
	const id = windowId ?? (await windows.getState())?.id;
	if (!id) return;
	const result = await windows.focusWindow(id);
	if (!result.focused) {
		logger.warn(`Could not raise the owner window: ${result.error ?? 'unknown'}`, '[TabWindows]');
	}
}

/** Mount once in App.tsx, inside the WindowProvider, beside the patch publisher. */
export function useTabWindowIntents(
	ownsSession: OwnsSession | undefined,
	handlers: TabWindowOwnerHandlers
): void {
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;
	const ownsSessionRef = useRef(ownsSession);
	ownsSessionRef.current = ownsSession;

	useEffect(
		() =>
			startTabWindowIntentDispatcher(
				() => handlersRef.current,
				(id) => ownsSessionRef.current?.(id) ?? true
			),
		[]
	);
}
