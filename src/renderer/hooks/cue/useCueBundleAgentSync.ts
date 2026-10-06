/**
 * useCueBundleAgentSync.ts
 *
 * Answers main's request to add the agents a bundle import brings. Main
 * writes the files (from the Bundles tab, or `maestro-cli bundle import`
 * while the app runs), then hands the agents here because the renderer owns
 * them. A failure is reported back, and main rolls the files back.
 *
 * Mounts once in App.tsx.
 */

import { useEffect } from 'react';
import { applyImportedAgents } from '../../services/cueBundle';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

export function useCueBundleAgentSync(): void {
	useEffect(() => {
		const api = window.maestro?.cueBundle;
		if (!api) return;
		return api.onApplyAgents(async (change, responseChannel) => {
			try {
				await applyImportedAgents(change);
				api.sendApplyAgentsResponse(responseChannel, { ok: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error('[CueBundle] Could not add imported agents', undefined, error);
				captureException(error instanceof Error ? error : new Error(message), {
					extra: { operation: 'cueBundle.applyAgents' },
				});
				api.sendApplyAgentsResponse(responseChannel, { ok: false, error: message });
			}
		});
	}, []);
}
