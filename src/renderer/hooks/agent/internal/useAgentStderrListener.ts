/**
 * useAgentStderrListener - registers `window.maestro.process.onStderr`
 *
 * Routes stderr chunks to the matching session/tab via the batched updater
 * with the `isStderr` flag set so the renderer can style them differently
 * from stdout. Empty / whitespace-only chunks are dropped at the source.
 *
 * No shared state with other listeners.
 */

import { useEffect } from 'react';
import { REGEX_AI_TAB } from '../../../utils/sessionIdParser';
import { useOwnedSessionGate } from './useOwnedSessionGate';
import type { BatchedUpdater } from './types';

export interface UseAgentStderrListenerDeps {
	batchedUpdater: BatchedUpdater;
}

export function useAgentStderrListener(deps: UseAgentStderrListenerDeps): void {
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		const unsubscribe = window.maestro.process.onStderr((sessionId: string, data: string) => {
			// Window scoping: ignore agents this window doesn't own (broadcast events).
			if (!ownedGate.current?.(sessionId)) return;
			if (!data.trim()) return;

			let actualSessionId: string;
			let tabIdFromSession: string | undefined;
			let isFromAi = false;

			const aiTabMatch = sessionId.match(REGEX_AI_TAB);
			if (aiTabMatch) {
				actualSessionId = aiTabMatch[1];
				tabIdFromSession = aiTabMatch[2];
				isFromAi = true;
			} else if (sessionId.includes('-batch-')) {
				return;
			} else {
				actualSessionId = sessionId;
			}

			if (isFromAi && tabIdFromSession) {
				deps.batchedUpdater.appendLog(actualSessionId, tabIdFromSession, true, data, true);
			} else {
				deps.batchedUpdater.appendLog(actualSessionId, null, false, data, true);
			}
		});

		return () => {
			unsubscribe();
		};
	}, [deps.batchedUpdater, ownedGate]);
}
