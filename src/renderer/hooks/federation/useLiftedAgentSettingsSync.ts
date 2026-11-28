/**
 * useLiftedAgentSettingsSync - keep every hosted agent this machine edits in step with its
 * Federation host (`services/liftedAgentSettingsSync.ts`), and answer main's Federation questions
 * for the CLI (`maestro-cli federation conflicts|resolve|agents|add`) from the same window. Mounted once, in App, and active only in the lifecycle
 * owner: two windows sending the same change would race each other.
 */

import { useEffect } from 'react';
import { startLiftedAgentSettingsSync } from '../../services/liftedAgentSettingsSync';
import { answerFederationWindowRequest } from '../../services/hostedAgents';

export function useLiftedAgentSettingsSync(enabled: boolean): void {
	useEffect(() => {
		const federation = window.maestro?.federation;
		if (!enabled || !federation) return;
		const stop = startLiftedAgentSettingsSync();
		const offRequests = federation.onFederationWindowRequest?.(answerFederationWindowRequest);
		return () => {
			stop();
			offRequests?.();
		};
	}, [enabled]);
}
