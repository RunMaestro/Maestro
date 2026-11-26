/**
 * Start the Auto Run a group chat moderator's `!autorun` asked for.
 *
 * Mounted in App beside the other Auto Run launchers, because it needs
 * `startBatchRun`. Only the lifecycle owner (the primary desktop window)
 * listens: every window gets the event, and each one starting the run would
 * start it once per window. See `src/renderer/services/groupChatAutoRun.ts`.
 */

import { useEffect } from 'react';
import {
	startGroupChatAutoRun,
	type GroupChatStartBatchRun,
} from '../../services/groupChatAutoRun';
import { useStableCallback } from '../utils/useStableCallback';

export interface UseGroupChatAutoRunTriggerOptions {
	enabled: boolean;
	startBatchRun: GroupChatStartBatchRun;
}

export function useGroupChatAutoRunTrigger({
	enabled,
	startBatchRun,
}: UseGroupChatAutoRunTriggerOptions): void {
	const start = useStableCallback(startBatchRun);
	useEffect(() => {
		if (!enabled) return;
		const unsubscribe = window.maestro.groupChat.onAutoRunTriggered?.(
			(groupChatId, participantName, targetFilename, agentId) => {
				void startGroupChatAutoRun(
					{ groupChatId, participantName, targetFilename, agentId },
					start
				);
			}
		);
		return () => unsubscribe?.();
	}, [enabled, start]);
}
