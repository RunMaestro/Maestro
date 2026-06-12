import { useCallback, useState } from 'react';
import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';

export interface UseProcessKillResult {
	isKilling: boolean;
	kill: (processSessionId: string, cueRunId?: string) => Promise<void>;
}

// Owns the kill IPC dispatch.
// - Routes to window.maestro.cue.stopRun(cueRunId) when a Cue run ID is supplied.
// - Falls back to window.maestro.process.kill(processSessionId) for everything else.
// - Always calls refresh() afterwards (in finally) so the UI reflects reality
//   regardless of whether the kill IPC succeeded or threw.
//
// onSettled fires after the kill resolves so the shell can clear its kill-confirm
// state regardless of which branch executed (success or thrown error).
export function useProcessKill(
	refresh: () => Promise<void>,
	onSettled?: () => void
): UseProcessKillResult {
	const [isKilling, setIsKilling] = useState(false);

	const kill = useCallback(
		async (processSessionId: string, cueRunId?: string) => {
			setIsKilling(true);
			try {
				if (cueRunId) {
					await window.maestro.cue.stopRun(cueRunId);
				} else {
					await window.maestro.process.kill(processSessionId);
				}
			} catch (error) {
				logger.error('Failed to kill process:', undefined, error);
				captureException(error, { extra: { processSessionId, cueRunId } });
			} finally {
				try {
					await refresh();
				} catch (refreshError) {
					logger.error('Failed to refresh process list after kill:', undefined, refreshError);
				}
				setIsKilling(false);
				onSettled?.();
			}
		},
		[refresh, onSettled]
	);

	return { isKilling, kill };
}
