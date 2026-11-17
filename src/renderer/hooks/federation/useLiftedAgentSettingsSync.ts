/**
 * useLiftedAgentSettingsSync - keep every hosted agent this machine edits in step with its
 * Federation host (`services/liftedAgentSettingsSync.ts`), and answer `maestro-cli federation
 * conflicts|resolve` from the same window. Mounted once, in App, and active only in the lifecycle
 * owner: two windows sending the same change would race each other.
 */

import { useEffect } from 'react';
import {
	answerHostedSettingsRequest,
	startLiftedAgentSettingsSync,
} from '../../services/liftedAgentSettingsSync';

export function useLiftedAgentSettingsSync(enabled: boolean): void {
	useEffect(() => {
		const federation = window.maestro?.federation;
		if (!enabled || !federation) return;
		const stop = startLiftedAgentSettingsSync();
		const offRequests = federation.onHostedSettingsRequest?.(answerHostedSettingsRequest);
		return () => {
			stop();
			offRequests?.();
		};
	}, [enabled]);
}
