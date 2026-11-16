/**
 * useLiftedAgentSettingsSync - keep every lifted agent's settings the same here and on its
 * Federation host (`services/liftedAgentSettingsSync.ts`). Mounted once, in App, and active only
 * in the lifecycle owner: two windows sending the same change would race each other.
 */

import { useEffect } from 'react';
import { startLiftedAgentSettingsSync } from '../../services/liftedAgentSettingsSync';

export function useLiftedAgentSettingsSync(enabled: boolean): void {
	useEffect(() => {
		if (!enabled || !window.maestro?.federation) return;
		return startLiftedAgentSettingsSync();
	}, [enabled]);
}
